// cdp-controller.js —— CDP 控制器（纯 CDP 方案，SSE 主捕获 + DOM 兜底）
//
// 面向 chat.qwen.ai（Qwen AI 网页版）的桥接控制器，机制与 deepseek-cdp-bridge 相同：
//   1. 连接已打开的 Chrome（--remote-debugging-port=9222），找到 chat.qwen.ai 页面
//   2. Network 层捕获对话接口的 SSE 流式响应（主路径，协议级，不依赖页面渲染）
//   3. SSE 未拿到 → DOM 轮询兜底
//
// 与 DeepSeek 版的关键差异（2026-08 调研，Rfym21/Qwen2API 等项目实证）：
//   - 对话接口：https://chat.qwen.ai/api/v1/chat/completions（OpenAI 兼容 chunk 流）
//   - SSE 帧：OpenAI 兼容格式 choices[].delta.content（思考内容在 delta.reasoning_content），
//     也可能出现 DashScope 原生格式 output.choices[].message.content（快照式，无 [DONE]）。
//     因此解析器做成"多格式通用 + 快照/增量自适应"，见 parseCompletionSSE()。
//   - DOM 兜底选择器基于 chat.qwen.ai 的 markdown 消息容器（可用环境变量 QWEN_SELECTOR 覆盖）
//
// 职责：
//   1. CDP.List() 找到已打开的 chat.qwen.ai 页面并连接（target 级 client）
//   2. executeChat(sessionId, message)：输入 → 发送 → SSE 累积捕获（主）→ DOM 轮询（兜底）
//   3. Network 事件同时保留诊断日志（API请求 / 响应预览）
//
// 前置条件：Chrome 已用 --remote-debugging-port=9222 启动，且 chat.qwen.ai 页面已登录。

const CDP = require('chrome-remote-interface');

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
// 显式 IPv4 回环地址：Chrome --remote-debugging-port 默认只监听 127.0.0.1（不含 IPv6），
// 且新版 Node 解析 localhost 可能优先 ::1 导致连接被拒。可用 CDP_HOST 覆盖（如 127.0.0.1）。
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const RESPONSE_TIMEOUT = Number(process.env.RESPONSE_TIMEOUT || 60000);
const STABLE_MS = Number(process.env.STABLE_MS || 3000); // DOM 兜底时的静默稳定窗口
const QWEN_URL_MATCH = /qwen\.ai/;                        // 匹配 chat.qwen.ai（chat.qwen.com 会跳转过来）
const API_PATH_MATCH = /chat\.qwen\.ai\/api/i;            // 页面内部 API 请求
// 对话接口路径（Qwen 网页版实测为 /api/v1/chat/completions；留正则兼容变体）
const COMPLETION_PATH_MATCH = /completions|completion|\/chat\/sse|chat_stream|stream/i;

// 助手回复正文的选择器（DOM 兜底用；实测 2026-08-21：chat.qwen.ai 消息容器 class 为
// qwen-chat-message（整条消息）与 response-message-content（助手回复正文），
// 优先取消息级容器，避免命中 markdown 段落级元素；若页面改版可用 QWEN_SELECTOR 覆盖）
const ASSISTANT_CONTENT_SELECTOR =
  process.env.QWEN_SELECTOR ||
  'div[class*="response-message-content"], div[class*="qwen-chat-message"], ' +
  'div[class*="assistant-message"], div[class*="message-content"]';

// 在页面上下文读取「最后一条助手消息」的状态（DOM 兜底用）。
// 关键修复（2026-08-21）：思考模式下整条消息容器(qwen-chat-message)同时包含「思考状态卡片」与「回答正文」，
//   且思考未完成时页面会显示「跳过」按钮及其文案。若直接读整条 innerText：
//     a) 思考中读取 → 得到"思考中…跳过"等提示符，3s 稳定即被误判为最终答复；
//     b) 思考完成后读取 → 仍带"已经完成思考"等思考卡片文案，混入真实回答。
//   因此本函数：① 优先取「回答阶段」专属节点 div[class*="phase-answer"]（只含真实回答）；
//               ② 返回 thinking 标志：思考状态卡片未 completed 或页面存在「跳过/Skip」按钮 → 仍在思考；
//               ③ 兜底清洗：整条消息回退读取时，去掉行首思考卡片残留文案。
// 返回值：{ count, last, thinking } —— last 为回答正文（已尽可能排除思考内容）。
const READ_ASSISTANT_STATE_JS = `(() => {
  const MSG = 'div[class*="response-message-content"], div[class*="qwen-chat-message"], div[class*="chat-response-message"], div[class*="assistant-message"], div[class*="message-content"]';
  const msgs = Array.from(document.querySelectorAll(MSG));
  if (!msgs.length) return { count: 0, last: '', thinking: false };
  const last = msgs[msgs.length - 1];
  // ① 优先回答阶段专属节点
  let ans = null;
  try { ans = last.querySelector('div[class*="phase-answer"]'); } catch (e) { ans = null; }
  let text = ans ? (ans.innerText || '').trim() : (last.innerText || '').trim();
  // ② 是否仍在思考
  let thinking = false;
  const tc = last.querySelector('[class*="thinking-status-card"]');
  if (tc && !/completed/i.test(tc.className || '')) thinking = true;
  if (!thinking) {
    const cands = Array.from(last.querySelectorAll('button, [role="button"], a, span, div'));
    for (let i = 0; i < cands.length; i++) {
      const el = cands[i];
      const t = ((el.innerText || '') + ' ' + (el.getAttribute ? (el.getAttribute('aria-label') || '') : '')).trim();
      if (t === '跳过' || /^skip$/i.test(t)) { thinking = true; break; }
    }
  }
  // ③ 兜底清洗：整条消息回退时去掉行首思考卡片文案
  if (!ans) {
    text = text.replace(/^(已经完成思考|思考已完成|思考已结束|思考中|正在思考|Thinking)\\s*/i, '').trim();
  }
  return { count: msgs.length, last: text, thinking: thinking };
})()`;

class CDPController {
  constructor() {
    this.client = null;
    this.connected = false;
    this.taggedRequests = new Set(); // 用于 Network 日志
    this.lastApiActivity = 0;        // 最近一次页面 API 请求时间（SPA 初始化判定）
    // —— SSE 捕获状态（主路径）——
    this.activeSSE = null;           // { sessionId, resolve, done, onProgress }
    this.sseAccum = '';              // 已累积的 completion SSE 原文
    this.completionRid = null;       // 当前 completion 请求的 requestId
    this.sseLastAnswer = '';         // 上次推送的回答（onProgress 增量）
    this.sseTimer = null;            // SSE 超时定时器
    this.captureArmed = false;       // 发送后置位：下一个 API 请求作为 completion 捕获目标（武装兜底）
    // —— 单标签页串行化（同一时刻只允许一轮对话，见 executeChat 注释）——
    this._chain = Promise.resolve();
    this._chainBusy = false;
  }

