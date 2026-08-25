// api-server.js —— Qwen AI 网页版 CDP 桥 · API 服务器
//
// 提供 OpenAI/DeepSeek 标准兼容接口：
//   POST /v1/chat/completions   （标准格式，OpenAI SDK / DSH / OpenWebUI 等可直接接入）
//   POST /chat/completions      （同上，无 /v1 前缀的别名）
//   POST /chat                  （旧版简单接口，向后兼容）
//
// 闭环：请求入队（串行） → CDP 控制器在已登录的 chat.qwen.ai 页面输入并发送
//       → Network 层 SSE 捕获完整回复（主）/ DOM 轮询（兜底）→ 按 OpenAI 格式返回（支持 stream SSE 增量）
//
// 启动：
//   1. 先启动 Chrome：chrome --remote-debugging-port=9222 --user-data-dir=%TEMP%\chrome-debug
//   2. 在 Chrome 中打开 https://chat.qwen.ai 并登录（保持窗口打开）
//   3. node api-server.js   （或 npm start）
//
// 环境变量：
//   CDP_PORT=9222           Chrome 调试端口（与 deepseek-cdp-bridge 共用同一 Chrome 也可，两桥互不干扰）
//   API_PORT=3001           本服务端口（默认 3001，避免与 deepseek 桥的 3000 冲突）
//   RESPONSE_TIMEOUT=60000  单次请求超时（毫秒）
//   QWEN_SELECTOR=...       DOM 兜底选择器覆盖（逗号分隔的 CSS 选择器）

const express = require('express');
const cdp = require('./cdp-controller');
const models = require('./models');
const tooluse = require('./tooluse');

const PORT = Number(process.env.API_PORT || 3001);

const app = express();
app.use(express.json({ limit: '1mb' }));

// —— CORS：允许浏览器前端跨源调用（前端 JS 直接 fetch /v1/chat/completions 时，
//          浏览器先发 OPTIONS 预检；未配置 CORS 头会报"跨域"错误）——
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-session-id');
  res.setHeader('Access-Control-Max-Age', '86400'); // 预检结果缓存 24h，减少 OPTIONS 次数
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204); // 预检直接通过
  }
  next();
});

function genSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// —— OpenAI 标准错误结构 ——
function sendOpenAIError(res, status, type, message, code) {
  return res.status(status).json({ error: { message, type, code: code || 'error' } });
}

// —— 会话控制：只有显式字段或 NEW.TOPIC 指令才新建会话 ——
// 2026-08-21 调整：**取消"客户端换 session_id 即自动新建页面会话"**（原自动检测已移除）。
// 理由：OpenAI 兼容客户端（OpenWebUI / DSH 等）点"新会话"时天然会换 session_id，
// 若每次切换都自动开新网页会话，网页侧会堆积大量空会话并丢失上下文。
// 现在新建会话只有两种途径：
//   1. 显式字段：请求体 `new_session: true`；
//   2. 控制指令：最后一条用户消息内容为 "NEW.TOPIC"（大小写/空白/点号宽松匹配）。
// explicit 为请求体里的 new_session 字段（undefined 表示未声明）。
function decideNewSession(explicit) {
  return explicit === true; // 仅显式强制新建；默认一律不自动新建
}

// —— NEW.TOPIC 控制指令 ——
// 归一化：去除所有空白与点号并转大写，稳定匹配 "NEW.TOPIC" / "new topic" / "NEW TOPIC" 等变体
function normalizeTopicText(s) {
  return String(s || '').replace(/\s+/g, '').replace(/\./g, '').toUpperCase();
}

// 检测最后一条用户消息是否就是 NEW.TOPIC 控制指令（独立回合，不转发给网页模型）。
// 只识别「最后一次用户消息」：历史里的旧 NEW.TOPIC 不触发，与 HI,TOOLS 的识别规则一致。
function isNewTopicCommand(messages) {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') {
      return normalizeTopicText(m.content) === 'NEWTOPIC';
    }
  }
  return false;
}

// —— 待执行队列：CDP 串行执行，一次只处理一个会话，防止页面上下文串话 ——
const queue = [];
let processing = false;

