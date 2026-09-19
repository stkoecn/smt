/*
 * SMT Task Manager — 浏览器端 Tauri IPC shim。
 * 由 webserver.rs 注入到 index.html（仅浏览器版本；桌面 Tauri 窗口里
 * __TAURI_INTERNALS__ 已存在，本脚本直接跳过）。
 *
 * 用 HTTP(POST /api/invoke) + WebSocket(/ws 事件广播) 模拟
 * window.__TAURI_INTERNALS__，使 @tauri-apps/api 的 invoke/listen 与
 * plugin-dialog 的 open 在纯浏览器里零修改工作。
 *
 * 认证：设置了访问密码时，先弹出登录门换 token（存 localStorage），
 * 之后所有 /api/invoke 请求带 Authorization: Bearer，WS 带 ?token=；
 * 遇到 401 自动清 token 重新弹登录门。
 */
(function () {
  'use strict';
  if (window.__TAURI_INTERNALS__) return; // 真 Tauri 桌面环境

  var TOKEN_KEY = 'smt-web-token';
  var nextId = 1;
  var callbacks = new Map();   // callbackId -> handler（transformCallback 注册）
  var listeners = new Map();   // 事件名 -> Set<callbackId>
  var byEventId = new Map();   // listen 返回的 eventId -> { event, handler }
  var ws = null;
  var retryTimer = null;

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  function authHeaders() {
    var t = getToken();
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  // ── 登录门：设置了密码且无有效 token 时覆盖全屏 ──────────────
  function showLogin(message) {
    var ov = document.getElementById('smt-login-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'smt-login-overlay';
      ov.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;background:#12161c;display:flex;' +
        'align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;';
      ov.innerHTML =
        '<form style="width:300px;padding:32px;border-radius:12px;background:#1b2129;' +
        'box-shadow:0 8px 32px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:14px;">' +
        '<div style="color:#e8ecf1;font-size:17px;font-weight:600;text-align:center;">SMT Task Manager</div>' +
        '<div style="color:#8b96a3;font-size:12px;text-align:center;">请输入 Web 访问密码</div>' +
        '<input id="smt-login-pwd" type="password" autocomplete="current-password" ' +
        'placeholder="访问密码" style="height:36px;padding:0 10px;border-radius:8px;border:1px solid #2c343f;' +
        'background:#12161c;color:#e8ecf1;font-size:13px;outline:none;"/>' +
        '<button type="submit" style="height:34px;border:none;border-radius:8px;background:#3b82f6;' +
        'color:#fff;font-size:13px;font-weight:500;cursor:pointer;">进 入</button>' +
        '<div id="smt-login-err" style="color:#f87171;font-size:12px;text-align:center;min-height:16px;"></div>' +
        '</form>';
      document.body.appendChild(ov);
      ov.querySelector('form').addEventListener('submit', function (e) {
        e.preventDefault();
        var pwd = document.getElementById('smt-login-pwd').value;
        var err = document.getElementById('smt-login-err');
        fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        }).then(function (r) { return r.json(); }).then(function (body) {
          if (body && body.ok && body.token) {
            setToken(body.token);
            location.reload();
          } else {
            err.textContent = (body && body.error) || '登录失败';
          }
        }).catch(function () { err.textContent = '网络错误，请重试'; });
      });
    }
    ov.querySelector('#smt-login-err').textContent = message || '';
    var pwdInput = ov.querySelector('#smt-login-pwd');
    pwdInput.focus();
  }

  function handleUnauthorized() {
    clearToken();
    showLogin('会话已过期，请重新输入密码');
  }

  // 启动时查询认证状态：需要密码但没存 token → 立即弹登录门
  fetch('/api/auth/state').then(function (r) { return r.json(); }).then(function (s) {
    if (s && s.required && !getToken()) showLogin();
  }).catch(function () { /* 服务不可达时由各请求的错误分支兜底 */ });

  // ── WebSocket 事件通道 ───────────────────────────────────────
  function connect() {
    var t = getToken();
    if (document.getElementById('smt-login-overlay')) { scheduleRetry(); return; }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + location.host + '/ws';
    if (t) url += '?token=' + encodeURIComponent(t);
    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleRetry();
      return;
    }
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.type === 'event') dispatchEvent(msg.event, msg.payload);
    };
    ws.onclose = function () { scheduleRetry(); };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* noop */ } };
  }
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () { retryTimer = null; connect(); }, 1000);
  }

  function dispatchEvent(event, payload) {
    var set = listeners.get(event);
    if (!set) return;
    set.forEach(function (handlerId) {
      var cb = callbacks.get(handlerId);
      // 回调形如 event.js 里 transformCallback 包装后的样子：{ event, id, payload }
      if (cb) cb({ event: event, id: handlerId, payload: payload });
    });
  }

  function httpInvoke(cmd, args) {
    return fetch('/api/invoke', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ cmd: cmd, args: args || {} })
    }).then(function (res) {
      if (res.status === 401) {
        handleUnauthorized();
        throw new Error('未认证');
      }
      return res.json();
    }).then(function (body) {
      if (body && body.ok) return body.value;
      throw new Error((body && body.error) || ('invoke 失败: ' + cmd));
    });
  }

  window.__TAURI_INTERNALS__ = {
    transformCallback: function (callback, once) {
      var id = nextId++;
      var cb = callback;
      if (once) {
        cb = function (data) {
          callbacks.delete(id);
          delete window['_' + id];
          callback(data);
        };
      }
      callbacks.set(id, cb);
      window['_' + id] = cb;
      return id;
    },
    unregisterCallback: function (id) {
      callbacks.delete(id);
      delete window['_' + id];
    },
    invoke: function (cmd, args) {
      // 事件插件在本地即可闭环：监听注册/注销不需要打后端
      if (cmd === 'plugin:event|listen') {
        var eventId = nextId++;
        var handlerId = args && args.handler;
        var name = (args && args.event) || '';
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(handlerId);
        byEventId.set(eventId, { event: name, handler: handlerId });
        return Promise.resolve(eventId);
      }
      if (cmd === 'plugin:event|unlisten') {
        var rec = byEventId.get(args && args.eventId);
        if (rec) {
          byEventId.delete(args.eventId);
          var set = listeners.get(rec.event);
          if (set) {
            set.delete(rec.handler);
            if (!set.size) listeners.delete(rec.event);
          }
        }
        return Promise.resolve(null);
      }
      if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') {
        return Promise.resolve(null); // 前端 → 后端事件未使用
      }
      // 浏览器环境下点击端口：在当前浏览器新建标签页打开（不向服务端发 cmd start），
      // 若在局域网访问，自动把 127.0.0.1 / localhost 换成当前访问的主机名/IP
      if (cmd === 'open_in_browser') {
        var rawUrl = args && args.url;
        if (typeof rawUrl === 'string' && rawUrl) {
          var targetUrl = rawUrl;
          try {
            var parsed = new URL(rawUrl);
            if (
              (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
              location.hostname &&
              location.hostname !== '127.0.0.1' &&
              location.hostname !== 'localhost'
            ) {
              parsed.hostname = location.hostname;
            }
            targetUrl = parsed.href;
          } catch (e) { /* ignore */ }
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
        }
        return Promise.resolve(null);
      }
      return httpInvoke(cmd, args);
    },
    convertFileSrc: function (filePath) {
      return 'http://ipc.localhost/' + String(filePath).replace(/^\//, '');
    },
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' }
    },
    plugins: {}
  };

  // event.js 的 _unlisten 在 invoke 之前调用本接口清理注册表
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: function (event, eventId) {
      var rec = byEventId.get(eventId);
      if (!rec) return;
      byEventId.delete(eventId);
      var set = listeners.get(rec.event);
      if (set) {
        set.delete(rec.handler);
        if (!set.size) listeners.delete(rec.event);
      }
    }
  };

  connect();
})();
