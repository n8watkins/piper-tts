# VoiceDock final review (November 2026)

Date: 2026-11-02
Scope: PRs #12 to #21 as merged on `master` at `4cde95e`: Kokoro lazy load and idle unload, the `/health` memory fields, memory history and the HTML report, the VoiceDock product tray in `servers/piper/tray`, and the Kokoro-optional docs.
Method: read-only review of the changed code, plus `node --test` and the Kokoro unit tests in a separate worktree.
Line numbers refer to `4cde95e`.

## Verdict

The memory work is solid.
Kokoro's lazy load and idle unload are race-free as written, `/health` never waits on a load, the Piper reader tracker samples off the request path, the report escapes everything it interpolates, and both servers still bind to `127.0.0.1` by default and reject browser origins other than `chrome-extension://` on every route.
The VoiceDock tray has no owner-specific paths: settings and history live under the user's app data folder, the autostart entry is per user, and it never calls `wsl.exe`.

Two real bugs were found and fixed in PR #22; the rest are low-severity hardening notes.

## Findings fixed in PR #22

1. **Medium: Stop Piper could kill an unrelated process** (`servers/piper/tray/voicedock-tray.js:103`, `:319`, `:335`).
   `managedPid()` trusted `logs/piper-tts-server.pid` plus "a process with that pid is alive".
   After the server crashes, Windows can give that pid to another process: the tray then enabled Stop and Restart, `process.kill` would terminate that process, and crash supervision (`!managed`) never restarted Piper.
   Fix: the server counts as the tray's own only while the child it spawned runs, or when the server answering `/health` reports the recorded pid; the pid file is cleared when the child exits.
   The rule is a tested pure helper, `isManagedServer` in `tray-core.js`.
2. **Low: the n8voice Node copy was not git-ignored** (`.gitignore:13`).
   N8 Tray's n8voice module copies `node.exe` to `servers/piper/voicedock-piper.exe` (about 80 MB, present in the deployed copy on the owner's PC); only the retired n8piper name was ignored, so `git add -A` there would commit it.

## Findings not fixed

1. **Low: a non-loopback host is accepted silently** (`servers/kokoro/server.py:55`, `servers/piper/config.js:8`).
   `KOKORO_HOST` and `HOST` are taken as given, and N8 Tray's n8voice passes its `piper.host` setting straight into `HOST`.
   Requests without an `Origin` header are allowed by design, so a host of `0.0.0.0` would let anyone on the LAN use `/tts`.
   Suggestion: refuse non-loopback hosts unless an explicit opt-in variable is set, and log the bind address at start.
2. **Low: concurrent `/tts` requests share one Kokoro instance without a lock** (`servers/kokoro/server.py:314-325`, `:533`).
   `ThreadingHTTPServer` runs requests in parallel and `kokoro.create` is called concurrently on one instance; the espeak phonemizer it uses is not documented as thread-safe.
   This predates #12 (the eager model had the same shape), and one user rarely overlaps reads, but a synthesis lock inside `KokoroEngine.synthesize` (kept apart from `_lock`, so `/health` stays responsive) would remove the risk at no real cost.
3. **Low: no `Host` header check** (both servers).
   A DNS-rebinding page could read `GET /health` and `/voices` (pid, memory, voice names), because same-origin GETs carry no `Origin`; `POST /tts` stays blocked by the origin check.
   Allowing only `127.0.0.1`, `localhost` and `[::1]` hosts would close it.
4. **Low: a corrupt tray settings file re-runs the first-run steps** (`servers/piper/tray/tray-core.js:29`, `servers/piper/tray/voicedock-tray.js:391`).
   An unreadable `tray-settings.json` loads as defaults, so `autostartChosen` is false: the tray reinstalls launch at login the user may have turned off, and the next save overwrites the file.
   Suggestion: tell "missing" from "unreadable", and keep an unreadable file untouched.
5. **Info: launch at login installs itself on the first run without asking** (`servers/piper/tray/voicedock-tray.js:391-394`).
   Deliberate and documented, and the toggle is respected afterwards; for a generic user a first-run notice or an opt-in would be friendlier.
   On a PC that runs N8 Tray, the N8 Tray module should stay the only VoiceDock UI.
6. **Info: memory figures mix measures.**
   Node's RSS for the Piper server, working set (`tasklist`) for its readers on Windows, `VmRSS` for Kokoro.
   Consistent within each engine and fine for the history and report; worth one sentence in `docs/API.md`.

## What was checked and holds

- **Load during unload:** `unload_if_idle` releases only with no synthesis in flight and under `_lock`; `synthesize` re-checks after `_ensure_loaded` and loads again if the model was released in between; `_load_lock` serializes loads, so two first requests load once; a fresh load resets the idle clock before the reaper can see it.
- **Health during a load:** `status()` takes only `_lock`, never `_load_lock`, and reports `modelLoading` (#19).
- **Memory accuracy:** after release Kokoro runs `gc.collect()` and `malloc_trim(0)` and drops the model files from the page cache, so `rssMb` and systemd's `MemoryCurrent` fall back; Piper's `totalRssMb` adds the live readers, and `lastReaderPeakRssMb` keeps short reads visible.
- **Security:** both servers bind `127.0.0.1` by default; the origin check runs on GET, POST and OPTIONS for Kokoro and as app-wide middleware for Piper; the report escapes text and escapes `<` in its embedded JSON.
- **Tray for a generic user:** no hard-coded user, drive or distro paths; Kokoro status is `/health` only; history is off by default; the legacy "Piper TTS Tray" entry is migrated, not duplicated.
- **Tests:** `node --test` passes (the Piper server suite needs `servers/piper/node_modules`), and the 34 Kokoro unit tests pass.
