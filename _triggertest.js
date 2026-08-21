// 临时测试：验证 triggerSend 的轮询/回退逻辑（不依赖真实浏览器）
const controller = require('./cdp-controller.js');

async function runScenario(name, mode) {
  let tick = 0;
  let clickCalled = false;
  controller.evalJS = async (expr) => {
    if (expr.includes('findSend')) {
      tick++;
      if (mode === 'none') return { action: 'none' };
      // 'late'：第 3 个 tick 才启用；'never'：始终 disabled
      const enabled = mode === 'late' && tick >= 3;
      return { action: enabled ? 'click' : 'disabled' };
    }
    if (expr.includes('innerText') && expr.includes('t.length')) {
      // 点击后清空校验：仅 'late' 场景在 click 后返回已清空
      return mode === 'late' ? true : false;
    }
    if (expr.includes('KeyboardEvent')) {
      return true; // Enter 回退成功
    }
    return null;
  };
  // 直接调用 triggerSend（mock 下 sleep 仍真实等待，但 intervalMs 小）
  const result = await controller.triggerSend(20, 1);
  console.log(`[${result === expected(name, mode) ? 'PASS' : 'FAIL'}] ${name}: triggerSend -> '${result}' (期望 '${expected(name, mode)}')`);
  return result === expected(name, mode);
}

function expected(name, mode) {
  if (mode === 'late') return 'click';
  if (mode === 'none') return 'enter';
  if (mode === 'never') return 'enter-timeout';
  return '?';
}

(async () => {
  let ok = true;
  if (!(await runScenario('① 按钮延迟启用（轮询等到启用后点击）', 'late'))) ok = false;
  if (!(await runScenario('② 找不到发送按钮（回退 Enter）', 'none'))) ok = false;
  if (!(await runScenario('③ 按钮始终 disabled（超时回退 Enter）', 'never'))) ok = false;
  console.log(ok ? '\nALL_TRIGGER_OK' : '\nTRIGGER_TEST_FAILED');
  process.exit(ok ? 0 : 1);
})();
