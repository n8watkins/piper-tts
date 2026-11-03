#!/usr/bin/env python3
"""VoiceDock Kokoro server: a small local Kokoro-82M TTS server (kokoro-onnx).

It speaks the same HTTP API as the VoiceDock Piper server (see
docs/API.md in the repo root):

  GET  /health  -> {"status": "ok", "engine": "kokoro", "version": "...", "voices": 54,
                    "modelLoaded": false, "rssMb": 11.3, ...memory fields}
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

Memory: the model (about 300-700 MB of RAM while loaded) is loaded lazily on
the first /tts request and released again after KOKORO_IDLE_UNLOAD_SECONDS
without requests (default 600; 0 keeps it loaded once loaded). /health and
/voices never load it: voice names are read from the voices file's index.

Stdlib http.server only. kokoro-onnx and numpy are imported when the model is
loaded, so this module (and its tests) import without them.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import gc
import io
import json
import os
import sys
import threading
import time
import wave
import zipfile
from datetime import datetime, timezone
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

# Seconds without a /tts request before the model is released (0 = never).
DEFAULT_IDLE_UNLOAD_SECONDS = 600.0


def idle_unload_seconds_from_env(value: str | None) -> float:
    """Parse KOKORO_IDLE_UNLOAD_SECONDS: unset or invalid -> default, negative -> 0."""
    if value is None or not value.strip():
        return DEFAULT_IDLE_UNLOAD_SECONDS
    try:
        seconds = float(value)
    except ValueError:
        print(
            f"[kokoro] ignoring invalid KOKORO_IDLE_UNLOAD_SECONDS={value!r}, "
            f"using {DEFAULT_IDLE_UNLOAD_SECONDS:g}",
            flush=True,
        )
        return DEFAULT_IDLE_UNLOAD_SECONDS
    return max(0.0, seconds)


IDLE_UNLOAD_SECONDS = idle_unload_seconds_from_env(os.environ.get("KOKORO_IDLE_UNLOAD_SECONDS"))

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
    """What the HTTP layer needs from a synthesizer; tests pass a fake.

    An engine may also define status() -> dict, merged into /health (memory
    and model state); engines without it are reported as modelLoaded.
    """

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


def read_voice_names(voices_path: Path) -> list[str]:
    """Voice ids from a kokoro-onnx voices file without loading it.

    voices-v1.0.bin is a NumPy .npz archive: a zip with one `<voice>.npy`
    member per voice, so the zip index alone lists the voices (a few KB read,
    no numpy, no model).
    """
    with zipfile.ZipFile(voices_path) as archive:
        return sorted(
            name[: -len(".npy")] for name in archive.namelist() if name.endswith(".npy")
        )


def release_freed_memory() -> None:
    """Ask glibc to return freed heap pages to the OS (no-op elsewhere).

    Dropping the ONNX session frees its buffers, but glibc keeps most of them
    in its arenas, so the process RSS barely moves without malloc_trim.
    """
    gc.collect()
    libc_name = ctypes.util.find_library("c")
    if not libc_name:
        return
    try:
        trim = ctypes.CDLL(libc_name).malloc_trim
    except (OSError, AttributeError):
        return  # not glibc (musl, macOS): nothing to trim
    trim(0)


def process_rss_mb() -> float | None:
    """This process's resident memory in MB (Linux /proc), or None elsewhere."""
    try:
        with open("/proc/self/status", encoding="ascii") as status:
            for line in status:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)  # kB -> MB
    except OSError:
        pass
    return None


def iso_utc(timestamp: float | None) -> str | None:
    """A Unix timestamp as an ISO 8601 UTC string (second precision)."""
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def drop_file_cache(*paths: Path) -> None:
    """Tell the kernel it may drop these files from the page cache (Linux).

    Loading copies the model into the ONNX session, but the 338 MB of model
    files read on the way stay in the page cache, charged to this service:
    systemd's MemoryCurrent would count them on top of the model itself, and
    keep counting them after the model is released. The next load reads them
    again from disk (well under a second on an SSD).
    """
    advise = getattr(os, "posix_fadvise", None)
    if advise is None:
        return  # not Linux: nothing to do
    for path in paths:
        try:
            fd = os.open(path, os.O_RDONLY)
        except OSError:
            continue
        try:
            advise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
        except OSError:
            pass
        finally:
            os.close(fd)


def load_kokoro(model_path: Path, voices_path: Path):
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(str(model_path), str(voices_path))
    drop_file_cache(model_path, voices_path)
    return kokoro


