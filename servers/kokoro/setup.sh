#!/usr/bin/env bash
# One-time setup for the local Kokoro TTS server: create the venv, install
# kokoro-onnx, and download the Kokoro-82M v1.0 model + voices into ./models.
# Idempotent - skips downloads that are already present.
set -euo pipefail
cd "$(dirname "$0")"

MODEL_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
VOICES_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"

echo "[setup] creating venv (.venv) ..."
python3 -m venv .venv
# shellcheck disable=SC1091
. .venv/bin/activate
pip install --quiet --upgrade pip
echo "[setup] installing kokoro-onnx + deps ..."
pip install --quiet kokoro-onnx soundfile numpy

mkdir -p models
if [ ! -f models/kokoro-v1.0.onnx ]; then
  echo "[setup] downloading model (~310 MB) ..."
  curl -sSL -o models/kokoro-v1.0.onnx "$MODEL_URL"
fi
if [ ! -f models/voices-v1.0.bin ]; then
  echo "[setup] downloading voices (~27 MB) ..."
  curl -sSL -o models/voices-v1.0.bin "$VOICES_URL"
fi

echo "[setup] done. Start the server with: ./start.sh"
