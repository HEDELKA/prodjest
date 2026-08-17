import { esc, truncate, contentText } from "./format.mjs";

/**
 * Live streaming renderer: turns DSH session events into Telegram messages.
 * Assistant tokens stream into an auto-editing message (throttled); reasoning
 * goes to its own "🧠" message; tool calls/results become status messages.
 */
export class StreamManager {
  constructor(bot, dsh, { streamIntervalMs = 1200, maxMessageChars = 3800, store } = {}) {
    this.bot = bot;
    this.dsh = dsh;
    this.store = store;
    this.streamIntervalMs = streamIntervalMs;
    this.maxMessageChars = maxMessageChars;
    this.streams = new Map(); // "chatId:sessionId" -> StreamState
  }

  key(chatId, sessionId) {
    return `${chatId}:${sessionId}`;
  }

  isWatching(chatId, sessionId) {
    return this.streams.has(this.key(chatId, sessionId));
  }

  attach(chatId, sessionId, { announce = true } = {}) {
    const key = this.key(chatId, sessionId);
    if (!this.streams.has(key)) {
      this.streams.set(key, new StreamState(this, chatId, sessionId));
    }
    const st = this.streams.get(key);
    if (announce) {
      this.bot.telegram
        .sendMessage(chatId, `📡 Наблюдаю за задачей <code>${esc(short(sessionId))}</code>`, {
          parse_mode: "HTML",
          ...this.controlKeyboard(),
        })
        .then((m) => (st.announceMsgId = m.message_id))
        .catch(() => {});
    }
    // Digest of the recent past so the user sees where the task is right now.
    st.backfill().catch(() => {});
    return st;
  }

  detach(chatId, sessionId) {
    const st = this.streams.get(this.key(chatId, sessionId));
    if (!st) return;
    st.dispose();
    this.streams.delete(this.key(chatId, sessionId));
  }

  /** Route one mux frame. */
  handleFrame(frame) {
    switch (frame.type) {
      case "session/event":
        this.dispatchEvent(frame.sessionId, frame.event);
        break;
      case "session/subscribed": {
        // Reconnect hook: backfill anything missed while the socket was down.
        for (const [key, st] of this.streams) {
          if (st.sessionId === frame.sessionId && st.lastSeq < frame.lastSeq) {
            st.backfill().catch(() => {});
          }
        }
        break;
      }
      case "approval/requested":
        this.dispatchApproval(frame);
        break;
      case "approval/resolved":
        this.dispatchApprovalResolved(frame);
        break;
      case "question/requested":
        this.dispatchQuestion(frame);
        break;
      case "session/queue":
        this.dispatchQueue(frame);
        break;
      case "session/jobs":
        this.dispatchJobs(frame);
        break;
    }
  }

  dispatchEvent(sessionId, event) {
    for (const [key, st] of this.streams) {
      if (st.sessionId !== sessionId || st.muted) continue;
      st.enqueue(event);
    }
  }

  dispatchApproval(frame) {
    for (const [key, st] of this.streams) {
      if (st.sessionId === frame.sessionId) st.handleApproval(frame);
    }
  }

  dispatchApprovalResolved(frame) {
    for (const [key, st] of this.streams) {
      if (st.sessionId === frame.sessionId) st.handleApprovalResolved(frame);
    }
  }

  dispatchQuestion(frame) {
    for (const [key, st] of this.streams) {
      if (st.sessionId === frame.sessionId) st.handleQuestion(frame);
    }
  }

  dispatchQueue(frame) {
    for (const [key, st] of this.streams) {
      if (st.sessionId === frame.sessionId) st.handleQueue(frame);
    }
  }

  dispatchJobs(frame) {
    for (const [key, st] of this.streams) {
      if (st.sessionId === frame.sessionId) st.handleJobs(frame);
    }
  }

  controlKeyboard() {
    const { Markup } = this.bot;
    return Markup.inlineKeyboard([
      Markup.button.callback("⏹ Стоп", "cb:" + this.bot.cb.set({ kind: "stop" })),
      Markup.button.callback("🔇 Пауза", "cb:" + this.bot.cb.set({ kind: "mute" })),
      Markup.button.callback("👁 Отписаться", "cb:" + this.bot.cb.set({ kind: "unwatch" })),
    ]);
  }

  /** Send a standalone note into the chat (used by the bot itself, not the stream). */
  async notify(chatId, text, extra = {}) {
    try {
      return await this.bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML", ...extra });
    } catch (err) {
      console.log("[tg] notify failed:", err.message);
      return null;
    }
  }
}

function short(sessionId) {
  return String(sessionId).replace(/^session-/, "").slice(0, 8);
}

