// 回归测试：验证 extractToolCalls 对各类"未完全解析"场景的健壮性
const tu = require('./tooluse.js');
const extractToolCalls = tu.extractToolCalls;

let pass = 0, fail = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  cond ? pass++ : fail++;
}

// 1) 用户报的现场：结尾只写了 __END（无尾部下划线）→ 旧逻辑泄漏，应正确抽出
const case1 = `__TOOL_CALL__{"name":"ask_user_question","arguments":{"questions":[{"id":"task_type_001","question":"请问您希望我协助您完成什么类型的任务？","header":"选择任务类型","options":[{"label":"代码开发与调试","description":"编写、审查或修复代码。"},{"label":"文档撰写与编辑","description":"创建、总结或修改文本内容。"}]}]}}__END`;
const r1 = extractToolCalls(case1);
check('case1: 漏写尾部下划线的 __END 能被解析', !!r1 && r1.length === 1 && r1[0].name === 'ask_user_question');
check('case1: arguments 为对象且含 1 个 questions、其 options 为 2 项', r1 && Array.isArray(r1[0].arguments.questions) && r1[0].arguments.questions.length === 1 && Array.isArray(r1[0].arguments.questions[0].options) && r1[0].arguments.questions[0].options.length === 2);

// 2) 规范格式 __END__（双尾部下划线）
const case2 = `__TOOL_CALL__{"name":"get_weather","arguments":{"city":"北京"}}__END__`;
const r2 = extractToolCalls(case2);
check('case2: 规范 __END__ 能被解析', !!r2 && r2[0].name === 'get_weather' && r2[0].arguments.city === '北京');

// 3) 带 ```json 围栏
const case3 = "好的，我调用工具：\n```json\n__TOOL_CALL__{\"name\":\"search\",\"arguments\":{\"q\":\"test\"}}__END__\n```\n已完成。";
const r3 = extractToolCalls(case3);
check('case3: 带 ```json 围栏能被解析', !!r3 && r3[0].name === 'search' && r3[0].arguments.q === 'test');

// 4) JSON 含尾逗号（模型常见）→ 容错修复
const case4 = `__TOOL_CALL__{"name":"foo","arguments":{"a":1,}}__END__`;
const r4 = extractToolCalls(case4);
check('case4: 尾逗号 JSON 能被修复解析', !!r4 && r4[0].name === 'foo' && r4[0].arguments.a === 1);

// 5) arguments 是 JSON 字符串（字符串化）→ 归一为对象
const case5 = `__TOOL_CALL__{"name":"bar","arguments":"{\\"x\\":2}"}__END__`;
const r5 = extractToolCalls(case5);
check('case5: 字符串化 arguments 归一为对象', !!r5 && typeof r5[0].arguments === 'object' && r5[0].arguments.x === 2);

// 6) 无工具调用 → null（不应误报）
const r6 = extractToolCalls('这是一段普通回复，没有工具调用。');
check('case6: 普通文本返回 null', r6 === null);

// 7) 连续两个工具调用
const case7 = `__TOOL_CALL__{"name":"a","arguments":{}}__END____TOOL_CALL__{"name":"b","arguments":{}}__END__`;
const r7 = extractToolCalls(case7);
check('case7: 多个工具调用全部抽出', !!r7 && r7.length === 2 && r7[0].name === 'a' && r7[1].name === 'b');

console.log(`\n结果: ${pass} PASS, ${fail} FAIL`);
console.log(fail === 0 ? 'ALL PASS ✅' : 'SOME FAILED ❌');
process.exit(fail === 0 ? 0 : 1);
