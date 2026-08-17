import { Telegraf, Markup } from "telegraf";
import { loadConfig } from "./config.mjs";
import { Store } from "./store.mjs";
import { DshClient, DshError } from "./dsh.mjs";
import { StreamManager } from "./stream.mjs";
import { transcribeVoice } from "./whisper.mjs";
import { esc, truncate, timeAgo, basename, shortId, sessionLabel, statusBadge } from "./format.mjs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cfg = loadConfig();
const store = new Store();
const dsh = new DshClient(cfg.dshUrl);
const bot = new Telegraf(cfg.telegramToken);
bot.Markup = Markup;

// ---------- callback registry (callback_data <= 64 bytes) ----------
const cbTokens = new Map(); // token -> {payload, at}
const CB_TTL_MS = 60 * 60 * 1000;
const cb = {
  set(payload) {
    // prune stale tokens occasionally
    if (cbTokens.size > 500) {
      const now = Date.now();
      for (const [t, v] of cbTokens) if (now - v.at > CB_TTL_MS) cbTokens.delete(t);
    }
    let token;
    do {
      token = Math.random().toString(36).slice(2, 8);
    } while (cbTokens.has(token));
    cbTokens.set(token, { payload, at: Date.now() });
    return token;
  },
  get(token) {
    return cbTokens.get(token)?.payload;
  },
};
bot.cb = cb;

const manager = new StreamManager(bot, dsh, {
  store,
  streamIntervalMs: cfg.streamIntervalMs,
  maxMessageChars: cfg.maxMessageChars,
});

// ---------- pending inputs (per chat) ----------
// { type: "task", cwd } | { type: "question", rpcId }
const pendingInputs = new Map();

// ---------- question flows (per chat:rpcId) ----------
// { rpcId, sessionId, questions, answers, index, msgId }
const questionFlows = new Map();
const flowKey = (chatId, rpcId) => `${chatId}:${rpcId}`;

// ---------- guard ----------
function allowed(ctx) {
  return store.isAllowed(ctx.chat?.id);
}

function deny(ctx) {
  return ctx.reply("⛔️ Доступ запрещён. Отправьте /start с разрешённого аккаунта.").catch(() => {});
}

/** Build { parse_mode: "HTML", reply_markup } from inline keyboard rows. */
function kb(rows) {
  return { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) };
}

// ---------- menus ----------
function mainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📋 Задачи", "cb:" + cb.set({ kind: "tasks" })),
      Markup.button.callback("➕ Новая задача", "cb:" + cb.set({ kind: "new" })),
    ],
    [
      Markup.button.callback("⏹ Стоп", "cb:st"),
      Markup.button.callback("📝 Корректировка", "cb:" + cb.set({ kind: "steer" })),
    ],
    [Markup.button.callback("✋ Помощь", "cb:" + cb.set({ kind: "help" }))],
  ]);
}

// ---------- session listing ----------
async function fetchSessions() {
  const { items } = await dsh.listSessions();
  return items.filter((s) => !s.blank && s.origin !== "subagent");
}

function latestOf(list) {
  return list.reduce((m, s) => Math.max(m, s.updatedAt ?? 0), 0);
}

async function replyProjects(ctx, chatId) {
  let sessions;
  try {
    sessions = await fetchSessions();
  } catch (err) {
    return ctx.reply(`❌ ${esc(err.message)}`).catch(() => {});
  }
  const groups = new Map();
  for (const s of sessions) {
    const cwd = s.cwd ?? "(неизвестно)";
    if (!groups.has(cwd)) groups.set(cwd, []);
    groups.get(cwd).push(s);
  }
  const rows = [...groups.entries()]
    .sort((a, b) => latestOf(b[1]) - latestOf(a[1]))
    .map(([cwd, list]) => {
      const anyRunning = list.some((s) => s.running);
      const badge = anyRunning ? "🟢" : `🕐 ${timeAgo(latestOf(list))}`;
      return [Markup.button.callback(`📁 ${basename(cwd)} · ${badge}`, "cb:" + cb.set({ kind: "proj", cwd }))];
    });
  if (rows.length === 0) rows.push([Markup.button.callback("(задач пока нет)", "cb:" + cb.set({ kind: "noop" }))]);
  rows.push([
    Markup.button.callback("➕ Новая", "cb:" + cb.set({ kind: "new" })),
    Markup.button.callback("🔄", "cb:" + cb.set({ kind: "tasks" })),
    Markup.button.callback("✖️", "cb:" + cb.set({ kind: "close" })),
  ]);
  const msg = await ctx.reply("📋 <b>Проекты</b> — выберите, за чем наблюдать", kb(rows));
  return msg;
}

