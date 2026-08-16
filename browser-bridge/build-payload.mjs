// Сборка payload для мост-сервера. Аргументы: method paramsJson tabId timeoutMs
const [m, p, t, to] = process.argv.slice(2);
console.log(JSON.stringify({
  token: process.env.TOKEN,
  method: m,
  params: JSON.parse(p || "{}"),
  tabId: t === "null" ? null : Number(t),
  timeoutMs: Number(to || 30000),
}));
