// tooluse.js —— 基于提示词的工具调用层（prompt-based tool use, DSML 增强版）
//
// 问题背景：Qwen 网页版没有原生的 function-calling 协议，本桥靠"键入文本 + 读回回复"驱动模型。
// 因此无法直接支持 OpenAI 的 tools/tool_calls。这里用一套**约定格式**让网页模型"假装"支持工具调用：
//   1. 把工具清单 + 调用规则作为前缀注入到用户消息里（buildToolInstruction）
//   2. 捕获模型回复，用 DSML（DeepSeek Markup Language）XML 标签抽取工具调用（parseToolOutput）
//   3. 转成 OpenAI 标准 tool_calls 返回；客户端执行后把 tool 结果发回，桥接层再把结果键入页面续聊
//
// 设计借鉴 deepseek-web2api-free 的 DSML + StreamSieve 思路，并针对本桥做了两点关键增强：
//   A) content 与 tool_calls 不再互斥 —— 模型"先说一句+再调工具"时，正文与工具调用同时返回（修复旧版 XOR bug）；
//   B) 流式场景下用 ToolStreamSieve 逐字符分离正文与工具调用，正文实时吐出，工具调用块闭合后才 flush。
//
// 格式（DSML）：
//   <|DSML|tool_calls>
//     <|DSML|invoke name="工具名">
//       <|DSML|parameter name="参数名"><![CDATA[参数值]]></|DSML|parameter>
//     </|DSML|invoke>
//   </|DSML|tool_calls>
//
// 说明：这是尽力而为的方案，可靠性依赖网页模型对格式的遵循程度；非官方 API 的原生工具调用可比。

'use strict';

// —— DSML 标签（与 deepseek-web2api-free 的 DSML 兼容）——
const DSML_MARK = '<|DSML|';

// —— 旧版定界符（向后兼容：仍保留解析能力，但注入格式已切换为 DSML）——
const TOOL_CALL_OPEN = '__TOOL_CALL__';
const TOOL_CALL_CLOSE = '__END__';

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 模型偶发把结束标签写成 </<|DSML|X>（多写了一个 '<'）：即 </ 后面又跟了 <|DSML|。
// 例如正常应为 </|DSML|parameter>，模型却输出 </<|DSML|parameter>。
// 这里在解析前把它归一化为规范形式，避免整段 DSML 解析失败、原样当正文吐出。
function fixMalformedDsml(raw) {
  if (typeof raw !== 'string' || !raw) return raw;
  return raw.replace(/<\/<\s*\|DSML\|/g, '</|DSML|');
}

// =====================================================================
// WorkBuddy 专有格式：真实用户消息提取
// WorkBuddy 客户端在 user 消息中总是附带系统提示词，真实用户消息由
// <user_query>...</user_query> 标签包裹（专有格式）。桥接层只把标签内的
// 真实消息传给网页模型；特殊指令（NEW.TOPIC / HI,TOOLS）也在真实消息上解析。
// 无标签时原样返回，兼容其它 OpenAI 兼容客户端。
// =====================================================================
function extractUserQuery(content) {
  if (typeof content !== 'string') return content;
  const m = content.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  return m && m[1] !== undefined ? m[1].trim() : content;
}

// =====================================================================
// 0. 工具系统提示词按需注入（显式指令 "HI,TOOLS" 才发送一次庞大的工具系统提示词）
//    语义：识别到指令 "HI,TOOLS" → **向网页发送 "HI" 消息代替客户端的 "HI,TOOLS" 文本**
//    （发给网页模型的内容 = 系统提示词 + "HI"，仅第一次）；此后本会话一直不再带
//    系统提示词发送；从未发送过 HI,TOOLS 的会话则一直不发送系统提示词。
//    指令只负责触发系统提示词添加：该回合把 "HI" 真正发给网页，网页的真实回复
//    返回给客户端（2026-08-21 调整，不再由服务器伪造 "HI" 确认响应）。
//    同一会话重复发 HI,TOOLS 只发 "HI"、不再带系统提示词（防膨胀）。
//    注意：归属"当前会话"，依赖客户端稳定传入相同 session_id / 复用同一网页
//    会话；换 session_id 或 new_session 新建会话后，需在新会话再发一次。
// =====================================================================
const TOOL_ARM_COMMAND = 'HI,TOOLS';

