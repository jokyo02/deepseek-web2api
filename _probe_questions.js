'use strict';
const tu = require('./tooluse.js');

// 用户贴的原始块（注意畸形闭合标签 </<|TOOLSXML|...>）
const block = `<|TOOLSXML|tool_calls>
  <|TOOLSXML|invoke name="AskUserQuestion">
    <|TOOLSXML|parameter name="questions"><![CDATA[[{"question":"接下来您希望我为您生成哪一类具体文案成品？请选择一项，我会立即输出。","header":"选择产出方向","options":[{"label":"A. 3条完整视频脚本","description":"含标题、钩子、口播词"},{"label":"B. 30天选题日历","description":"每日选题+推荐标题"}]},{"question":"您是否有具体的产品/服务卖点需要植入文案？","header":"产品信息","options":[{"label":"有，我会在下一条消息中说明","description":"请先说明产品详情"},{"label":"暂无，先按通用模板生成","description":"后续可再定制"}]}]]]></<|TOOLSXML|parameter>
  </<|TOOLSXML|invoke>
</<|TOOLSXML|tool_calls>`;

console.log('=== 原始块 ===');
console.log(block);
console.log('\n=== fixMalformedDsml 后 ===');
console.log(tu.fixMalformedDsml(block));
console.log('\n=== parseToolOutput 结果 ===');
const p = tu.parseToolOutput(block);
console.log('toolCalls 数量:', p.toolCalls.length);
for (const tc of p.toolCalls) {
  console.log('工具名:', tc.function.name);
  console.log('arguments:', tc.function.arguments);
  const args = JSON.parse(tc.function.arguments || '{}');
  console.log('questions 类型:', Array.isArray(args.questions) ? '数组 ✓' : typeof args.questions + ' ✗');
  if (typeof args.questions === 'string') {
    console.log('questions 字符串内容:', JSON.stringify(args.questions).slice(0, 200));
  }
}
console.log('正文 text:', JSON.stringify(p.text));
