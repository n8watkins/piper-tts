# N8 Tray plan: one `n8voice` module for both engines

Status: plan only.
No N8 Tray or n8piper code has been changed.

## Goal

Replace the `n8piper` module (Piper only) with one N8 Tray module, **`n8voice`**, that shows and controls both VoiceDock engines:

- **Piper** on Windows: the Node server in `servers/piper`, port 7477, as n8piper runs it today.
- **Kokoro** in WSL: the Python server in `servers/kokoro`, port 7478, run by the systemd user unit `kokoro-tts`.

The tray should answer "can VoiceDock read right now, and with which engines?" at a glance, and offer start, stop and restart per engine.

## Today

| Piece | Where | Notes |
| --- | --- | --- |
| N8 Tray | `C:\Users\natha\scripts\n8tray\n8tray.ps1` (0.10.0) | Built-in panels per module; module list in `n8tray\config\settings.json`. |
| n8piper | `C:\Users\natha\scripts\n8tray\n8piper` | `modular.json` id `piper-tts`; `piper-tts.ps1` wrapper; `config\settings.json` has `server.path`, `port`, `host`. Adopts an already-healthy server, starts `server.js` with a named Node copy (`piper-tts-server.exe`), writes a pid file, and only ever stops its own server. Health: `GET /health`, 300 ms. |
| Piper server | `C:\Users\natha\Projects\Tools\piper-tts\local-piper-server` | Moves to `...\voicedock\servers\piper` with `UPDATE_WINDOWS_SERVER.md`. |
| Kokoro server | WSL `Ubuntu-24.04`, `~/projects/extensions/kokoro-tts` (moving to `servers/kokoro`) | systemd user unit `kokoro-tts`, enabled with lingering, `Restart=always`. Uses about 610 MB of RAM once loaded. Reachable from Windows at `127.0.0.1:7478` through WSL localhost mirroring. |

The tray guide's rules that shape this design (from `TRAY_MODULE_GUIDE.md`):

