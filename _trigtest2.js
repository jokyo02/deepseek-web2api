// 逻辑测试：模拟「内容已进 DOM，但框架需 ~2.5s 才注册完成」的真实时序
const c = require('./cdp-controller.js');

// 假页面状态
let boxHasText = true;          // 粘贴后内容立即在 DOM 里
const registeredAt = Date.now() + 2500; // 2.5s 后框架才真正注册内容
let clickCount = 0;
let enterUsed = false;

c.evalJS = async (expr) => {
  // ① 就绪/清空检测（含 ready: 字段）
  if (expr.includes('ready:')) {
    const registered = Date.now() >= registeredAt;
    const ready = boxHasText && registered; // 按钮可点需等待注册
    return { empty: !boxHasText, ready };
  }
  // ② 点击发送
  if (expr.includes('b.click()')) {
    clickCount++;
    if (Date.now() >= registeredAt) {
      boxHasText = false; // 注册完成后点击才真正清空（=发送成功）
    }
    return true;
  }
  // ③ Enter 兜底后的清空检测
  if (expr.includes('t.length === 0')) {
    return !boxHasText;
  }
  return null;
};
c.enterFallback = async () => {
  enterUsed = true;
  if (Date.now() >= registeredAt) boxHasText = false;
  return true;
};

(async () => {
  const t0 = Date.now();
  const result = await c.triggerSend();
  const elapsed = Date.now() - t0;
  console.log('result =', result);
  console.log('elapsed =', elapsed, 'ms');
  console.log('clickCount =', clickCount, '| enterUsed =', enterUsed, '| boxCleared =', !boxHasText);
  const ok = (result === 'click' || result === 'enter') && !boxHasText;
  console.log(ok ? 'TRIGGER_SEND_OK' : 'TRIGGER_SEND_FAILED');
  process.exit(ok ? 0 : 1);
})();
