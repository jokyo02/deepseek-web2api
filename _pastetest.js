// 临时测试：用假 DOM 验证 pasteText 三条降级路径（无发送按钮时 registered 退化为仅校验长度）
const controller = require('./cdp-controller.js');

function makeFakeDocument(opts) {
  opts = opts || {};
  const contenteditable = opts.contenteditable !== false;
  const handlePaste = opts.handlePaste !== false;
  const el = {
    _text: '',
    isContentEditable: contenteditable,
    focus() {},
    dispatchEvent(ev) {
      if (handlePaste && ev.type === 'paste' && ev.clipboardData) {
        const t = ev.clipboardData.getData('text/plain');
        if (t != null) this._text = t;
      }
      return true;
    },
    get innerText() { return this._text; },
    set innerText(v) { this._text = v; },
    get value() { return this._text; },
    set value(v) { this._text = v; },
    innerHTML: '',
  };
  const doc = {
    querySelector(sel) {
      if (sel.indexOf('button') !== -1) return null; // 无发送按钮
      return el;
    },
    querySelectorAll() { return []; },
    execCommand(cmd, _u, val) {
      if (cmd === 'insertText') { el._text = val; return true; }
      if (cmd === 'selectAll') { return true; }
      return false;
    },
  };
  return { doc, el };
}

class FakeDataTransfer {
  constructor() { this.store = {}; }
  setData(k, v) { this.store[k] = v; }
  getData(k) { return this.store[k] || ''; }
}
class FakeClipboardEvent {
  constructor(type, init) { this.type = type; this.clipboardData = init ? init.clipboardData : undefined; }
}
class FakeInputEvent {
  constructor(type, init) { this.type = type; if (init) Object.assign(this, init); }
}

let GLOBAL_FAKE = {};
function runExpr(expression) {
  const textareaProto = {};
  Object.defineProperty(textareaProto, 'value', {
    configurable: true,
    get() { return GLOBAL_FAKE.el._text; },
    set(v) { GLOBAL_FAKE.el._text = v; },
  });
  const fn = new Function(
    'document', 'window', 'DataTransfer', 'ClipboardEvent', 'InputEvent', 'setTimeout', 'Promise',
    'return ' + expression + ';'
  );
  return fn(
    GLOBAL_FAKE.doc,
    { HTMLTextAreaElement: { prototype: textareaProto } },
    FakeDataTransfer, FakeClipboardEvent, FakeInputEvent, setTimeout, Promise
  );
}

async function testCase(name, opts) {
  const res = makeFakeDocument(opts);
  const doc = res.doc;
  const el = res.el;
  GLOBAL_FAKE = { doc, el };
  controller.evalJS = async (expr) => runExpr(expr);
  const msg = '你好，这是一段用于验证模拟粘贴速度提升的较长测试文本。\n第二行包含反引号`code`与Z模板Z占位。';
  await controller.pasteText(msg);
  const got = el._text;
  const pass = got === msg;
  console.log('[' + (pass ? 'PASS' : 'FAIL') + '] ' + name + ': 期望 ' + msg.length + ' 字，实际 ' + got.length + ' 字');
  if (!pass) console.log('   实际内容: ' + JSON.stringify(got.slice(0, 40)) + '...');
  return pass;
}

(async () => {
  let ok = true;
  if (!(await testCase('① contenteditable + 编辑器处理 paste', { contenteditable: true, handlePaste: true }))) ok = false;
  if (!(await testCase('② contenteditable + 无 paste 处理（走 execCommand）', { contenteditable: true, handlePaste: false }))) ok = false;
  if (!(await testCase('③ textarea + 无 paste 处理（走 value 兜底）', { contenteditable: false, handlePaste: false }))) ok = false;
  console.log(ok ? '\nALL_PASTE_PATHS_OK' : '\nPASTE_TEST_FAILED');
  process.exit(ok ? 0 : 1);
})();
