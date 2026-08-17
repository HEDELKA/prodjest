import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { statePath } from "./config.mjs";

/**
 * Durable per-chat state: which session a chat is watching, plus the
 * self-registered chat allowlist. Persisted to state.json so the bot survives
 * restarts without losing the watch mapping.
 */
export class Store {
  constructor() {
    this.path = statePath();
    this.data = { chats: {}, allowedChatIds: [] };
    this.load();
  }

  load() {
    try {
      this.data = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      this.data = { chats: {}, allowedChatIds: [] };
    }
    this.data.chats ??= {};
    this.data.allowedChatIds ??= [];
  }

  save() {
    mkdirSync(path.dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  isAllowed(chatId) {
    const id = String(chatId);
    return this.data.allowedChatIds.includes(id);
  }

  registerChat(chatId) {
    const id = String(chatId);
    if (!this.data.allowedChatIds.includes(id)) {
      this.data.allowedChatIds.push(id);
      this.save();
      return true;
    }
    return false;
  }

  watched(chatId) {
    return this.data.chats[String(chatId)]?.watchedSessionId ?? null;
  }

  setWatched(chatId, sessionId) {
    this.data.chats[String(chatId)] = { watchedSessionId: sessionId ?? null };
    this.save();
  }

  muted(chatId) {
    return this.data.chats[String(chatId)]?.muted ?? false;
  }

  setMuted(chatId, muted) {
    const key = String(chatId);
    this.data.chats[key] ??= {};
    this.data.chats[key].muted = muted;
    this.save();
  }
}
