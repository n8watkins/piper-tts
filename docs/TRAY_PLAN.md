# N8 Tray: the `n8voice` module for both engines

Status: built.
The module lives in the N8 Tray repo at `C:\Users\natha\scripts\n8tray\n8voice` (n8watkins/n8tray#6, N8 Tray 0.12.0) and replaced `n8piper` on 2026-11-02.
Its README there is the reference for settings and behavior; this page records the design and the decisions behind it.

## Goal

One N8 Tray module, **`n8voice`** (shown as "VoiceDock"), that shows and controls both VoiceDock engines and keeps a memory history:

- **Piper** on Windows: the Node server in `servers/piper`, port 7477.
- **Kokoro** in WSL: the Python server in `servers/kokoro`, port 7478, run by the systemd user unit `kokoro-tts`.

The tray answers "can VoiceDock read right now, with which engines, and what does it cost in memory?" at a glance.

## Rules from the tray guide that shaped it

From N8 Tray's `TRAY_MODULE_GUIDE.md`:

- Process running is not enough for servers: use an HTTP health check with a short timeout.
- Never call `wsl.exe` unless needed, because any `wsl.exe` call boots the VM and undoes `wsl --shutdown`.
  `wsl --list --running` is the one check that does not boot it.
- No detection, health check or WSL call on the UI thread; panel buttons queue background actions.

## Layout

```
C:\Users\natha\scripts\n8tray\n8voice\
├── modular.json                id n8voice, name VoiceDock
├── n8voice.ps1                 wrapper N8 Tray launches; also -Kokoro start|stop|restart and -Report
├── start-n8voice.bat           run the wrapper on its own
├── config\settings.example.json
├── config\settings.json        (not committed)
├── report\                     memory-report.js and memory-history.js, copied from servers/piper/tray
└── logs\                       n8voice.log, piper-server.pid, status.json, memory\
```

## Settings (`config\settings.json`)

```json
{
  "piper":  { "enabled": true, "path": "C:\\...\\servers\\piper", "host": "127.0.0.1", "port": 7477 },
  "kokoro": { "enabled": true, "distro": "Ubuntu-24.04", "unit": "kokoro-tts", "host": "127.0.0.1", "port": 7478, "startWsl": false },
  "memory": { "enabled": true, "intervalSeconds": 60, "keepDays": 30, "statusIntervalSeconds": 5, "wsl": true }
}
```

- `piper.*` keeps n8piper's meaning (`server.path`, `port`, `host`), so the migration was a copy.
- `kokoro.startWsl` defaults to `false`: n8voice never boots WSL to start Kokoro.
  Kokoro costs 300-700 MB while its model is loaded, plus the WSL VM itself, and the RAM budget on this machine is tight.

## Behavior

**Piper** (carried over from n8piper):

- Adopts a server that already answers `/health` (for example the VoiceDock tray's) and never stops it.
- Otherwise starts `server.js` with a named Node copy, `voicedock-piper.exe`, and writes `logs\piper-server.pid` as `<pid> <start ticks>` (guards against pid reuse).
- New: restarts its server after 1, 2, 4, ... up to 60 s if it exits, and takes over if an adopted server stops answering.

**Kokoro** (control only: systemd supervises it inside WSL):

- On module start, if Kokoro does not answer, n8voice runs `systemctl --user start kokoro-tts` only when `wsl --list --running` shows the distro, or when `kokoro.startWsl` is true.
- **Start / Restart / Stop Kokoro** in the panel run `n8voice.ps1 -Kokoro <action>` as a background action, with the same rule.
- Module stop leaves Kokoro running; **Stop Kokoro** stops it until the next WSL boot.

**Status and memory:**

- N8 Tray checks both `/health` endpoints over plain HTTP with a 300 ms timeout; that never touches `wsl.exe`.
- n8voice writes `logs\status.json` every 5 s (each engine's memory, Kokoro's model state, the WSL VM's used memory from devguard's status file) and the tray poller reads it.
- With Kokoro not answering, the panel shows "WSL off" when devguard's status file is stale and "Not reachable" otherwise.
- Every 60 s n8voice appends `timestamp,engine,rss_mb,model_loaded,event,detail` rows to `logs\memory\memory-YYYY-MM-DD.csv` (the format in `servers/piper/tray/memory-history.js`), kept 30 days.
- **Memory Report** builds `memory-report.html` with VoiceDock's report code (last hour, 24 hours, 7 days) and opens it.

## Panel

```
VoiceDock
  Piper: Running (port 7477) · 44 MB
  Kokoro: Running (port 7478) · 90 MB, model unloaded
  WSL VM 12.0 GB · history every 60 s
  ─────────────────────────────
  Memory Report · Open Memory History Folder · Open Piper Server Folder · Open Settings · Open Log
  ─────────────────────────────
  Start VoiceDock · Restart VoiceDock · Restart Piper Server · Stop VoiceDock
  ─────────────────────────────
  Start Kokoro · Restart Kokoro · Stop Kokoro
```

The right-click menu shows one status line, for example `VoiceDock: Piper running (port 7477) · 44 MB, Kokoro running (port 7478) · 90 MB, model unloaded`.

## Migration from n8piper (done 2026-11-02)

1. N8 Tray rewrites a `piper-tts` module entry in `config\settings.json` to `n8voice` on load, keeping `enabled` and `autoStart`.
2. `n8piper\config\settings.json` `server.*` was copied to `n8voice\config\settings.json` `piper.*`.
3. The `n8piper` folder was removed from the repo; its code is in git history (`git log -- n8piper`).

Rollback: `config\settings.pre-n8voice.bak` and `config\n8piper-settings.pre-n8voice.bak` in the N8 Tray folder hold the old settings, and `git checkout 18cd5af -- n8piper n8tray.ps1` restores the old module and tray.

## Decisions

- Starting VoiceDock never boots WSL unless `kokoro.startWsl` is true.
- The VoiceDock tray in `servers/piper/tray` stays for public users; n8voice coexists with it by adopting its Piper server.
- Module id `n8voice` (matching the other n8 modules), display name "VoiceDock".