// 已注入过系统提示词的会话集合：key 为 session_id 字符串，防同一会话重复注入。
// 进程重启清空（本地开发桥可接受；如需跨重启可改外部存储）。
const _promptInjectedSessions = new Set();

// 标记某会话已注入过系统提示词
function markPromptInjected(sessionId) {
  if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
    _promptInjectedSessions.add(String(sessionId));
  }
}

// 判断某会话是否已注入过系统提示词
function isPromptInjected(sessionId) {
  return _promptInjectedSessions.has(String(sessionId));
}

// 归一化：去除所有空白并转大写，便于稳定匹配 "HI,TOOLS" / "HI, TOOLS" 等变体
function normalizeArmText(s) {
  return String(s || '').replace(/\s+/g, '').toUpperCase();
}

// 只识别「最后一次用户消息」：客户端可能携带多轮会话历史（其中含以前的 HI,TOOLS 指令），
// 不能因为历史里有 HI,TOOLS 就重复触发握手——只有最新一次用户指令才算数。
function detectToolArm(messages) {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') {
      return normalizeArmText(m.content).includes(TOOL_ARM_COMMAND);
    }
  }
  return false;
}

// 从用户内容中剥离 HI,TOOLS 控制指令（保留真实提问），避免把控制词键入网页模型
function stripToolArm(content) {
  if (typeof content !== 'string') return content;
  return content
    .replace(/HI\s*,\s*TOOLS/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// =====================================================================
// 1. 构造注入到用户消息前的"工具说明"前缀
//    toolChoice: 'auto'(默认) | 'none' | 'required' | {type:'function',function:{name:'x'}}
// =====================================================================
function buildToolInstruction(tools, toolChoice) {
  if (toolChoice === 'none') return ''; // 不注入，纯问答

  const toolList = (tools || []).map(formatToolBrief).join('\n');

  const formatRules = [
    '你具备调用外部工具的能力。当需要调用工具时，请严格按以下 XML 格式输出',
    '（不要加代码围栏、不要在工具调用块之外写多余的解释性文字）：',
    '',
    `${DSML_MARK}tool_calls>`,
    `  ${DSML_MARK}invoke name="工具名">`,
    `    ${DSML_MARK}parameter name="参数名"><![CDATA[参数值]]></${DSML_MARK}parameter>`,
    `  </${DSML_MARK}invoke>`,
    `</${DSML_MARK}tool_calls>`,
    '',
    '规则：',
    '- 用 <|DSML|tool_calls> 包裹，内部可含一个或多个 <|DSML|invoke>；',
    '- 工具名写在 invoke 的 name 属性里；',
    '- 字符串参数值必须放在 <![CDATA[ ... ]]> 中；数字/布尔/null 直接写纯文本；',
    '- 工具调用块之前或之后可写自然语言说明（会作为普通回复一并返回）；',
    '- 不要把工具调用包在 ``` 代码围栏里，不要重复说明格式。',
    '- 结束标签形如 </|DSML|parameter>（只有一对尖括号）；严禁写成 </<|DSML|parameter>（多了一个 <），否则工具调用会解析失败。',
    '',
    '可用工具：',
    toolList,
  ].join('\n');

  let choiceInstruction = '';
  if (toolChoice === 'required') {
    choiceInstruction =
      '\n\n重要：你必须调用至少一个可用工具，不要直接回答用户，只输出上述工具调用格式。';
  } else if (toolChoice && typeof toolChoice === 'object' && toolChoice.function && toolChoice.function.name) {
    const name = toolChoice.function.name;
    choiceInstruction =
      `\n\n重要：你必须调用工具「${name}」，不要调用其他工具，也不要直接回答用户，只输出该工具的调用格式。`;
  } else if (typeof toolChoice === 'string' && !['auto', 'required', 'none'].includes(toolChoice)) {
    choiceInstruction =
      `\n\n重要：你必须调用工具「${toolChoice}」，不要直接回答用户，只输出该工具的调用格式。`;
  }

  return formatRules + choiceInstruction;
}

// 把一个 OpenAI tool 定义压缩成一行简介（名称 + 描述 + 参数名/类型/必填），避免注入整段 JSON Schema 造成模型困惑
function formatToolBrief(tool) {
  const fn = (tool && tool.function) ? tool.function : (tool || {});
  const name = fn.name || (tool && tool.name) || '?';
  const desc = String(fn.description || '').split('\n')[0].trim();
  let line = `- ${name}: ${desc}`;
  const params = fn.parameters && fn.parameters.properties;
  const required = (fn.parameters && Array.isArray(fn.parameters.required)) ? fn.parameters.required : [];
  if (params && typeof params === 'object') {
    const parts = Object.keys(params).map((k) => {
      const p = params[k] || {};
      const req = required.includes(k) ? '(必填)' : '(可选)';
      return `${k}:${p.type || 'any'}${req}`;
    });
    if (parts.length) line += `  参数[${parts.join(', ')}]`;
  }
  return line;
}

// =====================================================================
// 2. 解析：把模型回复中的 DSML 工具调用抽取为 OpenAI tool_calls，并保留正文
// =====================================================================

// 去除 <|DSML|...> 前缀标记，归一化为普通 <tag> 形式，便于后续 XML 正则解析。
// 同时兼容 "<|DSML|invoke" / "|DSML|invoke" / "<invoke" 多种写法。
function stripDsmlMarkup(text) {
  if (!text) return text;
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    // CDATA 原样保留
    if (text.startsWith(CDATA_OPEN, i)) {
      const close = text.indexOf(CDATA_CLOSE, i + CDATA_OPEN.length);
      if (close === -1) { out += text.slice(i); break; }
      out += text.slice(i, close + CDATA_CLOSE.length);
      i = close + CDATA_CLOSE.length;
      continue;
    }
    if (c !== '<') { out += c; i++; continue; }
    const end = text.indexOf('>', i);
    if (end === -1) { out += text.slice(i); break; }
    const inner = text.slice(i + 1, end);
    const rest = inner.startsWith('/') ? inner.slice(1) : inner;
    // 检测 |DSML| 前缀（允许前导空格/换行/竖线）
    let j = 0;
    let dsml = false;
    while (j < rest.length) {
      const ch = rest[j];
      if (ch === '|') { dsml = true; j++; }
      else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { j++; }
      else if (rest.slice(j, j + 4).toLowerCase() === 'dsml') { j += 4; dsml = true; }
      else break;
    }
    if (dsml) {
      let nameEnd = j;
      while (nameEnd < rest.length && /[A-Za-z0-9_]/.test(rest[nameEnd])) nameEnd++;
      const tagName = rest.slice(j, nameEnd).toLowerCase();
      if (tagName === 'tool_calls' || tagName === 'invoke' || tagName === 'parameter') {
        const prefix = inner.startsWith('/') ? '</' : '<';
        out += prefix + rest.slice(j) + '>';
        i = end + 1;
        continue;
      }
    }
    out += text.slice(i, end + 1);
    i = end + 1;
  }
  return out;
}

// 解析 <parameter> 内部：优先 JSON，失败则自动类型转换
function parseParameterValue(raw) {
  let v = raw.trim();
  if (v.startsWith(CDATA_OPEN) && v.endsWith(CDATA_CLOSE)) {
    v = v.slice(CDATA_OPEN.length, -CDATA_CLOSE.length);
  }
  try {
    return JSON.parse(v);
  } catch (_) {
    return autoType(v);
  }
}

function autoType(v) {
  const s = String(v).trim();
  if (s.toLowerCase() === 'true') return true;
  if (s.toLowerCase() === 'false') return false;
  if (s.toLowerCase() === 'null' || s.toLowerCase() === 'none') return null;
  if (s !== '' && !isNaN(Number(s))) {
    // 避免 "0123" 被当八进制/被 Number 吃掉前导零：保留为字符串更稳妥？这里按数值返回
    return Number(s);
  }
  return v;
}

function parseParameters(innerText) {
  const args = {};
  const re = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi;
  let m;
  while ((m = re.exec(innerText)) !== null) {
    const key = m[1].trim();
    args[key] = parseParameterValue(m[2]);
  }
  return args;
}

function formatToolCall(name, args) {
  if (!name) return null;
  const id = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args || {}, ensureAsciiSafe),
    },
  };
}