class StreamState {
  constructor(manager, chatId, sessionId) {
    this.manager = manager;
    this.bot = manager.bot;
    this.chatId = chatId;
    this.sessionId = sessionId;
    this.muted = false;
    this.announceMsgId = null;
    this.lastSeq = -1;
    this.seqs = new Set();
    this.turn = 0;
    this.step = 0;
    this.text = { buffer: "", msgId: null, lastSent: "", timer: null, final: false };
    this.reasoning = { buffer: "", msgId: null, timer: null };
    this.tools = new Map(); // callId -> {msgId, name}
    this.approvals = new Map(); // approvalId -> msgId
    this.questions = new Map(); // question batch rpcId -> {msgId, state}
    this.title = null;
    this.lastTodo = null;
    this.lastJob = null;
    this.chain = Promise.resolve();
  }

  dispose() {
    for (const buf of [this.text, this.reasoning]) {
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = null;
    }
  }

  // ---------- backfill ----------

  /** Digest of the recent past: last few assistant/user messages. */
  async backfill() {
    try {
      const { events } = await this.manager.dsh.history(this.sessionId, { maxMessages: 40 });
      const sorted = [...events]
        .map((e) => e.event)
        .filter((e) => e && Number.isInteger(e.seq))
        .sort((a, b) => a.seq - b.seq);
      const newest = sorted.at(-1)?.seq ?? -1;
      if (newest <= this.lastSeq) return; // nothing new since we last saw it
      this.lastSeq = Math.max(this.lastSeq, newest);
      const assistants = sorted.filter((e) => e.type === "assistant/message").slice(-3);
      const users = sorted.filter((e) => e.type === "user/message" && e.data?.source?.kind === "user").slice(-3);
      const parts = [];
      const digest = [...users, ...assistants].sort((a, b) => a.seq - b.seq);
      if (digest.length) parts.push("📜 <b>Что было недавно:</b>");
      for (const ev of digest) {
        const text =
          ev.type === "user/message"
            ? contentText(ev.data?.content)
            : contentText(ev.data?.message?.content);
        const clean = String(text ?? "").replace(/\s+/g, " ").trim();
        if (!clean) continue;
        parts.push(`${ev.type === "user/message" ? "📨" : "🤖"} ${esc(truncate(clean, 280))}`);
      }
      if (parts.length > 1) this.note(parts.join("\n"));
    } catch (err) {
      console.log("[stream] backfill failed:", err.message);
    }
  }

  // ---------- events ----------

  handleEvent(event, { replay = false } = {}) {
    if (Number.isInteger(event.seq)) {
      if (this.seqs.has(event.seq)) return;
      this.seqs.add(event.seq);
      this.lastSeq = Math.max(this.lastSeq, event.seq);
    }
    if (replay) return; // backfill uses the compact digest, not event replay
    // Events are processed strictly in arrival order (tool/result must see its call).
    this.chain = this.chain
      .then(() => this.handleEventNow(event))
      .catch((err) => console.log("[stream] event error:", err.message));
  }

  async handleEventNow(event) {
      switch (event.type) {
        case "turn/start":
          this.turn = event.data?.turn ?? this.turn + 1;
          this.step = 0;
          if (this.turn > 1) this.note(`▶️ Заход #${this.turn}`);
          break;
        case "step/start":
          this.step = event.data?.step ?? this.step + 1;
          break;
        case "assistant/chunk":
          this.handleChunk(event.data?.chunk);
          break;
        case "assistant/message": {
          const msg = event.data?.message;
          if (msg?.content) {
            const text = contentText(msg.content);
            if (text) {
              this.text.buffer = text;
              this.flushText(true).catch(() => {});
            }
          }
          break;
        }
        case "user/message": {
          const msg = event.data?.message ?? event.data;
          const source = msg?.source ?? event.data?.source;
          if (source?.kind === "user") {
            const text = contentText(msg?.content);
            if (text && !replay) this.note(`📨 <b>Вы:</b> ${esc(truncate(text, 600))}`);
          }
          break;
        }
        case "tool/call":
          this.handleToolCall(event.data);
          break;
        case "tool/result":
          this.handleToolResult(event.data);
          break;
        case "turn/end": {
          const reason = event.data?.reason?.kind;
          if (this.text.buffer || this.text.msgId) this.flushText(true, reason).catch(() => {});
          if (reason === "error") {
            const err = event.data?.reason?.error;
            this.note(`❌ Заход завершился ошибкой: ${esc(truncate(err?.message ?? "?", 300))}`);
          } else if (reason === "aborted") {
            this.note("⏹ Заход остановлен (cancel)");
          } else if (reason === "completed") {
            // silence: the final flush already shows the answer
          }
          this.tools.clear();
          break;
        }
        case "session/title":
          this.title = event.data?.title;
          break;
        case "todo/write": {
          const items = event.data?.todos ?? event.data?.items;
          if (Array.isArray(items) && items.length > 0) {
            const line = items
              .map((t, i) => `${t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜️"} ${i + 1}. ${t.content}`)
              .join("\n");
            this.lastTodo = `📝 <b>Задачи:</b>\n${esc(truncate(line, 800))}`;
          }
          break;
        }
        case "goal/change": {
          const g = event.data?.goal;
          if (g) this.note(`🎯 <b>Цель:</b> ${esc(truncate(g.objective, 200))} — ${phaseEmoji(g.phase)}`);
          break;
        }
        default:
          break;
      }
  }

