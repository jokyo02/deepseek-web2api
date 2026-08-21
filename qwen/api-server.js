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

// —— 会话跟踪：检测客户端切换会话 ——
// OpenAI 兼容客户端"新建会话"时会给新会话分配新的会话 id（session_id）。
// 服务器记住上次使用的 session_id：新请求的 id 与上次不同 → 判定客户端开了新会话 → 自动新建页面会话。
// 仅对客户端显式传入的 session_id 生效（未传时由服务端生成随机 id，不触发自动新建，保持向后兼容）。
let lastSessionId = null;

// 决策是否新建会话。bodySessionId 为客户端显式传入的会话 id（无则 null）。
// explicit 为请求体里的 new_session 字段（undefined 表示未声明）。
function decideNewSession(bodySessionId, explicit) {
  if (explicit === true) return true;  // 显式强制新建
  if (explicit === false) return false; // 显式禁止新建
  if (bodySessionId == null) return false; // 客户端未传 id，无法判断，维持当前会话
  if (lastSessionId !== null && bodySessionId !== lastSessionId) return true; // 检测到会话切换
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

  // —— 工具调用模式：tools 非空 → 启用基于提示词的工具层 ——
  const toolMode = Array.isArray(tools) && tools.length > 0;

  // 计算要键入页面的文本（outgoing）
  let outgoing;
  if (toolMode) {
    const last = messages[messages.length - 1];
    if (last && last.role === 'tool') {
      // 上一轮工具结果回传：标注后键入页面，供模型继续
      const tname = tooluse.resolveToolName(messages, last.tool_call_id);
      const tcontent = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      outgoing = `【工具「${tname}」的返回结果如下，请据此继续完成任务】\n${tcontent}`;
    } else {
      const u = [...messages].reverse().find(
        (m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()
      );
      if (!u) {
        return sendOpenAIError(res, 400, 'invalid_request_error', 'tools 模式下缺少有效的 user 消息', 'missing_user_message');
      }
      outgoing = u.content;
    }
    // 注入工具说明前缀（tool_choice==='none' 时不注入，纯问答）
    const instruction = tool_choice === 'none' ? '' : tooluse.buildToolInstruction(tools, tool_choice);
    outgoing = instruction ? instruction + '\n\n' + outgoing : outgoing;
  } else {
    // 取最后一条 user 消息作为发送内容（system 等角色会被忽略——网页版有自身预设）
    const lastUser = [...messages].reverse().find((m) => m && (m.role === 'user' || m.content));
    if (!lastUser || typeof lastUser.content !== 'string' || !lastUser.content.trim()) {
      return sendOpenAIError(res, 400, 'invalid_request_error', 'messages 中缺少有效的 user 消息', 'missing_user_message');
    }
    outgoing = lastUser.content;
  }

  // 会话 id：优先用客户端显式传入的 session_id（用于会话切换检测），否则服务端生成
  const hasClientSessionId = typeof body.session_id === 'string' && body.session_id.length > 0;
  const sessionId = hasClientSessionId ? body.session_id : genSessionId();
  const newSession = decideNewSession(hasClientSessionId ? sessionId : null, body.new_session);
  if (hasClientSessionId) lastSessionId = sessionId; // 记录本次会话 id（无论是否新建）
  const opts = { newSession, model: route.requested }; // 透传原始请求型号名，供后端按名称关键词（thinking/search）尽力切换网页模式

  console.log(
    `[api] 收到请求(${stream ? 'stream' : 'json'}) sessionId=${sessionId}` +
    ` model=${modelOut}${route.isAlias ? '(别名)' : ''}${!route.isKnown ? '(未知→默认后端)' : ''}` +
    `${toolMode ? ` [tools:${tools.length}${tool_choice ? ',choice=' + JSON.stringify(tool_choice) : ''}]` : ''}` +
    ` new_session=${newSession}${newSession && hasClientSessionId ? '（会话切换自动检测）' : ''}`
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
        res.json(buildCompletion(modelOut, sessionId, outgoing, result.content));
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

// —— 工具调用（tool_calls）相关构造 ——

// 构造 OpenAI 标准非流式「工具调用」响应
// 注意：content 与 tool_calls 可共存（模型先说一句再调工具时，正文也会被保留返回）
function buildToolCallCompletion(model, sessionId, calls, text) {
  const created = Math.floor(Date.now() / 1000);
  const content = typeof text === 'string' ? text : '';
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
  });
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
  });

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
async function handleStreaming(req, res, { model, sessionId, message, opts }) {
  const created = Math.floor(Date.now() / 1000);
  const chatId = `chatcmpl-${sessionId}`;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

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

  let lastSentLen = 0;

  const result = await cdp.executeChat(sessionId, message, { ...opts, onProgress: (text) => {
    // 推送本轮新增部分
    if (text.length > lastSentLen) {
      const delta = text.slice(lastSentLen);
      lastSentLen = text.length;
      res.write(
        `data: ${JSON.stringify({
          id: chatId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        })}\n\n`
      );
    }
  }});

  // 补发未覆盖的尾部（理论上 onProgress 已全覆盖，双保险）
  if (result.content && result.content.length > lastSentLen) {
    res.write(
      `data: ${JSON.stringify({
        id: chatId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: result.content.slice(lastSentLen) }, finish_reason: null }],
      })}\n\n`
    );
  }

  // 结束帧
  res.write(
    `data: ${JSON.stringify({
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
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
  const newSession = decideNewSession(hasClientSessionId ? sessionId : null, body.newSession);
  if (hasClientSessionId) lastSessionId = sessionId;
  console.log(
    `[api] 收到请求(legacy /chat) sessionId=${sessionId} newSession=${newSession}` +
    `${newSession && hasClientSessionId ? '（会话切换自动检测）' : ''}`
  );
  enqueue(() => runChat(sessionId, message, res, { newSession }));
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
