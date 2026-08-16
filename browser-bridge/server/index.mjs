#!/usr/bin/env node
/**
 * DSH Browser Bridge — локальный мост между агентом (DeepSeek Harness)
 * и расширением Chrome.
 *
 * - Слушает ТОЛЬКО 127.0.0.1 (недоступен снаружи).
 * - Защищён токеном: агент передаёт токен в теле запроса (или заголовке X-Token),
 *   расширение — в query-параметре WebSocket-соединения.
 * - Протокол: POST /api/command {"token","method","params","tabId","timeoutMs"}
 *   -> пересылается расширению по WebSocket -> ответ возвращается в HTTP.
 *
 * Методы расширения: list_tabs, open_tab, close_tab, activate_tab,
 * attach, detach, cdp, evaluate, screenshot.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.DSH_BRIDGE_PORT || 8787);
const TOKEN = process.env.DSH_BRIDGE_TOKEN || crypto.randomBytes(16).toString("hex");
const TOKEN_FILE = path.join(__dirname, "token.txt");

fs.writeFileSync(TOKEN_FILE, TOKEN, "utf8");

let extSocket = null;
let nextCmdId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }

const wss = new WebSocketServer({ noServer: true });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function failPending(error) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(error));
  }
  pending.clear();
}

wss.on("connection", (ws) => {
  if (extSocket && extSocket !== ws) {
    try { extSocket.close(); } catch { /* ignore */ }
  }
  extSocket = ws;
  log("extension connected");

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "pong") return;
    if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "command failed"));
      return;
    }
    if (msg.type === "event") {
      log("extension event:", JSON.stringify(msg.event));
    }
  });

  ws.on("close", () => {
    if (extSocket === ws) {
      extSocket = null;
      failPending("extension disconnected");
      log("extension disconnected");
    }
  });
  ws.on("error", () => { /* keepalive ping may fail; close handles it */ });
});

// Держим service worker расширения живым и проверяем связь.
setInterval(() => {
  if (extSocket && extSocket.readyState === extSocket.OPEN) {
    send(extSocket, { type: "ping" });
  }
}, 10000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);

  if (req.method === "GET" && url.pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, connected: !!extSocket, host: HOST, port: PORT }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/command") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let cmd;
    try { cmd = JSON.parse(body); } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
      return;
    }
    const token = cmd.token || req.headers["x-token"];
    if (token !== TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "bad token" }));
      return;
    }
    if (!extSocket) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "extension not connected" }));
      return;
    }
    if (typeof cmd.method !== "string" || !cmd.method) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "method required" }));
      return;
    }
    const id = nextCmdId++;
    const timeoutMs = Math.min(Number(cmd.timeoutMs || 30000), 120000);
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`bridge timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send(extSocket, {
          type: "command",
          id,
          method: cmd.method,
          params: cmd.params || {},
          tabId: cmd.tabId ?? null,
        });
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (url.pathname !== "/ws") { socket.destroy(); return; }
  if (url.searchParams.get("token") !== TOKEN) { socket.destroy(); return; }
  const origin = req.headers.origin || "";
  if (origin && !origin.startsWith("chrome-extension://")) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, HOST, () => {
  log(`bridge listening on ws://${HOST}:${PORT}/ws (token file: ${TOKEN_FILE})`);
});
