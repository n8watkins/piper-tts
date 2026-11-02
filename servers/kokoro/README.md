# LocalVoice Kokoro server

A small local [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) text-to-speech server backed by [`kokoro-onnx`](https://github.com/thewh1teagle/kokoro-onnx).
It is one of the two LocalVoice engines: the extension can read with Piper (`servers/piper`, port 7477) or Kokoro (this server, port 7478), chosen per profile.

Kokoro sounds more natural than Piper and ships 54 voices in 9 languages, at a small latency cost (about 1.5 s warm for one sentence versus 1.15 s for Piper).

It speaks the shared LocalVoice API described in [`docs/API.md`](../../docs/API.md).

## History

This folder was moved in from the standalone `n8watkins/kokoro-tts` repo with `git subtree`, so its earlier commits are kept.
List them with `git log --oneline <import merge>^2`, where the import merge is the commit "build: import the Kokoro server with its history into servers/kokoro".

## Ports and origins

- Piper server: `127.0.0.1:7477`
- Kokoro server (this): `127.0.0.1:7478`

The server binds `127.0.0.1` only (loopback), never `0.0.0.0`.
WSL2 mirrors `localhost` to Windows, so a server bound to `127.0.0.1:7478` inside WSL is reachable from Windows Chrome at the same address.

Like the Piper server, it only answers requests that either have no `Origin` header (curl, scripts, native apps) or come from a `chrome-extension://` origin.
Any other browser origin gets `403`, so a web page you visit can't drive your local engine.
Allowed extension origins get CORS headers, including on the `OPTIONS` preflight.

## API

| Method | Path      | Body                                          | Returns                                                |
| ------ | --------- | --------------------------------------------- | ------------------------------------------------------ |
| GET    | `/health` | -                                             | `{"status":"ok","engine":"kokoro","version":"1.0.0","voices":54}` |
| GET    | `/voices` | -                                             | `{"engine":"kokoro","voices":[...],"defaultVoice":"af_heart"}` |
| POST   | `/tts`    | `{"text":"...","voice":"af_heart","speed":1}` | `audio/wav` (16-bit PCM, 24 kHz mono)                  |

`voice` defaults to `af_heart`.
`speed` is clamped to 0.5-2.0 (the extension leaves it at 1 and changes speed during playback instead).
`lang` is optional: by default it follows the voice's first letter (`a` American English, `b` British English, `e` Spanish, `f` French, `h` Hindi, `i` Italian, `j` Japanese, `p` Brazilian Portuguese, `z` Mandarin).

Errors are JSON `{"error": "...", "details": "..."}` with a 4xx or 5xx status.

## Setup (one time)

```bash
./setup.sh
```

Creates a `.venv`, installs `kokoro-onnx`, and downloads the Kokoro-82M v1.0 model (`kokoro-v1.0.onnx`, about 310 MB) and voices (`voices-v1.0.bin`, about 27 MB) into `./models`.
It is idempotent.

## Run

```bash
./start.sh
```

Loads the model once (about 1-2 s) and serves on `127.0.0.1:7478`.
Override with `KOKORO_HOST` / `KOKORO_PORT`, and point at model files elsewhere with `KOKORO_MODELS_DIR`.

`start.sh` runs the server in the foreground with no supervision.
That is fine for a quick manual run, but if the launching terminal closes (or the process crashes or is OOM-killed) it dies silently.
For an always-on engine, use the supervised install below.

## Supervision (auto-start and auto-restart)

Recommended: a systemd user service.
It starts the server at login and restarts it on any exit (crash, OOM, or the `SIGHUP` from a closed terminal), and journald captures the logs.

```bash
./install-service.sh
```

The script writes `~/.config/systemd/user/kokoro-tts.service` (from the template in `systemd/`, with this folder's path substituted), enables and starts it, and turns on user lingering so it survives logout.

```bash
journalctl --user -u kokoro-tts.service -f          # logs
systemctl --user restart kokoro-tts.service         # restart
systemctl --user disable --now kokoro-tts.service   # remove
```

> The service binds `127.0.0.1:7478`.
> If an instance is already running there (for example the service installed from the old `kokoro-tts` checkout), stop it first or the new one will fail to bind.
> The install script checks `/health` and refuses to proceed if the port is already served.

No systemd user instance on this host (`systemctl --user` fails)?
Fall back to a detached launch plus a reboot hook:

```bash
setsid nohup ./start.sh >/tmp/kokoro-tts.log 2>&1 &   # detached, logged
(crontab -l 2>/dev/null; echo "@reboot setsid nohup $PWD/start.sh >/tmp/kokoro-tts.log 2>&1") | crontab -
```

That covers reboot and terminal close, but not crash restart, so systemd is preferred where available.

## Tests

The HTTP layer (routes, error shapes, origin check, CORS) is tested with a fake engine and needs only the Python standard library:

```bash
python3 -m unittest discover -s servers/kokoro/tests   # from the repo root
```

`npm test` at the repo root runs these too.

## Verify a running server

```bash
curl -s http://127.0.0.1:7478/health
curl -s http://127.0.0.1:7478/voices | python3 -m json.tool | head
curl -s -X POST http://127.0.0.1:7478/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"Kokoro voice check","voice":"af_heart"}' -o /tmp/kokoro.wav
file /tmp/kokoro.wav   # -> RIFF WAVE audio, 16 bit, mono 24000 Hz
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://example.com' http://127.0.0.1:7478/health   # -> 403
```

## Voices

54 voices across 9 languages, named by language and gender, for example American female `af_heart` (default) and `af_bella`, American male `am_adam`, British `bf_emma` and `bm_george`, plus Spanish, French, Hindi, Italian, Japanese, Portuguese and Mandarin sets.
Enumerate the live list from `GET /voices`.
