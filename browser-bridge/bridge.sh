#!/bin/bash
# Утилита агента: отправить команду в мост-сервер.
#
# ВАЖНО: JSON-параметры передаются ТОЛЬКО через файл (или по умолчанию {}),
# потому что передача JSON аргументом командной строки в некоторых средах ломается.
#
# usage:
#   ./bridge.sh <method>                 # без параметров (params = {})
#   ./bridge.sh <method> <paramsFile>    # params читаются из JSON-файла
#   ./bridge.sh <method> <paramsFile> <tabId> [timeoutMs]
#
#   методы: list_tabs | open_tab | close_tab | activate_tab | attach | detach | cdp | evaluate | screenshot
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN="$(cat "$DIR/server/token.txt")"
METHOD="${1:?method required}"
PFILE="${2:-}"
TABID="${3:-null}"
TIMEOUT="${4:-30000}"

if [ -n "$PFILE" ]; then
  PARAMS="$(cat "$PFILE")"
else
  PARAMS="{}"
fi

export TOKEN
PAYLOAD="$(node "$DIR/build-payload.mjs" "$METHOD" "$PARAMS" "$TABID" "$TIMEOUT")"

curl -sS -X POST "http://127.0.0.1:8787/api/command" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
echo
