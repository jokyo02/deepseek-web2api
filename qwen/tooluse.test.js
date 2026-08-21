// tooluse.test.js —— 纯逻辑单元测试（无需 Chrome，直接 node 运行）
// 覆盖：DSML 解析、多 invoke、CDATA 特殊字符、自动类型、旧格式兼容、ToolStreamSieve 流分离。

'use strict';
const assert = require('assert');
const t = require('./tooluse');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('— parseToolOutput —');

check('正文 + 单个 DSML 工具调用 共存（修复 XOR bug）', () => {
  const content =
    '我先帮你查一下天气。\n<|DSML|tool_calls>\n' +
    '  <|DSML|invoke name="get_weather">\n' +
    '    <|DSML|parameter name="location"><![CDATA[北京]]></|DSML|parameter>\n' +
    '  </|DSML|invoke>\n</|DSML|tool_calls>';
  const { text, toolCalls } = t.parseToolOutput(content);
  assert.strictEqual(toolCalls.length, 1);
  assert.strictEqual(toolCalls[0].function.name, 'get_weather');
  assert.deepStrictEqual(toolCalls[0].function.arguments, JSON.stringify({ location: '北京' }));
  assert.ok(text.includes('我先帮你查一下天气'), `正文应保留，实际: "${text}"`);
  assert.ok(!text.includes('DSML'), '正文不应残留 DSML 标签');
});

check('多个 invoke 同块', () => {
  const content =
    '<|DSML|tool_calls>\n' +
    '  <|DSML|invoke name="a"><|DSML|parameter name="x"><![CDATA[1]]></|DSML|parameter></|DSML|invoke>\n' +
    '  <|DSML|invoke name="b"><|DSML|parameter name="y"><![CDATA[2]]></|DSML|parameter></|DSML|invoke>\n' +
    '</|DSML|tool_calls>';
  const { toolCalls } = t.parseToolOutput(content);
  assert.strictEqual(toolCalls.length, 2);
  assert.strictEqual(toolCalls[0].function.name, 'a');
  assert.strictEqual(toolCalls[1].function.name, 'b');
});

check('CDATA 含特殊字符（引号/花括号/换行）', () => {
  const val = '{"a":1, "b":"x"}\n含"引号"';
  const content =
    `<|DSML|tool_calls><|DSML|invoke name="echo">` +
    `<|DSML|parameter name="text"><![CDATA[${val}]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>`;
  const { toolCalls } = t.parseToolOutput(content);
  assert.strictEqual(toolCalls.length, 1);
  assert.deepStrictEqual(JSON.parse(toolCalls[0].function.arguments), { text: val });
});

check('参数值自动类型转换（数字/布尔/null）', () => {
  const content =
    '<|DSML|tool_calls><|DSML|invoke name="calc">' +
    '<|DSML|parameter name="n">42</|DSML|parameter>' +
    '<|DSML|parameter name="flag">true</|DSML|parameter>' +
    '<|DSML|parameter name="z">null</|DSML|parameter>' +
    '</|DSML|invoke></|DSML|tool_calls>';
  const { toolCalls } = t.parseToolOutput(content);
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.strictEqual(args.n, 42);
  assert.strictEqual(args.flag, true);
  assert.strictEqual(args.z, null);
});

check('纯正文（无工具调用）自动剥离思考块', () => {
  const content = '<think>让我想想</think>这是普通回答';
  const { text, toolCalls } = t.parseToolOutput(content);
  assert.strictEqual(toolCalls.length, 0);
  assert.strictEqual(text, '这是普通回答');
});

check('旧版 __TOOL_CALL__ 格式向后兼容', () => {
  const content = '__TOOL_CALL__{"name":"old_tool","arguments":{"q":"hi"}}__END__';
  const { toolCalls } = t.parseToolOutput(content);
  assert.strictEqual(toolCalls.length, 1);
  assert.strictEqual(toolCalls[0].function.name, 'old_tool');
  assert.deepStrictEqual(JSON.parse(toolCalls[0].function.arguments), { q: 'hi' });
});

