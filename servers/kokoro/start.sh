#!/usr/bin/env bash
# Start the LocalVoice Kokoro TTS server on 127.0.0.1:7478 (Piper owns 7477).
# Run ./setup.sh once first. Override HOST/PORT via KOKORO_HOST / KOKORO_PORT.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "[start] no .venv - run ./setup.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1091
. .venv/bin/activate
exec python server.py
