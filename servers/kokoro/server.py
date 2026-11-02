#!/usr/bin/env python3
"""LocalVoice Kokoro server: a small local Kokoro-82M TTS server (kokoro-onnx).

It speaks the same HTTP API as the LocalVoice Piper server (see
docs/API.md in the repo root):

  GET  /health  -> {"status": "ok", "engine": "kokoro", "version": "...", "voices": 54}
  GET  /voices  -> {"engine": "kokoro", "voices": [...]}
  POST /tts     -> body {"text": "...", "voice": "af_heart", "speed": 1.0, "lang": "en-us"}
                   returns audio/wav (16-bit PCM, 24 kHz mono)

Errors are JSON: {"error": "...", "details": "..."} with a 4xx or 5xx status.

Binds 127.0.0.1:7478 by default (Piper owns 7477). WSL2 mirrors localhost to
Windows, so a server bound to 127.0.0.1 in WSL is reachable from Windows at the
same address. Bind to loopback only (never 0.0.0.0): it keeps the model off the
LAN.

Origin policy (same as the Piper server): requests without an Origin header
(curl, scripts, native apps) and requests from chrome-extension:// origins are
allowed; any other browser origin gets 403, so a random web page can't use the
local engine.

Stdlib http.server only. kokoro-onnx and numpy are imported when the model is
loaded, so this module (and its tests) import without them.
"""

from __future__ import annotations

import io
import json
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Protocol

VERSION = "1.0.0"
ENGINE = "kokoro"

HOST = os.environ.get("KOKORO_HOST", "127.0.0.1")
PORT = int(os.environ.get("KOKORO_PORT", "7478"))
# Model files live beside this script (downloaded by setup.sh). Overridable so
# the files can sit elsewhere without editing the server.
MODELS_DIR = Path(os.environ.get("KOKORO_MODELS_DIR", Path(__file__).parent / "models"))
MODEL_PATH = MODELS_DIR / "kokoro-v1.0.onnx"
VOICES_PATH = MODELS_DIR / "voices-v1.0.bin"

DEFAULT_VOICE = "af_heart"
MAX_TEXT_CHARS = 4000
MAX_BODY_BYTES = 1_000_000  # matches the Piper server's 1 MB JSON limit
MIN_SPEED, MAX_SPEED = 0.5, 2.0
# Kokoro always outputs 24 kHz mono float32 (kokoro_onnx.config.SAMPLE_RATE).
SAMPLE_RATE = 24000

# Kokoro voice ids start with a language letter: af_heart is American English,
# bm_george is British English, and so on. Picking the phonemizer language from
# that letter keeps a Spanish voice from being read with English phonemes.
LANG_BY_PREFIX = {
    "a": "en-us",
    "b": "en-gb",
    "e": "es",
    "f": "fr-fr",
    "h": "hi",
    "i": "it",
    "j": "ja",
    "p": "pt-br",
    "z": "cmn",
}


def lang_for_voice(voice: str) -> str:
    """The espeak language code for a Kokoro voice id (en-us when unknown)."""
    return LANG_BY_PREFIX.get(voice[:1].lower(), "en-us")


def is_allowed_origin(origin: str | None) -> bool:
    """Same rule as the Piper server: no Origin (CLI) or a Chrome extension."""
    if not origin:
        return True
    return origin.startswith("chrome-extension://")


class Engine(Protocol):
    """What the HTTP layer needs from a synthesizer; tests pass a fake."""

    def voices(self) -> list[str]: ...

    def synthesize(self, text: str, voice: str, speed: float, lang: str) -> bytes: ...