check('DSML 与旧格式混用均被抽取，正文保留', () => {
  const content =
    '说明一下：\n__TOOL_CALL__{"name":"a","arguments":{}}__END__\n' +
    '<|DSML|tool_calls><|DSML|invoke name="b"><|DSML|parameter name="x"><![CDATA[1]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>';
  const { text, toolCalls } = t.parseToolOutput(content);
  const names = toolCalls.map((c) => c.function.name).sort();
  assert.deepStrictEqual(names, ['a', 'b']);
  assert.ok(text.includes('说明一下'), `正文应保留，实际: "${text}"`);
});

console.log('— ToolStreamSieve —');

check('增量喂入：先正文后工具调用 → text 事件先于 tool_calls', () => {
  const sieve = new t.ToolStreamSieve((buf) => t.parseToolOutput(buf));
  const events = [];
  // 模型边生成边吐：先 "让我查一下" 再开始工具块
  events.push(...sieve.feed('让我查一下'));
  events.push(...sieve.feed('\n<|DSML|tool_calls>\n  <|DSML|invoke name="get_weather">'));
  events.push(...sieve.feed('<|DSML|parameter name="location"><![CDATA[北京]]></|DSML|parameter>'));
  events.push(...sieve.feed('</|DSML|invoke>\n</|DSML|tool_calls>'));
  events.push(...sieve.flush());
  const types = events.map((e) => e.type);
  assert.ok(types.includes('text'), '应有 text 事件');
  assert.ok(types.includes('tool_calls'), '应有 tool_calls 事件');
  const textEvent = events.find((e) => e.type === 'text');
  assert.ok(textEvent.data.includes('让我查一下'), '正文事件应含前缀文本');
  const tcEvent = events.find((e) => e.type === 'tool_calls');
  assert.strictEqual(tcEvent.data[0].function.name, 'get_weather');
});

check('未闭合工具块不提前吐出（避免把标签当正文）', () => {
  const sieve = new t.ToolStreamSieve((buf) => t.parseToolOutput(buf));
  // 喂入一个不完整的工具块（无闭合标签）
  const ev1 = sieve.feed('<|DSML|tool_calls>\n  <|DSML|invoke name="x">');
  // 在闭合前不应产生任何事件（标签尚未完成）
  assert.strictEqual(ev1.length, 0, '未闭合时不应有任何事件');
  const ev2 = sieve.feed('<|DSML|parameter name="y"><![CDATA[ok]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>');
  const tc = ev2.find((e) => e.type === 'tool_calls');
  assert.ok(tc, '闭合后应产生 tool_calls 事件');
  assert.strictEqual(tc.data[0].function.name, 'x');
});

check('普通文本含 < 不误判为工具（如 "1 < 2"）', () => {
  const sieve = new t.ToolStreamSieve((buf) => t.parseToolOutput(buf));
  const ev = sieve.feed('比较：1 < 2 成立');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].type, 'text');
  assert.strictEqual(ev[0].data, '比较：1 < 2 成立');
});

check('缓冲上限：异常超长未闭合 → 强制当正文吐出', () => {
  // 构造上限取 1024（与构造函数下限一致）；喂入远超该长度的未闭合内容触发强制吐出
  const sieve = new t.ToolStreamSieve((buf) => t.parseToolOutput(buf), 1024);
  sieve.feed('<|DSML|tool_calls>');
  const ev = sieve.feed('x'.repeat(2000)); // 远超 1024 上限
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].type, 'text');
});

console.log('— buildToolInstruction —');

check('tool_choice=none 不注入', () => {
  assert.strictEqual(t.buildToolInstruction([{ type: 'function', function: { name: 'a' } }], 'none'), '');
});

check('required 含强制调用指令 + 工具清单', () => {
  const ins = t.buildToolInstruction(
    [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } } }],
    'required'
  );
  assert.ok(ins.includes('<|DSML|tool_calls>'));
  assert.ok(ins.includes('必须调用'));
  assert.ok(ins.includes('- get_weather: 查天气'));
  assert.ok(ins.includes('location:string(必填)'));
});