  async connect() {
    let targets;
    try {
      // 显式用 IPv4 回环地址：Chrome --remote-debugging-port 默认只监听 127.0.0.1，
      // 而新版 Node 解析 localhost 时可能优先 ::1（IPv6）导致 ECONNREFUSED。
      targets = await CDP.List({ host: CDP_HOST, port: CDP_PORT });
    } catch (e) {
      throw new Error(
        `无法连接 Chrome 调试端口 ${CDP_PORT}：${e.message}。请确认 Chrome 已用 --remote-debugging-port=${CDP_PORT} 启动`
      );
    }

    const page = targets.find((t) => t.type === 'page' && QWEN_URL_MATCH.test(t.url));
    if (!page) {
      const pages = targets.filter((t) => t.type === 'page').map((t) => t.url).join(' | ') || '（无页面）';
      throw new Error(`未找到 Qwen 页面。请先在 Chrome 中打开并登录 https://chat.qwen.ai。当前页面：${pages}`);
    }

    this.client = await CDP({ target: page, host: CDP_HOST, port: CDP_PORT });
    const { Network, Page, Runtime, DOM } = this.client;

    await Promise.all([Network.enable(), Page.enable(), Runtime.enable(), DOM.enable()]);

    // 请求标记：识别 completion 请求，更新 API 活动时间（SPA 就绪判定）
    Network.requestWillBeSent((params) => {
      const url = (params.request && params.request.url) || '';
      if (API_PATH_MATCH.test(url)) {
        console.log(`[cdp] API请求: ${url}`);
        this.taggedRequests.add(params.requestId);
        this.lastApiActivity = Date.now();
        // 主匹配：URL 含 completion/stream 关键词 → 直接锁定为 completion 请求
        if (COMPLETION_PATH_MATCH.test(url)) {
          if (this.activeSSE && !this.activeSSE.done) {
            this.completionRid = params.requestId;
            this.sseAccum = ''; // 新请求到来，重置累积
            this.captureArmed = false;
          }
        } else if (this.captureArmed && this.activeSSE && !this.activeSSE.done && !this.completionRid) {
          // 武装兜底：发送后第一个 API 请求（路径不含关键词，如接口改版）也锁定为 completion
          this.completionRid = params.requestId;
          this.sseAccum = '';
          this.captureArmed = false;
          console.log(`[cdp] 武装兜底锁定 completion 请求: ${url}`);
        }
      }
    });

    // SSE 数据块累积（主捕获通道）
    Network.dataReceived((params) => {
      if (!this.completionRid || params.requestId !== this.completionRid) return;
      if (typeof params.data !== 'string') return;
      const chunk = Buffer.from(params.data, 'base64').toString('utf8');
      this.sseAccum = (this.sseAccum || '') + chunk;
      this.onSSEChunk();
    });

    // loadingFinished：getResponseBody 补全（dataReceived 缺 data 字段时的保险），并打印诊断预览
    Network.loadingFinished((params) => {
      if (!this.taggedRequests.has(params.requestId)) return;
      this.client.Network.getResponseBody({ requestId: params.requestId })
        .then(({ body, base64Encoded }) => {
          const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
          if (params.requestId === this.completionRid && this.activeSSE && !this.activeSSE.done) {
            if (text && text.length > (this.sseAccum || '').length) {
              this.sseAccum = text;
              this.onSSEChunk();
            }
          }
          console.log(`[cdp] 响应预览(${params.requestId}): ${text.slice(0, 300).replace(/\n/g, ' ')}`);
        })
        .catch(() => {});
    });

    this.connected = true;
    console.log(`[cdp] 已连接页面: ${page.url}`);
    return this.client;
  }

  async ensureConnected() {
    if (this.connected && this.client) return;
    await this.connect();
  }

  // —— 主流程：SSE 捕获 + DOM 兜底 ——
  // 单标签页串行化闸门。
  // 必须串行的原因（2026-08-25 实测日志）：activeSSE / sseAccum / sseTimer / captureArmed
  //   全是**单例共享字段**。若两个请求并发（WorkBuddy 常同时发普通请求 + 带 tools 的请求）：
  //     B 的 startSSECapture 会覆盖 A 的 activeSSE，并 clearTimeout 掉 A 的超时定时器
  //     → A 的 Promise 既不 resolve 也不超时 → **永久挂死**；且两者还会抢同一个输入框。
  //   这里用 Promise 链把 executeChat 排队，后到的请求等前一个彻底结束再执行。
  async executeChat(sessionId, message, opts = {}) {
    if (this._chain && this._chainBusy) {
      console.log(`[cdp] 页面忙，请求 ${sessionId} 排队等待上一轮对话结束`);
    }
    const prev = this._chain || Promise.resolve();
    const run = prev
      .catch(() => {}) // 前一个请求失败不影响后续排队
      .then(() => {
        this._chainBusy = true;
        return this._executeChatSerial(sessionId, message, opts);
      });
    this._chain = run.then(
      () => { this._chainBusy = false; },
      () => { this._chainBusy = false; }
    );
    return run;
  }

  async _executeChatSerial(sessionId, message, opts = {}) {
    await this.ensureConnected();

    // —— 0. 状态恢复：关闭可能残留的模态对话框 ——
    // 场景（2026-08-21 现场事故）：Qwen 页面在深度思考 / 工具调用模式下，可能弹出
    //   "ask_user_question" 等模态对话框接管输入框与发送按钮（sendDisabled=true 但 taLen=0），
    //   此时注入普通消息会失败。先派发 Escape 键尝试关闭任何模态；如果页面没对话框则 no-op。
    await this.evalJS(`(function () {
      try {
        var opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
        document.dispatchEvent(new KeyboardEvent('keydown', opts));
        document.body.dispatchEvent(new KeyboardEvent('keydown', opts));
        window.dispatchEvent(new KeyboardEvent('keydown', opts));
      } catch (e) {}
      return true;
    })()`, false);
    await sleep(300);

    if (opts.newSession) await this.newSession();

    const url = await this.evalJS('location.href');
    const snap = await this.snapshotAssistant();
    // 2026-08-21 关键修复：**不再自动新建会话**——保持当前会话页面（用户硬性要求）。
    // 页面停在根路径(URL 为 / 且无任何消息)时仅记录警告：此状态下直接发送可能因会话未创建而丢失消息，
    // 如需新会话请通过 NEW.TOPIC 指令或 new_session:true 显式触发（见 api-server.js）。
    if (!opts.newSession && snap.count === 0 && /^https?:\/\/chat\.qwen\.ai\/?$/.test(url)) {
      console.warn('[cdp] 警告：页面在根路径且无会话消息，直接发送可能丢失；如需新建会话请发送 NEW.TOPIC');
    }

    // 按模型名称尽力切换网页模式（深度思考 / 联网搜索）—— 失败不阻断发送
    if (opts.model) await this.applyModelHint(opts.model);

    // 启动 SSE 捕获（发送前开启监听，发送后 completion 请求到来即被捕获）
    const ssePromise = this.startSSECapture(sessionId, opts.onProgress, RESPONSE_TIMEOUT);
    this.captureArmed = true; // 武装：发送后第一个 API 请求兜底为 completion

    // —— 0b. 确认模态拦截（消除「卡死等待用户确认」）——
    // Qwen 在工具调用（ask_user_question 等）时会弹出原生确认框接管输入框：
    //   此时主输入框 taLen=0 + 发送按钮 disabled，triggerSend 会把「空输入框」误判为发送成功
    //   （st.empty 直接 return），导致 executeChat 以为发完了、傻等回复直到 RESPONSE_TIMEOUT 挂死。
    //   这里在注入主输入框之前先检测：若确有确认模态，则尝试「填入并点击确认」通过确认框送达；
    //   若无法处置，则明确抛错（不再静默挂死）并把模态 DOM 诊断写入 _captured_confirm_modal.json，
    //   便于后续据真实样本完善处置逻辑。
    //   ⚠ 结构性约束（2026-08-25 血案）：模态检测是**辅助**逻辑，绝不能阻断主发送链路。
    //   上一版 detectConfirmModal 注入脚本语法错误直接向外抛，导致每个请求在发送前就失败、
    //   服务端秒回错误（WorkBuddy 侧表现为 10000「请切换模型或重试」）。故这里整段兜底：
    //   检测/处置一旦异常，一律降级为常规发送。
    let modal = { present: false, strongModal: false };
    try {
      modal = await this.detectConfirmModal();
    } catch (e) {
      console.warn('[cdp] 确认模态检测失败(已忽略，按常规发送): ' + e.message);
      modal = { present: false, strongModal: false };
    }
    if (modal.present) {
      console.warn('[cdp] 检测到网页端确认模态(ask_user_question 等)，尝试通过确认框送达，避免误判发送成功而挂死');
      let handled = null;
      try {
        handled = await this.answerConfirmModal(message);
      } catch (e) {
        handled = { ok: false, reason: 'inject-error:' + e.message };
      }
      if (handled && handled.ok) {
        console.log('[cdp] 确认模态已自动处置(填入并点击确认)，继续等待回复');
      } else if (modal.strongModal) {
        // 确属强模态且处置失败：保留上一轮卡死修复——落盘诊断并明确抛错（不再静默挂死）
        await this.dumpConfirmModal(modal, message);
        this.captureArmed = false;
        throw new Error(
          'CONFIRM_MODAL_BLOCKED: 网页端弹出确认对话框，自动处置失败(' +
          (handled && handled.reason ? handled.reason : 'unknown') +
          ')。请在网页端手动确认，或将 _captured_confirm_modal.json 样本交给桥以便完善处置逻辑。'
        );
      } else {
        // 非强模态（弱 overlay，可能是误判）：不致命，回退常规发送，避免「每次都误卡死」
        console.warn('[cdp] 确认模态处置失败但非强模态，回退常规发送: ' + (handled && handled.reason));
        await this.humanTypeAndSend(message);
      }
    } else {
      await this.humanTypeAndSend(message);
    }

    this.captureArmed = false;
    const sseContent = await ssePromise;

    if (sseContent) {
      console.log(`[cdp] 会话 ${sessionId} 捕获到回复(SSE, ${sseContent.length}字)`);
      return { content: sseContent };
    }

    // SSE 未拿到 → DOM 轮询兜底（基准用发送前的快照 snap，
    // 不能用超时后再拍的快照——那时回复已渲染，基准相同会永远检测不到"新"）
    console.warn('[cdp] SSE 捕获未完成，回退 DOM 轮询');
    const domContent = await this.waitForNewReply(snap, RESPONSE_TIMEOUT, opts.onProgress);
    console.log(`[cdp] 会话 ${sessionId} 捕获到回复(DOM兜底, ${domContent.length}字)`);
    return { content: domContent };
  }