function enqueue(fn) {
  queue.push(fn);
  if (!processing) void processQueue();
}

async function processQueue() {
  processing = true;
  while (queue.length) {
    const fn = queue.shift();
    try {
      await fn();
    } catch (e) {
      console.error('[queue] 任务异常:', e.message);
    }
  }
  processing = false;
}

// =====================================================================
// OpenAI / DeepSeek 标准接口：POST /v1/chat/completions（及 /chat/completions）
// =====================================================================
async function handleCompletions(req, res) {
  const body = req.body || {};
  const { model = models.DEFAULT_MODEL, messages, stream = false, new_session = false,
          tools, tool_choice } = body;

  // —— 模型路由：把客户端传入的 model 名称解析到后端（内置 qwen-web + 常用别名）。
  //    注意：路由表只是"配置方便"，不是白名单限制——任何未知 model 名称都放行，
  //    一律路由到默认后端（qwen-web），原样回显请求名（resolveModel 恒返回 ok:true）。——
  const route = models.resolveModel(model);
  // 对外回显的模型名：原样回显客户端请求的型号（未知型号也照此回显，不报错）。
  // 未知型号提示一次（仅日志，不影响请求）。
  if (!route.isKnown) {
    console.warn(`[api] 收到未知模型 "${model}"，已路由至默认后端 ${route.id}（不做白名单限制）`);
  }
  const modelOut = route.requested;

  if (!Array.isArray(messages) || messages.length === 0) {
    return sendOpenAIError(res, 400, 'invalid_request_error', 'messages 必须是非空数组', 'invalid_messages');
  }

  // —— WorkBuddy 专有格式解析（2026-08-21）——
  // WorkBuddy 客户端在 user 消息中总是附带系统提示词，真实用户消息由 <user_query>...</user_query>
  // 标签包裹。除 HI,TOOLS 指令回合（注入工具系统提示词）外，其余情况**只把 <user_query> 内的
  // 真实消息传给网页模型**（不带客户端附加的系统提示词、不带标签本身）；特殊指令
  // （NEW.TOPIC / HI,TOOLS）也优先在提取后的真实消息上解析。无标签的普通客户端不受影响。
  const cleanMessages = messages.map((m) => {
    if (m && m.role === 'user' && typeof m.content === 'string') {
      return { ...m, content: tooluse.extractUserQuery(m.content) };
    }
    return m;
  });

  // 会话 id：优先用客户端显式传入的 session_id（用于系统提示词注入归属），否则服务端生成
  const hasClientSessionId = typeof body.session_id === 'string' && body.session_id.length > 0;
  const sessionId = hasClientSessionId ? body.session_id : genSessionId();
  // 新建会话决策：仅显式 new_session 字段触发（session_id 变化自动检测已取消，见 decideNewSession）
  const newSession = decideNewSession(body.new_session);

  // —— NEW.TOPIC 控制指令：独立回合新建会话（不转发给网页模型）——
  // 识别到即入队新建会话（fire-and-forget，立即回 NEW.TOPIC 确认）；下一条消息在队列中排在新建之后，
  // 天然落在新会话里，无需客户端等待。与 HI,TOOLS 握手机制同模式。
  if (isNewTopicCommand(cleanMessages)) {
    enqueue(async () => {
      try {
        await cdp.newSession();
        console.log(`[api] NEW.TOPIC 指令：已新建网页会话（sessionId=${sessionId}）`);
      } catch (e) {
        console.warn(`[api] NEW.TOPIC 新建会话失败: ${e.message}`);
      }
    });
    return sendNewTopicAck(res, modelOut, sessionId, stream);
  }

  // —— 工具系统提示词按需注入（HI,TOOLS 会话级一次性）——
  // 识别到指令 "HI,TOOLS" → **向网页发送 "HI" 消息代替客户端的 "HI,TOOLS" 文本**：
  // 首次（带 tools）时把系统提示词一并附在 "HI" 前发给网页（系统提示词 + "HI"），
  // 此后本会话一直不再带系统提示词发送；未发过该指令的会话则一直不发送系统提示词。
  // 2026-08-21 调整：该回合**不再由服务器伪造 "HI" ACK 返回客户端**，而是把 "HI"
  // （含系统提示词）真正发给网页，并将**网页的真实回复**返回给客户端（流式按增量推送）——
  // 指令本身只负责触发系统提示词添加。同一会话重复 HI,TOOLS 只发 "HI" 不带提示词。
  if (tooluse.detectToolArm(cleanMessages)) {
    const toolsOk = Array.isArray(tools) && tools.length > 0 && tool_choice !== 'none';
    const firstTime = !tooluse.isPromptInjected(sessionId);
    let handshake;
    if (toolsOk && firstTime) {
      tooluse.markPromptInjected(sessionId);
      const instruction = tooluse.buildToolInstruction(tools, tool_choice);
      handshake = instruction ? `${instruction}\n\nHI` : 'HI';
    } else {
      handshake = 'HI'; // 同会话重复 HI,TOOLS：仅发 "HI"，不再带系统提示词
    }
    const handshakeOpts = { newSession, model: route.requested };
    enqueue(async () => {
      try {
        if (stream) {
          // 流式：把网页对 "HI" 的回复按 SSE 增量实时推给客户端
          await handleStreaming(req, res, { model: modelOut, sessionId, message: handshake, opts: handshakeOpts });
        } else {
          const result = await cdp.executeChat(sessionId, handshake, handshakeOpts);
          res.json(buildCompletion(modelOut, sessionId, handshake, result.content));
        }
        console.log(`[api] HI,TOOLS 已发给网页会话 ${sessionId}：${handshake === 'HI' ? '仅 HI（无系统提示词）' : `系统提示词(1次)+HI，工具 ${tools.length} 个`}，网页回复已返回客户端`);
      } catch (err) {
        console.error(`[api] HI,TOOLS 会话 ${sessionId} 失败: ${err.message}`);
        if (res.headersSent) {
          res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error', code: 'cdp_error' } })}\n\n`);
          res.end();
        } else {
          sendOpenAIError(res, 500, 'server_error', err.message, 'cdp_error');
        }
      }
    });
    return;
  }

  // 工具调用模式：tools 非空。注意：**这里不再注入**工具系统提示词——它只在
  // HI,TOOLS 回合注入过一次（留在网页会话历史中）；未发过 HI,TOOLS 的会话按普通问答处理。
  const toolMode = Array.isArray(tools) && tools.length > 0;

  // 计算要键入页面的文本（outgoing）
  let outgoing;
  if (toolMode) {
    const last = cleanMessages[cleanMessages.length - 1];
    if (last && last.role === 'tool') {
      // 上一轮工具结果回传：标注后键入页面，供模型继续
      const tname = tooluse.resolveToolName(cleanMessages, last.tool_call_id);
      const tcontent = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      outgoing = `【工具「${tname}」的返回结果如下，请据此继续完成任务】\n${tcontent}`;
    } else {
      const u = [...cleanMessages].reverse().find(
        (m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()
      );
      if (!u) {
        return sendOpenAIError(res, 400, 'invalid_request_error', 'tools 模式下缺少有效的 user 消息', 'missing_user_message');
      }
      outgoing = u.content;
    }
  } else {
    // 取最后一条 user 消息作为发送内容（system 等角色会被忽略——网页版有自身预设）
    const lastUser = [...cleanMessages].reverse().find((m) => m && (m.role === 'user' || m.content));
    if (!lastUser || typeof lastUser.content !== 'string' || !lastUser.content.trim()) {
      return sendOpenAIError(res, 400, 'invalid_request_error', 'messages 中缺少有效的 user 消息', 'missing_user_message');
    }
    outgoing = lastUser.content;
  }

  const opts = { newSession, model: route.requested }; // 透传原始请求型号名，供后端按名称关键词（thinking/search）尽力切换网页模式

  console.log(
    `[api] 收到请求(${stream ? 'stream' : 'json'}) sessionId=${sessionId}` +
    ` model=${modelOut}${route.isAlias ? '(别名)' : ''}${!route.isKnown ? '(未知→默认后端)' : ''}` +
    `${toolMode ? ` [tools:${tools.length}${tool_choice ? ',choice=' + JSON.stringify(tool_choice) : ''}]` : ''}` +
    ` new_session=${newSession}`
  );

  enqueue(async () => {
    try {
      if (toolMode) {
        if (stream) {
          // 流式工具模式：正文实时吐出，工具调用块闭合后才 flush（详见 streamToolMode）
          await streamToolMode(res, modelOut, sessionId, outgoing, opts);
        } else {
          const result = await cdp.executeChat(sessionId, outgoing, opts);
          // parseToolOutput 同时返回 正文(content) 与 tool_calls，二者可共存（修复旧版 XOR bug）
          const parsed = tooluse.parseToolOutput(result.content);
          if (parsed.toolCalls.length) {
            res.json(buildToolCallCompletion(modelOut, sessionId, parsed.toolCalls, parsed.text));
          } else {
            res.json(buildCompletion(modelOut, sessionId, outgoing, parsed.text || ''));
          }
        }
      } else if (stream) {
        await handleStreaming(req, res, { model: modelOut, sessionId, message: outgoing, opts });
      } else {
        const result = await cdp.executeChat(sessionId, outgoing, opts);
        // 无条件转换（2026-08-25）：即使请求未带 tools，只要 content 含 DSML 工具块
        // 就解析为 tool_calls（正文与 tool_calls 可共存）；无工具块则按原始文本返回
        // （不用 parsed.text——cleanDsmlText 会 trim 首尾空白，破坏纯文本保真）。
        const parsed = tooluse.parseToolOutput(result.content);
        if (parsed.toolCalls.length) {
          res.json(buildToolCallCompletion(modelOut, sessionId, parsed.toolCalls, parsed.text));
        } else {
          res.json(buildCompletion(modelOut, sessionId, outgoing, result.content));
        }
      }
    } catch (err) {
      console.error(`[api] sessionId=${sessionId} 失败: ${err.message}`);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error', code: 'cdp_error' } })}\n\n`);
        res.end();
      } else {
        sendOpenAIError(res, 500, 'server_error', err.message, 'cdp_error');
      }
    }
  });
}