- Process running is not enough for servers: use an HTTP health check with a short timeout.
- Never call `wsl.exe` unless the module that needs it is running, because any `wsl.exe` call boots the VM and undoes `wsl --shutdown`.
  Use `Test-N8WslDistroRunning` (which doesn't boot the VM) before any other WSL call.
- No detection, health check or WSL call on the UI thread; background actions go through `Invoke-N8TrayAction`.
- Secrets never on a command line (not relevant here: neither engine has secrets).

## Design

### Folder

```
C:\Users\natha\scripts\n8voice\
├── modular.json
├── n8voice.ps1                 wrapper N8 Tray launches (Piper supervisor + Kokoro control)
├── start-n8voice.bat           run the wrapper on its own
├── config\settings.example.json
├── config\settings.json        (not committed)
├── logs\                       n8voice.log, piper-server.pid
└── README.md
```

### Module settings (`config\settings.json`)

```json
{
  "piper": {
    "enabled": true,
    "path": "C:\\Users\\natha\\Projects\\Tools\\voicedock\\servers\\piper",
    "host": "127.0.0.1",
    "port": 7477
  },
  "kokoro": {
    "enabled": true,
    "distro": "Ubuntu-24.04",
    "unit": "kokoro-tts",
    "host": "127.0.0.1",
    "port": 7478,
    "startWsl": false
  }
}
```

- `piper.*` keeps n8piper's meaning, so the migration is a copy of the old values.
- `kokoro.startWsl`: when `false` (the default), n8voice never boots WSL to start Kokoro; if WSL is off, Kokoro shows as "WSL off" and the extension falls back to the browser voice for Kokoro profiles.
  When `true`, starting the module (or **Start Kokoro**) may boot WSL.
  Default `false` because Kokoro costs about 610 MB plus the WSL VM itself, and the RAM budget on this machine is tight.

### Manifest (`modular.json`)

```json
{
  "schemaVersion": 2,
  "id": "n8voice",
  "name": "VoiceDock",
  "group": "Audio",
  "description": "Runs the VoiceDock engines: Piper on Windows and Kokoro in WSL.",
  "entry": "n8voice.ps1",
  "settings": "config/settings.json",
  "settingsExample": "config/settings.example.json",
  "log": "logs/n8voice.log",
  "autoStartDefault": true,
  "monitor": { "type": "process", "match": "n8voice.ps1" },
  "health": [
    { "name": "Piper",  "type": "http", "path": "/health", "hostSetting": "piper.host",  "portSetting": "piper.port",  "timeoutMs": 300 },
    { "name": "Kokoro", "type": "http", "path": "/health", "hostSetting": "kokoro.host", "portSetting": "kokoro.port", "timeoutMs": 300 }
  ],
  "tray": { "panel": "built-in" }
}
```

`health` becomes a list, which N8 Tray 0.10.0 doesn't read yet (it expects one object).
That is the one tray-side schema change; see "Tray changes" below.
The health checks are plain HTTP to `127.0.0.1`, so they never touch `wsl.exe`: a Kokoro check against a stopped WSL simply fails fast.

### Wrapper (`n8voice.ps1`)

One long-running wrapper, as n8piper is today, single-instance by a named mutex (`Local\N8Voice_SingleInstance`).

**Piper** (lifted from `piper-tts.ps1` with only renames):

- If `GET /health` on the Piper port already answers, adopt it (another tray or app started it) and don't start a second one.
- Otherwise start `server.js` with a named Node copy, `voicedock-piper.exe`, so Task Manager shows what it is, with `PORT`/`HOST` in the environment.
- Write `logs\piper-server.pid` as `<pid> <start ticks>` (guards against pid reuse) and only ever stop that process.
- If the server exits unexpectedly, restart it with a short backoff (n8piper currently just logs and exits; adding a restart loop is the one behavior change).

**Kokoro** (control only: systemd already supervises it inside WSL):

- On module start, if `kokoro.enabled`:
  1. `Test-N8WslDistroRunning -Distro <distro>`.
  2. WSL running: `Invoke-N8WslShell` with `systemctl --user start <unit>` (a no-op when it already runs, which it normally does because the unit is enabled with lingering).
  3. WSL off and `startWsl` is `false`: log "Kokoro: WSL off, not starting it" and leave it.
  4. WSL off and `startWsl` is `true`: run the same `systemctl` command, which boots WSL; the unit then starts by itself.
- **Stop Kokoro**: `systemctl --user stop <unit>`, only if the distro is running.
  It stays stopped until the next WSL boot or **Start Kokoro** (systemd re-enables it at boot because the unit is enabled; a "keep stopped" option could `disable` it, but that is out of scope).
- **Restart Kokoro**: `systemctl --user restart <unit>`; the model takes 1-2 s to load, so the panel shows "starting" until `/health` answers.
- The wrapper never polls WSL; status comes only from the HTTP health check.
- Module stop (tray **Stop VoiceDock**) stops the Piper server it started and leaves Kokoro running, because Kokoro also serves anything else that uses it in WSL.
  The panel has an explicit **Stop Kokoro** for that.

### Panel

```
VoiceDock                         ● running
  Piper   ● online   127.0.0.1:7477   [Restart] [Stop]
  Kokoro  ● online   127.0.0.1:7478   [Restart] [Stop]
  ─────────────────────────────────────────────
  Open voices folder (Piper)    Open logs    Open settings
  Open Kokoro logs (journalctl in a WSL terminal)
```

- Per-engine status: online, offline, starting, external (Piper adopted), WSL off (Kokoro, from `Test-N8WslDistroRunning` on the poller, not the UI thread).
- Status line in the tray menu: `VoiceDock: Piper ✓ Kokoro ✓`, or `VoiceDock: Piper ✓ Kokoro (WSL off)`.
- Tray icon tint follows the worst state of the enabled engines, as other modules do.

### Tray changes (in `n8tray.ps1`, later)

1. Read `health` as either an object (old manifests) or a list (new), and keep one status per named check.
2. A built-in `n8voice` panel, replacing the Piper panel, following the guide's "Add a module panel" steps.
3. Wire **Start/Stop/Restart Kokoro** through `Invoke-N8TrayAction` so the WSL calls run in the background with a 5 s timeout.

No other module changes.

## Migration from n8piper

1. Build `n8voice` next to `n8piper`; don't delete n8piper.
2. Copy `n8piper\config\settings.json` → `n8voice\config\settings.json` under `piper`, and add the `kokoro` block.
3. In `n8tray\config\settings.json`, disable the `piper-tts` module and add:

   ```json
   { "id": "n8voice", "manifest": "..\\n8voice\\modular.json", "enabled": true, "autoStart": true }
   ```

4. Restart N8 Tray.
   Because n8voice adopts a healthy Piper server, there's no gap: the server n8piper started keeps serving until it exits, then n8voice starts its own on the next restart.
   For a clean handover, stop the Piper module first, then enable n8voice.
5. After a week without trouble, remove the `piper-tts` entry and archive `n8piper`.

Rollback: re-enable `piper-tts`, disable `n8voice`, restart the tray.

## Naming

The module name follows the product name.
If VoiceDock is renamed (see `docs/NAMING.md`), rename the folder, `id`, mutex, named Node copy and panel title together, before the module ships, so it only changes once.

## Test plan

- Piper adopt: start the standalone Piper tray first, then n8voice: status shows "external" and **Stop Piper** is disabled.
- Piper own: n8voice starts Piper, `logs\piper-server.pid` is written, **Stop Piper** stops exactly that pid.
- Piper crash: kill `voicedock-piper.exe`; n8voice restarts it within a few seconds.
- Kokoro with WSL running: **Restart Kokoro** → status goes starting → online; `systemctl --user status kokoro-tts` agrees.
- Kokoro with WSL shut down (`wsl --shutdown`) and `startWsl: false`: the module starts, Kokoro shows "WSL off", and `wsl --list --running` stays empty (n8voice did not boot WSL).
- Same with `startWsl: true`: WSL boots and Kokoro comes online.
- UI thread: clicking every panel button keeps the tray responsive (all WSL calls are background actions).
- Extension: with Kokoro stopped from the panel, a Kokoro profile reads with the browser voice and the page says "Kokoro is offline"; after **Start Kokoro**, it reads with Kokoro again.

## Open questions for the owner

- Should starting VoiceDock ever boot WSL (`kokoro.startWsl`)? The plan defaults to no.
- Keep the standalone Piper tray in `servers/piper/tray` for public users? The plan keeps it; n8voice coexists with it by adopting.
- Module id: `n8voice` (matching the other n8 modules) with display name "VoiceDock", or rename both with the product?