async function replyProjectSessions(ctx, chatId, cwd, { editMsgId } = {}) {
  let sessions;
  try {
    sessions = (await fetchSessions()).filter((s) => (s.cwd ?? "(неизвестно)") === cwd);
  } catch (err) {
    return ctx.reply(`❌ ${esc(err.message)}`).catch(() => {});
  }
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const rows = sessions.map((s) => {
    const label = sessionLabel(s);
    return [
      Markup.button.callback(
        `💬 ${truncate(label, 44)} · ${statusBadge(s)}`,
        `cb:w:${s.sessionId}` // direct-encoded: survives bot restarts
      ),
    ];
  });
  if (rows.length === 0) rows.push([Markup.button.callback("(пусто)", "cb:" + cb.set({ kind: "noop" }))]);
  rows.push([
    Markup.button.callback("➕ Новая здесь", "cb:" + cb.set({ kind: "newin", cwd })),
    Markup.button.callback("⬅️ Назад", "cb:" + cb.set({ kind: "tasks" })),
  ]);
  const text = `📁 <b>${esc(cwd)}</b>`;
  const keyboard = Markup.inlineKeyboard(rows);
  if (editMsgId) {
    await ctx.telegram.editMessageText(chatId, editMsgId, undefined, text, { parse_mode: "HTML", ...keyboard }).catch(() => {});
  } else {
    await ctx.reply(text, { ...kb(rows) });
  }
}

async function newTaskFlow(chatId, cwd) {
  // Choose cwd interactively.
  const recent = new Map();
  try {
    for (const s of await fetchSessions()) {
      if (s.cwd && !recent.has(s.cwd)) recent.set(s.cwd, s.updatedAt ?? 0);
    }
  } catch {}
  const rows = [
    [Markup.button.callback(`📁 ${basename(cfg.defaultCwd)} (по умолчанию)`, "cb:" + cb.set({ kind: "newin", cwd: cfg.defaultCwd }))],
    ...[...recent.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([c, ts]) => [Markup.button.callback(`📁 ${basename(c)} · ${timeAgo(ts)}`, "cb:" + cb.set({ kind: "newin", cwd: c }))]),
    [
      Markup.button.callback("✍️ Другой путь…", "cb:" + cb.set({ kind: "newcustom" })),
      Markup.button.callback("❌", "cb:" + cb.set({ kind: "close" })),
    ],
  ];
  await bot.telegram.sendMessage(chatId, "📍 <b>Где создать задачу?</b>", kb(rows)).catch(() => {});
}

async function askTaskText(chatId, cwd) {
  pendingInputs.set(chatId, { type: "task", cwd });
  await bot.telegram.sendMessage(chatId, `📝 Опишите задачу (текстом или голосом) для <b>${esc(basename(cwd))}</b>…`).catch(() => {});
}

async function createTask(chatId, cwd, text) {
  if (!text.trim()) {
    await bot.telegram.sendMessage(chatId, "Пустое описание — задача не создана.").catch(() => {});
    return;
  }
  try {
    const { sessionId } = await dsh.createSession({ cwd });
    await dsh.prompt(sessionId, text, "queue");
    store.setWatched(chatId, sessionId);
    manager.attach(chatId, sessionId);
    await bot.telegram
      .sendMessage(chatId, `✅ <b>Задача создана</b>\n🆔 <code>${esc(shortId(sessionId))}</code>\n📁 ${esc(cwd)}\n\n📨 ${esc(truncate(text, 400))}`, {
        parse_mode: "HTML",
      })
      .catch(() => {});
  } catch (err) {
    await bot.telegram.sendMessage(chatId, `❌ ${esc(err.message)}`).catch(() => {});
  }
}

