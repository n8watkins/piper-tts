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

`start.sh` runs the server in the **foreground with no supervision** - fine for a
quick manual run, but if the launching terminal closes (or the process crashes /
is OOM-killed) it dies silently and permanently. For an always-on engine, use the
supervised install below instead.

## Supervision (auto-start + auto-restart)

Recommended: a systemd **user** service. It starts the server at login and
restarts it on any exit (crash, OOM, or the `SIGHUP` from a closed terminal - the
exact silent-death that motivated this), and journald captures the logs.

```bash
./install-service.sh
```

The script writes `~/.config/systemd/user/kokoro-tts.service` (from the template
in `systemd/`, with the repo path substituted), enables + starts it, and turns on
user lingering so it survives logout.

```bash
journalctl --user -u kokoro-tts.service -f      # logs
systemctl --user restart kokoro-tts.service     # restart
systemctl --user disable --now kokoro-tts.service   # remove
```

> The service binds `127.0.0.1:7478`. If an instance is already running there
> (e.g. a manual `nohup ./start.sh`), stop it first or the service will fail to
> bind. The install script checks `/health` and refuses to proceed if the port is
> already served.

No systemd user instance on this host (`systemctl --user` fails)? Fall back to a
detached launch plus a reboot hook:

```bash
setsid nohup ./start.sh >/tmp/kokoro-tts.log 2>&1 &   # detached, logged
(crontab -l 2>/dev/null; echo "@reboot setsid nohup $PWD/start.sh >/tmp/kokoro-tts.log 2>&1") | crontab -
```

(That covers reboot + terminal-close, but not crash-restart - systemd is
preferred where available.)

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
