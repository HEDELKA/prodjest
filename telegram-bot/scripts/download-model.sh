#!/bin/bash
# Download a multilingual ggml whisper model for local transcription.
# Default: ggml-base.bin (~140 MB) — good Russian/English balance.
# Usage: bash scripts/download-model.sh [base|small|medium|tiny]
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p models
SIZE="${1:-base}"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${SIZE}.bin"
DEST="models/ggml-${SIZE}.bin"
if [ -f "$DEST" ] && [ -s "$DEST" ]; then
  echo "already present: $DEST ($(du -h "$DEST" | cut -f1))"
  exit 0
fi
echo "Downloading $URL -> $DEST"
curl -L --fail --progress-bar -o "$DEST" "$URL"
echo "done: $DEST"
