// 验证：注入到页面的脚本源码必须是**合法 JS 表达式**，且模态判定行为正确。
// 上一版 bug：detectModalState 是类方法，toString() 产出方法简写，拼成
//   `(detectModalState(doc, win) { ... })(document, window)` → SyntaxError: Unexpected token '{'
// 本脚本直接构造同样的源码字符串，用 vm 编译校验，杜绝再次翻车。
const vm = require('vm');
const ctrl = require('./cdp-controller.js');
const { pickModalCandidates, detectModalState, fillAndConfirmModal } = ctrl;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

// ---------- 1. 注入源码语法校验 ----------
console.log('\n[1] 注入源码语法校验');

const detectSrc =
  '(function () {\n' +
  pickModalCandidates.toString() + '\n' +
  detectModalState.toString() + '\n' +
  'return detectModalState(document, window);\n' +
  '})()';

const answerSrc =
  '(function () {\n' +
  'var msg = ' + JSON.stringify('测试消息"含引号"\n换行') + ';\n' +
  pickModalCandidates.toString() + '\n' +
  fillAndConfirmModal.toString() + '\n' +
  'return fillAndConfirmModal(document, window, msg);\n' +
  '})()';

for (const [name, src] of [['detectConfirmModal 注入源码', detectSrc], ['answerConfirmModal 注入源码', answerSrc]]) {
  let err = null;
  try { new vm.Script(src); } catch (e) { err = e.message; }
  ok(name + ' 可编译', err === null, err);
}

// 反向验证：确认旧写法确实会炸（证明这个测试有鉴别力）
{
  class Demo { m(a, b) { return a + b; } }
  const bad = '(' + Demo.prototype.m.toString() + ')(1,2)';
  let err = null;
  try { new vm.Script(bad); } catch (e) { err = e.message; }
  ok('旧写法(类方法 toString)确实是语法错误', /Unexpected token/.test(err || ''), 'err=' + err);
}

// 确认注入函数都是模块级函数声明（toString 以 "function" 开头）
for (const [n, f] of [['pickModalCandidates', pickModalCandidates], ['detectModalState', detectModalState], ['fillAndConfirmModal', fillAndConfirmModal]]) {
  ok(n + ' 是模块级函数声明', /^function\s/.test(f.toString()), f.toString().slice(0, 40));
}

// ---------- 2. mock DOM 行为校验 ----------
console.log('\n[2] 模态判定行为校验（mock DOM）');

function mkBtn(t, disabled) {
  return { getAttribute: () => null, textContent: t, disabled: !!disabled, click() { this._clicked = true; } };
}
function mkEl(opts = {}) {
  const el = {
    offsetParent: opts.hidden ? null : {},
    className: opts.className || '',
    _buttons: (opts.buttons || []).map((b) => (typeof b === 'string' ? mkBtn(b) : mkBtn(b.t, b.disabled))),
    _input: opts.input ? { tagName: 'TEXTAREA', focus() {}, dispatchEvent() {}, innerText: '' } : null,
    getBoundingClientRect: () => opts.rect || { width: 0, height: 0 },
  };
  el.querySelectorAll = (sel) => (sel === 'button' ? el._buttons : []);
  el.querySelector = (sel) => (/textarea/i.test(sel) ? el._input : null);
  return el;
}
// mock document：sel → 元素数组
function mkDoc(map, mainTa = { offsetParent: {} }) {
  return {
    querySelectorAll: (sel) => map[sel] || [],
    querySelector: (sel) => (/contenteditable/.test(sel) ? mainTa : null),
  };
}
const win = { innerWidth: 1000, innerHeight: 800, getComputedStyle: (el) => el._style || { position: 'static' } };
function fixed(el) { el._style = { position: 'fixed', visibility: 'visible', display: 'block' }; return el; }

const S_STRONG = '[role="dialog"], dialog[open], [aria-modal="true"]';
const S_OVERLAY = '[class*="modal"], [class*="overlay"], [class*="backdrop"], [class*="mask"]';
const S_SHALLOW = 'body > div, body > div > div';

// A. 普通聊天页（有可见 drawer 侧边栏，无遮罩、无真模态）→ 必须 present=false（旧逻辑会误判）
{
  const drawer = mkEl({ className: 'sidebar-drawer', buttons: ['新建对话', '发送'] });
  const doc = mkDoc({ [S_STRONG]: [], [S_OVERLAY]: [], [S_SHALLOW]: [drawer] });
  const r = detectModalState(doc, win);
  ok('A 普通聊天页(可见 drawer) → present=false', r.present === false, JSON.stringify(r));
}

// B. 带 modal 类的浮层但**无全屏遮罩** → present=false（不许误判）
{
  const pop = mkEl({ className: 'xx-modal-tip', buttons: ['确定'] });
  const doc = mkDoc({ [S_STRONG]: [], [S_OVERLAY]: [pop], [S_SHALLOW]: [] });
  const r = detectModalState(doc, win);
  ok('B modal 类浮层但无遮罩 → present=false', r.present === false, JSON.stringify(r));
}

// C. 语义真模态 + 确认按钮 → present=true & strongModal=true
{
  const dlg = mkEl({ className: 'confirm-dialog', buttons: ['取消', '确认'], input: true });
  const doc = mkDoc({ [S_STRONG]: [dlg], [S_OVERLAY]: [], [S_SHALLOW]: [] });
  const r = detectModalState(doc, win);
  ok('C 真模态 → present=true', r.present === true, JSON.stringify(r));
  ok('C 真模态 → strongModal=true', r.strongModal === true);
  ok('C 真模态 → 识别到确认按钮', r.hasConfirmBtn === true && r.confirmBtnText === '确认');
}