// ---------- steer ----------
async function steer(chatId, text) {
  const sid = store.watched(chatId);
  if (!sid) {
    await bot.telegram.sendMessage(chatId, "Сначала выберите задачу: /tasks").catch(() => {});
    return false;
  }
  try {
    await dsh.prompt(sid, `[Корректировка] ${text}`, "steer");
    await bot.telegram
      .sendMessage(chatId, `📝 <b>Корректировка отправлена</b> — продолжаю с учётом:\n\n${esc(truncate(text, 500))}`)
      .catch(() => {});
    return true;
  } catch (err) {
    await bot.telegram.sendMessage(chatId, `❌ ${esc(err.message)}`).catch(() => {});
    return false;
  }
}

async function doStop(chatId, { editMsgId } = {}) {
  let sid = store.watched(chatId);
  if (!sid) {
    try {
      const running = (await fetchSessions()).find((s) => s.running);
      if (running) sid = running.sessionId;
    } catch {}
  }
  if (!sid) {
    const text = "⏹ Нет активной задачи (выберите /tasks или /new).";
    if (editMsgId) await bot.telegram.editMessageText(chatId, editMsgId, undefined, text, { parse_mode: "HTML" }).catch(() => {});
    else await bot.telegram.sendMessage(chatId, text).catch(() => {});
    return;
  }
  try {
    await dsh.cancel(sid);
    const text = `⏹ Остановка отправлена для <code>${esc(shortId(sid))}</code>.`;
    if (editMsgId) await bot.telegram.editMessageText(chatId, editMsgId, undefined, text, { parse_mode: "HTML" }).catch(() => {});
    else await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" }).catch(() => {});
  } catch (err) {
    await bot.telegram.sendMessage(chatId, `❌ ${esc(err.message)}`).catch(() => {});
  }
}

// ---------- questions (ask_user_question via Telegram) ----------
function renderQuestion(chatId, flow) {
  const q = flow.questions[flow.index];
  if (!q) return;
  const ans = flow.answers[flow.index];
  const lines = [`❓ <b>Вопрос агента</b>`];
  if (q.header) lines.push(`<i>${esc(q.header)}</i>`);
  lines.push(esc(q.question));
  if (q.detail) lines.push(`<i>${esc(q.detail)}</i>`);
  if (q.multiSelect) lines.push(`<i>(можно выбрать несколько)</i>`);
  const opts = q.options ?? [];
  const buttons = [];
  if (opts.length > 0) {
    for (const o of opts) {
      const sel = ans?.selected?.includes(o.label);
      const label = q.multiSelect ? `${sel ? "☑️" : "⬜️"} ${o.label}` : o.label;
      buttons.push([
        Markup.button.callback(truncate(label, 60), "cb:" + cb.set({ kind: "qopt", rpcId: flow.rpcId, index: flow.index, label: o.label })),
      ]);
    }
    if (q.multiSelect) {
      buttons.push([Markup.button.callback("✅ Отправить", "cb:" + cb.set({ kind: "qsubmit", rpcId: flow.rpcId }))]);
    }
  } else {
    buttons.push([Markup.button.callback("✍️ Ввести ответ", "cb:" + cb.set({ kind: "qcustom", rpcId: flow.rpcId }))]);
  }
  buttons.push([Markup.button.callback("❌ Отмена", "cb:" + cb.set({ kind: "qcancel", rpcId: flow.rpcId }))]);
  const text = lines.join("\n");
  if (flow.msgId) {
    bot.telegram.editMessageText(chatId, flow.msgId, undefined, text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) }).catch(() => {});
  } else {
    bot.telegram.sendMessage(chatId, text, kb(buttons)).then((m) => (flow.msgId = m.message_id)).catch(() => {});
  }
}

async function submitQuestion(chatId, flow) {
  try {
    await dsh.respond(flow.rpcId, {
      ok: true,
      value: { sessionId: flow.sessionId, answer: { answers: flow.answers } },
    });
  } catch (err) {
    await bot.telegram.editMessageText(chatId, flow.msgId, undefined, `❌ ${esc(err.message)}`, { parse_mode: "HTML" }).catch(() => {});
    return;
  }
  await bot.telegram.editMessageText(chatId, flow.msgId, undefined, "✅ Ответ отправлен агенту.").catch(() => {});
  questionFlows.delete(flowKey(chatId, flow.rpcId));
}