  // 检测网页端是否存在「确认模态」（ask_user_question 等原生对话框接管输入框）。
  // 注入实现见模块级 pickModalCandidates / detectModalState（见文件底部）。
  //
  // 关键修复（2026-08-25 第二次回归）：原先写成 `(${this.detectModalState.toString()})(...)`，
  //   而 detectModalState 曾是「类方法」，toString() 产出的是方法简写 `detectModalState(doc, win) {...}`，
  //   包上括号后是 `(detectModalState(doc, win) { ... })` —— 在页面里必然
  //   `SyntaxError: Unexpected token '{'`，导致每个请求在发送前就抛错 → 服务端秒回失败
  //   → WorkBuddy 报 10000「请切换模型或重试」。现改为注入模块级函数声明再显式调用。
  async detectConfirmModal() {
    const src =
      '(function () {\n' +
      pickModalCandidates.toString() + '\n' +
      detectModalState.toString() + '\n' +
      'return detectModalState(document, window);\n' +
      '})()';
    const info = await this.evalJS(src, false);
    return info || { present: false, strongModal: false };
  }

  // 尝试把 message 填入确认模态（若有输入区）并点击其「确认/确定/提交/发送」按钮，
  // 通过确认框把工具结果回传给网页，而非注入被接管的主输入框（后者会触发 triggerSend 误判发送成功）。
  // 返回 { ok, filled, reason }。
  // 注意：必须与 detectConfirmModal 使用**同一套候选选取逻辑**（pickModalCandidates），
  // 否则 detect 命中的是严格模态、answer 操作的却是另一个宽松浮层 —— 会填错框、点错按钮。
  async answerConfirmModal(message) {
    const msgJson = JSON.stringify(String(message == null ? '' : message));
    const src =
      '(function () {\n' +
      'var msg = ' + msgJson + ';\n' +
      pickModalCandidates.toString() + '\n' +
      fillAndConfirmModal.toString() + '\n' +
      'return fillAndConfirmModal(document, window, msg);\n' +
      '})()';
    return this.evalJS(src, false);
  }

  // 处置失败时把模态诊断信息落盘，便于据真实样本完善确认框处置逻辑。
  async dumpConfirmModal(modal, message) {
    try {
      const fs = require('fs');
      const dump = {
        ts: new Date().toISOString(),
        modal,
        message: String(message || '').slice(0, 2000),
      };
      fs.writeFileSync('_captured_confirm_modal.json', JSON.stringify(dump, null, 2));
      console.warn('[cdp] 已把确认模态诊断信息写入 _captured_confirm_modal.json');
    } catch (e) {
      console.warn('[cdp] dumpConfirmModal 失败: ' + e.message);
    }
  }

  // 开启 SSE 捕获会话；返回 Promise<content|null>（超时返回 null 触发 DOM 兜底）
  startSSECapture(sessionId, onProgress, timeoutMs) {
    return new Promise((resolve) => {
      this.activeSSE = { sessionId, resolve, done: false, onProgress };
      this.completionRid = null;
      this.sseAccum = '';
      this.sseLastAnswer = '';
      if (this.sseTimer) clearTimeout(this.sseTimer);
      this.sseTimer = setTimeout(() => {
        if (this.activeSSE && !this.activeSSE.done) {
          this.activeSSE.done = true;
          this.activeSSE = null;
          this.completionRid = null;
          resolve(null); // 超时 → DOM 兜底
        }
      }, timeoutMs);
    });
  }

  // 每收到一段 SSE 数据：尝试解析当前回答（流式推送增量）；检测结束信号后结算
  onSSEChunk() {
    if (!this.activeSSE || this.activeSSE.done) return;
    const answer = parseCompletionSSE(this.sseAccum);
    // 流式增量推送
    if (this.activeSSE.onProgress && answer && answer.length > this.sseLastAnswer.length) {
      this.activeSSE.onProgress(answer);
      this.sseLastAnswer = answer;
    }
    // 结束信号（多格式兼容，实测 Qwen v2 格式）：
    //   Qwen v2（实测 2026-08-21）：无 [DONE]/finish_reason，结束帧为
    //     {"delta":{"content":"","status":"finished","phase":"answer"}}
    //   其他：OpenAI 兼容 finish_reason 帧 / 独立行 [DONE] / 独立行 event: close
    // 关键修复（2026-08-25）：[DONE]/event: close 必须按**独立行**匹配，
    //   旧逻辑用裸 indexOf——answer 内容里出现 "[DONE]" 字样（如让模型输出该标记）会提前结算截断回复。
    if (
      hasDoneMarker(this.sseAccum) ||
      hasCloseMarker(this.sseAccum) ||
      sseStreamFinished(this.sseAccum)
    ) {
      this.finishSSE(answer);
    }
  }

  // 结算 SSE：resolve 完整回答
  finishSSE(answer) {
    if (!this.activeSSE || this.activeSSE.done) return;
    this.activeSSE.done = true;
    const resolve = this.activeSSE.resolve;
    const content = answer || parseCompletionSSE(this.sseAccum);
    this.activeSSE = null;
    this.completionRid = null;
    this.captureArmed = false;
    if (this.sseTimer) clearTimeout(this.sseTimer);
    resolve(content || null);
  }

