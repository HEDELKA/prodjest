const $ = (id) => document.getElementById(id);

async function refresh() {
  let s = null;
  try { s = await chrome.runtime.sendMessage({ type: "getStatus" }); } catch { /* SW перезапускается */ }
  const el = $("status");
  if (s && s.connected) {
    el.textContent = "подключено к мосту";
    el.className = "status online";
  } else if (s && !s.armed) {
    el.textContent = "управление отключено";
    el.className = "status offline";
  } else {
    el.textContent = "не подключено";
    el.className = "status offline";
  }
}

chrome.storage.local
  .get({ serverUrl: "ws://127.0.0.1:8787/ws", token: "", armed: true })
  .then((c) => {
    $("serverUrl").value = c.serverUrl;
    $("token").value = c.token;
    $("armed").checked = c.armed;
  });

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    serverUrl: $("serverUrl").value.trim(),
    token: $("token").value.trim(),
    armed: $("armed").checked,
  });
  await chrome.runtime.sendMessage({ type: "reconnect" });
  $("msg").textContent = "Сохранено, переподключение…";
  setTimeout(() => { $("msg").textContent = ""; refresh(); }, 800);
});

setInterval(refresh, 1000);
refresh();
