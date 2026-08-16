#!/bin/bash
# Запуск мост-сервера DSH Browser Bridge (кросс-платформенно).
# Сервер слушает только 127.0.0.1 и пишет токен в server/token.txt.
# Расширение само получает токен — вводить вручную не нужно.
cd "$(dirname "$0")/server"
exec node index.mjs
