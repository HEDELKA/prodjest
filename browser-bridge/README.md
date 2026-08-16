# DSH Browser Bridge

Расширение Chrome + локальный мост-сервер, которые позволяют агенту DeepSeek Harness
**управлять вашим реальным браузером Chrome** через API `chrome.debugger` (CDP).

```
Агент ──curl──▶ Мост (127.0.0.1:8787) ──WebSocket──▶ Расширение Chrome
                                                      │
                                                      ▼
                                              chrome.debugger → ваши вкладки
```

Никакого Playwright/MCP/отдельного браузера — управляется именно тот Chrome,
в котором установлено расширение (ваши логины, куки, профиль).

## Состав

| Путь | Что это |
|---|---|
| `extension/` | Расширение Chrome (Manifest V3): service worker + popup |
| `server/` | Мост-сервер на Node.js (`ws`), слушает только `127.0.0.1` |
| `bridge.sh` | Утилита агента: `./bridge.sh <method> [paramsJson] [tabId]` |
| `server/token.txt` | Токен (генерируется сервером, в git не коммитится) |

## Установка (один раз)

1. **Сервер** запускает агент (`node server/index.mjs`). Токен лежит в `server/token.txt`.
2. **Расширение**: откройте `chrome://extensions` → включите «Режим разработчика» →
   «Загрузить распакованное» → выберите папку `extension/` этого проекта.
3. **Токен**: кликните иконку расширения → вставьте токен из `token.txt` → «Сохранить и переподключить».
   Статус «подключено к мосту» означает, что всё работает.

## Команды агента

JSON-параметры передаются **через файл** (второй аргумент), а не аргументом командной строки —
это защищает от повреждения кавычек/скобок в некоторых средах:

```bash
./bridge.sh list_tabs
./bridge.sh open_tab /tmp/params-open.json        # {"url":"https://example.com"}
./bridge.sh activate_tab /dev/null 42             # без параметров — /dev/null или пусто
./bridge.sh evaluate /tmp/params-eval.json 42     # {"expression":"document.title"}
./bridge.sh cdp /tmp/params-cdp.json 42           # {"method":"Page.navigate","params":{...}}
./bridge.sh screenshot /dev/null 42               # скриншот вкладки (base64 в ответе)
./bridge.sh close_tab /tmp/params-close.json      # {"tabId":42}
```

Произвольные методы CDP — через `cdp` (Page.*, Runtime.*, Input.*, Network.* и т.д.).
Нативные клики/ввод — `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`.

## Безопасность

- Сервер слушает **только** `127.0.0.1` — снаружи недоступен.
- Все запросы и WebSocket-соединение защищены **токеном** (генерируется при старте сервера).
- Расширение подключается только к `ws://127.0.0.1:*`, к токену прилагается проверка Origin
  (`chrome-extension://`).
- Управляемая вкладка помечается жёлтой плашкой Chrome «debugging» — всегда видно, когда идёт управление.
- Расширение можно отключить/удалить в `chrome://extensions` — пока выключено, оно ничего не делает.
- Управление — **полный доступ** (чтение/изменение страниц, действия от вашего имени):
  используйте с осторожностью, только когда нужно.
