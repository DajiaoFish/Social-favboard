/**
 * inject.js —— 运行在页面主世界（MAIN world）
 *
 * 挂在真实页面的 fetch / XHR 上，把页面自己拉到的列表响应抄一份。
 * 它不发任何请求，只是旁听。
 */
(function () {
  if (window.__sfbInjected) return;
  window.__sfbInjected = true;

  var WATCH = /aweme\/v1\/web\/aweme\/(favorite|collection)|fav\/resource\/list|note\/user_posted|user_posted|user\/collected|user\/liked|note\/feed|liked_list|collect_list/i;

  /* 小红书的接口全在 /api/sns/web 下，但路径改得很勤。
     这里把整段 API 都旁听：响应里只要出现 xsec_token，会被 content.js 的
     通用挖掘逻辑捡出来，不用猜具体字段、也不额外发请求。 */
  var TOKEN_WATCH = /\/api\/sns\/web|edith\.xiaohongshu\.com/i;

  function shouldWatch(u) {
    var s = String(u || '');
    return WATCH.test(s) || TOKEN_WATCH.test(s);
  }

  function relay(url, data) {
    if (!data) return;
    try {
      window.postMessage({ __sfbBridge: 1, u: String(url).slice(0, 300), d: data }, '*');
    } catch (e) {
      /* 循环引用等，忽略这一条 */
    }
  }

  /* ---------- fetch ---------- */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      var args = arguments;
      var p = origFetch.apply(this, args);
      try {
        var u = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
        if (shouldWatch(u || '')) {
          p.then(function (res) {
            try {
              res.clone().json().then(function (j) {
                relay(u, j);
              }).catch(function () {});
            } catch (e) {}
          }).catch(function () {});
        }
      } catch (e) {}
      return p;
    };
  }

  /* ---------- XMLHttpRequest ---------- */
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__sfbUrl = url;
    return XO.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var self = this;
    try {
      self.addEventListener('load', function () {
        try {
          if (shouldWatch(self.__sfbUrl || '') && self.responseText) {
            relay(self.__sfbUrl, JSON.parse(self.responseText));
          }
        } catch (e) {}
      });
    } catch (e) {}
    return XS.apply(this, arguments);
  };

  /* ---------- 地址栏 ----------
     点开笔记时，前端会把带 xsec_token 的地址推进 history。
     这是 token 最可靠的来源：只看当前地址，不发任何请求。 */
  function sendNav() {
    try {
      var h = String(location.href || '');
      if (h.indexOf('xsec_token=') >= 0) {
        window.postMessage({ __sfbBridge: 1, nav: h.slice(0, 1500) }, '*');
      }
    } catch (e) {
      /* ignore */
    }
  }

  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    if (typeof orig === 'function') {
      history[k] = function () {
        var r = orig.apply(this, arguments);
        sendNav();
        return r;
      };
    }
  });

  window.addEventListener('popstate', sendNav);
  window.addEventListener('hashchange', sendNav);
  sendNav();
})();