// JSON.stringify 的 replacer：保留非 ASCII（中文参数名/值）原样，避免 \uXXXX 转义
function ensureAsciiSafe(_key, value) {
  return value;
}

function cleanDsmlText(normalized) {
  let t = normalized;
  t = t.replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, '');
  t = t.replace(/<invoke[^>]*>[\s\S]*?<\/invoke>/gi, '');
  t = t.replace(/<parameter[^>]*>[\s\S]*?<\/parameter>/gi, '');
  t = t.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  t = t.replace(/\[citation:\d+\]/g, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// 解析 DSML：返回 { toolCalls, text }
function parseDsmlToolCalls(content) {
  if (!content || typeof content !== 'string') return { toolCalls: [], text: '' };
  const normalized = stripDsmlMarkup(fixMalformedDsml(content));
  const toolCalls = [];

  // 外层 <tool_calls> 或 <tool_call>
  const blockMatch =
    normalized.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/i) ||
    normalized.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);

  const scanInvokes = (body) => {
    const re = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const tc = formatToolCall(m[1].trim(), parseParameters(m[2]));
      if (tc) toolCalls.push(tc);
    }
  };

  if (blockMatch) {
    scanInvokes(blockMatch[1]);
  } else {
    // 裸 <invoke>（无外层包裹）
    scanInvokes(normalized);
  }

  const text = cleanDsmlText(normalized);
  return { toolCalls, text };
}

