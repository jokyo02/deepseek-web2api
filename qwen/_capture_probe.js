// _capture_probe.js —— 原始捕获：注入+发送一条消息，完整抓取 completion SSE 存盘，
// 并 dump 发送后页面 DOM 容器结构，用于校准解析器与兜底选择器
'use strict';

const CDP = require('chrome-remote-interface');
const fs = require('fs');

const CDP_PORT = 9222;
const MESSAGE = '请回复三个字：测试通过';

async function evalJS(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const targets = await CDP.List({ port: CDP_PORT });
  const page = targets.find((t) => t.type === 'page' && /qwen\.ai/.test(t.url));
  console.log('页面:', page && page.url);
  const client = await CDP({ target: page, port: CDP_PORT });
  const { Runtime, Network } = client;
  await Promise.all([Runtime.enable(), Network.enable()]);

  // —— Network 捕获：只记 completion 请求的原始响应 ——
  let completionRid = null;
  let accum = '';
  Network.requestWillBeSent((p) => {
    const url = (p.request && p.request.url) || '';
    if (/chat\.qwen\.ai\/api/.test(url) && /completions|completion/i.test(url)) {
      completionRid = p.requestId;
      accum = '';
      console.log('>> 锁定 completion:', url);
    }
  });
  Network.dataReceived((p) => {
    if (p.requestId !== completionRid || typeof p.data !== 'string') return;
    accum += Buffer.from(p.data, 'base64').toString('utf8');
  });
  Network.loadingFinished(async (p) => {
    if (p.requestId !== completionRid) return;
    try {
      const { body, base64Encoded } = await Network.getResponseBody({ requestId: p.requestId });
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
      if (text.length > accum.length) accum = text;
      fs.writeFileSync('_captured_sse.txt', accum, 'utf8');
      console.log('>> completion 结束，SSE 已存盘，长度', accum.length);
    } catch (e) { console.log('>> getResponseBody 失败:', e.message); }
  });

  // —— 注入 + 发送 ——
  const textArg = JSON.stringify(MESSAGE);
  await evalJS(client, `(function (text) {
    var el = document.querySelector('textarea');
    if (!el) return { ok: false };
    var set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(el, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    return { ok: true, len: el.value.length };
  })(${textArg})`);
  console.log('已注入文本');
  await sleep(400);
  await evalJS(client, `(function () {
    var btns = Array.from(document.querySelectorAll('button'));
    for (var b of btns) {
      var label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
      if (/发送|send/i.test(label)) { b.click(); return true; }
    }
    return false;
  })()`);
  console.log('已点击发送，等待回复...');

  // 等待 completion 捕获完成（最多 45s）
  let waited = 0;
  while (waited < 45000) {
    if (accum.includes('_captured_sse.txt') === false && fs.existsSync('_captured_sse.txt')) break;
    // 简单等待：SSE 存盘后自动跳出（loadingFinished 已触发）
    await sleep(1000);
    waited += 1000;
    if (fs.existsSync('_captured_sse.txt')) {
      const stat = fs.statSync('_captured_sse.txt');
      if (stat.mtimeMs > Date.now() - 3000) break; // 最近 3s 有写入
    }
  }
  // 再等几秒确保尾部
  await sleep(6000);
  if (accum) fs.writeFileSync('_captured_sse.txt', accum, 'utf8');
  console.log('等待结束，SSE 累计长度:', accum.length);

  // —— dump 发送后的 DOM 容器结构（找兜底选择器）——
  const dom = await evalJS(client, `(() => {
    const out = [];
    const els = document.querySelectorAll('div[class*="message"], div[class*="response"], div[class*="markdown"], div[class*="chat-"]');
    els.forEach((el, i) => {
      const cls = (el.className || '').toString();
      if (!cls) return;
      const t = (el.innerText || '').trim();
      if (t.length > 0 && t.length < 300) {
        out.push({ i, cls: cls.slice(0, 70), text: t.slice(0, 50) });
      }
    });
    return out.slice(-25);
  })()`);
  fs.writeFileSync('_captured_dom.json', JSON.stringify(dom, null, 1), 'utf8');
  console.log('DOM 容器 dump 完成，共', dom.length, '个候选');

  await client.close();
  console.log('[done]');
})().catch((e) => { console.error('致命错误:', e.message); process.exit(1); });