  // 新建会话（API 优先，按钮/导航兜底）
  async newSession() {
    const before = await this.evalJS('location.href');
    try {
      const id = await this.createSessionViaAPI();
      if (id) {
        await this.client.Page.navigate({ url: `https://chat.qwen.ai/c/${id}` });
        await this.waitPageReady();
        const after = await this.evalJS('location.href');
        console.log(`[cdp] 已新建会话(API): ${before} -> ${after}`);
        return;
      }
    } catch (e) {
      console.warn(`[cdp] API 创建会话失败，回退按钮方式: ${e.message}`);
    }

    // 点击"新建对话"（实测为 DIV[aria-label="新建对话"]，侧边栏入口；放宽选择器）
    const clicked = await this.evalJS(`(() => {
      const els = Array.from(document.querySelectorAll('button, [role="button"], div[aria-label], a[aria-label], a'));
      const b = els.find((x) => {
        const t = (x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('title') || '') + ' ' + (x.textContent || '');
        return /新建对话|新对话|新建会话|new chat|new session/i.test(t);
      });
      if (b) { b.click(); return true; }
      return false;
    })()`);

    if (clicked) {
      const needUrlChange = before.indexOf('/c/') !== -1 || before.indexOf('/s/') !== -1;
      if (needUrlChange) {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const now = await this.evalJS('location.href');
          if (now !== before) break;
          await sleep(400);
        }
      }
    } else {
      await this.client.Page.navigate({ url: 'https://chat.qwen.ai/' });
    }