// 旧版 __TOOL_CALL__{json}__END__ 解析（向后兼容）
function extractLegacyToolCalls(content) {
  if (!content || typeof content !== 'string') return [];
  // 定界符尾部下划线数量宽松匹配（兼容模型漏写尾部下划线）：0~2 个
  const open = escapeRegExp(TOOL_CALL_OPEN).replace(/_+$/, '') + '(?:_){0,2}';
  const close = escapeRegExp(TOOL_CALL_CLOSE).replace(/_+$/, '') + '(?:_){0,2}';
  const re = new RegExp(open + '([\\s\\S]*?)' + close, 'g');
  const calls = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    let raw = (m[1] || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    if (!raw) continue;
    const obj = salvageJSON(raw);
    if (obj && typeof obj.name === 'string' && obj.name) {
      let args = obj.arguments != null ? obj.arguments : {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (_) { /* 保留原字符串 */ }
      }
      const tc = formatToolCall(obj.name, args);
      if (tc) calls.push(tc);
    }
  }
  return calls;
}

// 尽力解析一段可能为 JSON 的文本：直接解析 → 裁剪最外层 {} → 去除尾逗号重试
function salvageJSON(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  try { return JSON.parse(s); } catch (_) {}
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a !== -1 && b > a) {
    const sub = s.slice(a, b + 1);
    try { return JSON.parse(sub); } catch (_) {}
    try { return JSON.parse(sub.replace(/,(\s*[}\]])/g, '$1')); } catch (_) {}
  }
  return null;
}

// 去除正文里的旧版定界符残留（旧格式调用块之间的正文）
function stripLegacyMarkers(text) {
  return text.split(new RegExp(escapeRegExp(TOOL_CALL_OPEN) + '[\\s\\S]*?' + escapeRegExp(TOOL_CALL_CLOSE), 'g')).join('').trim();
}

// 去除模型可能的思考块（深度思考模式偶发泄漏到正文）
function stripThink(text) {
  if (!text) return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\[思考\][\s\S]*?\[\/思考\]/gi, '')
    .trim();
}

// 主入口：把模型原始回复解析为 { toolCalls, text }（content 与 tool_calls 可共存）
function parseToolOutput(content) {
  if (!content || typeof content !== 'string') return { toolCalls: [], text: '' };

  const legacyCalls = extractLegacyToolCalls(content);
  // 先剥离旧版定界符，避免污染 DSML 解析
  let working = legacyCalls.length ? stripLegacyMarkers(content) : content;

  const dsml = parseDsmlToolCalls(working);
  let toolCalls = dsml.toolCalls.concat(legacyCalls);
  let text = dsml.text;

  if (!toolCalls.length) {
    // 没有工具调用：作为普通回复，剥离可能的思考块
    return { toolCalls: [], text: stripThink(working) };
  }
  return { toolCalls, text: text || '' };
}