function advanceOrSubmit(chatId, flow) {
  if (flow.index + 1 < flow.questions.length) {
    flow.index += 1;
    renderQuestion(chatId, flow);
  } else {
    submitQuestion(chatId, flow);
  }
}

bot.emitQuestion = (chatId, frame) => {
  const key = flowKey(chatId, frame.rpcId);
  if (questionFlows.has(key)) return;
  const flow = {
    rpcId: frame.rpcId,
    sessionId: frame.sessionId,
    questions: frame.questions ?? [],
    answers: (frame.questions ?? []).map((q) => ({ id: q.id, selected: [], custom: "" })),
    index: 0,
    msgId: null,
  };
  if (flow.questions.length === 0) return;
  questionFlows.set(key, flow);
  renderQuestion(chatId, flow);
};

// ---------- callbacks ----------
bot.action(/^cb:/, async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!allowed(ctx)) return deny(ctx);
  const raw = String(ctx.callbackQuery.data);

  // Direct-encoded callbacks (survive bot restarts — no in-memory token).
  if (raw.startsWith("cb:w:")) {
    const sessionId = raw.slice(5);
    try {
      store.setWatched(chatId, sessionId);
      manager.attach(chatId, sessionId);
      await ctx.answerCbQuery().catch(() => {});
    } catch (err) {
      console.log("[tg] watch error:", err.message);
    }
    return;
  }
  if (raw === "cb:st") {
    await doStop(chatId, { editMsgId: ctx.callbackQuery.message?.message_id });
    await ctx.answerCbQuery().catch(() => {});
    return;
  }
  if (raw === "cb:mu") {
    const sid = store.watched(chatId);
    if (sid) {
      const st = manager.streams.get(manager.key(chatId, sid));
      if (st) {
        st.muted = !st.muted;
        store.setMuted(chatId, st.muted);
      }
    }
    await ctx.answerCbQuery().catch(() => {});
    return;
  }
  if (raw === "cb:uw") {
    const sid = store.watched(chatId);
    if (sid) manager.detach(chatId, sid);
    store.setWatched(chatId, null);
    await bot.telegram.editMessageText(chatId, ctx.callbackQuery.message?.message_id, undefined, "👁 Отписался от задачи.").catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  const payload = cb.get(raw.slice(3));
  if (!payload) return ctx.answerCbQuery("⏳ Кнопка устарела (бот перезапускался) — нажмите /tasks заново", true).catch(() => {});
  try {
    switch (payload.kind) {
      case "tasks":
        await replyProjects(ctx, chatId);
        break;
      case "proj":
        await replyProjectSessions(ctx, chatId, payload.cwd);
        break;
      case "new":
        await newTaskFlow(chatId);
        break;
      case "newin":
        await askTaskText(chatId, payload.cwd);
        break;
      case "newcustom":
        await bot.telegram.sendMessage(chatId, "Введите путь (например /Users/hedelka/Documents/prodjest):").catch(() => {});
        pendingInputs.set(chatId, { type: "cwd" });
        break;
      case "stop":
        await doStop(chatId, { editMsgId: ctx.callbackQuery.message?.message_id });
        break;
      case "steer":
        await bot.telegram.sendMessage(chatId, "Напишите корректировку текстом или голосом:").catch(() => {});
        pendingInputs.set(chatId, { type: "steer" });
        break;
      case "qopt": {
        const flow = questionFlows.get(flowKey(chatId, payload.rpcId));
        if (!flow) return ctx.answerCbQuery("устарело").catch(() => {});
        const q = flow.questions[flow.index];
        const ans = flow.answers[flow.index];
        if (q.multiSelect) {
          if (ans.selected.includes(payload.label)) ans.selected = ans.selected.filter((l) => l !== payload.label);
          else ans.selected.push(payload.label);
          renderQuestion(chatId, flow);
        } else {
          ans.selected = [payload.label];
          advanceOrSubmit(chatId, flow);
        }
        break;
      }
      case "qsubmit": {
        const flow = questionFlows.get(flowKey(chatId, payload.rpcId));
        if (!flow) return ctx.answerCbQuery("устарело").catch(() => {});
        submitQuestion(chatId, flow);
        break;
      }
      case "qcustom": {
        const flow = questionFlows.get(flowKey(chatId, payload.rpcId));
        if (!flow) return ctx.answerCbQuery("устарело").catch(() => {});
        await ctx.answerCbQuery("Введите ответ текстом").catch(() => {});
        pendingInputs.set(chatId, { type: "question", rpcId: flow.rpcId });
        break;
      }
      case "qcancel": {
        const flow = questionFlows.get(flowKey(chatId, payload.rpcId));
        if (!flow) return ctx.answerCbQuery("устарело").catch(() => {});
        questionFlows.delete(flowKey(chatId, payload.rpcId));
        await dsh
          .respond(flow.rpcId, { ok: false, error: { code: "cancelled", message: "cancelled by user via Telegram", details: {} } })
          .catch(() => {});
        await bot.telegram.editMessageText(chatId, flow.msgId, undefined, "❌ Вопрос отменён.").catch(() => {});
        break;
      }
      case "approve": {
        const outcome = payload.allow ? "allowed-once" : "rejected";
        await dsh.respond(payload.rpcId, {
          ok: true,
          value: { approvalId: payload.approvalId, sessionId: payload.sessionId, outcome },
        });
        await ctx.answerCbQuery(payload.allow ? "✅ Разрешено" : "❌ Отклонено").catch(() => {});
        await bot.telegram
          .editMessageText(chatId, ctx.callbackQuery.message?.message_id, undefined, `🔔 <b>Запрос разрешения</b>\n<i>${payload.allow ? "✅ Разрешено (отправлено)" : "❌ Отклонено (отправлено)"}</i>`, {
            parse_mode: "HTML",
          })
          .catch(() => {});
        break;
      }
      case "help":
        await ctx.reply(helpText(), { parse_mode: "HTML" }).catch(() => {});
        break;
      case "close": {
        const msgId = ctx.callbackQuery.message?.message_id;
        if (msgId) await bot.telegram.deleteMessage(chatId, msgId).catch(() => {});
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.log("[tg] callback error:", err.message);
    try {
      await ctx.answerCbQuery("ошибка: " + truncate(err.message, 50)).catch(() => {});
    } catch {}
  }
  try {
    await ctx.answerCbQuery().catch(() => {});
  } catch {}
});

// ---------- commands ----------
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const fresh = store.registerChat(chatId);
  await ctx
    .reply(
      `👋 Привет! Я пульт управления задачами DeepSeek Harness.\n${fresh ? "Чат зарегистрирован — теперь только вы можете управлять." : "Чат уже зарегистрирован."}\n\nВыберите действие:`,
      { parse_mode: "HTML", ...mainMenu() }
    )
    .catch(() => {});
});