    await this.waitPageReady();
    const after = await this.evalJS('location.href');
    console.log(`[cdp] 已新建会话: ${before} -> ${after}`);
  }

  // 按模型名称尽力切换网页模式（深度思考 / 联网搜索）。
  // 纯尽力而为：找不到开关或点击失败都只记录警告，绝不阻断后续发送。
  // 规则：模型名含 thinking/reasoning/r1/思考 → 打开深度思考；含 search/联网/online/搜索 → 打开联网搜索；
  //       其余 → 关闭深度思考（保持默认对话模式）。
  async applyModelHint(model) {
    const m = String(model || '').toLowerCase();
    const wantThink = /thinking|reasoning|\br1\b|思考|深度思考/.test(m);
    const wantSearch = /search|联网|online|web-search|搜索/.test(m);
    try {
      await this.evalJS(`(() => {
        function findBtn(keys) {
          const btns = Array.from(document.querySelectorAll('button'));
          return btns.find((b) => keys.some((k) => (b.textContent || '').toLowerCase().includes(k)));
        }
        function isOn(btn) {
          if (!btn) return false;
          return btn.getAttribute('aria-pressed') === 'true'
            || /(active|selected|on|enabled)/i.test(btn.className || '');
        }
        function setToggle(btn, wantOn) {
          if (!btn) return;
          if (isOn(btn) !== wantOn) btn.click();
        }
        setToggle(findBtn(['深度思考', 'thinking', 'think', '思考']), ${wantThink});
        setToggle(findBtn(['联网搜索', '联网', '搜索', 'search']), ${wantSearch});
        return true;
      })()`);
      console.log(`[cdp] 已按模型 ${model} 设置网页模式(深度思考=${wantThink}, 联网搜索=${wantSearch}, 尽力而为)`);
    } catch (e) {
      console.warn(`[cdp] 模型模式切换失败(忽略，不影响发送): ${e.message}`);
    }
  }

  // 在页面上下文调用 Qwen 会话创建接口候选，返回新会话 id（全部失败返回 null）
  async createSessionViaAPI() {
    const candidates = [
      { url: '/api/v1/chat/session', method: 'POST' },
      { url: '/api/v1/chat/new', method: 'POST' },
      { url: '/api/v1/session', method: 'POST' },
    ];
    for (const c of candidates) {
      try {
        const raw = await this.evalJS(
          `(async () => {
            const resp = await fetch(${JSON.stringify(c.url)}, { method: ${JSON.stringify(c.method)} });
            if (!resp.ok) return JSON.stringify({ ok: false });
            const j = await resp.json();
            return JSON.stringify(j);
          })()`,
          true
        );
        let j;
        try {
          j = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (_) {
          continue;
        }
        const id = pickSessionId(j);
        if (typeof id === 'string' && id) return id;
      } catch (_) {
        // 该候选接口不可用，尝试下一个
      }
    }
    return null;
  }

  // 等待页面就绪：加载完成 + 输入框可用 + SPA 初始化完成（API 请求静默 2s）
  async waitPageReady(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ok = await this.evalJS(`(() => {
          if (document.readyState !== 'complete') return false;
          return !!document.querySelector('[contenteditable="true"], textarea');
        })()`);
        if (ok) {
          const idleMs = this.lastApiActivity ? Date.now() - this.lastApiActivity : Infinity;
          if (idleMs >= 2000) return true;
        }
      } catch (e) {}
      await sleep(500);
    }
    throw new Error('页面未就绪（加载完成但输入框未出现，请确认已登录）');
  }

  // —— DOM 兜底 ——
  // 读取最后一条助手消息状态：回答正文 + 是否仍在思考（见 READ_ASSISTANT_STATE_JS）
  async snapshotAssistant() {
    return this.evalJS(READ_ASSISTANT_STATE_JS);
  }

  // 代码块完整性自检（DOM 兜底用）
  warnIfCodeBlocksIncomplete(text) {
    const fences = (text.match(/```/g) || []).length;
    if (fences === 0) return;
    if (fences % 2 !== 0) {
      console.warn(`[cdp] ⚠️ 代码块围栏不配对（${fences} 个 \`\`\`，应为偶数）— 内容可能未完整渲染`);
      return;
    }
    this.evalJS(`(() => {
      const els = document.querySelectorAll('${ASSISTANT_CONTENT_SELECTOR}');
      const last = els[els.length - 1];
      if (!last) return '';
      const pre = last.querySelectorAll('pre').length;
      const expected = ${fences} / 2;
      if (pre < expected) {
        console.warn('[cdp] ⚠️ 代码块可能未完整渲染：markdown 含 ' + expected + ' 个代码块，但 DOM 中 <pre> 只有 ' + pre + ' 个');
      }
    })`).catch(() => {});
  }

  // 轮询 DOM 等待新回复（兜底）：文本连续 STABLE_MS 不变视为流式结束
  // 关键修复（2026-08-21）：思考模式下绝不提前返回——只要 thinking=true（思考状态卡片未 completed
  //   或页面仍存在「跳过/Skip」按钮），即使文本暂时稳定也持续等待，避免把"跳过"提示符当答复。
  async waitForNewReply(snap, timeoutMs, onProgress) {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 500;
    const { count: prevCount, last: prevText, thinking: prevThinking } = snap || {};
    let lastText = null;
    let stableSince = 0;

    while (Date.now() < deadline) {
      const res = await this.evalJS(READ_ASSISTANT_STATE_JS);
      const text = (res && res.last) || '';
      const thinking = !!(res && res.thinking);
      const isNew = text && (res.count > prevCount || (prevText && text !== prevText));

      if (isNew && !thinking) {
        if (text === lastText) {
          if (stableSince === 0) stableSince = Date.now();
          else if (Date.now() - stableSince >= STABLE_MS) {
            this.warnIfCodeBlocksIncomplete(text);
            return text;
          }
        } else {
          lastText = text;
          stableSince = 0;
          if (typeof onProgress === 'function') onProgress(text);
        }
      } else {
        // 仍在思考 / 尚无新内容 → 重置稳定计时，继续等待
        stableSince = 0;
      }
      await sleep(pollInterval);
    }
    throw new Error(
      `等待回复超时（${RESPONSE_TIMEOUT / 1000}s）：页面未检测到新的助手回复。` +
      `请确认页面停留在聊天页、已登录，且发送后页面确实出现了回答`
    );
  }

  // 页面上下文执行 JS 并取值；awaitPromise=true 支持异步表达式
  async evalJS(expression, awaitPromise = false) {
    const r = await this.client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      const desc =
        (r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
        r.exceptionDetails.text ||
        'unknown';
      throw new Error(`页面脚本执行失败: ${desc}`);
    }
    return r.result.value;
  }

  async humanTypeAndSend(message) {
    const focused = await this.evalJS(`(function () {
      var el = document.querySelector('[contenteditable="true"], textarea');
      if (el) { el.focus(); return true; }
      return false;
    })()`);
    if (!focused) {
      throw new Error('未找到输入框（页面可能已变化或未在聊天页）');
    }

    // 一次性写入完整文本（不粘贴、不重复录入，文本只进输入框一次）
    await this.injectText(message);

    // 触发发送：等待框架把内容提交到内部状态、发送按钮启用后再点击。
    // 关键修复：注入后框架（React 等）需一小段时间提交状态，否则按钮仍 disabled、点击无效。
    const sent = await this.triggerSend();
    if (!sent) {
      throw new Error('未找到可用的发送方式（页面可能已变化或未在聊天页）');
    }
    console.log(`[cdp] 已触发发送 (${sent})`);
  }

  // 触发发送：注入后，框架（React 等）需要一小段时间把内容提交到内部状态，
  // 此时按钮虽「看起来」可点，点击却无效。因此这里在 maxWaitMs 预算内持续轮询：
  //   - 输入框已清空 → 视为发送成功（之前任一次点击已生效）
  //   - 内容已就绪（有文本且按钮可点）→ 点击发送；然后等待并检查是否清空
  //   - 未清空则继续等待/重试点击，直到预算耗尽或真正发送成功
  // 预算耗尽仍失败 → 最后回退 Enter 键。
  //
  // 关键修复（2026-08-21 现场事故）：长文本写入失败后，Qwen React state 卡在"空"，
  // DOM 残留 90 字、按钮永久 disabled。如果在 ~1.2s 内一直检测到「按钮 disabled + DOM 有内容」，
  // 主动重发 input 事件强制 React 把 state 同步到当前 DOM（修复卡死状态）。
  async triggerSend(maxWaitMs = 3000, pollMs = 250) {
    const deadline = Date.now() + maxWaitMs;
    let attempt = 0;
    let stuckSince = 0; // 状态卡死计时器（disabled + 有内容）
    while (Date.now() < deadline) {
      attempt++;
      const st = await this.evalJS(`(function () {
        function findSend() {
          var btns = Array.from(document.querySelectorAll('button'));
          for (var b of btns) {
            var label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
            if (/发送|send/i.test(label)) return b;
          }
          return document.querySelector('button[data-testid*="send"]');
        }
        var el = document.querySelector('[contenteditable="true"], textarea');
        var b = findSend();
        var txt = el ? (el.isContentEditable ? (el.innerText || '') : (el.value || '')).trim() : '';
        return {
          empty: txt.length === 0,
          ready: txt.length > 0 && (!b || !b.disabled),
          stuck: txt.length > 0 && b && b.disabled, // 卡死：有内容但按钮禁用
        };
      })()`);
      if (st && st.empty) {
        console.log('[cdp] 输入框已清空，发送成功');
        return 'click';
      }
      // 卡死恢复：disabled + DOM 有内容持续 ≥ 1.2s → 主动重发 input 事件，让 React 重新读 DOM
      if (st && st.stuck) {
        if (stuckSince === 0) stuckSince = Date.now();
        if (Date.now() - stuckSince >= 1200) {
          await this.evalJS(`(function () {
            var el = document.querySelector('[contenteditable="true"], textarea');
            if (!el) return;
            // 强制重新触发 React 监听的 input 事件，把 DOM 当前 value 推回 state
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: el.value || el.innerText || '' }));
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          })()`, false);
          console.warn('[cdp] 检测到按钮卡死(disabled + DOM 有内容)，已重发 input 事件强制 React 同步');
          stuckSince = 0; // 重置，下次再卡再触发
        }
      } else {
        stuckSince = 0;
      }
      if (st && st.ready) {
        await this.evalJS(`(function () {
          var btns = Array.from(document.querySelectorAll('button'));
          for (var b of btns) {
            var label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
            if (/发送|send/i.test(label)) { b.click(); return; }
          }
          var sb = document.querySelector('button[data-testid*="send"]');
          if (sb) sb.click();
        })()`);
        console.log(`[cdp] 已点击发送（第 ${attempt} 次尝试）`);
        await sleep(900); // 等待框架处理并清空输入框（避免误判未发送而重复点击）
        continue;
      }
      // 内容未就绪（输入框空 / 按钮 disabled）→ 继续等待框架提交状态
      await sleep(pollMs);
    }
    // 预算耗尽前最后一次点击可能已生效（清空发生在 deadline 之后极短时间内），最终确认一次
    const finalEmpty = await this.evalJS(`(function () {
      var el = document.querySelector('[contenteditable="true"], textarea');
      if (!el) return true;
      var t = el.isContentEditable ? (el.innerText || '').trim() : (el.value || '').trim();
      return t.length === 0;
    })()`);
    if (finalEmpty) {
      console.log('[cdp] 输入框已清空，发送成功（预算边缘）');
      return 'click';
    }
    // 仍未能发送：最后回退 Enter 键
    console.log('[cdp] 预算内按钮提交未成功，回退 Enter 键');
    const entered = await this.enterFallback();
    if (entered) {
      await sleep(900);
      const cleared = await this.evalJS(`(function () {
        var el = document.querySelector('[contenteditable="true"], textarea');
        if (!el) return true;
        var t = el.isContentEditable ? (el.innerText || '').trim() : (el.value || '').trim();
        return t.length === 0;
      })()`);
      if (cleared) return 'enter';
      return 'enter-timeout';
    }
    return 'none';
  }

  // 回退：在输入框聚焦后派发 Enter 键（keyCode=13），部分编辑器以此提交
  async enterFallback() {
    return this.evalJS(`(function () {
      var el = document.querySelector('[contenteditable="true"], textarea');
      if (!el) return false;
      el.focus();
      var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      return true;
    })()`);
  }

  // 一次性写入完整文本（替代逐字输入；不粘贴、不重复录入，文本只进输入框一次）。
  // 关键差异（实测 2026-08-21）：Qwen 页面内 setTimeout 被站点脚本包装/节流，
  // CDP Runtime.evaluate + awaitPromise 等待页面定时器会永久挂起，
  // 因此注入必须**全同步**（不 await 页面 promise），框架提交状态的时间在 Node 侧等待。
  //
  // 关键修复（2026-08-21 现场事故）：
  //   1) 长文本请求写入失败后，Qwen 页面 React 受控组件只同步了前 ~90 字符到 state（DOM 写入完整但 state 截断），
  //      发送按钮永久 disabled，后续所有消息发不出去。每次注入前先彻底清空输入框。
  //   2) Qwen 工具调用（ask_user_question 等）会弹出模态对话框接管输入框 + 禁用发送按钮，
  //      此时 taLen=0 + sendDisabled=true。检测到该状态时，自动新建会话恢复（newSession），
  //      避免无限 60s 超时。
  async injectText(text) {
    const t = String(text == null ? '' : text);
    if (!t) return; // 空消息无需写入

    // —— 0a. 注入前健康检查：识别「输入框有内容但发送按钮禁用」的真卡死状态 ——
    // 2026-08-21 关键修复：原实现把「空输入框 + 发送按钮 disabled」的正常状态误判为卡死
    // （taLen=0 + sendDisabled=true 正是空输入框的常态！），导致每次请求都自动 newSession()，
    // 网页会话被反复切换、无法保持原会话页面。
    // 现改为：① 空输入框（taLen=0）的 disabled 是正常态，**绝不处理**；
    //          ② 仅当「输入框有内容且按钮 disabled 持续 ≥800ms」才认为真卡死（React state 截断等），
    //             先重发 input 事件强制 React 同步（与 triggerSend 的 stuck 恢复一致）；
    //          ③ 仍失败则抛错提示人工处理——**不再自动新建会话**（新建仅由 api-server 层的
    //             new_session 字段 / NEW.TOPIC 指令驱动）。
    const stuck0 = await this.evalJS(`(function () {
      var el = document.querySelector('[contenteditable="true"], textarea');
      if (!el) return { taLen: -1, sendDisabled: null };
      var txt = (el.isContentEditable ? (el.innerText || '') : (el.value || '')).trim();
      var btns = Array.from(document.querySelectorAll('button'));
      var b = btns.find(function (x) {
        var label = (x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '');
        return /发送|send/i.test(label);
      });
      return { taLen: txt.length, sendDisabled: b ? b.disabled : null };
    })()`, false);
    if (stuck0 && stuck0.taLen > 0 && stuck0.sendDisabled === true) {
      // 再观察 800ms 确认是持续卡死（不是框架提交中的瞬时 disabled）
      await sleep(800);
      const stuck1 = await this.evalJS(`(function () {
        var el = document.querySelector('[contenteditable="true"], textarea');
        var txt = el ? ((el.isContentEditable ? (el.innerText || '') : (el.value || '')).trim()) : '';
        var btns = Array.from(document.querySelectorAll('button'));
        var b = btns.find(function (x) {
          var label = (x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '');
          return /发送|send/i.test(label);
        });
        return txt.length > 0 && b ? b.disabled : false;
      })()`, false);
      if (stuck1 === true) {
        console.warn(`[cdp] 检测到输入框有内容但发送按钮持续禁用(taLen=${stuck0.taLen})，重发 input 事件强制 React 同步（不新建会话）`);
        await this.evalJS(`(function () {
          var el = document.querySelector('[contenteditable="true"], textarea');
          if (!el) return;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: el.value || el.innerText || '' }));
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        })()`, false);
        await sleep(400);
        const recovered = await this.evalJS(`(function () {
          var btns = Array.from(document.querySelectorAll('button'));
          var b = btns.find(function (x) {
            var label = (x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '');
            return /发送|send/i.test(label);
          });
          return b ? !b.disabled : true;
        })()`, false);
        if (recovered !== true) {
          throw new Error('Qwen 页面输入框有内容但发送按钮持续禁用（React state 卡死），重发 input 无法恢复。请在 Chrome 手动刷新 chat.qwen.ai 后重试（服务不会自动新建会话）');
        }
        console.log('[cdp] 重发 input 后发送按钮已恢复可用');
      }
    }

    // —— 0b. 先清空输入框（包括残留内容 + 强制 React state 同步）——
    // contenteditable 用 Range select-all + execCommand('delete')；textarea 用原生 setter。
    // 不管输入框当前是否有内容，都必须走这一步：清掉前次残留 + 让 React 知道"现在为空"。
    await this.evalJS(`(function () {
      var el = document.querySelector('[contenteditable="true"], textarea');
      if (!el) return;
      el.focus();
      if (el.isContentEditable) {
        var sel = window.getSelection();
        if (sel) {
          var range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false);
        }
      } else {
        var set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        set.call(el, '');
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      return true;
    })()`, false);
    // 节点侧短暂等待清空提交到 state
    await sleep(120);

    // —— 1. 写入新文本（与原逻辑一致：原生命令插入 + 派发 input）——
    const textArg = JSON.stringify(t); // 独立序列化，避免模板字面量被消息中的反引号破坏
    const expr =
      `(function (text) {
        var el = document.querySelector('[contenteditable="true"], textarea');
        if (!el) return { ok: false, reason: 'no-el', finalLen: 0, wantLen: text.length };
        function curText(n) { return n.isContentEditable ? (n.innerText || '') : (n.value || ''); }
        function fire(n) { n.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true })); }
        el.focus();
        if (el.isContentEditable) {
          // 富文本编辑器：execCommand 原生整段插入（React 监听 input 读取内容），一次写入
          document.execCommand('insertText', false, text);
        } else {
          // textarea/input（React 受控）：用原生 value setter 绕过 React 的 value 拦截，再派发 input
          var set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          set.call(el, text);
        }
        fire(el);
        return { ok: true, finalLen: curText(el).length, wantLen: text.length };
      })(${textArg})`;

    const res = await this.evalJS(expr, false); // 同步求值，不用 awaitPromise

    if (!res || res.ok === false) {
      const want = (res && res.wantLen) || t.length;
      const got = (res && res.finalLen) || 0;
      throw new Error(`写入文本失败（${res ? res.reason || 'insert-failed' : 'no-result'}，期望 ${want} 字，实际 ${got} 字）`);
    }

    // Node 侧等待框架提交状态（React 读取 DOM value + input 事件 → 内部 state）
    await sleep(200);

    // 独立校验（第二次同步求值，确认文本仍在输入框）
    const check = await this.evalJS(`(function () {
      var el = document.querySelector('[contenteditable="true"], textarea');
      if (!el) return { finalLen: 0 };
      return { finalLen: (el.isContentEditable ? (el.innerText || '') : (el.value || '')).length };
    })()`, false);
    const finalLen = (check && check.finalLen) || 0;
    if (finalLen < res.wantLen) {
      console.warn(`[cdp] ⚠️ 文本可能未完整写入：期望 ${res.wantLen} 字，实际 ${finalLen} 字`);
    }
    console.log(`[cdp] 已写入文本（一次性写入，${finalLen}/${res.wantLen} 字）`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =====================================================================
// 确认模态（ask_user_question 等）注入脚本
//
// 这些函数**不在 Node 里执行**，而是被 `.toString()` 注入到页面上下文运行，因此：
//   1) 必须是**模块级函数声明**（不能是类方法/箭头属性）——否则 toString() 产出方法简写，
//      拼进 `(...)` 后就是 `SyntaxError: Unexpected token '{'`（2026-08-25 踩过）。
//   2) 内部只能用 ES5 风格 + 页面 API，不能引用 Node 作用域的任何变量（msg 由外层注入）。
//   3) detect 与 answer 共用 pickModalCandidates，保证判定与操作是**同一个元素**。
//
// 判定策略（2026-08-25 收紧后）：只认「语义真模态」或「带全屏遮罩的 overlay」，
// 且必须「有确认按钮」或「主输入框被接管」才算确认模态；普通 drawer/popup 一律放行常规发送。
// =====================================================================

// 选取确认模态候选。返回 { strong: [], cands: [], hasBackdrop: bool }
function pickModalCandidates(doc, win) {
  function visible(el) { return !!el && el.offsetParent !== null; }
  function q(sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); }
  var strong = q('[role="dialog"], dialog[open], [aria-modal="true"]').filter(visible);
  var overlay = q('[class*="modal"], [class*="overlay"], [class*="backdrop"], [class*="mask"]').filter(visible);
  // 全屏遮罩探测：只扫 body 下浅层节点（浮层几乎都 portal 挂在 body 上），
  // 避免 querySelectorAll('div') 全页遍历 + getComputedStyle 造成明显卡顿。
  var shallow = q('body > div, body > div > div').slice(0, 300);
  var hasBackdrop = shallow.some(function (el) {
    if (!visible(el)) return false;
    var s = win.getComputedStyle(el);
    if (s.position !== 'fixed') return false;
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    var r = el.getBoundingClientRect();
    return r.width >= win.innerWidth * 0.9 && r.height >= win.innerHeight * 0.9;
  });
  return { strong: strong, cands: strong.concat(hasBackdrop ? overlay : []), hasBackdrop: hasBackdrop };
}

// 判定当前是否存在确认模态（纯读，不做任何点击）
function detectModalState(doc, win) {
  var picked = pickModalCandidates(doc, win);
  if (!picked.cands.length) return { present: false, strongModal: false, hasBackdrop: picked.hasBackdrop };
  var modal = picked.cands[0];
  var btns = Array.prototype.slice.call(modal.querySelectorAll('button'));
  function txt(b) { return ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim(); }
  var confirmBtn = null;
  for (var i = 0; i < btns.length; i++) {
    if (/确认|确定|提交|发送|ok|yes|继续|confirm|agree|完成/i.test(txt(btns[i]))) { confirmBtn = btns[i]; break; }
  }
  var mainTa = doc.querySelector('[contenteditable="true"], textarea');
  var mainInputBlocked = !mainTa || mainTa.offsetParent === null;
  // 双重闸门：必须「有确认按钮」或「主输入框被接管」才算确认模态
  var present = !!confirmBtn || mainInputBlocked;
  return {
    present: present,
    strongModal: picked.strong.length > 0,
    hasBackdrop: picked.hasBackdrop,
    hasConfirmBtn: !!confirmBtn,
    confirmBtnText: confirmBtn ? txt(confirmBtn) : null,
    buttonTexts: btns.map(txt).filter(Boolean),
    hasInput: !!modal.querySelector('textarea, [contenteditable="true"], input[type="text"]'),
    mainInputBlocked: mainInputBlocked,
    modalClass: (modal.className && modal.className.toString) ? modal.className.toString() : ''
  };
}

// 把 msg 填入确认模态（若有输入区）并点击其「确认/确定/…」按钮。
// 找不到真确认按钮时**绝不**退而点最后一个按钮（2026-08-25 踩过：会误点无关按钮并谎报成功）。
function fillAndConfirmModal(doc, win, msg) {
  var picked = pickModalCandidates(doc, win);
  if (!picked.cands.length) return { ok: false, reason: 'no-modal' };
  var modal = picked.cands[0];
  var ta = modal.querySelector('textarea, [contenteditable="true"], input[type="text"]');
  if (ta) {
    try {
      ta.focus();
      // React 受控组件必须走原型链 value setter，否则内部 state 不更新；
      // 但该路径可能因环境差异抛错 —— 此时降级为直接赋值，绝不能因填值失败就放弃点确认。
      var filled = false;
      try {
        var proto = ta.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : (ta.tagName === 'INPUT' ? HTMLInputElement.prototype : null);
        if (proto) {
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, msg);
          filled = true;
        }
      } catch (e0) { /* 降级处理 */ }
      if (!filled) {
        if (ta.tagName === 'TEXTAREA' || ta.tagName === 'INPUT') ta.value = msg;
        else ta.innerText = msg;
      }
      if (typeof ta.dispatchEvent === 'function' && typeof Event === 'function') {
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (e) { return { ok: false, reason: 'fill-failed:' + e.message }; }
  }
  var btns = Array.prototype.slice.call(modal.querySelectorAll('button'));
  function txt(b) { return ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim(); }
  for (var i = 0; i < btns.length; i++) {
    if (/确认|确定|提交|发送|ok|yes|继续|confirm|agree|完成/i.test(txt(btns[i]))) {
      if (btns[i].disabled) return { ok: false, reason: 'confirm-button-disabled' };
      btns[i].click();
      return { ok: true, filled: !!ta };
    }
  }
  return { ok: false, reason: 'no-confirm-button' };
}

// =====================================================================
// Qwen completion SSE 解析（多格式通用 + 快照/增量自适应）
//
// 实测/调研格式（2026-08）：
//   A. OpenAI 兼容（chat.qwen.ai 当前网页版，增量式，结束有 [DONE]）：
//      data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}
//      data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{"reasoning_content":"思考..."},"finish_reason":null}]}  ← 思考模式
//      data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
//      data: [DONE]
//   B. DashScope 原生（快照式，无 [DONE]，finish_reason 为字符串 "null"）：
//      data:{"output":{"choices":[{"message":{"role":"assistant","content":"你好"},"finish_reason":"null"}]},"usage":{...},"request_id":"..."}
//      data:{"output":{"text":"..."}}
//
// 提取规则（answer = 最终回答，自动排除 reasoning_content/思考）：
//   1. 每帧提取候选文本（delta.content / message.content / output.text 等）
//   2. **按流分组**：分组键 = response_id || id || '__single__'。
//      关键（2026-08-25 血案）：真实 SSE 里 Qwen 的 answer 阶段是**增量式**——
//      每帧 delta.content 只含新增片段，不是整段快照。若不做分组而直接对全部帧做
//      "包含关系"判定，增量帧与已累积文本无包含关系 → 被忽略 → **客户端收到不完整回复**。
//      分组后：同一流内 超集覆盖/相等忽略/前缀忽略/其余追加；
//      不同流（新 response_id = 整段重放/新会话）→ 只保留最新流的累积，杜绝"双份回复"。
//   3. 结束：finish_reason 非空(非 "null") 或 独立行 [DONE] / event: close
// =====================================================================
function parseCompletionSSE(body) {
  if (!body) return null;
  let thinking = '';
  let thinkingText = '';
  const accByKey = new Map(); // 分组键 -> 该流已累积 answer
  let lastKey = null;         // 最近一次出现内容的流（"当前流"）

  const blocks = body.split(/\n\s*\n/);
  for (const block of blocks) {
    const dataLines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('data:'));
    for (const dl of dataLines) {
      const d = dl.slice(dl.indexOf('data:') + 5).trim();
      if (!d || d === '[DONE]') continue;
      let j;
      try {
        j = JSON.parse(d);
      } catch (_) {
        continue;
      }
      if (!j || typeof j !== 'object') continue;

      const key = (j.response_id || j.id) || '__single__';
      // 阶段判定：thinking/thinking_summary 等思考帧的 content **不得**进 answer。
      // 血案（2026-08-25）：Qwen 思考阶段会在 delta.content 里放完整规划草稿
      // （正文+工具块），answer 阶段再以增量式续写（只发工具块）。
      // 若不按 phase 过滤，thinking 的"正文+块"与 answer 的"块"无包含关系 → 追加 →
      // 客户端收到两份相同工具块（网页端却正常，因为页面只渲染 answer 阶段累积）。
      const phase = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.phase) || '';
      const isThinking = /thinking/i.test(String(phase));
      const { content, reasoning } = extractQwenTexts(j);
      if (reasoning) thinking += reasoning;
      if (isThinking) {
        // 思考阶段 content 不进 answer（防思考草稿/工具规划混入 → 重复工具块）。
        // 但保留在 thinkingText 里供「answer 为空时回退」兜底。
        if (content) thinkingText += content;
        continue;
      }
      if (!content) continue;

      const cur = accByKey.get(key) || '';
      accByKey.set(key, mergeStreamedText(cur, content));
      lastKey = key;
    }
  }
  if (thinking || thinkingText) {
    console.log(`[cdp] 思考内容(SSE, reasoning=${thinking.length}字, content=${thinkingText.length}字，已从回答中排除)`);
  }
  const answer = lastKey ? accByKey.get(lastKey) || '' : '';
  if (!answer && thinkingText) {
    // 兜底：answer 阶段完全没有 content（极端情况：Qwen 把全部正文放在思考阶段），
    // 回退思考阶段文本，避免客户端空手。
    console.warn(`[cdp] answer 阶段无内容，回退思考阶段文本(${thinkingText.length}字)`);
    return thinkingText || null;
  }
  return answer || null;
}

