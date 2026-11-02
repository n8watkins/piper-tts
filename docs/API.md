# LocalVoice engine API

Both LocalVoice engines are small local HTTP servers that speak the same API, so the extension (and any other local client) can treat them alike.

| Engine | Server | Default address | Runs on |
| --- | --- | --- | --- |
| Piper | `servers/piper` (Node.js, Express, `piper.exe`) | `http://127.0.0.1:7477` | Windows, macOS, Linux |
| Kokoro | `servers/kokoro` (Python, stdlib `http.server`, `kokoro-onnx`) | `http://127.0.0.1:7478` | Linux or WSL (reachable from Windows through WSL localhost mirroring) |

Override the port with `PORT` / `HOST` (Piper) or `KOKORO_PORT` / `KOKORO_HOST` (Kokoro).
The extension expects the defaults.

## Conventions

- **Loopback only.** Both servers bind `127.0.0.1` by default, never `0.0.0.0`.
- **Origin check.** A request with no `Origin` header (curl, scripts, native apps) or with a `chrome-extension://` origin is allowed.
  Any other browser origin gets `403` on every route, including the `OPTIONS` preflight, so a web page can't use your local engine.
- **CORS.** For an allowed extension origin the server echoes it in `Access-Control-Allow-Origin` (with `Vary: Origin`).
  Preflight answers allow `GET, POST, OPTIONS` (Piper also allows `DELETE`) and the `Content-Type` header.
  The extension also lists both addresses in `host_permissions`, so it works even with an older server that sends no CORS headers.
- **JSON everywhere except audio.** Every response that isn't audio is JSON, including errors and unknown routes.
- **Body limit.** Request bodies are limited to 1 MB.

## `GET /health`

`200` when the server is up and ready to synthesize.

```json
{ "status": "ok", "engine": "piper", "version": "1.0.0" }
```

```json
{ "status": "ok", "engine": "kokoro", "version": "1.0.0", "voices": 54 }
```

| Field | Type | Notes |
| --- | --- | --- |
| `status` | `"ok"` | Always `"ok"` on `200`. |
| `engine` | `"piper"` or `"kokoro"` | Which engine answered. |
| `version` | string | The server's own version (the servers are versioned separately from the extension). |
| `voices` | number | Kokoro only: how many voices are loaded. |

Clients should treat any non-`200` response, a timeout (the extension uses 2.5 s), or a connection error as "offline".

## `GET /voices`

```json
{
  "engine": "piper",
  "voices": ["en_US-amy-medium.onnx", "en_US-ryan-high.onnx"],
  "defaultVoice": "en_US-ryan-high.onnx",
  "sizes": { "en_US-amy-medium.onnx": 63201294 },
  "voiceDir": "C:\\...\\servers\\piper\\piper\\voices"
}
```

```json
{ "engine": "kokoro", "voices": ["af_alloy", "af_heart", "bm_george"], "defaultVoice": "af_heart" }
```

| Field | Type | Notes |
| --- | --- | --- |
| `engine` | string | Which engine answered. |
| `voices` | string[] | Voice ids to pass as `voice` to `/tts`. Piper ids are `.onnx` filenames; Kokoro ids look like `af_heart` (language letter, gender letter, name). |
| `defaultVoice` | string | The voice `/tts` uses when `voice` is omitted. For Piper it may not be installed. |
| `sizes`, `voiceDir` | object, string | Piper only: file sizes in bytes and the folder that holds the voices. |

## `POST /tts`

Request body (JSON):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `text` | string | yes | Trimmed; must not be empty. Piper accepts up to 8000 characters, Kokoro up to 4000. The extension sends chunks of at most 350. |
| `voice` | string | no | A voice id from `/voices`. Defaults to `defaultVoice`. |
| `speed` | number | no | Kokoro only, clamped to 0.5-2.0. The extension leaves it out and changes speed during playback instead, so the live speed control works the same for both engines. |
| `lang` | string | no | Kokoro only. Defaults to the voice's language (from its first letter). |

Success: `200` with `Content-Type: audio/wav` and the WAV bytes (Piper: the voice's native rate, usually 22.05 kHz; Kokoro: 16-bit PCM, 24 kHz mono).
Responses are `Cache-Control: no-store`.

## Errors

```json
{ "error": "Voice not found: zz_nobody" }
```

```json
{ "error": "TTS generation failed.", "details": "Piper exited with code 1. Stderr: ..." }
```

| Field | Type | Notes |
| --- | --- | --- |
| `error` | string | One human-readable sentence, safe to show to a user. |
| `details` | string | Optional: the underlying cause, for logs. |
| `hint` | string | Optional (Piper): what to do about a setup problem, such as a missing `piper.exe`. |

| Status | When |
| --- | --- |
| `400` | Invalid body, empty or too-long text, unknown or unsafe voice. |
| `403` | The request's `Origin` is not allowed. |
| `404` | Unknown route (`{"error":"Not found."}`). |
| `413` | Body over 1 MB. |
| `500` | Synthesis failed, or the engine binary or model is missing. |

## Piper-only routes

These manage installed voice files and are used by the extension's Voices tab.
Kokoro's voices live in a single bundled file, so it has no equivalents.

| Method | Path | Does |
| --- | --- | --- |
| `DELETE` | `/voices/:name` | Deletes `name` (a `.onnx` filename) and its `.onnx.json` config. |
| `POST` | `/voices/open-folder` | Opens the voices folder in the OS file manager. |

## Tests

- `test/piper-server.test.mjs`: Piper routes, error shapes and the origin check (no `piper.exe` needed).
- `servers/kokoro/tests/test_server.py`: Kokoro routes, error shapes, the origin check and CORS, with a fake engine (no model needed).

`npm test` runs both.
