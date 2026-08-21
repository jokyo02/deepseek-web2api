// tooluse.js —— 基于提示词的工具调用层（prompt-based tool use）
//
// 问题背景：Qwen AI 网页版没有对外的 function-calling 协议（网页内部自有 tools 体系），
// 本桥靠"键入文本 + 读回回复"驱动模型，因此无法直接复用 OpenAI 的 tools/tool_calls。
// 这里用一套**约定格式**让网页模型"假装"支持工具调用：
//   1. 把工具清单 + 调用规则作为前缀注入到用户消息里（buildToolInstruction）
//   2. 捕获模型回复，用定界符 __TOOL_CALL__...__END__ 抽取工具调用（extractToolCalls）
//   3. 转成 OpenAI 标准 tool_calls 返回；客户端执行后把 tool 结果发回，桥接层再把结果键入页面续聊
//
// 说明：这是尽力而为的方案，可靠性依赖网页模型对格式的遵循程度；非官方 API 的原生工具调用可比。
// （Rfym21/Qwen2API 等项目对 Qwen 网页版采用同样的提示词注入思路，只是标签不同。）

'use strict';

// 工具调用定界符（要求模型严格按此格式仅输出一行）
const TOOL_CALL_OPEN = '__TOOL_CALL__';
const TOOL_CALL_CLOSE = '__END__';

// 构造注入到用户消息前的"工具说明"前缀。
// toolChoice: 'auto'(默认) | 'none' | 'required' | {type:'function',function:{name:'x'}}
function buildToolInstruction(tools, toolChoice) {
  const schema = JSON.stringify(tools || [], null, 2);
  const base = `你具备调用外部工具的能力。可用工具（JSON Schema）：\n${schema}`;

  if (toolChoice === 'none') return ''; // 不注入，纯问答

  if (toolChoice === 'required') {
    return (
      base +
      `\n\n你必须调用一个工具来完成任务。请仅输出一行，格式严格为：\n` +
      `${TOOL_CALL_OPEN}{"name":"工具名","arguments":{...}}${TOOL_CALL_CLOSE}\n` +
      `不要输出任何其他文字。特别强调：在回复输出中TOOL_CALL 前后都一定要有下横线。`
    );
  }

  // 强制调用某个具体函数
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function && toolChoice.function.name) {
    const name = toolChoice.function.name;
    return (
      base +
      `\n\n你必须调用工具「${name}」。请仅输出一行，格式严格为：\n` +
      `${TOOL_CALL_OPEN}{"name":"${name}","arguments":{...}}${TOOL_CALL_CLOSE}\n` +
      `不要输出任何其他文字。特别强调：在回复输出中TOOL_CALL 前后都一定要有下横线。`
    );
  }

  // 默认 auto：可调用也可不调用
  return (
    base +
    `\n\n调用规则：\n` +
    `- 若需要调用工具，请仅输出一行，格式严格为：\n` +
    `  ${TOOL_CALL_OPEN}{"name":"工具名","arguments":{...}}${TOOL_CALL_CLOSE}\n` +
    `  不要输出任何其他文字。特别强调：在回复输出中TOOL_CALL 前后都一定要有下横线。\n` +
    `- 若不需要工具，请正常回答即可。`
  );
}

// 从模型回复中抽取工具调用。返回 null 或 [{name, arguments}]。
// 容错（2026-08-21 修复：模型常把结尾定界符写成 __END 而非 __END__，或 JSON 带尾逗号/围栏/
//   把 arguments 写成字符串，旧逻辑要求严格 __END__ 且 JSON.parse 一失败就丢弃，导致整段解析失败、
//   原始 __TOOL_CALL__...__END 包装串泄漏到回复里）：
//   1) 定界符前后下划线数量宽松匹配（__TOOL_CALL / __TOOL_CALL__ / __END / __END__ 都认）；
//   2) 去掉 ```json 围栏与首尾空白；
//   3) JSON 解析失败时尝试裁剪最外层 {} / 去除尾逗号后再次解析（salvageJSON）；
//   4) arguments 若本身是 JSON 字符串，则解析为对象，便于上层统一处理。
function extractToolCalls(content) {
  if (!content || typeof content !== 'string') return null;
  // 定界符：允许尾部 0..2 个下划线（兼容模型漏写尾部下划线的情况）。
  // 用 (?:_){0,2} 表示「0~2 个下划线」（注意不能写 __{0,2}，那会变成「至少 2 个」）。
  // 上限取 2 而非贪婪 *_：多个工具调用相邻时（__END____TOOL_CALL__ 共 4 个下划线），
  // 2+2 恰好拆分为「本调用结尾 2 个 + 下一调用开头 2 个」，避免结尾把下一调用开头的下划线吞掉。
  const open = escapeRegExp(TOOL_CALL_OPEN).replace(/_+$/, '') + '(?:_){0,2}';
  const close = escapeRegExp(TOOL_CALL_CLOSE).replace(/_+$/, '') + '(?:_){0,2}';
  const re = new RegExp(open + '([\\s\\S]*?)' + close, 'g');
  const calls = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    let raw = (m[1] || '').trim();
    // 去掉可能的代码围栏
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    if (!raw) continue;
    const obj = salvageJSON(raw);
    if (obj && typeof obj.name === 'string' && obj.name) {
      let args = obj.arguments != null ? obj.arguments : {};
      // arguments 若是 JSON 字符串，尝试解析为对象
      if (typeof args === 'string') {
        try { const pa = JSON.parse(args); args = pa; } catch (_) { /* 保留原字符串 */ }
      }
      calls.push({ name: obj.name, arguments: args });
    }
  }
  return calls.length ? calls : null;
}

// 尽力解析一段可能为 JSON 的文本：直接解析 → 裁剪最外层 {} → 去尾逗号重试
function salvageJSON(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  // 1) 直接解析
  try { return JSON.parse(s); } catch (_) {}
  // 2) 取第一个 { 到最后一个 } 的子串
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a !== -1 && b > a) {
    const sub = s.slice(a, b + 1);
    try { return JSON.parse(sub); } catch (_) {}
    // 3) 去除尾逗号（如 {"a":1,}）后重试
    try { return JSON.parse(sub.replace(/,(\s*[}\]])/g, '$1')); } catch (_) {}
  }
  return null;
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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE,
  buildToolInstruction,
  extractToolCalls,
  resolveToolName,
};