// 工具结果回传时，从 messages 中反查对应的工具名（用 tool_call_id 匹配 assistant 的 tool_calls）
function resolveToolName(messages, toolCallId) {
  if (!Array.isArray(messages)) return '工具';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const t = m.tool_calls.find((tc) => tc && tc.id === toolCallId);
      if (t) return (t.function && t.function.name) || t.name || '工具';
    }
  }
  return '工具';
}

// =====================================================================
// 3. ToolStreamSieve —— 逐字符流筛分引擎（JS 版 StreamSieve）
//    给定 parseFn(buf) => { toolCalls, text }，feed() 返回事件数组：
//      { type:'text', data }       普通正文增量
//      { type:'tool_calls', data } 已闭合的工具调用数组
//    设计目标：正文实时吐出；工具调用块未闭合前不提前吐出（避免把标签当正文）。
// =====================================================================
class ToolStreamSieve {
  constructor(parseFn, maxCaptureBuffer = 1024 * 1024) {
    this.parseFn = parseFn;
    this._maxCaptureBuffer = Math.max(1024, maxCaptureBuffer);
    this._pending = '';
    this._captureBuf = '';
    this._capturing = false;
  }

  feed(chunk) {
    const events = [];
    if (!chunk) return events;

    if (this._capturing) {
      this._captureBuf += chunk;
      if (this._captureBuf.length > this._maxCaptureBuffer) {
        // 超出缓冲上限：当作普通正文强制吐出，避免异常模型输出导致无限缓冲
        events.push({ type: 'text', data: this._captureBuf });
        this._captureBuf = '';
        this._capturing = false;
        return events;
      }
      const result = this._tryFinish();
      if (result) {
        this._emitResult(events, result);
        if (result.suffix) events.push(...this._drainPending());
      }
      return events;
    }

    this._pending += chunk;
    const startIdx = this._findToolStart(this._pending);
    if (startIdx >= 0) {
      const prefix = this._pending.slice(0, startIdx);
      const rest = this._pending.slice(startIdx);
      this._pending = '';
      if (prefix) events.push({ type: 'text', data: prefix });
      this._captureBuf = rest;
      this._capturing = true;
      const result = this._tryFinish();
      if (result) {
        this._emitResult(events, result);
        if (result.suffix) events.push(...this._drainPending());
      }
    } else {
      const [safe, hold] = this._splitSafe(this._pending);
      if (safe) events.push({ type: 'text', data: safe });
      this._pending = hold;
    }
    return events;
  }

  flush() {
    const events = [];
    if (this._capturing) {
      const result = this._tryFinish();
      if (result) {
        this._emitResult(events, result);
      } else {
        // 未闭合：整段当作正文
        events.push({ type: 'text', data: this._captureBuf });
      }
      this._captureBuf = '';
      this._capturing = false;
    }
    if (this._pending) {
      events.push({ type: 'text', data: this._pending });
      this._pending = '';
    }
    return events;
  }

  _emitResult(events, result) {
    // result: { prefix, toolCalls, suffix } 或 { text }
    if (result.text != null) {
      if (result.text) events.push({ type: 'text', data: result.text });
      return;
    }
    if (result.prefix) events.push({ type: 'text', data: result.prefix });
    if (result.toolCalls && result.toolCalls.length) {
      events.push({ type: 'tool_calls', data: result.toolCalls });
    }
  }

  _tryFinish() {
    if (!this._captureBuf || !this.parseFn) return null;
    if (!this._isCaptureComplete()) return null;
    const parsed = this.parseFn(this._captureBuf);
    if (parsed && parsed.toolCalls && parsed.toolCalls.length) {
      // 捕获区内除工具调用外的正文也要吐出（例如工具调用之后的说明）
      return { prefix: parsed.text || '', toolCalls: parsed.toolCalls, suffix: '' };
    }
    // 捕获区闭合但没有工具调用：当作普通正文
    return { text: this._captureBuf };
  }