class KokoroEngine:
    """Kokoro-82M, loaded on the first synthesis and released when idle.

    The model costs about 300-700 MB of RAM while loaded, so it is only kept
    in memory while it is being used: the first /tts request loads it (about
    1-2 s), and it is released after `idle_unload_seconds` without requests
    (0 keeps it loaded). Voice names come from the voices file's index, so
    /health and /voices never load the model.
    """

    def __init__(
        self,
        model_path: Path = MODEL_PATH,
        voices_path: Path = VOICES_PATH,
        idle_unload_seconds: float = IDLE_UNLOAD_SECONDS,
        loader: Callable[[Path, Path], object] = load_kokoro,
        release: Callable[[], None] = release_freed_memory,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        rss_mb: Callable[[], float | None] = process_rss_mb,
        start_reaper: bool = True,
    ):
        if not model_path.exists() or not voices_path.exists():
            raise SystemExit(
                f"[kokoro] model files missing under {model_path.parent} - run ./setup.sh first"
            )
        self._model_path = model_path
        self._voices_path = voices_path
        self._idle_unload_seconds = max(0.0, idle_unload_seconds)
        self._loader = loader
        self._release = release
        self._clock = clock
        self._wall_clock = wall_clock
        self._rss_mb = rss_mb
        self._started_at = wall_clock()
        self._loaded_at: float | None = None  # wall-clock times, for /health
        self._unloaded_at: float | None = None
        self._last_speak_at: float | None = None
        self._voices = read_voice_names(voices_path)
        self._kokoro = None
        self._active = 0  # synthesis calls in flight
        self._last_used = clock()
        # _lock guards the state and is only ever held briefly, so /health never
        # waits on a load; _load_lock serializes the 1-3 s model loads.
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()
        self._loading = False
        self._wake = threading.Event()
        self._stopped = False
        if start_reaper and self._idle_unload_seconds > 0:
            threading.Thread(target=self._reap_forever, name="kokoro-idle-unload", daemon=True).start()

    @property
    def idle_unload_seconds(self) -> float:
        return self._idle_unload_seconds

    def voices(self) -> list[str]:
        return self._voices

    def is_loaded(self) -> bool:
        return self._kokoro is not None

    def _ensure_loaded(self) -> None:
        """Load the model if it isn't, without holding _lock during the load."""
        with self._load_lock:
            if self._kokoro is not None:
                return
            with self._lock:
                self._loading = True
            try:
                started = time.monotonic()
                print(f"[kokoro] loading model {self._model_path.name} ...", flush=True)
                kokoro = self._loader(self._model_path, self._voices_path)
                print(f"[kokoro] model loaded in {time.monotonic() - started:.1f} s", flush=True)
            finally:
                with self._lock:
                    self._loading = False
            with self._lock:
                self._kokoro = kokoro
                self._loaded_at = self._wall_clock()
                # A fresh load is not idle: the reaper must not release it
                # before the request that loaded it has started.
                self._last_used = self._clock()
            self._wake.set()  # let the reaper start counting idle time

    def synthesize(self, text: str, voice: str, speed: float, lang: str) -> bytes:
        while True:
            self._ensure_loaded()
            with self._lock:
                kokoro = self._kokoro
                if kokoro is None:
                    continue  # released between the load and here: load again
                self._active += 1
                self._last_speak_at = self._wall_clock()
                break
        try:
            samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
        finally:
            with self._lock:
                self._active -= 1
                self._last_used = self._clock()
        return wav_bytes(samples, sample_rate)

    def unload_if_idle(self) -> bool:
        """Release the model if it has been idle long enough; True if released."""
        with self._lock:
            if (
                self._kokoro is None
                or self._active
                or self._idle_unload_seconds <= 0
                or self._clock() - self._last_used < self._idle_unload_seconds
            ):
                return False
            idle = self._clock() - self._last_used
            self._kokoro = None  # the last reference: no synthesis is in flight
            self._unloaded_at = self._wall_clock()
        self._release()
        print(f"[kokoro] model released after {idle:.0f} s idle", flush=True)
        return True

    def seconds_until_unload(self) -> float | None:
        """Seconds until the model is due for release, or None if not loaded."""
        with self._lock:
            if self._kokoro is None or self._idle_unload_seconds <= 0:
                return None
            if self._active:
                return self._idle_unload_seconds
            return max(0.0, self._last_used + self._idle_unload_seconds - self._clock())

    def status(self) -> dict:
        """Memory and model state for /health; cheap, never loads the model."""
        with self._lock:
            loaded = self._kokoro is not None
            speaking = self._active > 0
            idle = 0.0 if speaking else max(0.0, self._clock() - self._last_used)
            return {
                "modelLoaded": loaded,
                "modelLoading": self._loading,
                "speaking": speaking,
                "rssMb": self._rss_mb(),
                "pid": os.getpid(),
                "startedAt": iso_utc(self._started_at),
                "modelLoadedAt": iso_utc(self._loaded_at),
                "modelUnloadedAt": iso_utc(self._unloaded_at),
                "lastSpeakAt": iso_utc(self._last_speak_at),
                "idleSeconds": round(idle),
                "idleUnloadSeconds": (
                    int(self._idle_unload_seconds)
                    if float(self._idle_unload_seconds).is_integer()
                    else self._idle_unload_seconds
                ),
            }

    def stop(self) -> None:
        self._stopped = True
        self._wake.set()

    def _reap_forever(self) -> None:
        while not self._stopped:
            wait = self.seconds_until_unload()
            # Not loaded: sleep until a load wakes us. Loaded: wake when due
            # (plus a hair, so the idle check is past the threshold).
            self._wake.wait(None if wait is None else wait + 0.05)
            self._wake.clear()
            if not self._stopped:
                self.unload_if_idle()


def make_handler(engine: Engine) -> type[BaseHTTPRequestHandler]:
    """Build a request handler bound to one engine instance."""

    class Handler(BaseHTTPRequestHandler):
        server_version = f"VoiceDockKokoro/{VERSION}"

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
            self._json(403, {"error": "Origin not allowed by the VoiceDock Kokoro server."})
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
                health = {
                    "status": "ok",
                    "engine": ENGINE,
                    "version": VERSION,
                    "voices": len(engine.voices()),
                    "modelLoaded": True,
                }
                # Memory and model state; never loads the model.
                status = getattr(engine, "status", None)
                if status:
                    health.update(status())
                self._json(200, health)
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
    engine = load_engine()
    server = create_server(engine)
    unload = (
        f"released after {IDLE_UNLOAD_SECONDS:g} s idle"
        if IDLE_UNLOAD_SECONDS > 0
        else "kept once loaded"
    )
    print(
        f"[kokoro] VoiceDock Kokoro server v{VERSION}: "
        f"{len(engine.voices())} voices on http://{HOST}:{PORT} "
        f"(model loads on the first /tts request, {unload})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[kokoro] shutting down", flush=True)
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
