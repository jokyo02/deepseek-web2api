'use strict';
// deepseek-cdp-bridge 防重复回答回归测试（移植自 qwen-cdp 2026-08-25 修复）
// 覆盖：分片创建帧重发去重 / 快照取长 / FINISHED 判定独立帧 / sieve 重复事件 / 工具块去重
const ctrl = require('./cdp-controller.js');
const tu = require('./tooluse.js');
const parseSSE = ctrl.parseCompletionSSE;
const sseFin = ctrl.sseStreamFinishedDs;
const hasClose = ctrl.hasCloseLine;
const parseTool = tu.parseToolOutput;

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  PASS:', msg); }
  else { console.log('  FAIL:', msg); failures++; }
}

// —— DeepSeek 分片格式帧构造 ——
function fragFrame(fragments) {
  return `data: ${JSON.stringify({ p: 'response/fragments', o: 'APPEND', v: fragments })}\n\n`;
}
function incFrame(v) {
  return `data: ${JSON.stringify({ v })}\n\n`;
}
function snapFrame(fragments) {
  return `data: ${JSON.stringify({ v: { response: { fragments } } })}\n\n`;
}
function statusFrame(status = 'FINISHED') {
  return `data: ${JSON.stringify({ p: 'response/status', o: 'SET', v: status })}\n\n`;
}
function doneFrame() {
  return statusFrame('FINISHED');
}

console.log('\n=== D1: 正常增量拼接（分片创建 + 多段增量）===');
{
  const sse =
    fragFrame([{ id: 1, type: 'RESPONSE', content: '你好' }]) +
    incFrame('，世界') +
    incFrame('。测试完成') +
    doneFrame();
  const a = parseSSE(sse);
  assert(a === '你好，世界。测试完成', '增量完整拼接，实际=' + JSON.stringify(a));
}

console.log('\n=== D2: 【核心】分片创建帧重发 → 初始 content 只拼一次（不翻倍）===');
{
  const sse =
    fragFrame([{ id: 1, type: 'RESPONSE', content: '你好' }]) +
    fragFrame([{ id: 1, type: 'RESPONSE', content: '你好' }]) + // 同一分片 id 重发
    incFrame('，世界') +
    doneFrame();
  const a = parseSSE(sse);
  assert(a === '你好，世界', '重发分片不翻倍，实际=' + JSON.stringify(a));
}

console.log('\n=== D3: 快照取长（增量被截断时快照兜底）===');
{
  const sse =
    fragFrame([{ id: 1, type: 'RESPONSE', content: '你好' }]) +
    snapFrame([{ id: 1, type: 'RESPONSE', content: '你好，完整的快照内容' }]) +
    doneFrame();
  const a = parseSSE(sse);
  assert(a === '你好，完整的快照内容', '快照兜底取最长，实际=' + JSON.stringify(a));
}

console.log('\n=== D4: THINK 分片不进 answer ===');
{
  const sse =
    fragFrame([
      { id: 0, type: 'THINK', content: '用户想让我说你好' },
      { id: 1, type: 'RESPONSE', content: '你好' },
    ]) +
    doneFrame();
  const a = parseSSE(sse);
  assert(a === '你好', 'THINK 内容被排除，实际=' + JSON.stringify(a));
}

console.log('\n=== D5: answer 内容含 FINISHED 字样 → 不提前截断 ===');
{
  // 注意：这里刻意**不含**真正的结束帧——内容里的 FINISHED 字样不应算结束信号
  const sse = fragFrame([{ id: 1, type: 'RESPONSE', content: '结果是 FINISHED 标记' }]) + incFrame('，这是正常输出');
  assert(sseFin(sse) === false, 'FINISHED 字样在内容里不算结束信号');
  const a = parseSSE(sse + doneFrame());
  assert(a && a.includes('FINISHED'), '回复完整保留 FINISHED 字样');
}

console.log('\n=== D6: 真正的 FINISHED 状态帧才算结束 ===');
{
  assert(sseFin(doneFrame()) === true, 'response/status SET FINISHED → true');
  assert(sseFin('data: {"p":"response/status","o":"SET","v":"IN_PROGRESS"}\n\n') === false, 'IN_PROGRESS → false');
  assert(sseFin('data: {"v":"普通文本 FINISHED"}\n\n') === false, '内容里的 FINISHED → false');
  assert(hasClose('event: close\n\n') === true, '独立行 event: close → true');
  assert(hasClose('内容是 event: close 字样') === false, '内容里的 event: close → false');
}

