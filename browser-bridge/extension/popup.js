const $ = (id) => document.getElementById(id);

function setStatus(connected, armed) {
  const card = $("statusCard");
  const title = $("status");
  const sub = $("statusSub");
  card.classList.remove("online", "offline");
  if (connected) {
    card.classList.add("online");
    title.textContent = "подключено к мосту";
    sub.textContent = "агент может управлять вкладками";
  } else if (!armed) {
    title.textContent = "управление отключено";
    sub.textContent = "включите переключатель, чтобы разрешить агенту";
  } else {
    card.classList.add("offline");
    title.textContent = "не подключено";
    sub.textContent = "запустите сервер — токен подтянется сам";
  }
}

async function refresh() {
  let s = null;
  try { s = await chrome.runtime.sendMessage({ type: "getStatus" }); } catch { /* SW перезапускается */ }
  setStatus(!!(s && s.connected), s ? s.armed : true);
}

chrome.storage.local
  .get({ serverUrl: "ws://127.0.0.1:8787/ws", token: "", tokenAuto: false, armed: true, bgMode: true })
  .then((c) => {
    $("serverUrl").value = c.serverUrl;
    $("token").value = c.token;
    $("armed").checked = c.armed;
    $("bgMode").checked = c.bgMode;
    $("tokenHint").textContent = c.tokenAuto
      ? "получен автоматически с локального сервера"
      : c.token
        ? "введён вручную — можно оставить"
        : "будет получен автоматически при подключении";
  });

$("save").addEventListener("click", async () => {
  const token = $("token").value.trim();
  await chrome.storage.local.set({
    serverUrl: $("serverUrl").value.trim(),
    token,
    tokenAuto: false,
    armed: $("armed").checked,
    bgMode: $("bgMode").checked,
  });
  await chrome.runtime.sendMessage({ type: "reconnect" });
  showMsg(token ? "Сохранено, переподключение…" : "Сохранено — токен будет получен автоматически");
  setTimeout(refresh, 900);
});

$("detachAll").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "detachAll" });
  showMsg("Отключено вкладок: " + (r && r.detached));
});

$("toggleToken").addEventListener("click", () => {
  const inp = $("token");
  inp.type = inp.type === "password" ? "text" : "password";
});

$("copyToken").addEventListener("click", async () => {
  const v = $("token").value;
  if (!v) { showMsg("Токена пока нет — он появится после подключения"); return; }
  try {
    await navigator.clipboard.writeText(v);
    showMsg("Токен скопирован");
  } catch {
    showMsg("Не удалось скопировать");
  }
});

let msgTimer = null;
function showMsg(text) {
  $("msg").textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { $("msg").textContent = ""; }, 2500);
}

setInterval(refresh, 1000);
refresh();
