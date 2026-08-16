#!/bin/bash
# Утилита агента: отправить команду в мост-сервер.
# usage: ./bridge.sh <method> [paramsJson] [tabId] [timeoutMs]
#   методы: list_tabs | open_tab | close_tab | activate_tab | attach | detach | cdp | evaluate | screenshot
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN="$(cat "$DIR/server/token.txt")"
METHOD="${1:?method required}"
PARAMS="${2:-{}}"
TABID="${3:-null}"
TIMEOUT="${4:-30000}"
curl -sS -X POST "http://127.0.0.1:8787/api/command" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\",\"method\":\"$METHOD\",\"params\":$PARAMS,\"tabId\":$TABID,\"timeoutMs\":$TIMEOUT}"
echo