def wav_bytes(samples, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Encode float32 samples (~[-1, 1]) as 16-bit PCM WAV bytes in memory."""
    import numpy as np  # imported lazily so the HTTP layer works without numpy

    pcm16 = np.clip(samples, -1.0, 1.0)
    pcm16 = (pcm16 * 32767.0).astype("<i2")  # little-endian int16
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(sample_rate)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


class KokoroEngine:
    """Kokoro-82M loaded once at boot (~1-2 s) and reused for every request."""

    def __init__(self, model_path: Path = MODEL_PATH, voices_path: Path = VOICES_PATH):
        if not model_path.exists() or not voices_path.exists():
            raise SystemExit(
                f"[kokoro] model files missing under {model_path.parent} - run ./setup.sh first"
            )
        from kokoro_onnx import Kokoro

        self._kokoro = Kokoro(str(model_path), str(voices_path))
        self._voices = sorted(self._kokoro.get_voices())

    def voices(self) -> list[str]:
        return self._voices

    def synthesize(self, text: str, voice: str, speed: float, lang: str) -> bytes:
        samples, sample_rate = self._kokoro.create(text, voice=voice, speed=speed, lang=lang)
        return wav_bytes(samples, sample_rate)


def make_handler(engine: Engine) -> type[BaseHTTPRequestHandler]:
    """Build a request handler bound to one engine instance."""

    class Handler(BaseHTTPRequestHandler):
        server_version = f"LocalVoiceKokoro/{VERSION}"

        # Quieter logs; the default logs every request line to stderr.
        def log_message(self, fmt, *args):  # noqa: N802 (stdlib signature)
            return

        # ── helpers ──────────────────────────────────────────────────────
        def _origin(self) -> str | None:
            return self.headers.get("Origin")

        def _cors_headers(self) -> None:
            origin = self._origin()
            if origin and is_allowed_origin(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def _json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self._cors_headers()
            self.end_headers()
            self.wfile.write(body)

        def _reject_origin(self) -> bool:
            """Send 403 and return True when the request's Origin is not allowed."""
            if is_allowed_origin(self._origin()):
                return False
            self._json(403, {"error": "Origin not allowed by the LocalVoice Kokoro server."})
            return True

        def _path(self) -> str:
            return self.path.split("?", 1)[0]

        # ── methods ──────────────────────────────────────────────────────
        def do_OPTIONS(self) -> None:  # noqa: N802 (stdlib signature)
            if self._reject_origin():
                return
            self.send_response(204)
            self._cors_headers()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802 (stdlib signature)
            if self._reject_origin():
                return
            path = self._path()
            if path == "/health":
                self._json(200, {
                    "status": "ok",
                    "engine": ENGINE,
                    "version": VERSION,
                    "voices": len(engine.voices()),
                })
            elif path == "/voices":
                self._json(200, {
                    "engine": ENGINE,
                    "voices": engine.voices(),
                    "defaultVoice": DEFAULT_VOICE,
                })
            else:
                self._json(404, {"error": "Not found."})

        def do_POST(self) -> None:  # noqa: N802 (stdlib signature)
            if self._reject_origin():
                return
            if self._path() != "/tts":
                self._json(404, {"error": "Not found."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length > MAX_BODY_BYTES:
                    self._json(413, {"error": "Request body is too large."})
                    return
                payload = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("body must be a JSON object")
                # Coerce fields inside the guard so a malformed body (wrong
                # types, non-numeric speed) yields a clean 400.
                text = str(payload.get("text") or "").strip()
                voice = str(payload.get("voice") or "").strip() or DEFAULT_VOICE
                speed = float(payload.get("speed", 1.0))
                lang = str(payload.get("lang") or "").strip() or lang_for_voice(voice)
            except (ValueError, TypeError, AttributeError) as exc:
                self._json(400, {"error": "Invalid request body.", "details": str(exc)})
                return

            if not text:
                self._json(400, {"error": "Text must not be empty."})
                return
            if len(text) > MAX_TEXT_CHARS:
                self._json(400, {
                    "error": f"Text is too long ({len(text)} chars). Maximum is {MAX_TEXT_CHARS}."
                })
                return
            if voice not in engine.voices():
                self._json(400, {"error": f"Voice not found: {voice}"})
                return
            speed = min(MAX_SPEED, max(MIN_SPEED, speed))

            try:
                audio = engine.synthesize(text, voice, speed, lang)
            except Exception as exc:  # noqa: BLE001 - report any synth failure as 500
                self._json(500, {"error": "TTS generation failed.", "details": str(exc)})
                return

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "no-store")
            self._cors_headers()
            self.end_headers()
            self.wfile.write(audio)

    return Handler


def create_server(
    engine: Engine, host: str = HOST, port: int = PORT
) -> ThreadingHTTPServer:
    # ThreadingHTTPServer so a slow synthesis doesn't block /health checks.
    return ThreadingHTTPServer((host, port), make_handler(engine))


def main(load_engine: Callable[[], Engine] = KokoroEngine) -> None:
    print(f"[kokoro] loading model {MODEL_PATH.name} + {VOICES_PATH.name} ...", flush=True)
    engine = load_engine()
    server = create_server(engine)
    print(
        f"[kokoro] LocalVoice Kokoro server v{VERSION}: "
        f"{len(engine.voices())} voices on http://{HOST}:{PORT}",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[kokoro] shutting down", flush=True)
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
