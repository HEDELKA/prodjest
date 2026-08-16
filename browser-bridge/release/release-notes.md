# DSH Browser Bridge v0.3.0

Chrome extension + local bridge: let a DeepSeek Harness agent control your **real** Chrome
via `chrome.debugger` (CDP). Everything stays on your machine (127.0.0.1, token-protected).

## Highlights

- **Human-like actions** — `human_click` / `human_move` / `human_type`: smooth Bézier
  mouse trajectories with natural jitter and delays (anti-bot friendly).
- **Full visibility** — top banner "DSH agent is working on this page", ghost cursor
  follows every step, click ring + target element highlight.
- **Identifiable tabs** — agent tabs grouped into blue **"DSH-агент"** group, titles
  prefixed `🤖 DSH · <page title>` (visible without opening the tab).
- **Background mode** — agent tabs open inactive, your focus is never stolen.
- **Self-reload** — the agent can reload the extension remotely (`reload_extension`).
- **Security** — bridge binds 127.0.0.1 only, random token auth, Origin check,
  detach-all button in the popup.

## Install (dev mode)

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `extension/`.
2. Run the bridge server (`node server/index.mjs`), copy the token from `server/token.txt`
   into the extension popup → Save.

## Store package

`dsh-browser-bridge-v0.3.0.zip` — ready to upload to the Chrome Web Store
(manifest.json at the zip root, icons included). Privacy policy: `PRIVACY.md`.