  handleChunk(chunk) {
    if (!chunk || typeof chunk !== "object") return;
    switch (chunk.type) {
      case "text-delta":
        if (chunk.text) {
          this.text.buffer += chunk.text;
          this.scheduleTextFlush();
        }
        break;
      case "reasoning-delta":
        if (chunk.text) {
          this.reasoning.buffer += chunk.text;
          // keep only a tail window to avoid unbounded growth
          if (this.reasoning.buffer.length > 2000) {
            this.reasoning.buffer = "…" + this.reasoning.buffer.slice(-2000);
          }
          this.scheduleReasoningFlush();
        }
        break;
      default:
        break;
    }
  }

  // ---------- text flushing ----------

  scheduleTextFlush() {
    if (this.text.timer || this.text.final) return;
    this.text.timer = setTimeout(() => {
      this.text.timer = null;
      this.flushText(false).catch(() => {});
    }, this.manager.streamIntervalMs);
  }

  scheduleReasoningFlush() {
    if (this.reasoning.timer) return;
    this.reasoning.timer = setTimeout(() => {
      this.reasoning.timer = null;
      this.flushReasoning().catch(() => {});
    }, this.manager.streamIntervalMs * 1.5);
  }

  /** Serialized text flush: every call runs in arrival order on the event chain. */
  flushText(final, reason) {
    this.chain = this.chain
      .then(() => this.flushTextNow(final, reason))
      .catch((err) => console.log("[stream] flush error:", err.message));
    return this.chain;
  }

  flushReasoning() {
    this.chain = this.chain
      .then(() => this.flushReasoningNow())
      .catch((err) => console.log("[stream] reasoning flush error:", err.message));
    return this.chain;
  }

  async flushTextNow(final, reason) {
    const st = this.text;
    if (st.final && final) return;
    const text = st.buffer.trim();
    if (!text && st.msgId === null) {
      if (final && reason) this.note(`⏹ ${esc(reason)}`);
      return;
    }
    st.final = final;
    const rendered = final ? `🤖 ${esc(text)}` : `🤖 ${esc(text)}`;
    // Split long output across messages.
    const parts = splitRendered(rendered, this.manager.maxMessageChars);
    if (st.msgId === null) {
      const first = parts.shift() ?? rendered;
      const msg = await this.sendOrEdit(null, first);
      if (!msg) return;
      st.msgId = msg.message_id;
    } else {
      const first = parts.shift() ?? rendered;
      if (first !== st.lastSent || final) {
        await this.sendOrEdit(st.msgId, first);
        st.lastSent = first;
      }
    }
    for (const part of parts) {
      const msg = await this.sendOrEdit(null, part);
      if (msg) st.msgId = msg.message_id;
    }
    if (final) {
      st.buffer = "";
      st.lastSent = "";
      st.msgId = null;
      st.final = false;
    }
  }

