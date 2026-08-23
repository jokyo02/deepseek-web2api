// cdp-controller.js —— CDP 控制器（纯 CDP 方案，SSE 主捕获 + DOM 兜底）
//
// 捕获机制演进（实测 2026-08-20）：
//   1. 页面内 hook 监听 fetch/XHR   → URL 正则未命中 /api/v0/chat/...，静默失败
//   2. CDP Network 抓 SSE（早期）    → 结算时机错误（首个 chunk 即 resolve / loadingFinished 过早），只拿到片段
//   3. 直接读 DOM                    → 依赖页面渲染；DeepSeek 代码块渲染偶发失败（<pre> 空白），内容会丢
//   4. 当前（最终）：SSE 主捕获      → 完整回复就在 /api/v0/chat/completion 的 HTTP 流式响应里！
//       真实格式（用户提供 2026-08-20）：
//         - 增量式 delta：data: {"v":"字"} 每帧一个字符/词，需全部拼接
//         - 分片结构：fragments[] 含 THINK(思考) 与 RESPONSE(回答)；RESPONSE 分片创建后的增量才是回答
//         - 结束信号：data: {"p":"response/status","o":"SET","v":"FINISHED"} 或 event: close
//       捕获：Network.dataReceived 累积全部数据块 → 检测 FINISHED → 解析出完整 content（含代码）
//       DOM 轮询仅作为兜底（若请求不走 HTTP SSE / dataReceived 无 data 字段时）
//
// 职责：
//   1. CDP.List() 找到已打开的 chat.deepseek.com 页面并连接（target 级 client）
//   2. executeChat(sessionId, message)：输入 → 发送 → SSE 累积捕获（主）→ DOM 轮询（兜底）
//   3. Network 事件同时保留诊断日志（API请求 / 响应预览）
//
// 前置条件：Chrome 已用 --remote-debugging-port=9222 启动，且 DeepSeek 页面已登录。

const CDP = require('chrome-remote-interface');

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const RESPONSE_TIMEOUT = Number(process.env.RESPONSE_TIMEOUT || 60000);
const STABLE_MS = Number(process.env.STABLE_MS || 3000); // DOM 兜底时的静默稳定窗口
const DEEPSEEK_URL_MATCH = /deepseek\.com/;
const API_PATH_MATCH = /chat\.deepseek\.com\/api/i;
const COMPLETION_PATH = '/api/v0/chat/completion';

