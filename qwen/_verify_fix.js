'use strict';
// 回归测试：双份回复 / 半截块 / 增量不截断 / [DONE] 字样不截断
// 2026-08-25 二次修正后的语义：
//   - parseCompletionSSE 按 response_id|id 分组，组内 超集覆盖/相等忽略/前缀忽略/其余追加
//   - 不同流（新 response_id）只保留最新流 → 整段重放不翻倍
//   - 同一流内纯增量帧必须追加 → 回复不截断（上一版"其余一律忽略"导致的不完整回复回归）
//   - [DONE]/event: close 只认独立行 → answer 内容含字样不提前截断
const ctrl = require('./cdp-controller.js');
const tu = require('./tooluse.js');
const parseSSE = ctrl.parseCompletionSSE;
const hasDoneMarker = ctrl.hasDoneMarker;
const hasCloseMarker = ctrl.hasCloseMarker;
const parseTool = tu.parseToolOutput;

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  PASS:', msg); }
  else { console.log('  FAIL:', msg); failures++; }
}
function countOpenTags(answer) {
  return (answer.match(/<\|DSML\|tool_calls>/g) || []).length;
}

// —— 真实 DSML 工具调用块（含 AskUserQuestion）——
const Q = JSON.stringify([{ question: '行业?', header: '行业', multiSelect: false, options: [{ label: '制造业', description: '制造' }] }]);
const fullBlock =
`<|DSML|tool_calls>
  <|DSML|invoke name="AskUserQuestion">
    <|DSML|parameter name="questions"><![CDATA[${Q}]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`;

const halfBlock =
`<|DSML|tool_calls>
  <|DSML|invoke name="AskUserQuestion">
    <|DSML|parameter name="questions"><![CDATA[]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`;

const lead = '好的，我来帮你。\n';

