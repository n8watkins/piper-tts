# Updating the Piper server running on Windows

This is a one-time owner checklist for moving the Windows Piper server onto the LocalVoice 1.1 code.
Nothing here has been done for you: the running server was deliberately left alone.

## What is running today (checked 2026-11-01)

| What | Where |
| --- | --- |
| Piper server code | `C:\Users\natha\Projects\Tools\piper-tts\local-piper-server\server.js` |
| How it starts | N8 Tray module `piper-tts` → `C:\Users\natha\scripts\n8piper\piper-tts.ps1`, which reads `server.path` from `C:\Users\natha\scripts\n8piper\config\settings.json` and runs `server.js` with a named Node copy, `piper-tts-server.exe` |
| Last start | 2026-11-01 18:25, pid 29700, on `http://127.0.0.1:7477` (`/health` answers `{"status":"ok","version":"1.0.0"}`) |
| Piper binary and voices | `...\local-piper-server\piper\` (`piper.exe`, DLLs, `espeak-ng-data\`, 8 voices in `voices\`); gitignored, they exist only there |
| Chrome extension | Loaded unpacked from `C:\Users\natha\Projects\Tools\piper-tts\extension` (extension id `djhkchiohpmmgcjlliakdkbllhfbefmg`), version 1.0.17 |

That folder is a git clone still checked out at a 2026-05-25 commit (`f002999`), with newer files copied over it by hand.
`git status` there shows `server.js` and `package.json` under `local-piper-server` as modified, plus many untracked files.

## Review of the edited files

The two edited server files are not local fixes.
They are copies of newer repo code from 2026-06-05 laid over the old checkout:

- `server.js` matches the repo at `590b772` ("Hide piper.exe console window on each TTS request").
  The only difference from the current repo is that it reads `PORT`/`HOST` inline instead of from `config.js` (a refactor, `4c1c9fe`, same behavior).
- `package.json` is identical to the current repo's.

The other files that differ are older than the repo, not edits either:

- `setup.js` lacks the write-stream error handling added in `9db83af`.
- `tray/piper-tray.js` lacks the shared `config.js` (`4c1c9fe`).
- `scripts/start-windows.ps1`, `scripts/start-background-windows.ps1`, `scripts/start-unix.sh`, `scripts/piper-tray-windows.ps1` and `README.md` still default to the old port 5050.
  N8 Tray doesn't use them (n8piper passes `PORT=7477`), but running them by hand would start a server the extension can't find.
- `node_modules` has the dependency versions from June (for example `express` 4.22.2, `body-parser` 1.20.5); the repo lockfile now pins the patched versions from the 2026-10-26 Dependabot refresh (`express` 4.22.3, `body-parser` 1.20.9).
- `extension\offscreen.js` lacks the last extension fix ("Abort in-flight prefetch on stop").

So there was nothing to fold back into the repo.
Updating gets you: the `config.js` refactor, the setup fix, the patched dependencies, the `engine` field and JSON 404s that the LocalVoice API expects (see `docs/API.md`), and consistent 7477 defaults everywhere.

## Plan

Put the new server in a fresh clone next to the old folder, point n8piper at it, and keep Chrome loading the extension from the old folder.

Chrome derives an unpacked extension's id from its folder path, and the saved profiles belong to that id.
Loading the extension from a new folder would start LocalVoice with empty settings, so the extension stays where it is and is updated with `npm run deploy` from WSL.

Total time: about 10 minutes, with Piper unavailable for under a minute while it restarts.

## Steps

Run these in PowerShell unless they say WSL.

1. **Clone the repo** into a new folder:

   ```powershell
   git clone https://github.com/n8watkins/piper-tts.git C:\Users\natha\Projects\Tools\localvoice
   ```

2. **Copy the Piper binary and voices** from the old server (nothing is moved or deleted):

   ```powershell
   robocopy C:\Users\natha\Projects\Tools\piper-tts\local-piper-server\piper C:\Users\natha\Projects\Tools\localvoice\servers\piper\piper /E
   ```

   Then check that `C:\Users\natha\Projects\Tools\localvoice\servers\piper\piper\piper.exe` exists and `voices\` holds the 8 `.onnx` files with their `.onnx.json` configs.

3. **Install the server's dependencies:**

   ```powershell
   cd C:\Users\natha\Projects\Tools\localvoice\servers\piper
   npm ci
   ```

4. **Smoke-test the new server on a spare port** while the old one keeps serving 7477:

   ```powershell
   $env:PORT = "7577"; node server.js
   ```

   In a second PowerShell window:

   ```powershell
   Invoke-RestMethod http://127.0.0.1:7577/health
   # expect: status ok, engine piper, version 1.0.0
   Invoke-WebRequest -Method Post -Uri http://127.0.0.1:7577/tts -ContentType 'application/json' -Body '{"text":"LocalVoice check","voice":"en_US-ryan-high.onnx"}' -OutFile $env:TEMP\lv-check.wav
   ```

   Play `%TEMP%\lv-check.wav`, then stop the test server with Ctrl+C and `Remove-Item Env:PORT`.

5. **Stop the old server** from N8 Tray: stop the **Piper TTS** module.
   n8piper only stops the server it started (it checks its pid file), so this stops pid 29700.
   Confirm it is down: `Invoke-RestMethod http://127.0.0.1:7477/health` should now fail.

