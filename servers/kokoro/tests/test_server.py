"""Tests for the VoiceDock Kokoro server's HTTP layer (stdlib only).

A fake engine stands in for kokoro-onnx, so these run anywhere Python 3.9+ is
installed: python3 -m unittest discover -s servers/kokoro/tests
"""

from __future__ import annotations

import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server  # noqa: E402

FAKE_WAV = b"RIFF\x24\x00\x00\x00WAVEfmt "


class FakeEngine:
    def __init__(self):
        self.calls = []

    def voices(self):
        return ["af_heart", "bm_george", "ef_dora"]

    def synthesize(self, text, voice, speed, lang):
        self.calls.append({"text": text, "voice": voice, "speed": speed, "lang": lang})
        if text == "boom":
            raise RuntimeError("model exploded")
        return FAKE_WAV


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.httpd = server.create_server(self.engine, "127.0.0.1", 0)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        data = None
        hdrs = dict(headers or {})
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=data, headers=hdrs)
        res = conn.getresponse()
        payload = res.read()
        conn.close()
        return res, payload


class OriginCheckTests(ServerTestCase):
    EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

    def test_requests_without_origin_are_allowed(self):
        res, body = self.request("GET", "/health")
        self.assertEqual(res.status, 200)
        self.assertIsNone(res.getheader("Access-Control-Allow-Origin"))
        self.assertEqual(json.loads(body)["engine"], "kokoro")

    def test_extension_origin_is_allowed_and_echoed(self):
        res, _ = self.request("GET", "/voices", headers={"Origin": self.EXT})
        self.assertEqual(res.status, 200)
        self.assertEqual(res.getheader("Access-Control-Allow-Origin"), self.EXT)

    def test_web_page_origin_is_rejected_on_every_route(self):
        for method, path, body in [
            ("GET", "/health", None),
            ("GET", "/voices", None),
            ("POST", "/tts", {"text": "hello"}),
            ("OPTIONS", "/tts", None),
        ]:
            with self.subTest(method=method, path=path):
                res, payload = self.request(
                    method, path, body, headers={"Origin": "https://evil.example"}
                )
                self.assertEqual(res.status, 403)
                self.assertIsNone(res.getheader("Access-Control-Allow-Origin"))
                self.assertIn("Origin not allowed", json.loads(payload)["error"])
        self.assertEqual(self.engine.calls, [], "a rejected origin must never reach the engine")

    def test_null_and_localhost_origins_are_rejected(self):
        for origin in ["null", "http://127.0.0.1:3000", "http://localhost"]:
            with self.subTest(origin=origin):
                res, _ = self.request("GET", "/health", headers={"Origin": origin})
                self.assertEqual(res.status, 403)

    def test_preflight_from_extension_succeeds(self):
        res, _ = self.request(
            "OPTIONS",
            "/tts",
            headers={
                "Origin": self.EXT,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        self.assertEqual(res.status, 204)
        self.assertEqual(res.getheader("Access-Control-Allow-Origin"), self.EXT)
        self.assertIn("POST", res.getheader("Access-Control-Allow-Methods"))
        self.assertIn("Content-Type", res.getheader("Access-Control-Allow-Headers"))


class ApiContractTests(ServerTestCase):
    def test_health_shape(self):
        res, body = self.request("GET", "/health")
        data = json.loads(body)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["engine"], "kokoro")
        self.assertEqual(data["version"], server.VERSION)
        self.assertEqual(data["voices"], 3)
        self.assertIs(data["modelLoaded"], True, "engines without status() count as loaded")

    def test_voices_shape(self):
        _, body = self.request("GET", "/voices")
        data = json.loads(body)
        self.assertEqual(data["engine"], "kokoro")
        self.assertEqual(data["voices"], ["af_heart", "bm_george", "ef_dora"])
        self.assertEqual(data["defaultVoice"], "af_heart")

    def test_tts_returns_wav(self):
        res, body = self.request("POST", "/tts", {"text": " Hello there. ", "voice": "bm_george"})
        self.assertEqual(res.status, 200)
        self.assertEqual(res.getheader("Content-Type"), "audio/wav")
        self.assertEqual(body, FAKE_WAV)
        self.assertEqual(
            self.engine.calls[-1],
            {"text": "Hello there.", "voice": "bm_george", "speed": 1.0, "lang": "en-gb"},
        )

    def test_tts_defaults_voice_and_infers_language(self):
        self.request("POST", "/tts", {"text": "hola"})
        self.assertEqual(self.engine.calls[-1]["voice"], "af_heart")
        self.assertEqual(self.engine.calls[-1]["lang"], "en-us")
        self.request("POST", "/tts", {"text": "hola", "voice": "ef_dora"})
        self.assertEqual(self.engine.calls[-1]["lang"], "es")
        self.request("POST", "/tts", {"text": "hola", "voice": "ef_dora", "lang": "es-419"})
        self.assertEqual(self.engine.calls[-1]["lang"], "es-419")

    def test_tts_clamps_speed(self):
        self.request("POST", "/tts", {"text": "fast", "speed": 9})
        self.assertEqual(self.engine.calls[-1]["speed"], server.MAX_SPEED)

    def test_error_shapes(self):
        cases = [
            ({"text": ""}, 400, "Text must not be empty."),
            ({"text": "x" * (server.MAX_TEXT_CHARS + 1)}, 400, "Text is too long"),
            ({"text": "hi", "voice": "zz_nobody"}, 400, "Voice not found: zz_nobody"),
            ({"text": "hi", "speed": "fast"}, 400, "Invalid request body."),
            (["not", "an", "object"], 400, "Invalid request body."),
            ({"text": "boom"}, 500, "TTS generation failed."),
        ]
        for body, status, message in cases:
            with self.subTest(body=str(body)[:40]):
                res, payload = self.request("POST", "/tts", body)
                self.assertEqual(res.status, status)
                self.assertEqual(res.getheader("Content-Type"), "application/json")
                self.assertIn(message, json.loads(payload)["error"])

    def test_malformed_json_is_a_400(self):
        res, payload = self.request("POST", "/tts", b"{not json")
        self.assertEqual(res.status, 400)
        self.assertEqual(json.loads(payload)["error"], "Invalid request body.")

    def test_unknown_route_is_a_json_404(self):
        res, payload = self.request("GET", "/nope")
        self.assertEqual(res.status, 404)
        self.assertEqual(json.loads(payload)["error"], "Not found.")


class FakeKokoro:
    """Stands in for kokoro_onnx.Kokoro: create() returns (samples, rate)."""

    def __init__(self, gate=None):
        self.gate = gate
        self.started = threading.Event()

    def create(self, text, voice, speed, lang):
        self.started.set()
        if self.gate is not None:
            self.gate.wait(5)
        return [0.0], server.SAMPLE_RATE


class FakeClock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


class LazyEngineTests(unittest.TestCase):
    VOICES = ["af_heart", "bm_george", "ef_dora"]

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.models = Path(tmp.name)
        self.model_path = self.models / "kokoro-v1.0.onnx"
        self.model_path.write_bytes(b"onnx")
        self.voices_path = self.models / "voices-v1.0.bin"
        # Same layout as the real voices file: an .npz (zip) with <voice>.npy members.
        with zipfile.ZipFile(self.voices_path, "w") as archive:
            for voice in reversed(self.VOICES):
                archive.writestr(f"{voice}.npy", b"\x93NUMPY")
        self.loads = []
        self.releases = 0
        self.clock = FakeClock()
        self.wall = FakeClock(1_800_000_000.0)  # 2027-01-15T08:00:00Z
        self.gate = None
        # wav_bytes needs numpy; the engine's memory behavior doesn't.
        patcher = mock.patch.object(server, "wav_bytes", lambda samples, rate: FAKE_WAV)
        patcher.start()
        self.addCleanup(patcher.stop)

    def loader(self, model_path, voices_path):
        self.loads.append((model_path, voices_path))
        self.kokoro = FakeKokoro(self.gate)
        return self.kokoro

    def release(self):
        self.releases += 1

    def engine(self, idle=600.0, **kwargs):
        options = dict(
            model_path=self.model_path,
            voices_path=self.voices_path,
            idle_unload_seconds=idle,
            loader=self.loader,
            release=self.release,
            clock=self.clock,
            wall_clock=self.wall,
            rss_mb=lambda: 42.5,
            start_reaper=False,
        )
        options.update(kwargs)
        engine = server.KokoroEngine(**options)
        self.addCleanup(engine.stop)
        return engine

    def test_starts_without_loading_the_model(self):
        engine = self.engine()
        self.assertFalse(engine.is_loaded())
        self.assertEqual(engine.voices(), self.VOICES)
        self.assertEqual(self.loads, [])

    def test_first_synthesis_loads_once_and_reuses_the_model(self):
        engine = self.engine()
        self.assertEqual(engine.synthesize("hi", "af_heart", 1.0, "en-us"), FAKE_WAV)
        self.assertTrue(engine.is_loaded())
        engine.synthesize("again", "af_heart", 1.0, "en-us")
        self.assertEqual(self.loads, [(self.model_path, self.voices_path)])

    def test_unloads_only_after_the_idle_period(self):
        engine = self.engine(idle=600)
        engine.synthesize("hi", "af_heart", 1.0, "en-us")
        self.clock.now += 599
        self.assertFalse(engine.unload_if_idle())
        self.assertTrue(engine.is_loaded())
        self.assertAlmostEqual(engine.seconds_until_unload(), 1)
        self.clock.now += 1
        self.assertTrue(engine.unload_if_idle())
        self.assertFalse(engine.is_loaded())
        self.assertEqual(self.releases, 1)
        self.assertIsNone(engine.seconds_until_unload())
        self.assertFalse(engine.unload_if_idle(), "nothing to release twice")

    def test_reloads_after_an_unload(self):
        engine = self.engine(idle=10)
        engine.synthesize("hi", "af_heart", 1.0, "en-us")
        self.clock.now += 10
        engine.unload_if_idle()
        engine.synthesize("back", "af_heart", 1.0, "en-us")
        self.assertTrue(engine.is_loaded())
        self.assertEqual(len(self.loads), 2)

    def test_each_request_restarts_the_idle_period(self):
        engine = self.engine(idle=600)
        engine.synthesize("hi", "af_heart", 1.0, "en-us")
        self.clock.now += 500
        engine.synthesize("still reading", "af_heart", 1.0, "en-us")
        self.clock.now += 500
        self.assertFalse(engine.unload_if_idle())

    def test_zero_disables_unloading(self):
        engine = self.engine(idle=0)
        engine.synthesize("hi", "af_heart", 1.0, "en-us")
        self.clock.now += 10**9
        self.assertFalse(engine.unload_if_idle())
        self.assertTrue(engine.is_loaded())
        self.assertIsNone(engine.seconds_until_unload())

    def test_never_unloads_during_a_synthesis(self):
        self.gate = threading.Event()
        engine = self.engine(idle=1)
        worker = threading.Thread(target=engine.synthesize, args=("long", "af_heart", 1.0, "en-us"))
        worker.start()
        self.assertTrue(self.kokoro_started())
        self.clock.now += 3600
        self.assertFalse(engine.unload_if_idle())
        self.gate.set()
        worker.join(5)
        self.assertTrue(engine.is_loaded(), "the idle period starts when the request ends")
        self.clock.now += 1
        self.assertTrue(engine.unload_if_idle())

    def kokoro_started(self):
        deadline = time.monotonic() + 5
        while not self.loads and time.monotonic() < deadline:
            time.sleep(0.01)
        return self.kokoro.started.wait(5)

    def test_background_reaper_releases_the_model(self):
        engine = self.engine(idle=0.05, clock=time.monotonic, start_reaper=True)
        engine.synthesize("hi", "af_heart", 1.0, "en-us")
        deadline = time.monotonic() + 5
        while engine.is_loaded() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(engine.is_loaded())
        self.assertEqual(self.releases, 1)
        engine.synthesize("again", "af_heart", 1.0, "en-us")
        deadline = time.monotonic() + 5
        while engine.is_loaded() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(engine.is_loaded(), "the reaper keeps working after a reload")

    def test_status_reports_memory_and_model_events(self):
        engine = self.engine(idle=600)
        status = engine.status()
        self.assertEqual(status["rssMb"], 42.5)
        self.assertIs(status["modelLoaded"], False)
        self.assertIs(status["speaking"], False)
        self.assertEqual(status["startedAt"], "2027-01-15T08:00:00Z")
        self.assertIsNone(status["modelLoadedAt"])
        self.assertIsNone(status["modelUnloadedAt"])
        self.assertIsNone(status["lastSpeakAt"])
        self.assertEqual(status["idleUnloadSeconds"], 600)
        self.assertIsInstance(status["pid"], int)

        self.wall.now += 60
        engine.synthesize("hi", "af_heart", 1.0, "en-us")
        self.clock.now += 30
        status = engine.status()
        self.assertIs(status["modelLoaded"], True)
        self.assertEqual(status["modelLoadedAt"], "2027-01-15T08:01:00Z")
        self.assertEqual(status["lastSpeakAt"], "2027-01-15T08:01:00Z")
        self.assertEqual(status["idleSeconds"], 30)

        self.clock.now += 570
        self.wall.now += 600
        engine.unload_if_idle()
        status = engine.status()
        self.assertIs(status["modelLoaded"], False)
        self.assertEqual(status["modelUnloadedAt"], "2027-01-15T08:11:00Z")
        self.assertEqual(status["modelLoadedAt"], "2027-01-15T08:01:00Z", "kept for history")

    def test_status_while_speaking(self):
        self.gate = threading.Event()
        engine = self.engine()
        worker = threading.Thread(target=engine.synthesize, args=("long", "af_heart", 1.0, "en-us"))
        worker.start()
        self.assertTrue(self.kokoro_started())
        self.clock.now += 100
        status = engine.status()
        self.assertIs(status["speaking"], True)
        self.assertEqual(status["idleSeconds"], 0)
        self.gate.set()
        worker.join(5)

    def test_missing_model_files_fail_fast(self):
        self.model_path.unlink()
        with self.assertRaises(SystemExit):
            self.engine()

    def test_health_and_voices_never_load_the_model(self):
        engine = self.engine()
        httpd = server.create_server(engine, "127.0.0.1", 0)
        thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        try:
            def get(path):
                conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
                conn.request("GET", path)
                body = json.loads(conn.getresponse().read())
                conn.close()
                return body

            health = get("/health")
            self.assertEqual(health["voices"], 3)
            self.assertIs(health["modelLoaded"], False)
            self.assertEqual(health["rssMb"], 42.5)
            self.assertEqual(health["idleUnloadSeconds"], 600)
            self.assertEqual(get("/voices")["voices"], self.VOICES)
            self.assertEqual(self.loads, [])
            engine.synthesize("hi", "af_heart", 1.0, "en-us")
            self.assertIs(get("/health")["modelLoaded"], True)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


class HelperTests(unittest.TestCase):
    def test_idle_unload_seconds_from_env(self):
        parse = server.idle_unload_seconds_from_env
        self.assertEqual(parse(None), server.DEFAULT_IDLE_UNLOAD_SECONDS)
        self.assertEqual(parse(""), server.DEFAULT_IDLE_UNLOAD_SECONDS)
        self.assertEqual(parse("0"), 0)
        self.assertEqual(parse("90"), 90)
        self.assertEqual(parse("-5"), 0)
        with mock.patch("builtins.print"):
            self.assertEqual(parse("soon"), server.DEFAULT_IDLE_UNLOAD_SECONDS)

    def test_release_freed_memory_is_safe_to_call(self):
        server.release_freed_memory()

    def test_process_rss_mb(self):
        rss = server.process_rss_mb()
        if Path("/proc/self/status").exists():
            self.assertGreater(rss, 1)
        else:
            self.assertIsNone(rss)

    def test_iso_utc(self):
        self.assertIsNone(server.iso_utc(None))
        self.assertEqual(server.iso_utc(0), "1970-01-01T00:00:00Z")

    def test_lang_for_voice(self):
        self.assertEqual(server.lang_for_voice("af_heart"), "en-us")
        self.assertEqual(server.lang_for_voice("bf_emma"), "en-gb")
        self.assertEqual(server.lang_for_voice("jf_alpha"), "ja")
        self.assertEqual(server.lang_for_voice("zm_yunxi"), "cmn")
        self.assertEqual(server.lang_for_voice("qq_unknown"), "en-us")

    def test_is_allowed_origin(self):
        self.assertTrue(server.is_allowed_origin(None))
        self.assertTrue(server.is_allowed_origin(""))
        self.assertTrue(server.is_allowed_origin("chrome-extension://abc"))
        self.assertFalse(server.is_allowed_origin("https://example.com"))
        self.assertFalse(server.is_allowed_origin("moz-extension://abc"))


if __name__ == "__main__":
    unittest.main()
