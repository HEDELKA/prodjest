// DSH Browser Bridge — фон (service worker).
// Держит WebSocket к мосту 127.0.0.1:8787 и выполняет команды через chrome.debugger.
// Внедряет в управляемую вкладку оверлей: бейдж «DSH-агент управляет вкладкой»
// и призрачный курсор с анимацией клика (визуализация действий агента).

let ws = null;
let reconnectTimer = null;
const attachedTabs = new Set();
const overlayTabs = new Set();

function log(...args) {
  console.log("[dsh-bridge]", new Date().toISOString(), ...args);
}

// --- Оверлей для управляемой вкладки -------------------------------------
// Полноэкранный фиксированный слой (pointer-events:none) с:
//  - верхним баннером-статусом «DSH-агент работает на этой странице»,
//  - призрачным курсором (липкий — остаётся в точке последнего действия),
//  - кольцом-вспышкой и подсветкой элемента при клике.
const OVERLAY_JS = `
(() => {
  if (window.__dshOverlay) return;
  const make = () => {
    const root = document.createElement('div');
    root.id = 'dsh-overlay';
    root.setAttribute('data-dsh', '1');
    root.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.4;';

    const banner = document.createElement('div');
    banner.id = 'dsh-banner';
    banner.style.cssText = 'position:absolute;top:0;left:0;right:0;height:30px;display:flex;align-items:center;gap:8px;padding:0 12px;background:rgba(2,6,23,.94);color:#e2e8f0;border-bottom:2px solid #38bdf8;box-shadow:0 2px 12px rgba(0,0,0,.45);';
    const dot = document.createElement('span');
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#22c55e;display:inline-block;animation:dshPulse 1.1s ease-in-out infinite;flex:none;';
    const title = document.createElement('span');
    title.textContent = 'DSH-агент работает на этой странице';
    title.style.cssText = 'font-weight:700;white-space:nowrap;';
    const status = document.createElement('span');
    status.id = 'dsh-status';
    status.textContent = 'последнее действие: —';
    status.style.cssText = 'margin-left:auto;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%;';
    banner.appendChild(dot); banner.appendChild(title); banner.appendChild(status);

    const cursor = document.createElement('div');
    cursor.id = 'dsh-cursor';
    cursor.style.cssText = 'position:absolute;top:0;left:0;width:28px;height:28px;transform:translate(-9999px,-9999px);filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));';
    cursor.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M5 2 L19 12 L12 13.5 L8.5 18 Z" fill="#38bdf8" stroke="#0f172a" stroke-width="1.3"/></svg>';
    const ring = document.createElement('div');
    ring.id = 'dsh-ring';
    ring.style.cssText = 'position:absolute;top:0;left:0;width:20px;height:20px;border-radius:50%;border:3px solid #f59e0b;transform:translate(-9999px,-9999px);opacity:0;';

    root.appendChild(banner); root.appendChild(cursor); root.appendChild(ring);
    const style = document.createElement('style');
    style.textContent = '@keyframes dshPulse{0%,100%{opacity:1}50%{opacity:.3}}';
    (document.head || document.documentElement).appendChild(style);
    (document.documentElement || document.body).appendChild(root);

    window.__dshOverlay = {
      show() {},
      hide() { root.remove(); style.remove(); window.__dshOverlay = null; },
      status(t) {
        const s = document.getElementById('dsh-status'); if (!s) return;
        s.textContent = 'последнее действие: ' + t;
      },
      cursor(x, y, kind) {
        const c = document.getElementById('dsh-cursor'); if (!c) return;
        c.style.transform = 'translate(' + x + 'px,' + y + 'px)';
        const r = document.getElementById('dsh-ring'); if (!r) return;
        if (kind === 'click') {
          const el = document.elementFromPoint(x, y);
          if (el) {
            const prev = { outline: el.style.outline, outlineOffset: el.style.outlineOffset };
            el.style.outline = '2px solid #f59e0b';
            el.style.outlineOffset = '2px';
            setTimeout(() => {
              el.style.outline = prev.outline;
              el.style.outlineOffset = prev.outlineOffset;
            }, 900);
          }
          r.style.transform = 'translate(' + (x - 10) + 'px,' + (y - 10) + 'px)';
          r.style.opacity = '1';
          r.style.transition = 'none';
          requestAnimationFrame(() => {
            r.style.transition = 'transform .45s ease-out, opacity .45s ease-out';
            r.style.transform = 'translate(' + (x - 28) + 'px,' + (y - 28) + 'px)';
            r.style.opacity = '0';
          });
        }
      },
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', make);
  else make();
})();
`;

