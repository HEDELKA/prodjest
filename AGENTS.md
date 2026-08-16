# DSH Browser Bridge — Agent Manual (AGENTS.md)

> Read this if you are an AI agent (DeepSeek Harness, Claude Code, Codex, etc.)
> working in this repository. This project gives an agent **hands in a real
> Chrome browser** — and, more importantly, the ability to **improve those hands
> by itself**.

## What this is

A Chrome extension + a tiny local bridge. The agent sends commands over HTTP to a
local Node server (`127.0.0.1:8787`), the server forwards them over WebSocket to
the extension, and the extension executes them in the user's **real** Chrome via
`chrome.debugger` (CDP). No separate browser, no Playwright, no MCP needed.

```
agent ──HTTP──▶ bridge server (127.0.0.1:8787) ──WebSocket──▶ Chrome extension
                                                                │
                                                                ▼
                                                        chrome.debugger → user's tabs
```

## Layout

| Path | Purpose |
|---|---|
| `extension/` | Chrome MV3 extension (background service worker, popup, overlay) |
| `extension/background.js` | All command logic — **the file you will most often edit** |
| `server/index.mjs` | Bridge server (Node, `ws`), token-protected, 127.0.0.1 only |
| `server/token.txt` | Random token, generated at server start — **never commit it** (gitignored) |
| `bridge.sh` | Agent CLI: `./bridge.sh <method> <paramsFile> [tabId] [timeoutMs]` |
| `build-payload.mjs` | JSON payload builder used by `bridge.sh` |
| `scripts/gen-icons.mjs` | Regenerates extension icons |
| `release/` | Chrome Web Store package, screenshots, privacy policy |

## How to control the browser

1. Start the server: `node server/index.mjs` (background). It prints the token
   and writes `server/token.txt`.
2. The extension must be loaded in Chrome once (human step: `chrome://extensions`
   → Developer mode → Load unpacked → `extension/`) and given the token in its popup.
3. Check the bridge: `curl http://127.0.0.1:8787/api/status` → `connected: true`.
4. Send commands. JSON params go **through a file** (never as a shell argument —
   some shells mangle braces):

```bash
B=./bridge.sh
$B list_tabs
printf '{"url":"https://example.com"}' > /tmp/p.json
$B open_tab /tmp/p.json                      # opens INACTIVE in bg mode
$B evaluate /tmp/p.json <tabId>              # {"expression":"document.title"}
$B human_click /tmp/xy.json <tabId>          # {"x":388,"y":226,"duration":700}
$B human_type /tmp/txt.json <tabId>          # {"text":"hello"}
$B screenshot /dev/null <tabId>              # base64 in response
$B cdp /tmp/cdp.json <tabId>                 # raw CDP passthrough
```

### Command reference

| Method | Params | Notes |
|---|---|---|
| `list_tabs` | — | tabs with id/title/url/active/groupId |
| `open_tab` | `{url, active?}` | background-mode default: inactive; auto-grouped into «DSH-агент» |
| `close_tab` | `{tabId}` | removes empty agent group |
| `activate_tab` | `{tabId}` | ignored in background mode (`skipped:true`) |
| `attach` / `detach` | `{tabId}` | manage the debugger session |
| `list_groups` | — | tab groups (agent group is blue «DSH-агент») |
| `evaluate` | `{expression, awaitPromise?}` | Runtime.evaluate, returns value |
| `cdp` | `{method, params}` | raw CDP: `Page.navigate`, `Network.*`, `Runtime.*`, … |
| `screenshot` | `{format?}` | returns base64 PNG |
| `human_move` | `{x, y, duration?}` | smooth Bézier path, jitter, natural pauses |
| `human_click` | `{x, y, duration?}` | smooth move + pause + press/release with delays |
| `human_type` | `{text, x?, y?, clear?, enter?}` | optional click-focus, select-all clear, per-char typing, Enter |
| `press_key` | `{key}` | Enter / Tab / Escape / Backspace / Delete / arrows / Home / End |
| `page_snapshot` | — | **interaction map**: visible links/buttons/inputs with center coordinates — one call replaces many DOM queries |
| `reload_extension` | — | **self-reload**: applies extension code changes instantly |
| `list_groups` | — | inspect tab groups |

## 🔁 The self-improvement loop (why this repo exists)

