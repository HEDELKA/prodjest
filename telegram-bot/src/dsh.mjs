import crypto from "node:crypto";

/**
 * Minimal client for the DeepSeek Harness host API (the same HTTP/WebSocket
 * surface the Web GUI uses at 127.0.0.1:3080).
 *
 * Unary RPC: POST /api/<method> with {type:"client-request", rpcId, method, payload}
 * Streams:   WebSocket /api/events.mux  -> {type:"server-request", rpcId, method, payload}
 * Respond:   POST /api/respond with {type:"client-response", rpcId, result}
 */

export class DshError extends Error {
  constructor(method, code, message, details) {
    super(`${method}: ${message}`);
    this.name = "DshError";
    this.method = method;
    this.code = code;
    this.details = details ?? {};
  }
}

export class DshClient {
  constructor(url) {
    this.url = url.replace(/\/$/, "");
    this.wsUrl = this.url.replace(/^http/, "ws") + "/api/events.mux";
    this.ws = null;
    this.onFrame = null;
    this.reconnectTimer = null;
    this.backoffMs = 1000;
    this.stopped = false;
    this.connected = false;
  }

  // ---------- unary RPC ----------

  async rpc(method, payload, { timeoutMs = 30000, signal } = {}) {
    const rpcId = crypto.randomUUID();
    let res;
    try {
      res = await fetch(`${this.url}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DshError(method, "transport", `DSH host unreachable: ${err?.message ?? err}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new DshError(method, `http-${res.status}`, `HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const full = await res.json();
    if (full?.type !== "server-response" || full.rpcId !== rpcId) {
      throw new DshError(method, "protocol", "invalid server envelope");
    }
    if (!full.result?.ok) {
      const e = full.result?.error ?? {};
      throw new DshError(method, e.code ?? "internal", e.message ?? "unknown error", e.details);
    }
    return full.result.value;
  }

  async respond(rpcId, result) {
    const res = await fetch(`${this.url}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-response", rpcId, result }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new DshError("respond", `http-${res.status}`, `HTTP ${res.status}`);
    return res.json();
  }

  // ---------- domain wrappers ----------

  listSessions() {
    return this.rpc("session.list", {});
  }

  createSession({ cwd, agentPreset } = {}) {
    return this.rpc("session.create", {
      ...(cwd ? { cwd } : {}),
      ...(agentPreset ? { agentPreset } : {}),
    });
  }

  prompt(sessionId, text, mode = "queue") {
    return this.rpc("session.prompt", {
      sessionId,
      mode,
      content: [{ type: "text", text }],
    });
  }

  cancel(sessionId) {
    return this.rpc("session.cancel", { sessionId });
  }

  history(sessionId, { beforeSeq, maxMessages } = {}) {
    return this.rpc("session.history", {
      sessionId,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      ...(maxMessages !== undefined ? { maxMessages } : {}),
    });
  }

  // ---------- mux event stream (WebSocket) ----------

  start(onFrame) {
    this.onFrame = onFrame;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = 1000;
      this.connected = true;
      console.log("[dsh] mux stream connected");
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg?.type === "server-request" && msg.payload) {
        // Answerable frames need the envelope's rpcId to respond later.
        const p = msg.payload;
        if (
          (p.type === "approval/requested" || p.type === "question/requested") &&
          p.rpcId === undefined
        ) {
          p.rpcId = msg.rpcId;
        }
        this.onFrame?.(p);
      }
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      console.log("[dsh] mux stream closed, reconnecting…");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
  }
}
