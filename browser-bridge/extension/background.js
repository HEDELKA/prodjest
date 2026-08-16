// DSH Browser Bridge — фон (service worker).
// Держит WebSocket к мосту 127.0.0.1:8787 и выполняет команды через chrome.debugger.

let ws = null;
let reconnectTimer = null;
const attachedTabs = new Set();

function log(...args) {
  console.log("[dsh-bridge]", new Date().toISOString(), ...args);
}

async function config() {
  const c = await chrome.storage.local.get({
    serverUrl: "ws://127.0.0.1:8787/ws",
    token: "",
    armed: true,
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

function connect() {
  clearTimeout(reconnectTimer);
  config().then(async ({ serverUrl, token, armed }) => {
    if (!armed || !token) {
      updateBadge(false);
      scheduleReconnect(3000);
      return;
    }
    const url = serverUrl + (serverUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      scheduleReconnect(3000);
      return;
    }
    ws = socket;
    socket.onopen = () => {
      log("connected to bridge");
      send({ type: "hello", name: "dsh-bridge-extension", version: "0.1.0" });
      updateBadge(true);
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
      ws = null;
      updateBadge(false);
      scheduleReconnect(2000);
    };
    socket.onerror = () => { try { socket.close(); } catch { /* ignore */ } };
  });
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
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
      const t = await chrome.tabs.create({
        url: params.url || "chrome://newtab/",
        active: params.active !== false,
      });
      return { id: t.id, url: t.url };
    }
    case "close_tab": {
      await chrome.tabs.remove(params.tabId);
      attachedTabs.delete(params.tabId);
      return { closed: true };
    }
    case "activate_tab": {
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
        await chrome.debugger.detach({ tabId: params.tabId });
        attachedTabs.delete(params.tabId);
      }
      return { detached: true };
    }
    case "cdp": {
      await ensureAttached(tabId);
      const res = await chrome.debugger.sendCommand({ tabId }, params.method, params.params || {});
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
      return res.result && res.result.value;
    }
    case "screenshot": {
      await ensureAttached(tabId);
      const res = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
        format: params.format || "png",
      });
      return res.data; // base64
    }
    default:
      throw new Error("unknown method: " + method);
  }
}

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
  }
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