// Последняя позиция курсора (чтобы восстановить его после перехода страницы).
let lastCursor = null;

async function installOverlay(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY_JS });
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: OVERLAY_JS });
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "window.__dshOverlay && window.__dshOverlay.show()" });
    if (lastCursor) {
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "window.__dshOverlay && window.__dshOverlay.cursor(" + lastCursor.x + ", " + lastCursor.y + ", null)",
      });
    }
    overlayTabs.add(tabId);
  } catch (e) {
    log("overlay install skipped for tab", tabId, ":", String(e && e.message || e));
  }
}

async function removeOverlay(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: "window.__dshOverlay && window.__dshOverlay.hide()",
    });
  } catch { /* ignore */ }
  overlayTabs.delete(tabId);
}

async function updateOverlay(tabId, label, x, y, kind) {
  try {
    const expr = x != null && y != null
      ? "window.__dshOverlay && (window.__dshOverlay.status(" + JSON.stringify(String(label)) + "), window.__dshOverlay.cursor(" + x + ", " + y + ", " + JSON.stringify(kind || null) + "))"
      : "window.__dshOverlay && window.__dshOverlay.status(" + JSON.stringify(String(label)) + ")";
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: expr });
  } catch { /* ignore */ }
}

// --- WebSocket к мосту ----------------------------------------------------
async function config() {
  const c = await chrome.storage.local.get({
    serverUrl: "ws://127.0.0.1:8787/ws",
    token: "",
    armed: true,
    bgMode: true,
  });
  return c;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function scheduleReconnect(ms) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, ms);
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#4caf50" });
}

// Single-flight: одновременно существует только ОДНО WebSocket-соединение.
// Без этого повторные вызовы connect() (события установки/запуска/перезагрузки)
// порождают два сокета, сервер закрывает старый, его onclose запускает
// переподключение — бесконечный reconnect-цикл.
let connecting = false;

function connect() {
  if (connecting) return;
  if (ws) {
    const old = ws;
    ws = null;
    try { old.close(); } catch { /* ignore */ }
  }
  connecting = true;
  clearTimeout(reconnectTimer);
  config().then(async ({ serverUrl, token, armed }) => {
    if (!armed || !token) {
      connecting = false;
      updateBadge(false);
      scheduleReconnect(3000);
      return;
    }
    const url = serverUrl + (serverUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      connecting = false;
      scheduleReconnect(3000);
      return;
    }
    ws = socket;
    socket.onopen = () => {
      log("connected to bridge");
      send({ type: "hello", name: "dsh-bridge-extension", version: "0.2.0" });
      updateBadge(true);
      connecting = false;
    };
    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "ping") { send({ type: "pong" }); return; }
      if (msg.type === "command") {
        dispatch(msg.method, msg.params || {}, msg.tabId)
          .then((result) => send({ type: "result", id: msg.id, ok: true, result }))
          .catch((err) => send({ type: "result", id: msg.id, ok: false, error: String((err && err.message) || err) }));
      }
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      connecting = false;
      updateBadge(false);
      scheduleReconnect(2000);
    };
    socket.onerror = () => { try { socket.close(); } catch { /* ignore */ } };
  }).catch(() => {
    connecting = false;
    scheduleReconnect(3000);
  });
}

// --- chrome.debugger ------------------------------------------------------
async function ensureAttached(tabId) {
  if (!attachedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
  }
  if (!overlayTabs.has(tabId)) {
    await installOverlay(tabId);
  }
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    overlayTabs.delete(source.tabId);
    send({ type: "event", event: { kind: "detach", tabId: source.tabId, reason } });
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId && (method === "Page.loadEventFired" || method === "Page.javascriptDialogOpening")) {
    send({ type: "event", event: { kind: "cdp", tabId: source.tabId, method, params } });
  }
});