// 助手回复正文的选择器（DOM 兜底用；探针实测 2026-08-20）
const ASSISTANT_CONTENT_SELECTOR =
  'div.ds-assistant-message-main-content, div[class*="assistant-message-main-content"]';

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
  }

  async connect() {
    let targets;
    try {
      targets = await CDP.List({ port: CDP_PORT });
    } catch (e) {
      throw new Error(
        `无法连接 Chrome 调试端口 ${CDP_PORT}：${e.message}。请确认 Chrome 已用 --remote-debugging-port=${CDP_PORT} 启动`
      );
    }

    const page = targets.find((t) => t.type === 'page' && DEEPSEEK_URL_MATCH.test(t.url));
    if (!page) {
      const pages = targets.filter((t) => t.type === 'page').map((t) => t.url).join(' | ') || '（无页面）';
      throw new Error(`未找到 DeepSeek 页面。请先在 Chrome 中打开并登录 https://chat.deepseek.com。当前页面：${pages}`);
    }

    this.client = await CDP({ target: page, port: CDP_PORT });
    const { Network, Page, Runtime, DOM } = this.client;

    await Promise.all([Network.enable(), Page.enable(), Runtime.enable(), DOM.enable()]);

    // 请求标记：识别 completion 请求，更新 API 活动时间（SPA 就绪判定）
    Network.requestWillBeSent((params) => {
      const url = (params.request && params.request.url) || '';
      if (API_PATH_MATCH.test(url)) {
        console.log(`[cdp] API请求: ${url}`);
        this.taggedRequests.add(params.requestId);
        this.lastApiActivity = Date.now();
        if (url.indexOf(COMPLETION_PATH) !== -1 && this.activeSSE && !this.activeSSE.done) {
          this.completionRid = params.requestId;
          this.sseAccum = ''; // 新会话请求到来，重置累积
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

    // 关键修复（2026-08-23）：启动时立即新建一个「干净」DeepSeek 会话，
    // 绝不沿用用户手动打开的、可能含无关历史的会话（如 562200df「优先使用工具」等测试对话）。
    // 否则那些历史会被 DeepSeek 当成上下文续写，导致回答被污染（例如吐出与 AskUserQuestion 相关的胡话）。
    // 用户原有的历史对话不会丢失（仅新建一个空白会话），属非破坏性操作。best-effort：失败仅告警。
    try {
      await this.newSession();
      const fresh = await this.evalJS('location.href');
      console.log(`[cdp] 已为桥创建干净会话（脱离手动历史）: ${fresh}`);
    } catch (e) {
      console.warn(`[cdp] 启动时新建干净会话失败（忽略，沿用当前会话）: ${e.message}`);
    }

    return this.client;
  }

  async ensureConnected() {
    if (this.connected && this.client) return;
    await this.connect();
  }

  // —— 主流程：SSE 捕获 + DOM 兜底 ——
  async executeChat(sessionId, message, opts = {}) {
    await this.ensureConnected();
    if (opts.newSession) await this.newSession();

    const url = await this.evalJS('location.href');
    const snap = await this.snapshotAssistant();
    // 边界：页面停在根路径(URL 为 / 且无任何消息)时，直接发送会因会话未创建而丢失消息
    if (!opts.newSession && snap.count === 0 && /^https?:\/\/chat\.deepseek\.com\/?$/.test(url)) {
      console.log('[cdp] 检测到根路径无会话，自动创建会话页后发送');
      await this.newSession();
    }

    // 按模型名称尽力切换网页模式（深度思考 / 联网搜索）—— 失败不阻断发送
    if (opts.model) await this.applyModelHint(opts.model);

    // 启动 SSE 捕获（发送前开启监听，发送后 completion 请求到来即被捕获）
    const ssePromise = this.startSSECapture(sessionId, opts.onProgress, RESPONSE_TIMEOUT);
    await this.humanTypeAndSend(message);
    const sseContent = await ssePromise;

    if (sseContent) {
      console.log(`[cdp] 会话 ${sessionId} 捕获到回复(SSE, ${sseContent.length}字)`);
      return { content: sseContent };
    }

    // SSE 未拿到 → DOM 轮询兜底
    console.warn('[cdp] SSE 捕获未完成，回退 DOM 轮询');
    const snap2 = await this.snapshotAssistant();
    const domContent = await this.waitForNewReply(snap2, RESPONSE_TIMEOUT, opts.onProgress);
    console.log(`[cdp] 会话 ${sessionId} 捕获到回复(DOM兜底, ${domContent.length}字)`);
    return { content: domContent };
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

  // 每收到一段 SSE 数据：尝试解析当前回答（流式推送增量）；检测 FINISHED 后结算
  onSSEChunk() {
    if (!this.activeSSE || this.activeSSE.done) return;
    const answer = parseCompletionSSE(this.sseAccum);
    // 流式增量推送
    if (this.activeSSE.onProgress && answer && answer.length > this.sseLastAnswer.length) {
      this.activeSSE.onProgress(answer);
      this.sseLastAnswer = answer;
    }
    // 结束信号：FINISHED（status 或 quasi_status）或 event: close
    if (this.sseAccum.indexOf('FINISHED') !== -1 || this.sseAccum.indexOf('event: close') !== -1) {
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
    if (this.sseTimer) clearTimeout(this.sseTimer);
    resolve(content || null);
  }

  // 新建会话（API 优先，按钮/导航兜底）
  async newSession() {
    const before = await this.evalJS('location.href');
    try {
      const id = await this.createSessionViaAPI();
      if (id) {
        await this.client.Page.navigate({ url: `https://chat.deepseek.com/a/chat/s/${id}` });
        await this.waitPageReady();
        const after = await this.evalJS('location.href');
        console.log(`[cdp] 已新建会话(API): ${before} -> ${after}`);
        return;
      }
    } catch (e) {
      console.warn(`[cdp] API 创建会话失败，回退按钮方式: ${e.message}`);
    }

    // 按钮方式：点击"新建对话"按钮（DeepSeek 该按钮点击后跳到根路径=新对话）
    const ok = await this.clickNewChatButton();
    if (ok) {
      await this.waitPageReady();
      const after = await this.evalJS('location.href');
      console.log(`[cdp] 已新建会话(按钮): ${before} -> ${after}`);
      return;
    }
    // 兜底：直接导航到根路径
    await this.client.Page.navigate({ url: 'https://chat.deepseek.com/' });

    await this.waitPageReady();
    const after = await this.evalJS('location.href');
    console.log(`[cdp] 已新建会话(导航兜底): ${before} -> ${after}`);
  }

  // 点击"新建对话"按钮：DeepSeek 的按钮 class 为混淆名、无文字/aria 标签，无法用静态选择器定位。
  // 改为行为探测：遍历少量候选 [role="button"]，点哪个会让 URL 跳到根路径（/a/chat/s/ 消失）即命中。
  // 命中返回 true；点错（URL 未变，或变化但非根路径）则还原现场后继续尝试。
  async clickNewChatButton() {
    const candidates = [5, 2, 3, 4, 6, 7, 8];
    for (const idx of candidates) {
      const before = await this.evalJS('location.href');
      const clicked = await this.evalJS(
        `(() => { const b = Array.from(document.querySelectorAll('[role="button"]'))[${idx}]; if (b) { b.click(); return true; } return false; })()`
      );
      if (!clicked) continue;
      await sleep(1200);
      const after = await this.evalJS('location.href');
      if (after && !/chat\/s\//.test(after)) {
        // URL 跳到根路径（已离开旧会话 = 新对话），命中
        return true;
      }
      // 否则还原现场，尝试下一个候选
      if (after !== before) {
        try {
          await this.client.Page.navigate({ url: before });
          await sleep(800);
        } catch (_) {}
      }
    }
    return false;
  }

  // 按模型名称尽力切换网页模式（深度思考 R1 / 联网搜索）。
  // 纯尽力而为：找不到开关或点击失败都只记录警告，绝不阻断后续发送。
  // 规则：模型名含 reasoner/r1 → 打开 DeepThink；含 search/联网/online → 打开联网搜索；
  //       其余（chat/v3/coder/web）→ 关闭 DeepThink（保持默认对话模式）。
  async applyModelHint(model) {
    const m = String(model || '').toLowerCase();
    const wantThink = /reasoner|\br1\b|深度思考/.test(m);
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
        setToggle(findBtn(['deepthink', 'r1', '深度思考']), ${wantThink});
        setToggle(findBtn(['联网', '搜索', 'search']), ${wantSearch});
        return true;
      })()`);
      console.log(`[cdp] 已按模型 ${model} 设置网页模式(深度思考=${wantThink}, 联网搜索=${wantSearch}, 尽力而为)`);
    } catch (e) {
      console.warn(`[cdp] 模型模式切换失败(忽略，不影响发送): ${e.message}`);
    }
  }

  // 在页面上下文调用 DeepSeek 会话创建接口，返回新会话 id（失败返回 null）
  async createSessionViaAPI() {
    try {
      const raw = await this.evalJS(
        `(async () => {
          try {
            const resp = await fetch('/api/v0/chat_session/create', { method: 'POST' });
            const j = await resp.json();
            return JSON.stringify(j);
          } catch (e) { return JSON.stringify({ __err: String(e) }); }
        })()`,
        true
      );
      let j;
      try {
        j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (_) {
        return null;
      }
      // 裸 fetch 不带鉴权头（Missing Token / code!=0 等）→ 走按钮兜底，属预期，不报错
      if (!j || j.__err || (typeof j.code === 'number' && j.code !== 0)) return null;
      const id = j.data && j.data.biz_data && j.data.biz_data.chat_session && j.data.biz_data.chat_session.id;
      return typeof id === 'string' && id ? id : null;
    } catch (_) {
      return null;
    }
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
  async snapshotAssistant() {
    return this.evalJS(`(() => {
      const els = document.querySelectorAll('${ASSISTANT_CONTENT_SELECTOR}');
      return {
        count: els.length,
        last: els.length ? (els[els.length - 1].innerText || '').trim() : '',
      };
    })()`);
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
  async waitForNewReply(snap, timeoutMs, onProgress) {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 500;
    const { count: prevCount, last: prevText } = snap || {};
    let lastText = null;
    let stableSince = 0;

    while (Date.now() < deadline) {
      const res = await this.evalJS(`(() => {
        const els = document.querySelectorAll('${ASSISTANT_CONTENT_SELECTOR}');
        return {
          count: els.length,
          last: els.length ? (els[els.length - 1].innerText || '').trim() : '',
        };
      })()`);
      const text = (res && res.last) || '';
      const isNew = text && (res.count > prevCount || (prevText && text !== prevText));

      if (isNew) {
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
    // 关键修复：粘贴/注入后框架（React 等）需一小段时间提交状态，否则按钮仍 disabled、点击无效。
    const sent = await this.triggerSend();
    if (!sent) {
      throw new Error('未找到可用的发送方式（页面可能已变化或未在聊天页）');
    }
    console.log(`[cdp] 已触发发送 (${sent})`);
  }

  // 触发发送：粘贴/注入后，框架（React 等）需要一小段时间把内容提交到内部状态。
  // 在 maxWaitMs 预算内持续轮询：
  //   - 输入框已清空 → 视为发送成功
  //   - 内容已就绪（有文本且按钮可点）→ 按编辑器类型选择主路径：
  //       * TEXTAREA（如 DeepSeek 新版）：优先走 Enter 键（按钮点击常因 React 受控状态竞态失效）
  //       * contenteditable：优先走按钮点击
  //     主路径连续失败则自动切换另一种方式兜底，直到预算耗尽。
  async triggerSend(maxWaitMs = 4000, pollMs = 300) {
    const deadline = Date.now() + maxWaitMs;
    let clickTries = 0;
    let enterTries = 0;
    const clickSend = () =>
      this.evalJS(`(function () {
        var btns = Array.from(document.querySelectorAll('button'));
        for (var b of btns) {
          var label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
          if (/发送|send/i.test(label)) { b.click(); return; }
        }
        var sb = document.querySelector('button[data-testid*="send"]');
        if (sb) sb.click();
      })()`);
    while (Date.now() < deadline) {
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
          isTextarea: !!(el && el.tagName === 'TEXTAREA'),
        };
      })()`);
      if (st && st.empty) {
        console.log('[cdp] 输入框已清空，发送成功');
        return 'send';
      }
      if (st && st.ready) {
        if (st.isTextarea) {
          // TEXTAREA：优先 Enter（DeepSeek 以 Enter 提交、Shift+Enter 换行）
          if (enterTries < 2) {
            enterTries++;
            await this.enterFallback();
            console.log(`[cdp] 已通过 Enter 尝试发送（第 ${enterTries} 次）`);
            await sleep(700);
            continue;
          }
          if (clickTries < 2) {
            clickTries++;
            await clickSend();
            console.log(`[cdp] Enter 未生效，改点击发送（第 ${clickTries} 次）`);
            await sleep(800);
            continue;
          }
        } else {
          // contenteditable：优先按钮点击
          if (clickTries < 3) {
            clickTries++;
            await clickSend();
            console.log(`[cdp] 已点击发送（第 ${clickTries} 次尝试）`);
            await sleep(800);
            continue;
          }
          if (enterTries < 2) {
            enterTries++;
            await this.enterFallback();
            console.log(`[cdp] 点击未生效，改 Enter 发送（第 ${enterTries} 次）`);
            await sleep(700);
            continue;
          }
        }
      }
      // 内容未就绪（输入框空 / 按钮 disabled）→ 继续等待框架提交状态
      await sleep(pollMs);
    }
    // 预算耗尽：强制一次 Enter 作为最终兜底
    console.log('[cdp] 预算内提交未成功，强制回退 Enter 键');
    await this.enterFallback();
    await sleep(700);
    return 'enter';
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
  // 速度远快于逐字（1 次 CDP 往返、无逐字 sleep），且不会在粘贴后又被二次录入。
  // 写入后仅校验「文本已进 DOM」，发送按钮是否启用交给 triggerSend 的 3 秒窗口处理。
  async injectText(text) {
    const t = String(text == null ? '' : text);
    if (!t) return; // 空消息无需写入
    const textArg = JSON.stringify(t); // 独立序列化，避免模板字面量被消息中的反引号破坏
    const expr =
      `(async function (text) {
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
        await new Promise(function (r) { setTimeout(r, 50); });
        return { ok: curText(el).length >= text.length, finalLen: curText(el).length, wantLen: text.length };
      })(` + textArg + `)`;

    const res = await this.evalJS(expr, true);

    if (!res || res.ok === false) {
      const want = (res && res.wantLen) || t.length;
      const got = (res && res.finalLen) || 0;
      throw new Error(`写入文本失败（${res ? res.reason || 'insert-failed' : 'no-result'}，期望 ${want} 字，实际 ${got} 字）`);
    }
    if (res.finalLen < res.wantLen) {
      console.warn(`[cdp] ⚠️ 文本可能未完整写入：期望 ${res.wantLen} 字，实际 ${res.finalLen} 字`);
    }
    console.log(`[cdp] 已写入文本（一次性写入，${res.finalLen}/${res.wantLen} 字）`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =====================================================================
// DeepSeek completion SSE 解析（增量式 + 分片结构，实测格式 2026-08-20）：
//   data: {"v":{"response":{...,"fragments":[{"id":N,"type":"THINK|RESPONSE","content":"..."}]}}}
//   data: {"p":"response/fragments","o":"APPEND","v":[{"id":N,"type":"RESPONSE","content":"..."}]}
//   data: {"p":"response/fragments/-1/content","o":"APPEND","v":"增量文本"}  ← 之后纯 {"v":"..."} 沿用该 path
//   data: {"v":"字符增量"}      ← RESPONSE 分片创建后的 v 字符串为回答增量
//   data: {"p":"response/status","o":"SET","v":"FINISHED"}   /   event: close
// 提取规则：RESPONSE 分片创建后的所有字符串 v 增量拼接 = 最终回答（自动排除 THINK 思考内容）。
// =====================================================================
function parseCompletionSSE(body) {
  if (!body) return null;
  let answer = '';
  let inResponse = false;
  const snapshots = []; // 快照帧中的 RESPONSE content（取最长作保险）

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

      // 快照帧：v.response.fragments（记录 RESPONSE content 作为保险）
      const vr = j.v && j.v.response;
      if (vr && Array.isArray(vr.fragments)) {
        const respFrag = vr.fragments
          .filter((f) => f && f.type === 'RESPONSE' && typeof f.content === 'string')
          .map((f) => f.content)
          .join('');
        if (respFrag) snapshots.push(respFrag);
        continue;
      }

      // RESPONSE 分片创建：标记进入回答段，并拼上初始 content
      if (j.p === 'response/fragments' && j.o === 'APPEND' && Array.isArray(j.v)) {
        for (const f of j.v) {
          if (f && f.type === 'RESPONSE' && typeof f.content === 'string') {
            inResponse = true;
            answer += f.content;
          }
        }
        continue;
      }

      // 增量：RESPONSE 段内的字符串 v 直接拼接（排除 FINISHED 等状态标记）
      if (inResponse && typeof j.v === 'string' && j.v && j.v !== 'FINISHED') {
        answer += j.v;
      }
    }
  }

  // 快照取长（保险：某些情况下页面最后发完整快照）
  if (snapshots.length) {
    const longest = snapshots.reduce((a, b) => (b.length > a.length ? b : a), '');
    if (longest.length > answer.length) answer = longest;
  }
  return answer || null;
}

module.exports = new CDPController();
// 导出解析函数便于单测
module.exports.parseCompletionSSE = parseCompletionSSE;