The agent can change its own browser-control code and apply it **without any
human step**:

1. Edit `extension/background.js` (add a command, tweak the overlay, fix a bug).
2. `git add`/`git commit`/`git push` (project practice).
3. Apply instantly: `$B reload_extension` — the service worker reloads and
   reconnects to the bridge automatically (~1–2 s).
4. Re-test through the bridge (`list_tabs`, `evaluate`, `human_click`, …).
5. Iterate. This is a closed loop: **the agent improves its own browser hands
   and verifies the improvement itself.**

`chrome://extensions` pages are NOT accessible to `chrome.debugger` — that is why
`reload_extension` exists instead of clicking the browser's reload button.

### Adding a new command (pattern)

In `extension/background.js` → `dispatch(method, params, tabId)` switch:

```js
case "my_new_command": {
  await ensureAttached(tabId);
  const res = await chrome.debugger.sendCommand({ tabId }, "Page.navigate", { url: params.url });
  updateOverlay(tabId, "navigate: " + params.url, null, null, null);
  return res || {};
}
```

Then `reload_extension`, then call `./bridge.sh my_new_command <paramsFile> <tabId>`.
`ensureAttached` also installs the in-page overlay (banner, ghost cursor, title
prefix) — do not attach manually.

### Overlay

`OVERLAY_JS` (in `background.js`) injects into controlled tabs:
- top banner «DSH-агент работает на этой странице» + pulsing dot + last action;
- sticky ghost cursor + click ring + target-element highlight;
- title prefix `🤖 DSH · <page title>` (survives site title rewrites; restored on detach).

`updateOverlay(tabId, label, x, y, kind)` shows the last action / cursor position.

## Timing & Chrome quirks (MUST know)

- **Attach to background tabs is slow** (measured 6–17 s, sometimes 0.1 s; active
  tabs attach fast). The FIRST command on a tab pays this inside `ensureAttached`.
  → Use a large timeout (≥ 60 000 ms) for the first command on a tab, and normal
  timeouts afterwards. `warmUpSessions()` re-attaches controlled tabs at connect,
  so after ~20 s the penalty is usually already paid.
- Chrome shows a yellow **«X started debugging this browser»** bar on controlled
  tabs. It is normal — do NOT try to remove it. If the user clicks Cancel on it,
  the session detaches (`canceled_by_user`); the next command re-attaches.
  Respect the cancel: do not auto-re-attach immediately.
- The bridge server times out commands and sends `{"type":"cancel"}`; long loops
  (`humanMove`, `human_type`) check cancellation and stop — no zombies.
- **Auto-detach (idle timeout)**: after `idleTimeoutMin` (default 5, 0 = off) without
  a command, the extension releases all controlled tabs — overlay removed, title
  restored, debugger detached (yellow bar gone). Turning off «Управление браузером»
  in the popup also detaches everything. New commands re-attach on demand.

## Invariants & security (MUST follow)

- **Never commit `server/token.txt`** — it is gitignored; keep it that way. If it
  ever lands in history, purge history before making the repo public.
- Keep the server bound to `127.0.0.1` only. Never expose the port.
- The token guards a **full-control** capability (`debugger`): treat it as a secret.
- Background mode (`bgMode`, default ON): agent tabs open inactive; never steal
  the user's focus; `activate_tab` is disabled in bg mode.
- Controlled tabs show Chrome's yellow «debugging» banner — expected, do not fight it.
- Use `human_*` methods for interactions; reserve raw `Input.*` CDP for precision.
- After the user's Chrome reloads or the extension reloads, debugger sessions drop —
  re-attach happens automatically on the next command to a tab.

## Testing checklist (after any change)

1. `curl http://127.0.0.1:8787/api/status` → `connected: true`
2. `list_tabs` → tabs visible
3. `open_tab` on a harmless URL → `active:false`, `groupId` set
4. `evaluate` `document.title` → prefixed `🤖 DSH · …`
5. `human_click` on a link → page navigates; banner/cursor/ring visible to the user
6. `reload_extension` → server logs `disconnected` then `connected`; commands still work

## Contribution practice

- Keep commits small and self-explanatory.
- Update `README.md` and this file when behavior changes.
- Never put secrets in the repo. `release/` artifacts are gitignored except
  screenshots/docs.
