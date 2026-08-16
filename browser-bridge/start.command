#!/bin/bash
# Запуск мост-сервера DSH Browser Bridge (для macOS: двойной клик по файлу).
# Сервер слушает только 127.0.0.1 и печатает токен (server/token.txt).
# Расширение само получает токен — вводить вручную не нужно.
cd "$(dirname "$0")"
cd server
exec node index.mjs
