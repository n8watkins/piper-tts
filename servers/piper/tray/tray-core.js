// Pure helpers for the VoiceDock tray: settings, status text, health checks
// and the autostart entry's location. Kept apart from voicedock-tray.js
// (which needs the systray2 helper binary) so they can be unit tested.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const KOKORO_HOST = process.env.KOKORO_HOST || '127.0.0.1';
const KOKORO_PORT = Number(process.env.KOKORO_PORT || 7478);

const DEFAULT_SETTINGS = Object.freeze({
  // Self-install the autostart entry only on the very first run; after that
  // the "Launch at login" toggle is the user's choice.
  autostartChosen: false,
  // Set once Kokoro has answered /health, so a later outage reads as
  // "not reachable" (for example WSL is off) rather than "not installed".
  kokoroSeen: false,
  memoryHistory: { enabled: false, intervalSeconds: 60, keepDays: 30 },
});

/** Per-user folder for tray settings and memory history. */
function appDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'VoiceDock');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'VoiceDock');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'voicedock');
}

function loadSettings(file) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run or unreadable: defaults */ }
  const history = { ...DEFAULT_SETTINGS.memoryHistory, ...(saved.memoryHistory || {}) };
  history.intervalSeconds = Math.max(5, Number(history.intervalSeconds) || 60);
  history.keepDays = Math.max(0, Number(history.keepDays) || 0);
  history.enabled = history.enabled === true;
  return { ...DEFAULT_SETTINGS, ...saved, memoryHistory: history };
}

function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** GET /health as parsed JSON, or null (offline, timeout, not JSON, not 2xx). */
function fetchHealth(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); resolve(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 65536) body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ status: 'ok' }); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const fmtMb = (n) => (n == null || !Number.isFinite(Number(n)) ? null : `${Math.round(Number(n))} MB`);

/** Piper's memory: the server plus any reader, as reported by /health. */
function piperMemoryText(health) {
  if (!health) return null;
  const total = fmtMb(health.totalRssMb ?? health.rssMb);
  if (!total) return null;
  return health.speaking && health.activeVoice ? `${total}, reading` : total;
}

function kokoroMemoryText(health) {
  if (!health) return null;
  const rss = fmtMb(health.rssMb);
  const model = health.modelLoaded === true ? 'model loaded' : health.modelLoaded === false ? 'model unloaded' : null;
  if (rss && model) return `${rss} (${model})`;
  return rss || (model ? `(${model})` : null);
}

/** "Running", "Running (external)" or "Stopped", plus memory when known. */
function piperStatusText(health, managed) {
  if (!health) return 'Piper: Stopped';
  const memory = piperMemoryText(health);
  const state = managed ? 'Running' : 'Running (external)';
  return `Piper: ${state}${memory ? ` · ${memory}` : ''}`;
}

/**
 * Kokoro runs in WSL or Linux and the tray never starts it (that would mean
 * calling wsl.exe, which boots the VM). Status comes only from its /health:
 * running, or "not installed" / "not reachable" depending on whether it has
 * ever answered on this machine.
 */
function kokoroStatusText(health, seen) {
  if (health) {
    const memory = kokoroMemoryText(health);
    return `Kokoro: Running${memory ? ` · ${memory}` : ''}`;
  }
  return seen ? 'Kokoro: Not reachable' : 'Kokoro: Not installed (optional)';
}

/** One-line tooltip, kept under the 127 characters Windows shows. */
function tooltipText(piperHealth, kokoroHealth, kokoroSeen) {
  const piper = piperHealth ? `Piper ${piperMemoryText(piperHealth) || 'running'}` : 'Piper stopped';
  let kokoro;
  if (kokoroHealth) kokoro = `Kokoro ${kokoroMemoryText(kokoroHealth) || 'running'}`;
  else kokoro = kokoroSeen ? 'Kokoro not reachable' : null;
  const text = `VoiceDock | ${piper}${kokoro ? ` · ${kokoro}` : ''}`;
  return text.length > 127 ? `${text.slice(0, 126)}…` : text;
}

/**
 * Whether the Piper server is the one this tray started, so Stop and Restart
 * may act on it. A pid file alone is not proof: after a crash, Windows can
 * hand the same pid to an unrelated process, and killing it would be wrong.
 * It is ours while the child this tray spawned is still running (it may not
 * answer yet while it starts), or when the server that answers /health
 * reports the pid recorded in the pid file (a server a previous tray run
 * started).
 */
function isManagedServer({ filePid = null, health = null, ownChildAlive = false } = {}) {
  if (ownChildAlive) return true;
  if (!filePid || !health) return false;
  return Number(health.pid) === Number(filePid);
}

/** Where the "Launch at login" entry lives, and where the old Piper TTS one lived. */
function autostartPaths(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const dir = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    return { current: path.join(dir, 'VoiceDock Tray.lnk'), legacy: path.join(dir, 'Piper TTS Tray.lnk') };
  }
  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    return { current: path.join(dir, 'com.voicedock.tray.plist'), legacy: path.join(dir, 'com.n8.pipertts.tray.plist') };
  }
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart');
  return { current: path.join(dir, 'voicedock-tray.desktop'), legacy: path.join(dir, 'piper-tts-tray.desktop') };
}

module.exports = {
  KOKORO_HOST, KOKORO_PORT, DEFAULT_SETTINGS, appDataDir, loadSettings, saveSettings, fetchHealth,
  piperMemoryText, kokoroMemoryText, piperStatusText, kokoroStatusText, tooltipText, autostartPaths,
  isManagedServer,
};