// D. 弱 overlay + 全屏遮罩 + 确认按钮 → present=true & strongModal=false（可回退，不致命）
{
  const ov = mkEl({ className: 'app-overlay', buttons: ['确定'], rect: { width: 1000, height: 800 } });
  fixed(ov);
  const doc = mkDoc({ [S_STRONG]: [], [S_OVERLAY]: [ov], [S_SHALLOW]: [ov] });
  const r = detectModalState(doc, win);
  ok('D 遮罩+overlay+确认按钮 → present=true', r.present === true, JSON.stringify(r));
  ok('D 该场景 strongModal=false（失败可回退常规发送）', r.strongModal === false);
}

// E. 真模态但主输入框被接管、且无确认按钮 → present=true（靠 mainInputBlocked 闸门）
{
  const dlg = mkEl({ className: 'q-dialog', buttons: ['知道了'] });
  const doc = mkDoc({ [S_STRONG]: [dlg], [S_OVERLAY]: [], [S_SHALLOW]: [] }, null);
  const r = detectModalState(doc, win);
  ok('E 主输入框被接管 → present=true', r.present === true, JSON.stringify(r));
}

// F. 无任何候选 → present=false
{
  const doc = mkDoc({ [S_STRONG]: [], [S_OVERLAY]: [], [S_SHALLOW]: [] });
  const r = detectModalState(doc, win);
  ok('F 无候选 → present=false', r.present === false);
}

// ---------- 3. 点击行为校验 ----------
console.log('\n[3] 确认框处置行为校验');

// G. 有真确认按钮 → 点它，ok=true
{
  const dlg = mkEl({ className: 'q-dialog', buttons: ['取消', '确认'], input: true });
  const doc = mkDoc({ [S_STRONG]: [dlg], [S_OVERLAY]: [], [S_SHALLOW]: [] });
  const r = fillAndConfirmModal(doc, win, 'hello');
  ok('G 点击真确认按钮 → ok=true', r.ok === true, JSON.stringify(r));
  ok('G 点的是「确认」而非最后一个按钮', dlg._buttons[1]._clicked === true && !dlg._buttons[0]._clicked);
}

// H. 无确认按钮 → 绝不凑最后一个按钮（旧 bug），返回 no-confirm-button
{
  const dlg = mkEl({ className: 'q-dialog', buttons: ['关闭', '稍后再说'] });
  const doc = mkDoc({ [S_STRONG]: [dlg], [S_OVERLAY]: [], [S_SHALLOW]: [] });
  const r = fillAndConfirmModal(doc, win, 'hello');
  ok('H 无确认按钮 → ok=false/no-confirm-button', r.ok === false && r.reason === 'no-confirm-button', JSON.stringify(r));
  ok('H 未误点任何按钮', !dlg._buttons.some((b) => b._clicked));
}

// I. 确认按钮 disabled → 不点，明确报 reason
{
  const dlg = mkEl({ className: 'q-dialog', buttons: [{ t: '确认', disabled: true }] });
  const doc = mkDoc({ [S_STRONG]: [dlg], [S_OVERLAY]: [], [S_SHALLOW]: [] });
  const r = fillAndConfirmModal(doc, win, 'hello');
  ok('I 确认按钮 disabled → ok=false/confirm-button-disabled', r.ok === false && r.reason === 'confirm-button-disabled', JSON.stringify(r));
}

// J. 无模态 → no-modal
{
  const doc = mkDoc({ [S_STRONG]: [], [S_OVERLAY]: [], [S_SHALLOW]: [] });
  const r = fillAndConfirmModal(doc, win, 'hello');
  ok('J 无模态 → no-modal', r.ok === false && r.reason === 'no-modal', JSON.stringify(r));
}

// ---------- 4. 并发串行化校验 ----------
// 背景：activeSSE / sseAccum / sseTimer 是单例共享字段，并发会让先到的请求永久挂死。
(async () => {
  console.log('\n[4] 并发串行化校验');

  const timeline = [];
  let live = 0, maxLive = 0;
  const orig = ctrl._executeChatSerial;
  ctrl._executeChatSerial = async function (sessionId, message) {
    live++; maxLive = Math.max(maxLive, live);
    timeline.push('start:' + sessionId);
    await new Promise((r) => setTimeout(r, 30));
    timeline.push('end:' + sessionId);
    live--;
    if (sessionId === 'B') throw new Error('boom'); // 中间一个失败，验证不影响后续排队
    return { content: 'ok:' + sessionId };
  };

  const results = await Promise.allSettled([
    ctrl.executeChat('A', 'm'),
    ctrl.executeChat('B', 'm'),
    ctrl.executeChat('C', 'm'),
  ]);
  ctrl._executeChatSerial = orig;

  ok('并发请求已串行（同时最多 1 个在执行）', maxLive === 1, 'maxLive=' + maxLive);
  ok('执行顺序严格不重叠', timeline.join(',') === 'start:A,end:A,start:B,end:B,start:C,end:C', timeline.join(','));
  ok('三个请求全部有结果（无挂死）', results.length === 3 && results.every((r) => r.status !== 'pending'));
  ok('A 成功', results[0].status === 'fulfilled' && results[0].value.content === 'ok:A');
  ok('B 失败被正确传播（不吞错）', results[1].status === 'rejected' && /boom/.test(results[1].reason.message));
  ok('C 不受 B 失败影响，仍成功', results[2].status === 'fulfilled' && results[2].value.content === 'ok:C', JSON.stringify(results[2]));
  ok('串行链已释放（_chainBusy=false）', ctrl._chainBusy === false);

  console.log('\n==== 结果: ' + pass + ' PASS / ' + fail + ' FAIL ====');
  process.exit(fail ? 1 : 0);
})();
