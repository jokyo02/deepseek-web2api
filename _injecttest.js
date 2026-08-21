// 验证 injectText：富文本(contenteditable) 与 textarea 两种输入框均一次性干净写入，无二次录入
const c = require('./cdp-controller.js');

function makeFakeDocument(kind) {
  const el = {
    _text: '',
    isContentEditable: kind === 'ce',
    focus() {},
    dispatchEvent(ev) { return true; },
    get innerText() { return this._text; },
    set innerText(v) { this._text = v; },
    get value() { return this._text; },
    set value(v) { this._text = v; },
  };
  return {
    doc: {
      querySelector() { return el; },
      execCommand(cmd, _u, val) {
        if (cmd === 'insertText') { el._text = val; return true; }
        return false;
      },
    },
    el,
  };
}

function makeEnv(doc) {
  const textareaProto = {};
  Object.defineProperty(textareaProto, 'value', {
    configurable: true,
    get() { return doc.el._text; },
    set(v) { doc.el._text = v; },
  });
  return {
    document: doc.doc,
    window: { HTMLTextAreaElement: { prototype: textareaProto } },
    InputEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    setTimeout,
    Promise,
  };
}

async function runExpr(node, expression) {
  const env = makeEnv(node);
  const fn = new Function(
    'document', 'window', 'InputEvent', 'setTimeout', 'Promise',
    'return ' + expression + ';'
  );
  return fn(env.document, env.window, env.InputEvent, env.setTimeout, env.Promise);
}

async function testCase(name, kind) {
  const node = makeFakeDocument(kind);
  const msg = '验证一次性写入：含中文、换行\n第二行、`反引号`与${模板}占位，这些曾破坏逐字输入。';
  c.evalJS = async (expr, awaitPromise) => runExpr(node, expr);
  // 直接调用（绕过 humanTypeAndSend 的聚焦逻辑）
  await c.injectText(msg);
  const got = node.el._text;
  const pass = got === msg;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}: 期望 ${msg.length} 字，实际 ${got.length} 字`);
  if (!pass) console.log('   实际:', JSON.stringify(got.slice(0, 40)) + '...');
  return pass;
}

(async () => {
  let ok = true;
  ok = (await testCase('① contenteditable 富文本', 'ce')) && ok;
  ok = (await testCase('② textarea', 'ta')) && ok;
  console.log(ok ? '\nINJECT_OK' : '\nINJECT_FAILED');
  process.exit(ok ? 0 : 1);
})();