async function dispatch(method, params, tabId) {
  switch (method) {
    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id,
        windowId: t.windowId,
        title: t.title,
        url: t.url,
        active: t.active,
        pinned: t.pinned,
      }));
    }
    case "open_tab": {
      const cfg = await config();
      // Фоновый режим: вкладки открываются НЕактивными, не перехватывая фокус.
      const active = params.active !== undefined ? !!params.active : !cfg.bgMode;
      const t = await chrome.tabs.create({
        url: params.url || "chrome://newtab/",
        active,
      });
      return { id: t.id, url: t.url, active };
    }
    case "close_tab": {
      await chrome.tabs.remove(params.tabId);
      attachedTabs.delete(params.tabId);
      overlayTabs.delete(params.tabId);
      return { closed: true };
    }
    case "activate_tab": {
      const cfg = await config();
      // Фоновый режим: не переключаем видимую вкладку пользователя.
      if (cfg.bgMode) {
        return { backgroundMode: true, skipped: true, message: "activate_tab отключён в фоновом режиме" };
      }
      const t = await chrome.tabs.update(params.tabId, { active: true });
      if (t.windowId) await chrome.windows.update(t.windowId, { focused: true });
      return { id: t.id, active: true, url: t.url };
    }
    case "attach": {
      await ensureAttached(params.tabId);
      return { attached: true, tabId: params.tabId };
    }
    case "detach": {
      if (attachedTabs.has(params.tabId)) {
        await removeOverlay(params.tabId);
        await chrome.debugger.detach({ tabId: params.tabId });
        attachedTabs.delete(params.tabId);
      }
      return { detached: true };
    }
    case "cdp": {
      await ensureAttached(tabId);
      const res = await chrome.debugger.sendCommand({ tabId }, params.method, params.params || {});
      const p = params.params || {};
      if (params.method && params.method.startsWith("Input.") && typeof p.x === "number" && typeof p.y === "number") {
        lastCursor = { x: p.x, y: p.y };
        let label;
        if (params.method.includes("mousePressed")) label = "клик (" + p.x + ", " + p.y + ")";
        else if (params.method.includes("mouseMoved")) label = "мышь → (" + p.x + ", " + p.y + ")";
        else label = params.method;
        updateOverlay(tabId, label, p.x, p.y, params.method.includes("mousePressed") ? "click" : "move");
      } else if (params.method && params.method.startsWith("Input.")) {
        updateOverlay(tabId, params.method, null, null, null);
      }
      return res || {};
    }
    case "evaluate": {
      await ensureAttached(tabId);
      const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: params.expression,
        returnByValue: true,
        awaitPromise: !!params.awaitPromise,
      });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails.exception;
        throw new Error("evaluate exception: " + (d && d.description ? d.description : res.exceptionDetails.text));
      }
      const label = "evaluate: " + String(params.expression || "").replace(/\s+/g, " ").slice(0, 48);
      updateOverlay(tabId, label, null, null, null);
      return res.result && res.result.value;
    }
    case "screenshot": {
      await ensureAttached(tabId);
      const res = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
        format: params.format || "png",
      });
      updateOverlay(tabId, "screenshot", null, null, null);
      return res.data; // base64
    }
    default:
      throw new Error("unknown method: " + method);
  }
}

// --- сообщения из popup ---------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "reconnect") {
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    ws = null;
    connect();
    sendResponse({ ok: true });
  } else if (msg.type === "getStatus") {
    (async () => {
      const { armed } = await chrome.storage.local.get({ armed: true });
      sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN), armed });
    })();
    return true; // async response
  } else if (msg.type === "detachAll") {
    (async () => {
      const tabs = [...attachedTabs];
      for (const t of tabs) {
        try { await removeOverlay(t); } catch { /* ignore */ }
        try { await chrome.debugger.detach({ tabId: t }); } catch { /* ignore */ }
        attachedTabs.delete(t);
      }
      sendResponse({ detached: tabs.length });
    })();
    return true;
  }
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