// —— 真实故障回归：模型把结束标签写成 </<|DSML|X>（多一个 <）——
console.log('— 真实故障回归：结束标签双 < 容错 —');

check('fixMalformedDsml 把 </< 归一化为 </', () => {
  assert.strictEqual(
    t.fixMalformedDsml('</<|DSML|parameter>abc</<|DSML|invoke>'),
    '</|DSML|parameter>abc</|DSML|invoke>'
  );
  // 正确写法不受影响
  assert.strictEqual(t.fixMalformedDsml('</|DSML|parameter>'), '</|DSML|parameter>');
});

const MALFORMED_REPLY = [
  '<|DSML|tool_calls>',
  '  <|DSML|invoke name="ask_user_question">',
  '    <|DSML|parameter name="questions"><![CDATA[',
  '[',
  '  {',
  '    "id": "q1",',
  '    "question": "您想计算距离哪个具体日期还有多久？"',
  '  },',
  '  {',
  '    "id": "q2",',
  '    "question": "您是想先获取当前精确时间吗？"',
  '  },',
  '  {',
  '    "id": "q3",',
  '    "question": "您是否想查询某个未来公开事件？"',
  '  },',
  '  {',
  '    "id": "q4",',
  '    "question": "如果指的未来的抽象概念请明确。"',
  '  }',
  ']',
  ']]></<|DSML|parameter>',
  '  </<|DSML|invoke>',
  '</<|DSML|tool_calls>',
].join('\n');

check('双 < 结束标签的回复能被正确解析为 tool_calls（不泄漏原样正文）', () => {
  const { toolCalls, text } = t.parseToolOutput(MALFORMED_REPLY);
  assert.strictEqual(toolCalls.length, 1, '应解析出 1 个工具调用');
  assert.strictEqual(toolCalls[0].function.name, 'ask_user_question');
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.ok(Array.isArray(args.questions), 'questions 应为数组');
  assert.strictEqual(args.questions.length, 4);
  assert.strictEqual(args.questions[0].id, 'q1');
  // 整段 DSML 不应残留在正文里
  assert.ok(!text.includes('<|DSML|'), '正文不应残留 DSML 标签');
});

check('双 < 结束标签在流式筛分下也能正确闭合并产出 tool_calls', () => {
  const sieve = new t.ToolStreamSieve((buf) => t.parseToolOutput(buf));
  // 逐字符/分块喂入（模拟流式），含双 < 结束标签
  const chunks = MALFORMED_REPLY.match(/[\s\S]{1,12}/g) || [MALFORMED_REPLY];
  let gotToolCalls = null;
  chunks.forEach((c) => {
    sieve.feed(c).forEach((ev) => {
      if (ev.type === 'tool_calls') gotToolCalls = ev.data;
    });
  });
  sieve.flush().forEach((ev) => {
    if (ev.type === 'tool_calls') gotToolCalls = ev.data;
  });
  assert.ok(gotToolCalls, '流式应产出 tool_calls 事件');
  assert.strictEqual(gotToolCalls.length, 1);
  assert.strictEqual(gotToolCalls[0].function.name, 'ask_user_question');
});

// —— 按需注入控制：HI,TOOLS 会话级一次性注入 ——
console.log('— 按需注入控制：HI,TOOLS 会话级一次性注入 —');

check('detectToolArm: 用户消息含 HI,TOOLS 命中', () => {
  assert.strictEqual(
    t.detectToolArm([{ role: 'user', content: '北京天气？' }, { role: 'user', content: 'HI,TOOLS' }]),
    true
  );
});

check('detectToolArm: 变体 HI, TOOLS（含空格）也命中', () => {
  assert.strictEqual(t.detectToolArm([{ role: 'user', content: 'hi, tools' }]), true);
});

check('detectToolArm: 无 HI,TOOLS 不命中', () => {
  assert.strictEqual(t.detectToolArm([{ role: 'user', content: '北京天气？' }]), false);
});