// 把同一条流（同一 response_id/id）里的新帧 content 合并进该流已累积的 answer。
// 设计目标（2026-08-25 二次修正）：既要根除「双份回复」，又**绝不丢增量帧**。
//
// 真实 Qwen 网页版 SSE 形态（实测样本）：
//   - 思考阶段 thinking_summary：extra 里累积数组逐帧追加 —— 但 content 恒为空，不参与 answer；
//   - 回答阶段 answer：delta.content 为**增量式**（短文本一帧全量，长文本分多帧，每帧只含新增片段）。
//   因此对同一流内的帧：
//     - content 与 answer 完全相同          → 重放帧，忽略
//     - content 是 answer 的超集快照        → 覆盖（answer = content，兼容累积式增量/整段快照）
//     - content 是 answer 的旧前缀片段      → 忽略（旧短帧重放）
//     - content 是 answer 的**后缀**        → 忽略（跨阶段续写/已包含内容重放，防重复工具块）
//     - 其余（纯增量新内容）               → **追加**（增量式流的正常形态，必须拼接，否则回复不完整）
// 注：旧版这里写"一律忽略"，导致增量帧被丢弃 → 客户端收到不完整回复（2026-08-25 现场事故）。
// 防翻倍的职责已上移到 parseCompletionSSE 的按流分组：不同流只保留最新一条，杜绝整段重放翻倍。
function mergeStreamedText(answer, content) {
  if (!content) return answer;
  if (!answer) return content;
  if (content === answer) return answer;                 // 完全相同：重放帧，忽略
  if (content.startsWith(answer)) return content;        // 超集快照/累积式增量：覆盖
  if (answer.startsWith(content)) return answer;         // 旧前缀片段：忽略
  if (answer.endsWith(content)) return answer;           // 已包含的后缀续写：忽略（防重复）
  return answer + content;                               // 纯增量帧：追加（绝不丢内容）
}