bot.command("tasks", async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  await replyProjects(ctx, ctx.chat.id);
});

bot.command(["watch", "w"], async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  const arg = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
  if (arg) {
    store.setWatched(ctx.chat.id, arg);
    manager.attach(ctx.chat.id, arg);
  } else {
    await replyProjects(ctx, ctx.chat.id);
  }
});

bot.command(["unwatch", "uw"], async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  const sid = store.watched(ctx.chat.id);
  if (sid) manager.detach(ctx.chat.id, sid);
  store.setWatched(ctx.chat.id, null);
  await ctx.reply("👁 Отписался.").catch(() => {});
});

bot.command("new", async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  const text = ctx.message.text.replace(/^\/new(@\w+)?/, "").trim();
  if (text) {
    await createTask(ctx.chat.id, cfg.defaultCwd, text);
  } else {
    await newTaskFlow(ctx.chat.id);
  }
});

bot.command("stop", async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  await doStop(ctx.chat.id);
});

bot.command(["steer", "s"], async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  const text = ctx.message.text.replace(/^\/(steer|s)(@\w+)?/, "").trim();
  if (!text) {
    await ctx.reply("Пример: /steer сделай по-другому — начни с тестов").catch(() => {});
    return;
  }
  await steer(ctx.chat.id, text);
});