// 构造 OpenAI 标准非流式响应
function buildCompletion(model, sessionId, prompt, content) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-${sessionId}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    // token 估算值（网页版不返回真实用量；中文字符粗略按 1 字符 ≈ 1 token）
    usage: {
      prompt_tokens: Math.max(1, Math.ceil(prompt.length / 1.5)),
      completion_tokens: Math.max(1, Math.ceil(content.length / 1.5)),
      total_tokens: Math.max(2, Math.ceil((prompt.length + content.length) / 1.5)),
    },
  };
}

// =====================================================================
// SSE 心跳保活（2026-08-25）
// 网页端回复量大又慢（深度思考阶段可能几十秒无文本增量），而 SSE 连接
// 空闲超过 30~60 秒时，中间代理（Nginx/企业网关）或客户端会掐断连接，
// 表现为「网页端还在生成，客户端却已超时断开 / 报 10000 无响应」。
// 方案：定时发送 SSE 注释帧（": keep-alive"）——标准 EventSource 忽略
// 注释行（不触发 message 事件），仅用于维持 TCP/HTTP 连接活跃；配合
// 响应头 X-Accel-Buffering: no 禁用 Nginx 等代理的响应缓冲（否则代理
// 会把整个 SSE 缓冲到响应结束才转发，SSE 增量形同虚设）。
// =====================================================================
function startSSEKeepAlive(res, intervalMs = 15000) {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) { clearInterval(timer); return; }
    try { res.write(': keep-alive\n\n'); } catch (_) { clearInterval(timer); }
  }, Math.max(1000, intervalMs));
  res.once('close', () => clearInterval(timer));
  return timer;
}

