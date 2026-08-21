// _sse_selftest.js —— SSE 解析器自测（无需浏览器，纯离线验证 parseCompletionSSE）
//
// 覆盖 chat.qwen.ai 可能的两种 SSE 形态：
//   A. OpenAI 兼容增量格式（当前网页版主格式）：delta.content 逐帧追加，[DONE] 结束
//   B. DashScope 原生快照格式：output.choices[].message.content 每帧为完整回答，无 [DONE]
// 以及思考模式（delta.reasoning_content 应从回答中排除）与 finish_reason 结束检测。
//
// 运行：node _sse_selftest.js   （或 npm run selftest）

'use strict';

const { parseCompletionSSE, sseStreamFinished } = require('./cdp-controller');

let passed = 0;
let failed = 0;

function assertEqual(name, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`);
  }
}

function assertContains(name, actual, sub) {
  if (typeof actual === 'string' && actual.indexOf(sub) !== -1) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}\n    期望包含: ${JSON.stringify(sub)}\n    实际: ${JSON.stringify(actual)}`);
  }
}

console.log('[selftest] SSE 解析器自测开始\n');

// —— 用例 1：OpenAI 兼容增量格式（增量 delta，[DONE] 结尾）——
console.log('[1] OpenAI 兼容增量格式');
{
  const sse = [
    'data: {"id":"chatcmpl-a1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-a1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-a1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"，世界"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-a1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"！"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-a1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const out = parseCompletionSSE(sse);
  assertEqual('[1a] 增量拼接正确', out, '你好，世界！');
  assertEqual('[1b] finish_reason 结束检测', sseStreamFinished(sse), true);
}

// —— 用例 7：真实 Qwen v2 格式（2026-08-21 实测捕获，无 [DONE]/finish_reason，
//    结束帧为 delta.status="finished"，answer 为快照式）——
console.log('[7] 真实 Qwen v2 SSE（实测捕获）');
{
  const sse = [
    'data: {"response.created":{"chat_id":"c1","response_id":"r1","response_index":"0"}}',
    '',
    'data: {"choices": [{"delta": {"role": "assistant", "content": "", "phase": "thinking_summary", "extra": {"summary_thought": {"content": ["我先思考一下"]}}, "status": "typing"}}], "response_id": "r1"}',
    '',
    'data: {"choices": [{"delta": {"role": "assistant", "content": "", "phase": "thinking_summary", "status": "finished"}}], "response_id": "r1"}',
    '',
    'data: {"choices": [{"delta": {"role": "assistant", "content": "测试", "phase": "answer", "status": "typing"}}], "response_id": "r1"}',
    '',
    'data: {"choices": [{"delta": {"role": "assistant", "content": "测试通过", "phase": "answer", "status": "typing"}}], "response_id": "r1"}',
    '',
    'data: {"choices": [{"delta": {"content": "", "role": "assistant", "status": "finished", "phase": "answer"}}], "response_id": "r1"}',
    '',
  ].join('\n');
  const out = parseCompletionSSE(sse);
  assertEqual('[7a] 快照式 answer 去重正确', out, '测试通过');
  assertEqual('[7b] 思考内容被排除', out.indexOf('思考') === -1, true);
  assertEqual('[7c] delta.status="finished" 结束检测', sseStreamFinished(sse), true);
}

// —— 用例 8：status 仍在 typing 时不算结束 ——
console.log('[8] typing 中不算结束');
{
  const sse = [
    'data: {"choices": [{"delta": {"role": "assistant", "content": "进行中", "phase": "answer", "status": "typing"}}], "response_id": "r1"}',
    '',
    'data: {"choices": [{"delta": {"role": "assistant", "content": "进行中，继续", "phase": "answer", "status": "typing"}}], "response_id": "r1"}',
    '',
  ].join('\n');
  assertEqual('[8a] typing 帧不触发结束', sseStreamFinished(sse), false);
  assertEqual('[8b] 内容可解析', parseCompletionSSE(sse), '进行中，继续');
}

// —— 用例 2：DashScope 原生快照格式（每帧完整回答，无 [DONE]）——
console.log('[2] DashScope 原生快照格式');
{
  const sse = [
    'id:1',
    'event:result',
    ':HTTP_STATUS/200',
    'data:{"output":{"choices":[{"message":{"role":"assistant","content":"你"},"finish_reason":"null"}]},"usage":{"input_tokens":4,"output_tokens":1},"request_id":"r1"}',
    '',
    'id:2',
    'event:result',
    ':HTTP_STATUS/200',
    'data:{"output":{"choices":[{"message":{"role":"assistant","content":"你好"},"finish_reason":"null"}]},"usage":{"input_tokens":4,"output_tokens":2},"request_id":"r1"}',
    '',
    'id:3',
    'event:result',
    ':HTTP_STATUS/200',
    'data:{"output":{"choices":[{"message":{"role":"assistant","content":"你好世界"},"finish_reason":"stop"}]},"usage":{"input_tokens":4,"output_tokens":4},"request_id":"r1"}',
    '',
  ].join('\n');
  const out = parseCompletionSSE(sse);
  assertEqual('[2a] 快照模式去重正确（取最长完整回答）', out, '你好世界');
  assertEqual('[2b] 字符串 "null" 不算结束，stop 才算', sseStreamFinished(sse), true);
}

// —— 用例 3：思考模式（reasoning_content 排除，delta.content 正常）——
console.log('[3] 思考模式（reasoning_content 排除）');
{
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"让我想想这个问题"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"首先分析条件"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"答案是"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":" 42"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const out = parseCompletionSSE(sse);
  assertEqual('[3a] 回答不包含思考内容', out, '答案是 42');
  const noReasoning = out.indexOf('让我想想') === -1;
  assertEqual('[3b] 回答确实不含 reasoning 文本', noReasoning, true);
}

// —— 用例 4：顶层简化形态 + 代码块（多行 data，反引号不破坏）——
console.log('[4] 代码块与顶层 content');
{
  const sse = [
    'data: {"content":"下面是代码：\\n```python\\nprint(1)\\n```\\n"}',
    '',
    'data: {"content":"完"}',
    '',
    'data: {"content":""}',
    '',
  ].join('\n');
  const out = parseCompletionSSE(sse);
  assertContains('[4a] 代码块保留', out, '```python');
  assertContains('[4b] 多帧增量拼接', out, '完');
}

// —— 用例 5：混合增量（非前缀追加的场景：增量模式）——
console.log('[5] 增量模式（帧间无包含关系）');
{
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"B"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"C"},"finish_reason":null}]}',
    '',
  ].join('\n');
  const out = parseCompletionSSE(sse);
  assertEqual('[5a] 纯增量拼接', out, 'ABC');
}

// —— 用例 6：空/垃圾输入不崩溃 ——
console.log('[6] 异常输入容错');
{
  assertEqual('[6a] 空串返回 null', parseCompletionSSE(''), null);
  assertEqual('[6b] null 返回 null', parseCompletionSSE(null), null);
  assertEqual('[6c] 非 JSON data 行忽略', parseCompletionSSE('data: hello\n\ndata: [DONE]\n'), null);
  assertEqual('[6d] 垃圾文本不崩溃', parseCompletionSSE('some random text without data'), null);
}

console.log(`\n[selftest] 完成：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
