'use strict';
// 验证「无条件转换」：即使请求未带 tools 参数，DSML 工具块也必须转成 OpenAI tool_calls。
// 用用户网页端的真实文本（正文 + read_me 块）测试。
const tu = require('./tooluse.js');
const parseTool = tu.parseToolOutput;

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  PASS:', msg); }
  else { console.log('  FAIL:', msg); failures++; }
}

// —— 用户网页端真实内容 ——
const lead = `你好！我是内容创作专家。缺乏系统规划是导致内容团队“想到什么写什么”、最终陷入流量瓶颈和团队内耗的核心原因。\n\n为了将这套通用框架转化为专属落地方案，我需要向您了解一些具体信息。`;
const toolBlock =
`<|DSML|tool_calls>
  <|DSML|invoke name="read_me">
    <|DSML|parameter name="modules"><![CDATA[["diagram", "chart"]]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`;
const full = lead + '\n\n' + toolBlock;

console.log('\n=== 场景A: stream 路径——sieve 无条件转换（正文 + read_me 块）===');
{
  const sieve = new tu.ToolStreamSieve((buf) => tu.parseToolOutput(buf));
  const events = [];
  // 模拟流式：分片喂入（块被拆成多片）
  const chunkSize = 25;
  for (let i = 0; i < full.length; i += chunkSize) {
    events.push(...sieve.feed(full.slice(i, i + chunkSize)));
  }
  events.push(...sieve.flush());

  const texts = events.filter((e) => e.type === 'text' && e.data).map((e) => e.data).join('');
  const toolEvts = events.filter((e) => e.type === 'tool_calls' && e.data && e.data.length);

  assert(texts.includes('内容创作专家'), '正文被作为 text 事件完整吐出');
  assert(!texts.includes('<|DSML|tool_calls>'), 'DSML 原文未混入正文（无截断/透传）');
  assert(toolEvts.length === 1, 'tool_calls 事件恰好 1 次，实际=' + toolEvts.length);
  if (toolEvts.length) {
    const calls = toolEvts[0].data;
    assert(calls.length === 1, 'read_me 调用 1 个，实际=' + calls.length);
    assert(calls[0].function.name === 'read_me', '工具名 read_me，实际=' + calls[0].function.name);
    const args = JSON.parse(calls[0].function.arguments || '{}');
    assert(Array.isArray(args.modules) && args.modules[0] === 'diagram' && args.modules[1] === 'chart',
      '参数 modules=["diagram","chart"] 正确解析');
  }
}

console.log('\n=== 场景B: stream 路径——纯文本不误转 ===');
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

console.log('\n=== 场景C: json 路径——parseToolOutput 无条件转换 ===');
{
  const p = parseTool(full);
  assert(p.toolCalls.length === 1, 'toolCalls 数量=1（无 tools 参数也解析），实际=' + p.toolCalls.length);
  assert(p.toolCalls[0].function.name === 'read_me', '工具名 read_me');
  const args = JSON.parse(p.toolCalls[0].function.arguments || '{}');
  assert(JSON.stringify(args.modules) === JSON.stringify(['diagram', 'chart']), 'modules 参数完整');
  assert(p.text.includes('内容创作专家') && !p.text.includes('<|DSML|tool_calls>'), '正文清理后保留且无 DSML 原文');
}

console.log('\n=== 场景D: json 路径——纯文本原样（无工具块）===');
{
  const p = parseTool('你好，这是普通回复。');
  assert(p.toolCalls.length === 0, '无工具块 → toolCalls=0');
}

console.log('\n=== 场景E: 工具块被拆成极碎片（每片 3 字符）——sieve 流式鲁棒性 ===');
{
  const sieve = new tu.ToolStreamSieve((buf) => tu.parseToolOutput(buf));
  const events = [];
  for (let i = 0; i < full.length; i += 3) {
    events.push(...sieve.feed(full.slice(i, i + 3)));
  }
  events.push(...sieve.flush());
  const texts = events.filter((e) => e.type === 'text' && e.data).map((e) => e.data).join('');
  const toolEvts = events.filter((e) => e.type === 'tool_calls' && e.data && e.data.length);
  assert(texts.includes('内容创作专家'), '极碎分片下正文仍完整');
  assert(toolEvts.length === 1 && toolEvts[0].data[0].function.name === 'read_me', '极碎分片下工具仍被识别');
}

console.log('\n========================================');
if (failures === 0) console.log('全部通过 ✅ 无条件转换已生效');
else { console.log(failures + ' 项失败 ❌'); process.exit(1); }