bot.command(["mute", "m"], async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  const sid = store.watched(ctx.chat.id);
  if (!sid) return ctx.reply("Нет активной задачи для паузы.").catch(() => {});
  const st = manager.streams.get(manager.key(ctx.chat.id, sid));
  if (st) {
    st.muted = true;
    store.setMuted(ctx.chat.id, true);
  }
  await ctx.reply("🔇 Трансляция приостановлена. Команды (stop/steer/…) продолжают работать.").catch(() => {});
});

bot.command(["unmute", "um"], async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  const sid = store.watched(ctx.chat.id);
  if (!sid) return ctx.reply("Нет активной задачи.").catch(() => {});
  const st = manager.streams.get(manager.key(ctx.chat.id, sid));
  if (st) {
    st.muted = false;
    store.setMuted(ctx.chat.id, false);
  }
  await ctx.reply("🔊 Трансляция возобновлена.").catch(() => {});
});

bot.command("status", async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  const chatId = ctx.chat.id;
  try {
    const sessions = await fetchSessions();
    const watched = store.watched(chatId);
    const lines = ["📊 <b>Статус</b>"];
    if (watched) {
      const s = sessions.find((x) => x.sessionId === watched);
      if (s) {
        lines.push(`\n👁 Наблюдаю: <b>${esc(sessionLabel(s))}</b>`);
        lines.push(`🆔 <code>${esc(shortId(s.sessionId))}</code>`);
        lines.push(`📁 ${esc(s.cwd ?? "?")}`);
        lines.push(`<b>${statusBadge(s)}</b>`);
      } else {
        lines.push(`\n👁 Наблюдаю: <code>${esc(shortId(watched))}</code> (не в списке)`);
      }
    }
    const running = sessions.filter((s) => s.running);
    if (running.length > 0) {
      lines.push("\n🟢 <b>Сейчас активны:</b>");
      for (const s of running.slice(0, 5)) lines.push(`• ${esc(truncate(sessionLabel(s), 60))} · <code>${esc(shortId(s.sessionId))}</code>`);
    } else {
      lines.push("\n🟢 Активных задач нет.");
    }
    const last = sessions.reduce((m, s) => (s.updatedAt > (m?.updatedAt ?? 0) ? s : m), null);
    if (last) lines.push(`\nПоследняя активность: <b>${esc(truncate(sessionLabel(last), 60))}</b> · ${timeAgo(last.updatedAt)}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" }).catch(() => {});
  } catch (err) {
    await ctx.reply(`❌ ${esc(err.message)}`).catch(() => {});
  }
});

bot.command("help", async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  await ctx.reply(helpText(), { parse_mode: "HTML" }).catch(() => {});
});

// ---------- voice ----------
async function handleVoice(ctx) {
  const chatId = ctx.chat.id;
  const voice = ctx.message.voice;
  const pending = pendingInputs.get(chatId);

  if (pending?.type === "task" || pending?.type === "cwd") {
    // voice describing a new task / path
    pendingInputs.delete(chatId);
    const link = await ctx.telegram.getFileLink(voice.file_id);
    const text = await downloadAndTranscribe(link, chatId);
    if (!text) return;
    if (pending.type === "cwd") {
      const cwd = text.trim();
      await askTaskText(chatId, cwd);
    } else {
      await createTask(chatId, pending.cwd, text);
    }
    return;
  }

  const sid = store.watched(chatId);
  if (!sid) {
    await ctx.reply("Сейчас ни за чем не наблюдаю. /tasks — выбрать, /new — создать.").catch(() => {});
    return;
  }
  const link = await ctx.telegram.getFileLink(voice.file_id);
  const text = await downloadAndTranscribe(link, chatId);
  if (!text) return;
  await ctx.reply(`🎙 <b>Распознано:</b>\n${esc(truncate(text, 800))}`, { parse_mode: "HTML" }).catch(() => {});
  await steer(chatId, `[Голосовое сообщение] ${text}`);
}

async function downloadAndTranscribe(link, chatId) {
  const tmp = path.join(os.tmpdir(), `dsh-tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`);
  try {
    await ctx_fetchToFile(link, tmp);
  } catch (err) {
    await bot.telegram.sendMessage(chatId, `❌ Не удалось скачать голосовое: ${esc(err.message)}`).catch(() => {});
    return "";
  }
  const statusMsg = await bot.telegram.sendMessage(chatId, "🎙 Распознаю речь локально (Whisper)…").catch(() => null);
  try {
    const text = await transcribeVoice({
      cli: cfg.whisperCli,
      model: cfg.whisperModel,
      oggPath: tmp,
      opusdec: cfg.opusdec,
    });
    return text;
  } catch (err) {
    await bot.telegram
      .sendMessage(chatId, `❌ Распознавание не удалось: ${esc(truncate(err.message, 300))}`, { parse_mode: "HTML" })
      .catch(() => {});
    return "";
  } finally {
    if (statusMsg) await bot.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
  }
}

async function ctx_fetchToFile(link, file) {
  const res = await fetch(link);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

bot.on("voice", async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  try {
    await handleVoice(ctx);
  } catch (err) {
    console.log("[tg] voice error:", err);
    await ctx.reply(`❌ ${esc(truncate(err.message, 300))}`).catch(() => {});
  }
});

// ---------- plain text ----------
bot.on("text", async (ctx) => {
  if (!allowed(ctx)) return deny(ctx);
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return; // commands are handled by bot.command

  const pending = pendingInputs.get(chatId);
  if (pending) {
    pendingInputs.delete(chatId);
    switch (pending.type) {
      case "task":
        await createTask(chatId, pending.cwd, text);
        return;
      case "cwd":
        await askTaskText(chatId, text);
        return;
      case "steer":
        await steer(chatId, text);
        return;
      case "question": {
        const flow = questionFlows.get(flowKey(chatId, pending.rpcId));
        if (!flow) return;
        const q = flow.questions[flow.index];
        flow.answers[flow.index] = { id: q.id, selected: [], custom: text };
        advanceOrSubmit(chatId, flow);
        return;
      }
    }
  }

  const sid = store.watched(chatId);
  if (!sid) {
    await ctx.reply("Сейчас ни за чем не наблюдаю. /tasks — выбрать задачу, /new — создать.").catch(() => {});
    return;
  }
  await steer(chatId, text);
});

// ---------- boot ----------
function helpText() {
  return [
    "<b>🧭 Команды</b>",
    "/tasks — выбрать проект → задачу (с индикаторами 🟢/🕐)",
    "/watch &lt;id&gt; — наблюдать за задачей напрямую",
    "/new [текст] — создать новую задачу (по умолчанию в prodjest)",
    "/stop — остановить текущую задачу",
    "/steer текст — корректировка текстом",
    "/mute, /unmute — пауза/возобновление трансляции",
    "/status — статус задач",
    "/unwatch — отписаться",
    "",
    "<b>🎙 Голос</b> — пришлите голосовое: распознается локально (Whisper) и отправляется как корректировка в контекст задачи.",
    "",
    "<b>💬 Просто текст</b> — пока вы наблюдаете за задачей, обычное сообщение тоже становится корректировкой.",
    "",
    "<b>🔔 Разрешения и вопросы</b> — запросы агента приходят сюда кнопками ✅/❌.",
  ].join("\n");
}

async function main() {
  if (!cfg.whisperCli || !(await fileExists(cfg.whisperCli))) {
    console.warn("[warn] whisper-cli не найден — голосовые не будут работать. Укажите whisperCli в config.json");
  }
  if (cfg.whisperModel && !(await fileExists(cfg.whisperModel))) {
    console.warn("[warn] модель whisper не найдена:", cfg.whisperModel);
  }

  // sanity: DSH host reachable
  try {
    await dsh.listSessions();
    console.log("[dsh] host OK:", cfg.dshUrl);
  } catch (err) {
    console.warn("[warn] DSH host недоступен:", err.message);
  }

  dsh.start((frame) => manager.handleFrame(frame));

  bot.catch((err) => console.error("[tg] unhandled:", err?.message ?? err));

  bot.launch({ dropPendingUpdates: true });
  console.log("[tg] bot started (long polling). Token:", cfg.telegramToken.slice(0, 8) + "…");
  console.log("[tg] разрешённые чаты:", store.data.allowedChatIds.length ? store.data.allowedChatIds.join(", ") : "никто — первый /start зарегистрирует чат");
}

import { access } from "node:fs/promises";
async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