console.log('\n=== D7: 快照相同内容去重（重发快照不干扰取最长）===');
{
  const snap = snapFrame([{ id: 1, type: 'RESPONSE', content: '完整快照内容' }]);
  const sse = fragFrame([{ id: 1, type: 'RESPONSE', content: '你好' }]) + snap + snap + doneFrame();
  const a = parseSSE(sse);
  assert(a === '完整快照内容', '重发快照仍取最长且无重复，实际=' + JSON.stringify(a));
}

// —— TOOLSXML 工具块 ——
const Q = JSON.stringify({ question: '行业?', options: ['A', 'B'] });
const fullBlock =
`<|TOOLSXML|tool_calls>
  <|TOOLSXML|invoke name="search">
    <|TOOLSXML|parameter name="query"><![CDATA[${Q}]]></|TOOLSXML|parameter>
  </|TOOLSXML|invoke>
</|TOOLSXML|tool_calls>`;

console.log('\n=== D8: parseToolOutput 双完整块去重为 1 ===');
{
  const p = parseTool(fullBlock + '\n' + fullBlock);
  assert(p.toolCalls.length === 1, '两份相同完整块去重为 1，实际=' + p.toolCalls.length);
}

console.log('\n=== D9: sieve 无条件转换（正文 + 工具块，不重复）===');
{
  const lead = '好的，我来查一下。\n';
  const full = lead + fullBlock;
  const sieve = new tu.ToolStreamSieve((buf) => tu.parseToolOutput(buf));
  const events = [];
  for (let i = 0; i < full.length; i += 7) {
    events.push(...sieve.feed(full.slice(i, i + 7)));
  }
  events.push(...sieve.flush());
  const texts = events.filter((e) => e.type === 'text' && e.data).map((e) => e.data).join('');
  const toolEvts = events.filter((e) => e.type === 'tool_calls' && e.data && e.data.length);
  assert(texts.includes('好的，我来查一下。'), '正文作为 text 事件完整吐出');
  assert(!texts.includes('<|TOOLSXML|tool_calls>'), 'TOOLSXML 原文未混入正文');
  assert(toolEvts.length === 1, 'tool_calls 事件恰好 1 次（不重复），实际=' + toolEvts.length);
  if (toolEvts.length) {
    assert(toolEvts[0].data[0].function.name === 'search', '工具名 search');
  }
}

console.log('\n=== D10: sieve 极碎片（3 字符）仍不重复 ===');
{
  const lead = '查一下：\n';
  const full = lead + fullBlock;
  const sieve = new tu.ToolStreamSieve((buf) => tu.parseToolOutput(buf));
  const events = [];
  for (let i = 0; i < full.length; i += 3) {
    events.push(...sieve.feed(full.slice(i, i + 3)));
  }
  events.push(...sieve.flush());
  const toolEvts = events.filter((e) => e.type === 'tool_calls' && e.data && e.data.length);
  assert(toolEvts.length === 1, '极碎片下 tool_calls 恰好 1 次，实际=' + toolEvts.length);
}

console.log('\n=== D11: sieve 纯文本不误转 ===');
{
  const sieve = new tu.ToolStreamSieve((buf) => tu.parseToolOutput(buf));
  const events = [];
  events.push(...sieve.feed('你好，这是普通回复，没有工具调用。'));
  events.push(...sieve.flush());
  const texts = events.filter((e) => e.type === 'text' && e.data).map((e) => e.data).join('');
  const toolEvts = events.filter((e) => e.type === 'tool_calls');
  assert(texts === '你好，这是普通回复，没有工具调用。', '纯文本原样透传');
  assert(toolEvts.length === 0, '无工具块 → 无 tool_calls 事件');
}

console.log('\n========================================');
if (failures === 0) console.log('全部通过 ✅ deepseek 防重复修复已验证');
else { console.log(failures + ' 项失败 ❌'); process.exit(1); }