6. **Point n8piper at the new folder.**
   Edit `C:\Users\natha\scripts\n8piper\config\settings.json` (a settings file, not n8piper's code) and change `server.path`:

   ```json
   {
     "server": {
       "path": "C:\\Users\\natha\\Projects\\Tools\\localvoice\\servers\\piper",
       "port": 7477,
       "host": "127.0.0.1"
     }
   }
   ```

7. **Start the module** again from N8 Tray.
   On its first start in the new folder, n8piper copies `node.exe` to `servers\piper\piper-tts-server.exe` (gitignored).

8. **Verify:**

   ```powershell
   Invoke-RestMethod http://127.0.0.1:7477/health
   # expect: status ok, engine piper, version 1.0.0  (the "engine" field means the new code is live)
   ```

   N8 Tray should show the module as running.

9. **Update the extension** Chrome loads, from WSL:

   ```bash
   cd ~/projects/extensions/piper-tts
   npm run deploy   # builds and mirrors extension/ into C:\Users\natha\Projects\Tools\piper-tts\extension
   ```

   Then reload it at `chrome://extensions`.
   It now shows as **LocalVoice 1.1.0**, your profiles carry over (the migration runs on update), and each profile can pick Piper or Kokoro.

## Rollback

1. Stop the **Piper TTS** module in N8 Tray.
2. Set `server.path` in `C:\Users\natha\scripts\n8piper\config\settings.json` back to `C:\\Users\\natha\\Projects\\Tools\\piper-tts\\local-piper-server`.
3. Start the module again.

The old folder is untouched by the steps above, so this always works.

## Cleanup (later, once you're happy)

- The old `C:\Users\natha\Projects\Tools\piper-tts\local-piper-server` can be deleted once the new server has run for a while; keep `C:\Users\natha\Projects\Tools\piper-tts\extension`, because Chrome loads it.
- The old folder's git checkout is stale and dirty; it only needs to exist as the extension folder that `npm run deploy` writes into.

## Kokoro (WSL), for completeness

The Kokoro service was also left running from the old standalone checkout, `~/projects/extensions/kokoro-tts` (systemd user unit `kokoro-tts`).
It keeps working as is, but it lacks the new origin check, so any web page you visit could use it.
To move it onto `servers/kokoro` (WSL, about 2 minutes, Kokoro unavailable for a few seconds):

```bash
cd ~/projects/extensions/piper-tts/servers/kokoro
python3 -m venv .venv && .venv/bin/pip install --quiet kokoro-onnx soundfile numpy   # or ./setup.sh
mkdir -p models && cp ~/projects/extensions/kokoro-tts/models/* models/               # reuse the 340 MB model, no download
systemctl --user stop kokoro-tts
./install-service.sh          # rewrites the unit to point at servers/kokoro, enables and starts it
curl -s http://127.0.0.1:7478/health                                                    # expect "version": "1.0.0"
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://example.com' http://127.0.0.1:7478/health   # expect 403
```

Rollback: `systemctl --user stop kokoro-tts`, then run `~/projects/extensions/kokoro-tts/install-service.sh`.
