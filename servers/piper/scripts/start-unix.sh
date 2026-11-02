#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVER_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

cd "$SERVER_DIR"

: "${HOST:=127.0.0.1}"
: "${PORT:=7477}"
: "${VOICE_DIR:=$SERVER_DIR/piper/voices}"
: "${OUTPUT_DIR:=$SERVER_DIR/output}"

if [ -z "${PIPER_BIN:-}" ]; then
  if [ -x "$SERVER_DIR/piper/piper" ]; then
    PIPER_BIN="$SERVER_DIR/piper/piper"
  elif command -v piper >/dev/null 2>&1; then
    PIPER_BIN=$(command -v piper)
  else
    PIPER_BIN="$SERVER_DIR/piper/piper"
  fi
fi

if [ ! -x "$PIPER_BIN" ]; then
  echo "Piper executable is not runnable: $PIPER_BIN" >&2
  echo "Download Piper, place it at servers/piper/piper/piper, then run:" >&2
  echo "  chmod +x servers/piper/piper/piper" >&2
  echo "Or start with PIPER_BIN=/path/to/piper $0" >&2
  exit 1
fi

mkdir -p "$VOICE_DIR" "$OUTPUT_DIR"

if [ ! -d node_modules ]; then
  npm install
fi

export HOST PORT PIPER_BIN VOICE_DIR OUTPUT_DIR
exec npm start
