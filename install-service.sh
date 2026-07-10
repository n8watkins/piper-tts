#!/usr/bin/env bash
# Install the Kokoro TTS server as a systemd USER service so it auto-starts at
# login and auto-restarts on ANY exit (crash / OOM / a closed terminal's SIGHUP).
#
# Background: the server used to run as a bare foreground `python server.py` with
# no supervision and no log file, so a single terminal close killed it silently
# and permanently - the app fell back with zero surfacing and it was noticed only
# by ear. This unit removes that failure mode.
#
# Requires a systemd user instance (`systemctl --user`). Idempotent - safe to
# re-run. Does NOT need root (a user unit + optional lingering).
#
# IMPORTANT: `enable --now` starts the server on 127.0.0.1:7478. If an instance
# is ALREADY running on 7478 (e.g. a manual `nohup ./start.sh`), STOP it first,
# or the systemd instance will fail to bind (address in use) and crash-loop.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_SRC="$REPO_DIR/systemd/kokoro-tts.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_DST="$UNIT_DIR/kokoro-tts.service"

if ! systemctl --user >/dev/null 2>&1; then
  echo "[install] No systemd user instance (systemctl --user failed)." >&2
  echo "[install] This host isn't running 'systemd --user'. Fallback: launch" >&2
  echo "[install]   setsid nohup ./start.sh >/tmp/kokoro-tts.log 2>&1 &" >&2
  echo "[install] plus a cron @reboot line - see README 'Supervision'." >&2
  exit 1
fi

if [ ! -d "$REPO_DIR/.venv" ]; then
  echo "[install] No .venv - run ./setup.sh first." >&2
  exit 1
fi

# Warn (don't clobber) if something is already serving on 7478.
PORT="${KOKORO_PORT:-7478}"
if command -v curl >/dev/null 2>&1 \
  && curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "[install] WARNING: something is already serving 127.0.0.1:${PORT}." >&2
  echo "[install] Stop that instance before the systemd service starts, or it" >&2
  echo "[install] will fail to bind. Re-run this script once ${PORT} is free." >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
sed "s#@KOKORO_DIR@#${REPO_DIR}#g" "$UNIT_SRC" > "$UNIT_DST"
echo "[install] Wrote ${UNIT_DST} (repo: ${REPO_DIR})"

systemctl --user daemon-reload
systemctl --user enable --now kokoro-tts.service
echo "[install] Enabled + started. Status:"
systemctl --user --no-pager status kokoro-tts.service | head -n 6 || true

# Keep the service running after logout (on WSL, across shell sessions).
if command -v loginctl >/dev/null 2>&1; then
  if loginctl enable-linger "$USER" >/dev/null 2>&1; then
    echo "[install] Lingering enabled (service survives logout)."
  else
    echo "[install] Note: couldn't enable lingering (needs polkit/root); the" \
         "service still runs while you're logged in."
  fi
fi

cat <<EOF

[install] Done. Useful commands:
  logs:    journalctl --user -u kokoro-tts.service -f
  restart: systemctl --user restart kokoro-tts.service
  stop:    systemctl --user stop kokoro-tts.service
  remove:  systemctl --user disable --now kokoro-tts.service
EOF
