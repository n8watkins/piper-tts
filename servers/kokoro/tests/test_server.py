"""Tests for the LocalVoice Kokoro server's HTTP layer (stdlib only).

A fake engine stands in for kokoro-onnx, so these run anywhere Python 3.9+ is
installed: python3 -m unittest discover -s servers/kokoro/tests
"""

from __future__ import annotations

import http.client
import json
import sys
import threading
import unittest
from pathlib import Path

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


class HelperTests(unittest.TestCase):
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