  async sendOrEdit(msgId, text) {
    try {
      if (msgId === null) {
        const m = await this.bot.telegram.sendMessage(this.chatId, text, { parse_mode: "HTML", disable_web_page_preview: true });
        return m;
      }
      await this.bot.telegram.editMessageText(this.chatId, msgId, undefined, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return { message_id: msgId };
    } catch (err) {
      // "message is not modified" and edit-rate limits are benign.
      if (String(err?.message).includes("message is not modified")) return { message_id: msgId };
      if (String(err?.message).includes("Too Many Requests")) {
        console.log("[tg] edit rate limited, will retry on next flush");
        return null;
      }
      console.log("[tg] send/edit failed:", err?.message);
      return null;
    }
  }

  async flushReasoningNow() {
    const st = this.reasoning;
    const text = st.buffer.trim();
    if (!text) return;
    const rendered = `🧠 <i>${esc(text)}</i>`;
    if (st.msgId === null) {
      const m = await this.sendOrEdit(null, rendered);
      if (m) st.msgId = m.message_id;
    } else {
      await this.sendOrEdit(st.msgId, rendered);
    }
  }

  // ---------- tools ----------

  async handleToolCall(data) {
    const name = data?.name ?? "?";
    const args = data?.arguments ? truncate(String(data.arguments), 300) : "";
    const callId = data?.callId ?? `${name}-${Date.now()}`;
    const text = `🛠 <b>${esc(name)}</b>${args ? `\n<code>${esc(args)}</code>` : ""}`;
    // Register synchronously so a fast tool/result never races us.
    const rec = { msgId: null, name };
    this.tools.set(callId, rec);
    try {
      const m = await this.bot.telegram.sendMessage(this.chatId, text, { parse_mode: "HTML" });
      rec.msgId = m.message_id;
    } catch {}
  }

  async handleToolResult(data) {
    const callId = data?.callId ?? data?.message?.callId;
    const rec = callId ? this.tools.get(callId) : undefined;
    if (!rec) return;
    // Wait briefly if the call card is still being sent.
    for (let i = 0; i < 10 && rec.msgId === null; i++) await new Promise((r) => setTimeout(r, 100));
    if (rec.msgId === null) return;
    const message = data?.message;
    const ok = !message?.isError;
    const textContent = contentText(message?.content) || "";
    const detail = ok
      ? truncate(textContent, 200)
      : truncate(String(data?.error ?? textContent ?? message?.content?.[0]?.text ?? "ошибка"), 200);
    const text = `🛠 <b>${esc(rec.name)}</b>\n${ok ? "✅" : "❌"} <code>${esc(detail)}</code>`;
    try {
      await this.bot.telegram.editMessageText(this.chatId, rec.msgId, undefined, text, { parse_mode: "HTML" });
      this.tools.delete(callId);
    } catch {}
  }

  // ---------- approvals & questions ----------

  handleApproval(frame) {
    const { Markup } = this.bot;
    const text = `🔔 <b>Запрос разрешения</b>\n🛠 ${esc(frame.toolName ?? "?")}${frame.reason ? `\n<i>${esc(frame.reason)}</i>` : ""}`;
    const rpcId = frame.rpcId ?? frame.questionRpcId; // approval frames carry rpcId on the frame
    this.bot.telegram
      .sendMessage(this.chatId, text, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          Markup.button.callback("✅ Разрешить", "cb:" + this.bot.cb.set({ kind: "approve", rpcId, approvalId: frame.approvalId, sessionId: frame.sessionId, allow: true })),
          Markup.button.callback("❌ Отклонить", "cb:" + this.bot.cb.set({ kind: "approve", rpcId, approvalId: frame.approvalId, sessionId: frame.sessionId, allow: false })),
        ]),
      })
      .then((m) => this.approvals.set(frame.approvalId, m.message_id))
      .catch(() => {});
  }

  handleApprovalResolved(frame) {
    const msgId = this.approvals.get(frame.approvalId);
    if (!msgId) return;
    const outcome = frame.outcome === "rejected" ? "❌ Отклонено" : "✅ Разрешено";
    this.bot.telegram
      .editMessageText(this.chatId, msgId, undefined, `🔔 <b>Запрос разрешения</b>\n<i>${outcome}</i>`, { parse_mode: "HTML" })
      .catch(() => {});
    this.approvals.delete(frame.approvalId);
  }

  handleQuestion(frame) {
    // Forward to the bot-level question handler (renders per-question flow).
    this.bot.emitQuestion?.(this.chatId, frame);
  }

  // ---------- queue / jobs ----------

  handleQueue(frame) {
    const items = frame.items ?? [];
    const pending = items.filter((i) => i.placement === "queued");
    if (pending.length > 0) {
      this.note(`🧍 В очереди: ${pending.length} сообщ. (обработаю после текущего шага)`);
    }
  }

  handleJobs(frame) {
    const jobs = (frame.jobs ?? []).filter((j) => j.status === "running" || j.status === "stopping");
    if (jobs.length > 0 && jobs.some((j) => j.label !== this.lastJob)) {
      this.lastJob = jobs.map((j) => j.label).join(", ");
      this.note(`⚡ Выполняется: ${esc(this.lastJob)}`);
    }
  }

  async note(text) {
    try {
      await this.bot.telegram.sendMessage(this.chatId, text, { parse_mode: "HTML", disable_web_page_preview: true });
    } catch {}
  }
}

function splitRendered(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    // break at a newline when possible, else hard cut
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function phaseEmoji(phase) {
  switch (phase) {
    case "complete":
      return "✅ завершена";
    case "paused":
      return "⏸ на паузе";
    case "blocked":
      return "🚧 заблокирована";
    case "active":
      return "▶️ активна";
    default:
      return phase ?? "?";
  }
}
