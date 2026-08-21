// page-hook.js —— 注入 DeepSeek 页面的 hook 脚本（纯 CDP 方案，替代 Whistle）
//
// 职责：
//   1. hook window.fetch 与 XMLHttpRequest，仅关注 DeepSeek 聊天 API 请求
//   2. 区分 SSE 流式响应（text/event-stream）与普通 JSON，提取最终文本
//   3. 通过 Runtime.addBinding 注册的 cdpHook() 把 {type, sessionId, content, stream}
//      上报给 CDP 控制器（sessionId 取请求发起瞬间 window.__activeSessionId 的快照，
//      由 CDP 控制器在每次操作前设置）
//
// 注入方式（见 cdp-controller.js）：
//   - Page.addScriptToEvaluateOnNewDocument: 未来每次导航自动生效
//   - Runtime.evaluate: 当前已打开页面立即生效（无需刷新）
//
// 注意：fetch 上报采用 fire-and-forget（clone().text()），不阻塞原始调用方的流式渲染。

module.exports = `(function () {
  if (window.__cdpChatHookInstalled) return;
  window.__cdpChatHookInstalled = true;

  function report(data) {
    try {
      if (typeof cdpHook !== 'function') {
        console.error('[hook] cdpHook 未定义，无法上报 sessionId=' + (data && data.sessionId));
        return;
      }
      cdpHook(JSON.stringify(data));
    } catch (e) {
      console.error('[hook] report 调用失败: ' + e.message);
    }
  }

  // 解析 SSE 帧：按空行切帧，取每帧 data: 行，跳过 [DONE]，叠加 delta 文本
  function parseSSE(text) {
    var content = '';
    var frames = String(text).split('\\n\\n');
    for (var i = 0; i < frames.length; i++) {
      var dataLine = null;
      var lines = frames[i].split('\\n');
      for (var j = 0; j < lines.length; j++) {
        if (lines[j].indexOf('data:') === 0) { dataLine = lines[j].slice(5).trim(); break; }
      }
      if (!dataLine || dataLine === '[DONE]') continue;
      try {
        var obj = JSON.parse(dataLine);
        var delta = obj.content
          || (obj.delta && obj.delta.content)
          || (obj.choices && obj.choices[0] && (
                (obj.choices[0].delta && obj.choices[0].delta.content)
                || (obj.choices[0].message && obj.choices[0].message.content)
              ));
        if (delta) content += delta;
      } catch (e) {}
    }
    return content;
  }

  function extractFromJSON(body) {
    try {
      var j = JSON.parse(body);
      return j.content
        || (j.message && j.message.content)
        || (j.choices && j.choices[0] && (
              (j.choices[0].message && j.choices[0].message.content)
              || (j.choices[0].delta && j.choices[0].delta.content)
            ))
        || '';
    } catch (e) { return ''; }
  }

  // 只拦截 DeepSeek 聊天接口，排除静态资源
  function isChatAPI(input) {
    var u = String(typeof input === 'string' ? input : (input && input.url) || '').toLowerCase();
    if (/\\.(css|js|png|jpe?g|gif|svg|woff2?|ico)(\\?|$)/.test(u)) return false;
    return u.indexOf('chat.deepseek.com') >= 0 && (u.indexOf('chat') >= 0 || u.indexOf('completion') >= 0)
      || u.indexOf('/chat/completions') >= 0
      || u.indexOf('/api/chat') >= 0
      || u.indexOf('/api/v0/chat') >= 0;
  }

  function handleBody(body, ct, sid) {
    var stream = ct.indexOf('text/event-stream') >= 0;
    var content = stream ? parseSSE(body) : extractFromJSON(body);
    if (content) {
      report({ type: 'chat', sessionId: sid, content: content, stream: stream });
    } else {
      // content 提取失败也上报，带原始预览，便于服务端诊断真实响应格式
      report({ type: 'chat-debug', sessionId: sid, rawPreview: String(body).slice(0, 600), ct: ct, stream: stream });
    }
  }

  // ---- hook fetch ----
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      var args = arguments;
      var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      var p = origFetch.apply(this, args);
      if (isChatAPI(url)) {
        var sid = window.__activeSessionId || '';
        p.then(function (resp) {
          var ct = (resp.headers && resp.headers.get('content-type')) || '';
          resp.clone().text()
            .then(function (body) { handleBody(body, ct, sid); })
            .catch(function () {});
        }).catch(function () {});
      }
      return p;
    };
  }

  // ---- hook XMLHttpRequest（部分接口走 XHR 时的兜底）----
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cdpHookUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (isChatAPI(xhr.__cdpHookUrl)) {
      var sid = window.__activeSessionId || '';
      xhr.addEventListener('load', function () {
        try {
          var ct = xhr.getResponseHeader('content-type') || '';
          handleBody(xhr.responseText, ct, sid);
        } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();`;
