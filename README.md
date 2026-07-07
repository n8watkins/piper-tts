# kokoro-tts

A minimal local [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) TTS
server backed by [`kokoro-onnx`](https://github.com/thewh1teagle/kokoro-onnx),
API-compatible with the Piper server T-Hub already proxies.

It exists so T-Hub's Voice settings can offer **Kokoro** (neural, 54 voices) as
an alternative engine to **Piper**. T-Hub's Rust backend proxies this server
(the browser can't call it directly - it rejects browser-Origin requests); see
`apps/desktop/src-tauri/src/voice.rs` in the T-Hub repo.

## Ports

- Piper server: `127.0.0.1:7477`
- **Kokoro server (this): `127.0.0.1:7478`**

WSL2 mirrors `localhost` to Windows, so a server bound to `127.0.0.1:7478`
inside WSL is reachable from the Windows T-Hub app at the same
`127.0.0.1:7478`. The server binds `127.0.0.1` only (loopback), never `0.0.0.0`.

## API

Identical shape to the Piper server:

| Method | Path      | Body                                          | Returns                                   |
| ------ | --------- | --------------------------------------------- | ----------------------------------------- |
| GET    | `/health` | -                                             | `{"status":"ok","engine":"kokoro",...}`   |
| GET    | `/voices` | -                                             | `{"voices":[...],"engine":"kokoro"}`      |
| POST   | `/tts`    | `{"text":"...","voice":"af_heart","speed":1}` | `audio/wav` (16-bit PCM, 24 kHz mono)     |

## Setup (one time)

```bash
./setup.sh
```

Creates a `.venv`, installs `kokoro-onnx`, and downloads the Kokoro-82M v1.0
model (`kokoro-v1.0.onnx`, ~310 MB) and voices (`voices-v1.0.bin`, ~27 MB) into
`./models`. Idempotent.

## Run

```bash
./start.sh
```

Loads the model once (~1-2 s) and serves on `127.0.0.1:7478`. Override with
`KOKORO_HOST` / `KOKORO_PORT`.

## Verify

```bash
curl -s http://127.0.0.1:7478/health
curl -s http://127.0.0.1:7478/voices | python3 -m json.tool | head
curl -s -X POST http://127.0.0.1:7478/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"Kokoro voice check","voice":"af_heart"}' -o /tmp/kokoro.wav
file /tmp/kokoro.wav   # -> RIFF WAVE audio, 16 bit, mono 24000 Hz
```

## Voices

54 voices across languages, prefixed by language + gender, e.g. American female
`af_heart` (default), `af_bella`; American male `am_adam`; British `bf_emma`,
`bm_george`; plus Spanish/French/Hindi/Italian/Japanese/Portuguese/Mandarin
sets. Enumerate the live list from `GET /voices`.