// 从单个 SSE JSON 帧中提取回答文本与思考文本。
// 覆盖 OpenAI 兼容 chunk / DashScope 原生 / 简单 {"content":...} 等形态。
function extractQwenTexts(j) {
  let content = '';
  let reasoning = '';

  // 1) choices[].delta{content, reasoning_content} —— OpenAI 兼容增量
  if (Array.isArray(j.choices)) {
    for (const c of j.choices) {
      if (!c) continue;
      const d = c.delta;
      if (d) {
        if (typeof d.content === 'string') content += d.content;
        if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
        if (typeof d.reasoning === 'string') reasoning += d.reasoning;
      }
      if (c.message) {
        if (typeof c.message.content === 'string') content += c.message.content;
        if (typeof c.message.reasoning_content === 'string') reasoning += c.message.reasoning_content;
      }
      if (typeof c.text === 'string') content += c.text;
    }
  }

  // 2) output.choices[].message.content —— DashScope 原生快照
  const out = j.output;
  if (out) {
    if (Array.isArray(out.choices)) {
      for (const c of out.choices) {
        if (!c) continue;
        const msg = c.message;
        if (msg && typeof msg.content === 'string') content += msg.content;
        if (typeof c.text === 'string') content += c.text;
        if (msg && typeof msg.reasoning_content === 'string') reasoning += msg.reasoning_content;
      }
    }
    if (typeof out.text === 'string') content += out.text;
  }

  // 3) 顶层简化形态
  if (typeof j.content === 'string') content += j.content;
  if (typeof j.text === 'string') content += j.text;
  if (typeof j.reasoning_content === 'string') reasoning += j.reasoning_content;

  return { content, reasoning };
}