// 带 response_id 的帧（贴合 chat.qwen.ai 真实格式）
function frame(content, rid = 'rid-1', phase = 'answer') {
  return `data: ${JSON.stringify({ choices: [{ delta: { content, phase, status: 'typing' } }], response_id: rid })}\n\n`;
}
function doneFrame(rid = 'rid-1') {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: '', phase: 'answer', status: 'finished' } }], response_id: rid })}\n\n`;
}

console.log('\n=== 场景1: 同 rid 整段重放（完全相同帧）→ 忽略不翻倍 ===');
{
  const f1 = frame(lead + fullBlock, 'rid-1');
  const f2 = frame(lead + fullBlock, 'rid-1'); // 完全相同重放
  const answer = parseSSE(f1 + f2 + doneFrame('rid-1'));
  assert(answer && countOpenTags(answer) === 1, 'answer 未翻倍，tool_calls 次数=' + (answer ? countOpenTags(answer) : 0));
  const p = parseTool(answer || '');
  assert(p.toolCalls.length === 1, 'toolCalls 数量=1，实际=' + p.toolCalls.length);
  const args = JSON.parse(p.toolCalls[0].function.arguments);
  assert(Array.isArray(args.questions) && args.questions.length === 1, '参数完整：questions 含 1 项');
}

console.log('\n=== 场景2: 半截块在前、完整块在后（同名去重保留完整）===');
{
  const content = halfBlock + '\n' + fullBlock;
  const p = parseTool(content);
  assert(p.toolCalls.length === 1, 'toolCalls 数量=1（去重），实际=' + p.toolCalls.length);
  const args = JSON.parse(p.toolCalls[0].function.arguments);
  assert(Array.isArray(args.questions) && args.questions.length === 1, '保留完整块（参数含 1 项），而非空半截块');
}

console.log('\n=== 场景3: 整段重发为【新 response_id】完整流 → 只保留最新流，不翻倍 ===');
{
  const f1 = frame(lead + fullBlock, 'rid-A');
  const f2 = frame(lead + fullBlock, 'rid-B'); // 新流整段重放
  const answer = parseSSE(f1 + f2 + doneFrame('rid-B'));
  assert(answer && countOpenTags(answer) === 1, 'answer 未翻倍，tool_calls 次数=' + (answer ? countOpenTags(answer) : 0));
  const p = parseTool(answer || '');
  assert(p.toolCalls.length === 1, 'toolCalls 数量=1，实际=' + p.toolCalls.length);
}

console.log('\n=== 场景4: 同 rid 累积超集快照（每帧是上一帧超集）→ 覆盖 ===');
{
  const f1 = frame('先查一下', 'rid-1');
  const f2 = frame('先查一下。现在分析', 'rid-1');
  const f3 = frame('先查一下。现在分析。完成', 'rid-1');
  const answer = parseSSE(f1 + f2 + f3 + doneFrame('rid-1'));
  assert(answer === '先查一下。现在分析。完成', '累积增量正确，实际=' + JSON.stringify(answer));
}

console.log('\n=== 场景5: 【核心回归】同 rid 纯增量多帧（每帧只有新增片段）→ 必须完整拼接 ===');
{
  // 上一版"其余一律忽略"在这里只留第一帧 → 客户端收到不完整回复
  const f1 = frame('先查一下', 'rid-1');
  const f2 = frame('，现在分析', 'rid-1'); // 纯新增，与已累积无包含关系
  const f3 = frame('。完成', 'rid-1');
  const answer = parseSSE(f1 + f2 + f3 + doneFrame('rid-1'));
  assert(answer === '先查一下，现在分析。完成', '增量帧全部拼上（回复完整），实际=' + JSON.stringify(answer));
}

console.log('\n=== 场景5b: 混合形态——同 rid 增量后再来新 rid 完整快照 → 不翻倍且内容完整 ===');
{
  const f1 = frame('分析如下：', 'rid-1');
  const f2 = frame('分析如下：', 'rid-2');   // 新流（重放/接管）
  const f3 = frame('分析如下：结论完成', 'rid-2'); // 新流内累积
  const answer = parseSSE(f1 + f2 + f3 + doneFrame('rid-2'));
  assert(answer === '分析如下：结论完成', '只保留最新流且内容完整，实际=' + JSON.stringify(answer));
}

console.log('\n=== 场景6: 两份完整块直接串接（parseTool 同名去重）===');
{
  const content = fullBlock + '\n' + fullBlock;
  const p = parseTool(content);
  assert(p.toolCalls.length === 1, '两份相同完整块去重为 1，实际=' + p.toolCalls.length);
  const args = JSON.parse(p.toolCalls[0].function.arguments);
  assert(Array.isArray(args.questions) && args.questions.length === 1, '参数完整未被破坏');
}

console.log('\n=== 场景7: 正常无工具调用的纯文本 ===');
{
  const f1 = frame('你好，', 'rid-1');
  const f2 = frame('你好，这是普通回复', 'rid-1');
  const answer = parseSSE(f1 + f2 + doneFrame('rid-1'));
  const p = parseTool(answer || '');
  assert(p.toolCalls.length === 0, '无工具调用，toolCalls=0');
  assert(p.text.includes('普通回复'), '正文保留');
}

console.log('\n=== 场景8: answer 内容含 [DONE] 字样 → 不提前截断 ===');
{
  const body = frame('结果是 [DONE] 标记，这是代码输出', 'rid-1') + doneFrame('rid-1');
  assert(hasDoneMarker(body) === false, '独立行匹配：内容里的 [DONE] 不算结束信号');
  assert(hasDoneMarker('data: [DONE]\n\n') === true, '独立行 data: [DONE] 才算结束信号');
  assert(hasCloseMarker('event: close\n\n') === true, '独立行 event: close 才算结束信号');
  assert(hasCloseMarker('内容是 event: close 字样') === false, '内容里的 event: close 不算结束信号');
  // 端到端：该 body 不含真结束帧，sseStreamFinished 应为 false（由外层 doneFrame 才触发）
  const answer = parseSSE(body);
  assert(answer && answer.includes('[DONE]'), '回复完整包含 [DONE] 字样，实际=' + JSON.stringify(answer));
}

console.log('\n=== 场景9: 【核心回归】thinking 阶段 content 含工具块草稿 + answer 完整 → 思考草稿不进 answer ===');
{
  // Qwen 思考阶段在 delta.content 里放完整规划（正文+工具块），answer 阶段正式输出。
  // 血案（2026-08-25）：不按 phase 过滤时，thinking 的"正文+块"与 answer 的"块"无包含
  // 关系被追加 → 客户端收到两份相同工具块（网页端正常，因页面只渲染 answer 阶段累积）。
  const thinkingContent = lead + fullBlock; // thinking 阶段规划草稿
  const f1 = frame(thinkingContent, 'rid-1', 'thinking_summary');
  const f2 = frame(thinkingContent, 'rid-1', 'thinking_summary', 'finished');
  const f3 = frame(lead + fullBlock, 'rid-1', 'answer'); // answer 完整输出
  const answer = parseSSE(f1 + f2 + f3 + doneFrame('rid-1'));
  assert(answer && countOpenTags(answer) === 1, 'answer 中 tool_calls 仅 1 次（thinking 草稿被排除），实际=' + (answer ? countOpenTags(answer) : 0));
  assert(answer && answer.includes('好的，我来帮你。'), '正文保留');
  const p = parseTool(answer || '');
  assert(p.toolCalls.length === 1, 'toolCalls 数量=1，实际=' + p.toolCalls.length);
  const args = JSON.parse(p.toolCalls[0].function.arguments);
  assert(Array.isArray(args.questions) && args.questions.length === 1, '参数完整：questions 含 1 项');
}

console.log('\n=== 场景10: thinking 完整规划 + answer 完整输出（不同 rid）→ 只保留 answer 流 ===');
{
  const f1 = frame(lead + fullBlock, 'rid-think', 'thinking_summary');
  const f2 = frame(lead + fullBlock, 'rid-ans', 'answer');
  const answer = parseSSE(f1 + f2 + doneFrame('rid-ans'));
  assert(answer && countOpenTags(answer) === 1, 'answer 中 tool_calls 仅 1 次，实际=' + (answer ? countOpenTags(answer) : 0));
  assert(answer === lead + fullBlock, 'answer 内容完整正确');
}

console.log('\n=== 场景11: 后缀续写忽略——answer 恰是已累积的后缀 → 不重复 ===');
{
  const f1 = frame(lead + fullBlock, 'rid-1', 'answer');
  const f2 = frame(fullBlock, 'rid-1', 'answer'); // 后缀续写（已包含）
  const answer = parseSSE(f1 + f2 + doneFrame('rid-1'));
  assert(answer && countOpenTags(answer) === 1, '后缀续写被忽略，tool_calls 次数=' + (answer ? countOpenTags(answer) : 0));
}

console.log('\n=== 场景12: thinking 阶段 content 为空、answer 正常增量 → 不受 phase 过滤影响 ===');
{
  const f1 = frame('', 'rid-1', 'thinking_summary');
  const f2 = frame('', 'rid-1', 'thinking_summary', 'finished');
  const f3 = frame('测试通过', 'rid-1', 'answer');
  const answer = parseSSE(f1 + f2 + f3 + doneFrame('rid-1'));
  assert(answer === '测试通过', 'answer 正常，实际=' + JSON.stringify(answer));
}

console.log('\n========================================');
if (failures === 0) console.log('全部通过 ✅ 双份回复/半截块/增量截断/[DONE]误判 均已修复');
else { console.log(failures + ' 项失败 ❌'); process.exit(1); }