// NEW.TOPIC 控制指令的确认响应：桥接层已入队新建网页会话（fire-and-forget），
// 这里回一个 OpenAI 标准完成（或 SSE），正文回显 "NEW.TOPIC"，客户端据此确认指令已受理。
function sendNewTopicAck(res, model, sessionId, stream) {
  const ack = 'NEW.TOPIC';
  if (stream) {
    const created = Math.floor(Date.now() / 1000);
    const chatId = `chatcmpl-${sessionId}`;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    startSSEKeepAlive(res);
    res.write(
      `data: ${JSON.stringify({
        id: chatId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant', content: ack }, finish_reason: null }],
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id: chatId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`
    );
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  return res.json(buildCompletion(model, sessionId, '', ack));
}

// —— 工具调用（tool_calls）相关构造 ——

// 构造 OpenAI 标准非流式「工具调用」响应
// 注意：content 与 tool_calls 可共存（模型先说一句再调工具时，正文也会被保留返回）
function buildToolCallCompletion(model, sessionId, calls, text) {
  const created = Math.floor(Date.now() / 1000);
  const content = typeof text === 'string' ? text : '';
  // 诊断日志（2026-08-25）：发出前检查每个 tool_calls 的参数类型，便于复现
  // "questions expected array, received string" 类问题时从日志定位真实参数形态。
  if (Array.isArray(calls) && calls.length) {
    for (const c of calls) {
      try {
        const raw = (c.function && c.function.arguments) || '';
        const parsed = JSON.parse(raw);
        const summary = {};
        for (const k of Object.keys(parsed)) {
          const val = parsed[k];
          summary[k] = Array.isArray(val) ? 'array(' + val.length + ')' : (val === null ? 'null' : typeof val);
        }
        console.log(`[api] tool_calls → ${c.function.name} 参数类型: ${JSON.stringify(summary)}`);
      } catch (e) {
        console.warn(`[api] tool_calls ${c.function.name} 参数 JSON 解析失败: ${e.message.slice(0, 80)}`);
      }
    }
  }
  return {
    id: `chatcmpl-${sessionId}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: content || null, tool_calls: calls },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: Math.max(1, Math.ceil((content.length + 1) / 1.5)),
      completion_tokens: Math.max(1, Math.ceil(content.length / 1.5)),
      total_tokens: Math.max(2, Math.ceil((content.length * 2 + 1) / 1.5)),
    },
  };
}

// 流式输出：纯文本回复（把最终完整内容切片回放为 SSE 增量）
async function streamContent(res, model, sessionId, content) {
  const created = Math.floor(Date.now() / 1000);
  const chatId = `chatcmpl-${sessionId}`;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  startSSEKeepAlive(res);
  res.write(
    `data: ${JSON.stringify({
      id: chatId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })}\n\n`
  );
  const text = typeof content === 'string' ? content : '';
  const CHUNK = 24;
  for (let i = 0; i < text.length; i += CHUNK) {
    res.write(
      `data: ${JSON.stringify({
        id: chatId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { content: text.slice(i, i + CHUNK) }, finish_reason: null }],
      })}\n\n`
    );
  }
  res.write(
    `data: ${JSON.stringify({
      id: chatId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

// 流式输出：工具调用（role 帧 → 各 tool_call 帧 → 结束帧 → [DONE]）
// 流式工具模式：接入 ToolStreamSieve，实时分离正文与工具调用。
// 正文增量立即以 delta.content 帧吐出；工具调用块闭合后才以 delta.tool_calls 帧 flush。
async function streamToolMode(res, model, sessionId, message, opts) {
  const created = Math.floor(Date.now() / 1000);
  const chatId = `chatcmpl-${sessionId}`;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  startSSEKeepAlive(res);

  // 首个 chunk：声明 assistant 角色
  res.write(
    `data: ${JSON.stringify({
      id: chatId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })}\n\n`
  );

  const sieve = new tooluse.ToolStreamSieve((buf) => tooluse.parseToolOutput(buf));
  const state = { hasToolCalls: false };
  let lastLen = 0;

  const onProgress = (answer) => {
    if (typeof answer !== 'string') return;
    if (answer.length > lastLen) {
      const delta = answer.slice(lastLen);
      lastLen = answer.length;
      emitSieveEvents(res, model, chatId, created, sieve.feed(delta), state);
    }
  };

  const result = await cdp.executeChat(sessionId, message, { ...opts, onProgress });

  // 补齐：确保最终完整内容的尾部也推进了筛分器（避免 onProgress 未推送最后一截）
  const finalText = (result && result.content) || '';
  if (finalText.length > lastLen) {
    emitSieveEvents(res, model, chatId, created, sieve.feed(finalText.slice(lastLen)), state);
    lastLen = finalText.length;
  }
  // 收尾：flush 剩余 pending / 未闭合捕获区
  emitSieveEvents(res, model, chatId, created, sieve.flush(), state);

  // 结束帧
  res.write(
    `data: ${JSON.stringify({
      id: chatId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: state.hasToolCalls ? 'tool_calls' : 'stop' }],
    })}\n\n`
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

// 把筛分器产生的事件写成 SSE 帧
function emitSieveEvents(res, model, chatId, created, events, state) {
  for (const ev of events) {
    if (ev.type === 'text' && ev.data) {
      res.write(
        `data: ${JSON.stringify({
          id: chatId, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: ev.data }, finish_reason: null }],
        })}\n\n`
      );
    } else if (ev.type === 'tool_calls' && ev.data && ev.data.length) {
      state.hasToolCalls = true;
      // 诊断日志（2026-08-25）：流式发出前检查参数类型（与 buildToolCallCompletion 一致）
      try {
        const c0 = ev.data[0];
        const parsed = JSON.parse((c0.function && c0.function.arguments) || '{}');
        const summary = {};
        for (const k of Object.keys(parsed)) {
          const val = parsed[k];
          summary[k] = Array.isArray(val) ? 'array(' + val.length + ')' : (val === null ? 'null' : typeof val);
        }
        console.log(`[api] sieve → ${c0.function.name} 参数类型: ${JSON.stringify(summary)}`);
      } catch (e) {
        console.warn(`[api] sieve tool_calls 参数 JSON 解析失败: ${e.message.slice(0, 80)}`);
      }
      ev.data.forEach((c, i) => {
        res.write(
          `data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i, id: c.id, type: 'function',
                  function: { name: c.function.name, arguments: c.function.arguments },
                }],
              },
              finish_reason: null,
            }],
          })}\n\n`
        );
      });
    }
  }
}

// SSE 流式：DOM 轮询每次检测到文本增长 → 推送 delta 增量帧 → 结束帧 → [DONE]
// 2026-08-25 改造：**无条件转换**——无论请求是否携带 tools 参数，只要内容里出现
// DSML 工具调用块（<|DSML|tool_calls>…），一律通过 ToolStreamSieve 转成 OpenAI
// tool_calls 事件；纯文本照常增量透传。此前无 tools 请求走纯文本透传，DSML 块被
// 当普通正文发给客户端（前端收不到工具调用），违背"透明管道无条件转换"的约定。
async function handleStreaming(req, res, { model, sessionId, message, opts }) {
  const created = Math.floor(Date.now() / 1000);
  const chatId = `chatcmpl-${sessionId}`;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  startSSEKeepAlive(res);

  // 首个 chunk：声明 assistant 角色
  res.write(
    `data: ${JSON.stringify({
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })}\n\n`
  );

  // 无条件转换：正文实时吐出；工具调用块闭合后才 flush 为 tool_calls 事件
  const sieve = new tooluse.ToolStreamSieve((buf) => tooluse.parseToolOutput(buf));
  const state = { hasToolCalls: false };
  let lastLen = 0;

  const onProgress = (answer) => {
    if (typeof answer !== 'string') return;
    if (answer.length > lastLen) {
      const delta = answer.slice(lastLen);
      lastLen = answer.length;
      emitSieveEvents(res, model, chatId, created, sieve.feed(delta), state);
    }
  };

  const result = await cdp.executeChat(sessionId, message, { ...opts, onProgress });

  // 补齐：确保最终完整内容的尾部也推进了筛分器（避免 onProgress 未推送最后一截）
  const finalText = (result && result.content) || '';
  if (finalText.length > lastLen) {
    emitSieveEvents(res, model, chatId, created, sieve.feed(finalText.slice(lastLen)), state);
    lastLen = finalText.length;
  }
  // 收尾：flush 剩余 pending / 未闭合捕获区
  emitSieveEvents(res, model, chatId, created, sieve.flush(), state);

  // 结束帧
  res.write(
    `data: ${JSON.stringify({
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: state.hasToolCalls ? 'tool_calls' : 'stop' }],
    })}\n\n`
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

// 注册标准端点（同时支持 /v1 前缀与无前缀）
app.post(['/v1/chat/completions', '/chat/completions'], handleCompletions);

// =====================================================================
// OpenAI 标准模型列表：GET /v1/models（及 /models 别名）
// 返回本服务支持的全部模型（内置 qwen-web + 常用别名）
// =====================================================================
app.get(['/v1/models', '/models'], (req, res) => {
  res.json(models.listModels());
});

// =====================================================================
// 旧版简单接口（向后兼容）：POST /chat  {"message":"...","sessionId":"..."}
// =====================================================================
app.post('/chat', (req, res) => {
  const body = req.body || {};
  const { message } = body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ success: false, error: 'message 必填且为字符串' });
  }
  const hasClientSessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0;
  const sessionId = hasClientSessionId ? body.sessionId : genSessionId();
  const newSession = decideNewSession(body.newSession);
  // WorkBuddy 专有格式：只取 <user_query> 内的真实消息（指令检测与发送都用真实消息）
  const realMessage = tooluse.extractUserQuery(message);
  console.log(`[api] 收到请求(legacy /chat) sessionId=${sessionId} newSession=${newSession}`);

  // NEW.TOPIC 控制指令：入队新建会话并回确认（不转发给网页模型）
  if (normalizeTopicText(realMessage) === 'NEWTOPIC') {
    enqueue(async () => {
      try {
        await cdp.newSession();
        console.log(`[api] NEW.TOPIC 指令：已新建网页会话（sessionId=${sessionId}）`);
      } catch (e) {
        console.warn(`[api] NEW.TOPIC 新建会话失败: ${e.message}`);
      }
    });
    return res.json({
      success: true,
      sessionId,
      content: 'NEW.TOPIC',
      newSession: true,
      timestamp: new Date().toISOString(),
    });
  }

  enqueue(() => runChat(sessionId, realMessage, res, { newSession }));
});

async function runChat(sessionId, message, res, opts) {
  try {
    const result = await cdp.executeChat(sessionId, message, opts);
    res.json({
      success: true,
      sessionId,
      content: result.content,
      newSession: !!(opts && opts.newSession),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[api] sessionId=${sessionId} 失败: ${err.message}`);
    res.status(500).json({ success: false, sessionId, error: err.message });
  }
}

// 全局错误处理：JSON 解析失败（Windows 引号踩坑）返回 OpenAI 标准错误格式
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return sendOpenAIError(
      res,
      400,
      'invalid_request_error',
      '请求体不是合法 JSON：' + err.message +
      '。Windows 下请避免用单引号包裹 JSON：① Git Bash 中运行；' +
      '② PowerShell 用 curl.exe 配合 --% 停止解析（例：curl.exe --% -X POST http://localhost:3001/v1/chat/completions -H "Content-Type: application/json" -d "{\\"model\\":\\"qwen-web\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"你好\\"}]}"）；' +
      '③ 或把 JSON 写入 body.json 后用 -d @body.json',
      'json_parse_error'
    );
  }
  next(err);
});

app.listen(PORT, async () => {
  console.log(`[api] Qwen AI CDP Bridge 服务启动: http://localhost:${PORT}`);
  console.log(`[api] OpenAI 兼容端点: POST /v1/chat/completions`);
  console.log(`[api] 模型列表端点: GET /v1/models  （内置模型: ${models.DEFAULT_MODEL}）`);
  try {
    await cdp.connect();
  } catch (e) {
    console.warn(`[api] ${e.message}`);
    console.warn('[api] 提示：首次请求时仍会尝试重新连接（请确保 Chrome 已开且 chat.qwen.ai 已登录）');
  }
});