// [DONE] / event: close 必须作为**独立行**才算结束信号，
// 否则 answer 内容里出现 "[DONE]" 字样（如用户要求模型输出该标记）会提前结算截断回复。
function hasDoneMarker(body) {
  if (!body) return false;
  return body.split('\n').some((l) => l.trim() === 'data: [DONE]');
}
function hasCloseMarker(body) {
  if (!body) return false;
  return body.split('\n').some((l) => l.trim() === 'event: close');
}

// 检测 SSE 原文中是否出现流式结束信号。
// 实测 Qwen v2（2026-08-21）思考 + 回答两阶段 SSE：
//   思考阶段结束帧：{"delta":{"content":"","phase":"thinking_summary","status":"finished"}}  ← 仅是"思考"结束，整条流未完
//   回答阶段结束帧：{"delta":{"content":"","phase":"answer","status":"finished"}}            ← 整条流真正结束
//   思考内容位于 delta.extra.summary_thought（不在 delta.content），回答内容在 delta.content。
// 关键修复（2026-08-21）：原逻辑只判 delta.status === 'finished' 不区分 phase，
//   会在「思考阶段结束帧」就误判整条流结束 → 此时累积 content 仍为空 → resolve(null) → 回落 DOM 兜底 → 读到"跳过"。
//   因此必须要求 phase 为 answer（或非思考阶段）才视为结束；thinking/thinking_summary 阶段的 finished 一律忽略。
// 兼容：OpenAI 兼容 finish_reason 帧；DashScope 原生 finish_reason 为字符串 "null"（进行中），非 "null" 即结束。
function sseStreamFinished(body) {
  if (!body) return false;
  // 逐行找 data: JSON，检查结束信号
  const lines = body.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const d = t.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try {
      const j = JSON.parse(d);
      if (Array.isArray(j.choices)) {
        for (const c of j.choices) {
          if (!c) continue;
          // Qwen v2：delta.status === "finished" —— 但必须排除「思考阶段」结束帧
          if (c.delta && c.delta.status === 'finished') {
            const phase = c.delta.phase;
            // 思考阶段结束（thinking_summary / thinking）不算整条流结束，必须等 answer 阶段
            const isThinkingPhase = /thinking/i.test(String(phase || ''));
            if (!isThinkingPhase) return true;
          }
          // OpenAI 兼容：finish_reason 非空非 null
          if (c.finish_reason && c.finish_reason !== 'null' && c.finish_reason !== null) return true;
        }
      }
      const out = j.output;
      if (out && Array.isArray(out.choices)) {
        for (const c of out.choices) {
          if (c && c.finish_reason && c.finish_reason !== 'null' && c.finish_reason !== null) return true;
        }
      }
      if (out && out.finish_reason && out.finish_reason !== 'null' && out.finish_reason !== null) return true;
    } catch (_) {
      // 非 JSON 行忽略
    }
  }
  return false;
}

// 从会话创建接口响应里抽取会话 id（多字段兼容）
function pickSessionId(j) {
  const d = j && j.data;
  if (!d) return null;
  const cands = [
    d.id,
    d.session_id,
    d.sessionId,
    d.chat_id,
    d.chatId,
    (d.biz_data && d.biz_data.chat_session && d.biz_data.chat_session.id),
    (d.biz_data && d.biz_data.id),
  ];
  for (const c of cands) {
    if (typeof c === 'string' && c) return c;
    if (typeof c === 'number') return String(c);
  }
  return null;
}

module.exports = new CDPController();
// 导出解析函数便于自测
module.exports.parseCompletionSSE = parseCompletionSSE;
module.exports.extractQwenTexts = extractQwenTexts;
module.exports.sseStreamFinished = sseStreamFinished;
module.exports.sseHasFinishReason = sseStreamFinished; // 旧名兼容
module.exports.mergeStreamedText = mergeStreamedText;
module.exports.hasDoneMarker = hasDoneMarker;
module.exports.hasCloseMarker = hasCloseMarker;
// 导出注入脚本函数便于 mock-DOM 单测（它们运行在页面上下文，必须保持模块级函数声明）
module.exports.pickModalCandidates = pickModalCandidates;
module.exports.detectModalState = detectModalState;
module.exports.fillAndConfirmModal = fillAndConfirmModal;