check('detectToolArm: 非 user 角色不命中', () => {
  assert.strictEqual(
    t.detectToolArm([{ role: 'assistant', content: 'HI,TOOLS' }, { role: 'system', content: 'HI,TOOLS' }]),
    false
  );
});

check('detectToolArm: 只认最后一次用户消息——历史含旧 HI,TOOLS 不误触发', () => {
  // 客户端带多轮历史：早期发过 HI,TOOLS，但最后一次用户消息是真实提问 → 不算握手
  assert.strictEqual(
    t.detectToolArm([
      { role: 'user', content: 'HI,TOOLS' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '北京天气怎么样？' },
    ]),
    false
  );
});

check('detectToolArm: 只认最后一次用户消息——最后一次才是 HI,TOOLS 则命中', () => {
  assert.strictEqual(
    t.detectToolArm([
      { role: 'user', content: '北京天气怎么样？' },
      { role: 'assistant', content: '稍等' },
      { role: 'user', content: 'HI,TOOLS' },
    ]),
    true
  );
});

check('detectToolArm: 最后一次用户消息在 tool 结果回传之后仍能识别', () => {
  // 模拟上一轮工具结果回传后，新回合用户消息是 HI,TOOLS
  assert.strictEqual(
    t.detectToolArm([
      { role: 'user', content: '北京天气怎么样？' },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '晴 25°C' },
      { role: 'user', content: 'HI,TOOLS' },
    ]),
    true
  );
});

check('detectToolArm: messages 非数组安全返回 false', () => {
  assert.strictEqual(t.detectToolArm(null), false);
  assert.strictEqual(t.detectToolArm(undefined), false);
});

check('stripToolArm: 剥离 HI,TOOLS 保留真实提问', () => {
  assert.strictEqual(t.stripToolArm('HI,TOOLS 北京天气怎么样？'), '北京天气怎么样？');
});

check('stripToolArm: 剥离带空格变体并规整空白', () => {
  assert.strictEqual(t.stripToolArm('  HI , TOOLS   查一下上海 '), '查一下上海');
});

check('stripToolArm: 纯指令剥离后为空串', () => {
  assert.strictEqual(t.stripToolArm('HI,TOOLS'), '');
  assert.strictEqual(t.stripToolArm('hi, tools'), '');
});

// —— 会话级一次性系统提示词注入（HI,TOOLS → 注入一次并防重复）——
console.log('— 会话级一次性注入（markPromptInjected / isPromptInjected / detectToolArm）—');

check('detectToolArm 命中后标记注入 → 同会话重复 HI,TOOLS 不再注入', () => {
  // 握手回合：识别到 HI,TOOLS → 调用方标记已注入
  assert.strictEqual(t.detectToolArm([{ role: 'user', content: 'HI,TOOLS' }]), true);
  assert.strictEqual(t.isPromptInjected('sess-A'), false);
  t.markPromptInjected('sess-A');
  assert.strictEqual(t.isPromptInjected('sess-A'), true);
  // 同会话再次发 HI,TOOLS（或任何请求）→ 已注入，调用方跳过注入
  assert.strictEqual(t.isPromptInjected('sess-A'), true);
});

check('未发过 HI,TOOLS 的会话从未注入', () => {
  assert.strictEqual(t.detectToolArm([{ role: 'user', content: '北京天气？' }]), false);
  assert.strictEqual(t.isPromptInjected('sess-B'), false);
});

check('markPromptInjected: 空/缺省 session_id 不写入（防污染）', () => {
  t.markPromptInjected('');
  t.markPromptInjected(null);
  t.markPromptInjected(undefined);
  assert.strictEqual(t.isPromptInjected(''), false);
  assert.strictEqual(t.isPromptInjected('null'), false);
  assert.strictEqual(t.isPromptInjected('undefined'), false);
});

check('markPromptInjected: 不同 session_id 互不影响（一次注入只归属一个会话）', () => {
  t.markPromptInjected('sess-D');
  assert.strictEqual(t.isPromptInjected('sess-D'), true);
  assert.strictEqual(t.isPromptInjected('sess-E'), false);
});

console.log(`\n通过 ${passed} 项断言。`);
