// 隔离测试：mock CDP，验证未知模型不再被 400 拒绝，且回显请求名
process.env.API_PORT = '3226';
const cdp = require('./cdp-controller');
const captured = [];
cdp.executeChat = async (sid, message, opts) => {
  captured.push(opts && opts.model); // 记录每个请求传给控制器的 model
  return { content: 'ok' };
};
require('./api-server');

const http = require('http');
function post(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: 'localhost', port: 3226, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    req.write(data); req.end();
  });
}

(async () => {
  const r1 = await post({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  const j1 = JSON.parse(r1.body);
  const r2 = await post({ model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'hi' }] });
  const j2 = JSON.parse(r2.body);
  const r3 = await post({ messages: [{ role: 'user', content: 'hi' }] });
  const j3 = JSON.parse(r3.body);

  console.log('[1] gpt-4o          status=', r1.status, 'echo=', j1.model, 'ctrl.model=', captured[0]);
  console.log('[2] deepseek-reasoner status=', r2.status, 'echo=', j2.model, 'ctrl.model=', captured[1]);
  console.log('[3] (no model)     status=', r3.status, 'echo=', j3.model, 'ctrl.model=', captured[2]);

  const pass =
    r1.status === 200 && j1.model === 'gpt-4o' && captured[0] === 'gpt-4o' &&
    r2.status === 200 && j2.model === 'deepseek-reasoner' && captured[1] === 'deepseek-reasoner' &&
    r3.status === 200 && j3.model === 'deepseek-web' && captured[2] === 'deepseek-web';
  console.log(pass ? '\nROUTE_NO_RESTRICT_OK' : '\nROUTE_TEST_FAILED');
  process.exit(pass ? 0 : 1);
})();
