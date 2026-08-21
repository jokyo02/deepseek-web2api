// _debug_page.js —— 对已打开的 chat.qwen.ai 页面逐步探测，定位 executeChat 卡点
// 用法：node _debug_page.js
'use strict';

const CDP = require('chrome-remote-interface');

const CDP_PORT = Number(process.env.CDP_PORT || 9222);

async function evalJS(client, expression, awaitPromise = false) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    const desc = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'unknown';
    throw new Error(`页面脚本异常: ${desc}`);
  }
  return r.result.value;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时(${ms}ms)`)), ms)),
  ]);
}

async function main() {
  const targets = await CDP.List({ port: CDP_PORT });
  const page = targets.find((t) => t.type === 'page' && /qwen\.ai/.test(t.url));
  console.log('1) 找到页面:', page ? page.url : '未找到！');

  if (!page) return;
  const client = await CDP({ target: page, port: CDP_PORT });
  const { Runtime, Network, Page, DOM } = client;
  await Promise.all([Runtime.enable(), Network.enable(), Page.enable(), DOM.enable()]);
  console.log('2) CDP 域已启用');

  // 3) location
  try {
    const url = await withTimeout(evalJS(client, 'location.href'), 5000, 'location');
    console.log('3) location:', url);
  } catch (e) { console.log('3) 失败:', e.message); }

  // 4) 输入框存在性
  try {
    const input = await withTimeout(evalJS(client, `(() => {
      const el = document.querySelector('[contenteditable="true"], textarea');
      return el ? { tag: el.tagName, ce: el.isContentEditable, cls: (el.className || '').slice(0, 80) } : null;
    })()`), 5000, 'input');
    console.log('4) 输入框:', JSON.stringify(input));
  } catch (e) { console.log('4) 失败:', e.message); }

  // 5) 发送按钮
  try {
    const send = await withTimeout(evalJS(client, `(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const hits = btns.filter((b) => /发送|send/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.textContent||'')));
      return hits.slice(0, 5).map((b) => ({
        aria: b.getAttribute('aria-label') || '',
        text: (b.textContent || '').slice(0, 20),
        disabled: b.disabled,
        cls: (b.className || '').slice(0, 60),
      }));
    })()`), 5000, 'sendbtn');
    console.log('5) 发送按钮候选:', JSON.stringify(send, null, 1));
  } catch (e) { console.log('5) 失败:', e.message); }

  // 6) 助手消息容器（DOM 兜底选择器命中率）
  try {
    const sel = 'div[class*="markdown-body"], div[class*="markdown"], div[class*="message-content"], div[class*="assistant-message"], div[class*="assistant"], .prose';
    const hits = await withTimeout(evalJS(client, `(() => {
      const els = document.querySelectorAll('${sel}');
      const counts = {};
      els.forEach((e) => {
        const c = (e.className || '').toString().split(' ')[0];
        counts[c] = (counts[c] || 0) + 1;
      });
      return { total: els.length, last: els.length ? (els[els.length - 1].innerText || '').slice(0, 60) : '', counts };
    })()`), 5000, 'domsel');
    console.log('6) DOM 兜底选择器:', JSON.stringify(hits));
  } catch (e) { console.log('6) 失败:', e.message); }

  // 7) 模式开关按钮（深度思考/联网搜索）
  try {
    const toggles = await withTimeout(evalJS(client, `(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.filter((b) => /思考|think|联网|搜索|search/i.test(b.textContent || '')).slice(0, 8)
        .map((b) => ({ text: (b.textContent || '').trim().slice(0, 20), aria: b.getAttribute('aria-label') || '' }));
    })()`), 5000, 'toggles');
    console.log('7) 模式开关:', JSON.stringify(toggles));
  } catch (e) { console.log('7) 失败:', e.message); }

  // 8) 新建对话按钮
  try {
    const nb = await withTimeout(evalJS(client, `(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.filter((b) => /新建对话|新对话|新建会话|new chat|new session/i.test((b.getAttribute('aria-label')||'') + ' ' + (b.textContent||''))).slice(0, 4)
        .map((b) => ({ text: (b.textContent || '').trim().slice(0, 20), aria: b.getAttribute('aria-label') || '' }));
    })()`), 5000, 'newbtn');
    console.log('8) 新建对话按钮:', JSON.stringify(nb));
  } catch (e) { console.log('8) 失败:', e.message); }

  // 9) 写文本测试（不动发送）
  try {
    const res = await withTimeout(evalJS(client, `(async function () {
      const text = '__DEBUG_PROBE__';
      const el = document.querySelector('[contenteditable="true"], textarea');
      if (!el) return { ok: false, reason: 'no-el' };
      el.focus();
      if (el.isContentEditable) {
        document.execCommand('insertText', false, text);
      } else {
        const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        set.call(el, text);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 100));
      const cur = el.isContentEditable ? (el.innerText || '') : (el.value || '');
      return { ok: cur.includes('__DEBUG_PROBE__'), len: cur.length };
    })()`, true), 8000, 'inject');
    console.log('9) 写文本:', JSON.stringify(res));
  } catch (e) { console.log('9) 失败:', e.message); }

  // 10) 清空输入框（避免污染页面）
  try {
    await withTimeout(evalJS(client, `(() => {
      const el = document.querySelector('[contenteditable="true"], textarea');
      if (!el) return false;
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
      if (!el.isContentEditable) {
        const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        set.call(el, '');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      }
      return true;
    })()`), 5000, 'clean');
    console.log('10) 已清空测试文本');
  } catch (e) { console.log('10) 清理失败:', e.message); }

  await client.close();
  console.log('\n[debug] 探测完成');
}

main().catch((e) => {
  console.error('[debug] 致命错误:', e.message);
  process.exit(1);
});
