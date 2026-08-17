/** Formatting helpers for Telegram messages (HTML parse mode). */

export function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

export function timeAgo(tsMs) {
  if (!tsMs) return "—";
  const diff = Date.now() - tsMs;
  if (diff < 0) return "только что";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} с назад`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} дн назад`;
}

export function shortId(sessionId) {
  return String(sessionId ?? "").replace(/^session-/, "").slice(0, 8);
}

export function basename(p) {
  return String(p ?? "").split("/").filter(Boolean).pop() || p || "?";
}

/** Extract human-readable text from a message content block list. */
export function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      switch (block.type) {
        case "text":
          return block.text ?? "";
        case "image":
          return "🖼 изображение";
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

/** A short label for a session: title projection > first user text > id. */
export function sessionLabel(session, events) {
  const title = session?.projections?.title;
  if (title && typeof title === "string" && title.trim()) return title.trim();
  if (Array.isArray(events)) {
    const first = events.find((e) => e.type === "user/message");
    const text = first ? contentText(first.data?.message?.content ?? first.data?.content) : "";
    if (text) return truncate(text.replace(/\s+/g, " "), 60);
  }
  return `Сессия ${shortId(session?.sessionId)}`;
}

/** Status badge for a session row. */
export function statusBadge(session) {
  if (session.running) return "🟢 активен";
  return `🕐 ${timeAgo(session.updatedAt)}`;
}