  _isCaptureComplete() {
    const buf = fixMalformedDsml(this._captureBuf);
    // 开启标签可能是原始 <|DSML|...> 或归一化后的 <...>；闭合标签是 </|DSML|...>（注意是 </ 不是 </<）
    const openTool = `${DSML_MARK}tool_calls>`;   // <|DSML|tool_calls>
    const closeTool = `</|DSML|tool_calls>`;       // </|DSML|tool_calls>
    const openInvoke = `${DSML_MARK}invoke `;      // <|DSML|invoke 
    const closeInvoke = `</|DSML|invoke>`;         // </|DSML|invoke>
    if (buf.includes(openTool) || buf.includes('<tool_calls>')) {
      return buf.includes(closeTool) || buf.includes('</tool_calls>');
    }
    if (buf.includes(openInvoke) || buf.includes('<invoke ')) {
      return buf.includes(closeInvoke) || buf.includes('</invoke>');
    }
    return false;
  }

  _findToolStart(text) {
    const starts = [
      `${DSML_MARK}tool_calls>`,
      `|DSML|tool_calls>`,
      '<tool_calls>',
      '<tool_call>',
      '<invoke ',
      `${DSML_MARK}invoke `,
      '|DSML|invoke ',
    ];
    for (const tag of starts) {
      let pos = text.indexOf(tag);
      while (pos >= 0) {
        // 跳过 </<|DSML|... 这种「结束标签里又嵌了一个 <」的误匹配：
        // 例如 </<|DSML|tool_calls> 内含 <|DSML|tool_calls>，但该位置其实是结束标签
        if (pos >= 2 && text[pos - 2] === '<' && text[pos - 1] === '/') {
          pos = text.indexOf(tag, pos + 1);
          continue;
        }
        return pos;
      }
    }
    const prefixes = [`${DSML_MARK}`, '|DSML|', '<tool_calls', '<tool_call', '<invoke'];
    for (const p of prefixes) {
      const pos = text.indexOf(p);
      if (pos >= 0) return pos;
    }
    return -1;
  }

  _splitSafe(text) {
    if (!text) return ['', ''];
    const lastLt = text.lastIndexOf('<');
    const lastPipe = text.lastIndexOf('|');
    const lastSpecial = lastLt >= lastPipe ? lastLt : lastPipe;
    if (lastSpecial === -1) return [text, ''];
    const tail = text.slice(lastSpecial);
    if (!tail) return [text, ''];
    const starts = [
      `${DSML_MARK}tool_calls>`,
      `|DSML|tool_calls>`,
      '<tool_calls>',
      '<tool_call>',
      '<invoke ',
      `${DSML_MARK}invoke `,
      '|DSML|invoke ',
    ];
    const prefixes = [`${DSML_MARK}`, '|DSML|', '<tool_calls', '<tool_call', '<invoke'];
    for (const tag of starts) {
      if (tag.startsWith(tail)) return [text.slice(0, lastSpecial), tail];
    }
    for (const p of prefixes) {
      if (p.startsWith(tail)) return [text.slice(0, lastSpecial), tail];
    }
    return [text, ''];
  }

  _drainPending() {
    const events = [];
    while (this._pending) {
      if (this._capturing) break;
      const startIdx = this._findToolStart(this._pending);
      if (startIdx >= 0) {
        const prefix = this._pending.slice(0, startIdx);
        const rest = this._pending.slice(startIdx);
        this._pending = '';
        if (prefix) events.push({ type: 'text', data: prefix });
        this._captureBuf = rest;
        this._capturing = true;
        const result = this._tryFinish();
        if (result) {
          this._emitResult(events, result);
          if (result.suffix) continue;
          else break;
        } else {
          break;
        }
      } else {
        const [safe, hold] = this._splitSafe(this._pending);
        if (safe) events.push({ type: 'text', data: safe });
        this._pending = hold;
        break;
      }
    }
    return events;
  }
}

module.exports = {
  DSML_MARK,
  TOOL_CALL_OPEN,
  fixMalformedDsml,
  TOOL_CALL_CLOSE,
  TOOL_ARM_COMMAND,
  detectToolArm,
  stripToolArm,
  extractUserQuery,
  markPromptInjected,
  isPromptInjected,
  buildToolInstruction,
  formatToolBrief,
  parseToolOutput,
  extractLegacyToolCalls,
  parseDsmlToolCalls,
  stripThink,
  resolveToolName,
  ToolStreamSieve,
};
