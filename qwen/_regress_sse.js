// 回归测试：验证 SSE 思考/回答两阶段流的修复
const fs = require('fs');
const path = require('path');
const ctrl = require('./cdp-controller.js');

const ssePath = path.join(__dirname, '_captured_sse.txt');
// 文件为中文 GBK，按 utf8 读取会出现乱码，但 JSON 结构与 content 字段位置不受影响，足够验证逻辑
let body = fs.readFileSync(ssePath, 'utf8');

const parseCompletionSSE = ctrl.parseCompletionSSE;
const sseStreamFinished = ctrl.sseStreamFinished;

// 构造「思考刚结束、回答尚未开始」的中间态：取第一个 answer 帧之前的所有内容
const ansIdx = body.indexOf('"phase": "answer"');
const thinkingOnly = body.slice(0, ansIdx > 0 ? ansIdx : body.length);

console.log('=== 1) 思考阶段结束帧（不含回答）时，流是否误判结束？ ===');
console.log('   期望: false (不能在思考结束就终止)');
console.log('   实际: sseStreamFinished(thinkingOnly) =', sseStreamFinished(thinkingOnly));

console.log('\n=== 2) 完整流（含回答）是否最终结束？ ===');
console.log('   期望: true');
console.log('   实际: sseStreamFinished(body) =', sseStreamFinished(body));

console.log('\n=== 3) 解析出的回答内容是否只含真实回答（排除思考）？ ===');
const ans = parseCompletionSSE(body);
console.log('   期望: 非空且不含"已完成/思考/跳过"等思考文案');
console.log('   实际长度:', ans ? ans.length : 0);
console.log('   实际内容(乱码因GBK):', ans);
const bad = ans && /(跳过|思考|已经完成|finished|thinking)/i.test(ans);
console.log('   是否混入思考文案/跳过:', !!bad);

console.log('\n=== 结论 ===');
const ok1 = sseStreamFinished(thinkingOnly) === false;
const ok2 = sseStreamFinished(body) === true;
const ok3 = ans && ans.length > 0 && !bad;
console.log('思考阶段不误终止:', ok1 ? 'PASS' : 'FAIL');
console.log('完整流能结束    :', ok2 ? 'PASS' : 'FAIL');
console.log('只提取真实回答  :', ok3 ? 'PASS' : 'FAIL');
console.log(ok1 && ok2 && ok3 ? '\nALL PASS ✅' : '\nSOME FAILED ❌');
