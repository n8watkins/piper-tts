#!/usr/bin/env python3
"""Minimal local Kokoro TTS server (kokoro-onnx), API-compatible with the Piper
server that T-Hub already proxies.

Endpoints (identical shape to the Piper server on :7477):
  GET  /health  -> {"status": "ok", "engine": "kokoro", ...}
  GET  /voices  -> {"voices": [...], "engine": "kokoro"}
  POST /tts     -> body {"text": "...", "voice": "af_heart", "speed": 1.0}
                   returns audio/wav (16-bit PCM, 24 kHz mono)

Binds 127.0.0.1:7478 by default. WSL2 mirrors localhost to Windows, so a server
bound to 127.0.0.1 in WSL is reachable from the Windows Tauri app at the same
127.0.0.1:7478 - which is exactly how T-Hub's Rust proxy (voice.rs, the Kokoro
engine) reaches it. Bind to 127.0.0.1 only (never 0.0.0.0): loopback is all the
app needs and it keeps the model off the LAN.

Stdlib http.server only (plus kokoro-onnx + numpy) - no web framework, so
startup is just model load. Kokoro-82M is loaded ONCE at boot (~1-2s) and reused
for every request.
"""

from __future__ import annotations

import io
import json
import os
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from kokoro_onnx import Kokoro

HOST = os.environ.get("KOKORO_HOST", "127.0.0.1")
PORT = int(os.environ.get("KOKORO_PORT", "7478"))
# Model files live beside this script (downloaded by setup.sh). Overridable so
# the files can sit elsewhere without editing the server.
MODELS_DIR = Path(os.environ.get("KOKORO_MODELS_DIR", Path(__file__).parent / "models"))
MODEL_PATH = MODELS_DIR / "kokoro-v1.0.onnx"
VOICES_PATH = MODELS_DIR / "voices-v1.0.bin"

# Guard rails matching the Piper server + the app's own /tts text cap (4 KB).
MAX_TEXT_CHARS = 4000
# Kokoro always outputs 24 kHz mono float32 (kokoro_onnx.config.SAMPLE_RATE).
SAMPLE_RATE = 24000

print(f"[kokoro] loading model {MODEL_PATH.name} + {VOICES_PATH.name} ...", flush=True)
if not MODEL_PATH.exists() or not VOICES_PATH.exists():
    raise SystemExit(
        f"[kokoro] model files missing under {MODELS_DIR} - run ./setup.sh first"
    )
KOKORO = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
VOICES = sorted(KOKORO.get_voices())
print(f"[kokoro] ready: {len(VOICES)} voices on http://{HOST}:{PORT}", flush=True)


def wav_bytes(samples: np.ndarray, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Encode float32 samples (~[-1, 1]) as 16-bit PCM WAV bytes in-memory."""
    pcm16 = np.clip(samples, -1.0, 1.0)
    pcm16 = (pcm16 * 32767.0).astype("<i2")  # little-endian int16
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(sample_rate)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    # Quieter logs; the default logs every request line to stderr.
    def log_message(self, fmt, *args):  # noqa: N802 (stdlib signature)
        return

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 (stdlib signature)
        if self.path == "/health":
            self._json(200, {"status": "ok", "engine": "kokoro", "voices": len(VOICES)})
        elif self.path == "/voices":
            self._json(200, {"voices": VOICES, "engine": "kokoro"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 (stdlib signature)
        if self.path != "/tts":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            # Coerce fields inside the guard so a malformed body (wrong types,
            # non-numeric speed) yields a clean 400, not a dropped connection.
            text = str(payload.get("text") or "").strip()
            voice = str(payload.get("voice") or "af_heart")
            speed = float(payload.get("speed", 1.0))
            lang = str(payload.get("lang") or "en-us")
        except (ValueError, TypeError, AttributeError, json.JSONDecodeError):
            self._json(400, {"error": "invalid request body"})
            return

        if not text:
            self._json(400, {"error": "missing 'text'"})
            return
        if len(text) > MAX_TEXT_CHARS:
            self._json(400, {"error": f"text too long (max {MAX_TEXT_CHARS} chars)"})
            return
        if voice not in KOKORO.get_voices():
            self._json(400, {"error": f"unknown voice '{voice}'"})
            return

        try:
            samples, sr = KOKORO.create(text, voice=voice, speed=speed, lang=lang)
            audio = wav_bytes(samples, sr)
        except Exception as exc:  # noqa: BLE001 - report any synth failure as 500
            self._json(500, {"error": f"synthesis failed: {exc}"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


def main() -> None:
    # ThreadingHTTPServer so a slow synthesis doesn't block /health checks.
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[kokoro] shutting down", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
