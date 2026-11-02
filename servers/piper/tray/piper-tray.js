// Cross-platform Piper TTS tray (Windows / macOS / Linux).
//
// One Node codebase replacing the per-OS tray scripts. It shows server status
// as a green/red dot (swapping pre-rendered icon files — no runtime drawing, so
// it ports cleanly), and offers Start/Stop/Open-Voices/Quit. The local server is
// already Node, so the tray reuses the same runtime.
//
//   node tray/piper-tray.js
//
// Robustness: async (non-blocking) health checks, a single-instance lockfile
// with stale-lock recovery, graceful shutdown, and modest crash supervision.
const SysTray = require('systray2').default;
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

const TRAY_DIR = __dirname;
const SERVER_DIR = path.dirname(TRAY_DIR); // .../servers/piper
const ASSETS = path.join(TRAY_DIR, 'assets');
const LOG_DIR = path.join(SERVER_DIR, 'logs');
const PID_FILE = path.join(LOG_DIR, 'piper-tts-server.pid');
const LOCK_FILE = path.join(LOG_DIR, 'piper-tray.lock');
const { HOST, PORT } = require('../config'); // shared with server.js so they agree
const isWin = process.platform === 'win32';
const ICON_EXT = isWin ? 'ico' : 'png'; // Windows tray needs .ico; mac/linux use .png
const MAX_RESTARTS = 3;

fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Single instance (portable lockfile + stale-lock recovery) ───────────────
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
(function acquireLock(attempt = 0) {
  try {
    // 'wx' = create exclusively; fails atomically if the file exists, so two
    // instances starting at once can't both win the lock (fixes the race where
    // both passed an existsSync check before either wrote).
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      let owner = 0;
      try { owner = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10); } catch { /* ignore */ }
      if (owner && owner !== process.pid && isAlive(owner)) {
        console.error(`Piper tray already running (pid ${owner}); exiting.`);
        process.exit(0);
      }
      // Stale lock (owner gone) — clear it once and retry.
      if (attempt < 1) { fs.rmSync(LOCK_FILE, { force: true }); acquireLock(attempt + 1); return; }
    }
    // Any other error: proceed without a lock rather than failing to launch.
  }
})();
const releaseLock = () => {
  try {
    if (fs.existsSync(LOCK_FILE) &&
        parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch { /* ignore */ }
};

// ─── Icons (pre-rendered; just swap which file is shown) ──────────────────────
const iconB64 = (name) => fs.readFileSync(path.join(ASSETS, `${name}.${ICON_EXT}`)).toString('base64');
const ICON_ONLINE = iconB64('online');
const ICON_OFFLINE = iconB64('offline');

// ─── Health (async, never blocks the tray) ───────────────────────────────────
const checkHealth = () => new Promise((resolve) => {
  const req = http.get({ host: HOST, port: PORT, path: '/health', timeout: 1500 }, (res) => {
    res.resume();
    resolve(res.statusCode >= 200 && res.statusCode < 300);
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

// ─── Server lifecycle ────────────────────────────────────────────────────────
const managedPid = () => {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return pid && isAlive(pid) ? pid : null;
  } catch { return null; }
};
function startServer() {
  const out = fs.openSync(path.join(LOG_DIR, 'piper-tts-server.log'), 'a');
  const child = spawn(process.execPath, ['server.js'], {
    // windowsHide hides the console window a detached child would otherwise pop
    // up on Windows — that was the CMD flash, not the (already-hidden) tray.
    cwd: SERVER_DIR, detached: true, windowsHide: true, stdio: ['ignore', out, out],
  });
  try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch { /* ignore */ }
  child.unref();
  try { fs.closeSync(out); } catch { /* ignore */ } // child keeps its own dup; don't leak our fd
}
function stopServer() {
  const pid = managedPid();
  if (pid) { try { process.kill(pid); } catch { /* ignore */ } }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}
// Is something already listening on the port? (Used so a restart waits for the
// old process to release it — otherwise the new server hits EADDRINUSE.)
const portInUse = () => new Promise((resolve) => {
  const s = net.connect({ host: HOST, port: PORT });
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.setTimeout(600, () => { s.destroy(); resolve(false); });
});
// Start the server, but first wait (briefly) for the port to be free, and never
// overlap two start attempts. This makes restart-after-crash and the Restart
// menu item reliable instead of racing the dying process.
let starting = false;
async function startServerSafely() {
  if (starting) return;
  starting = true;
  try {
    const deadline = Date.now() + 12000;
    while ((await portInUse()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 600));
    }
    startServer();
  } finally {
    setTimeout(() => { starting = false; }, 1500); // let it bind before another attempt
  }
}
function openVoices() {
  const dir = path.join(SERVER_DIR, 'piper', 'voices');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const opener = isWin ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  try { spawn(opener, [dir], { detached: true, windowsHide: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}

// ─── Launch at login (self-installing, per-OS) ───────────────────────────────
// The path of the autostart entry for the current OS.
function autostartFile() {
  if (isWin) {
    return path.join(process.env.APPDATA || os.homedir(),
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Piper TTS Tray.lnk');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.n8.pipertts.tray.plist');
  }
  return path.join(os.homedir(), '.config', 'autostart', 'piper-tts-tray.desktop');
}
const isAutostartInstalled = () => { try { return fs.existsSync(autostartFile()); } catch { return false; } };

function installAutostart() {
  const file = autostartFile();
  const script = path.join(TRAY_DIR, 'piper-tray.js');
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
  if (isWin) {
    // Startup shortcut runs the .vbs via wscript (a windowless host) so node
    // starts hidden — no CMD flash at login, unlike a .bat launcher.
    const vbs = path.join(SERVER_DIR, 'scripts', 'start-piper-tray.vbs');
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${file}');` +
      `$s.TargetPath='C:\\Windows\\System32\\wscript.exe';$s.Arguments='"${vbs}"';` +
      `$s.WorkingDirectory='${path.dirname(vbs)}';$s.WindowStyle=7;` +
      `$s.Description='Start Piper TTS tray at sign-in';$s.Save()`;
    spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  } else if (process.platform === 'darwin') {
    fs.writeFileSync(file,
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.n8.pipertts.tray</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${script}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`);
    try { spawn('launchctl', ['load', file], { stdio: 'ignore' }); } catch { /* ignore */ }
  } else {
    fs.writeFileSync(file,
`[Desktop Entry]
Type=Application
Name=Piper TTS Tray
Exec=${process.execPath} ${script}
X-GNOME-Autostart-enabled=true
Terminal=false
`);
  }
}

function removeAutostart() {
  const file = autostartFile();
  if (process.platform === 'darwin') { try { spawn('launchctl', ['unload', file], { stdio: 'ignore' }); } catch { /* ignore */ } }
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

// ─── Menu ────────────────────────────────────────────────────────────────────
const sep = () => Object.assign({}, SysTray.separator);
const statusItem = { title: 'Status: checking…', tooltip: '', enabled: false };
const startItem = { title: 'Start Server', tooltip: 'Start the local Piper server', enabled: true };
const stopItem = { title: 'Stop Server', tooltip: 'Stop the managed server', enabled: false };
const restartItem = { title: 'Restart Server', tooltip: 'Stop and start the managed server', enabled: false };
const voicesItem = { title: 'Open Voices Folder', tooltip: '', enabled: true };
const loginItem = { title: 'Launch at login', tooltip: 'Start the tray automatically at sign-in', checked: isAutostartInstalled(), enabled: true };
const quitItem = { title: 'Quit', tooltip: '', enabled: true };
const menu = {
  icon: ICON_OFFLINE,
  title: 'Piper TTS',
  tooltip: 'Piper TTS',
  items: [statusItem, sep(), startItem, stopItem, restartItem, sep(), voicesItem, loginItem, sep(), quitItem],
};
const systray = new SysTray({ menu, debug: false, copyDir: true });

let intendedRunning = false; // user/auto wants it up — gates crash supervision
let restarts = 0;
let lastKey = '';

async function refresh() {
  const online = await checkHealth();
  const managed = managedPid() !== null;

  // Crash supervision: if we wanted it up and it died (not just starting), restart.
  if (intendedRunning && !online && !managed && !starting) {
    if (restarts < MAX_RESTARTS) { restarts += 1; startServerSafely(); }
  }
  if (online) restarts = 0;

  const key = `${online}|${managed}`;
  if (key === lastKey) return; // only push to the tray on actual state changes
  lastKey = key;

  statusItem.title = online
    ? (managed ? 'Status: Running' : 'Status: Running (external)')
    : 'Status: Stopped';
  startItem.enabled = !online;
  stopItem.enabled = managed;
  restartItem.enabled = managed;

  // update-menu only refreshes the icon/tooltip — the rendered menu items must be
  // updated individually with update-item (same path the working login toggle uses).
  for (const item of [statusItem, startItem, stopItem, restartItem]) {
    systray.sendAction({ type: 'update-item', item }).catch(() => {});
  }
  menu.icon = online ? ICON_ONLINE : ICON_OFFLINE;
  menu.tooltip = statusItem.title;
  systray.sendAction({ type: 'update-menu', menu }).catch(() => {});
}

systray.onClick((action) => {
  switch (action.item && action.item.title) {
    case 'Start Server': intendedRunning = true; restarts = 0; startServerSafely(); setTimeout(refresh, 1200); break;
    case 'Stop Server': intendedRunning = false; stopServer(); setTimeout(refresh, 800); break;
    case 'Restart Server':
      intendedRunning = true; restarts = 0;
      stopServer();
      startServerSafely(); // waits for the port to free before starting
      setTimeout(refresh, 1500);
      break;
    case 'Open Voices Folder': openVoices(); break;
    case 'Launch at login':
      if (isAutostartInstalled()) { removeAutostart(); loginItem.checked = false; }
      else { installAutostart(); loginItem.checked = true; }
      systray.sendAction({ type: 'update-item', item: loginItem }).catch(() => {});
      break;
    case 'Quit': shutdown(); break;
    default: break;
  }
});

function shutdown() {
  releaseLock();
  try { systray.kill(true); } catch { process.exit(0); }
}
process.on('exit', releaseLock);
process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });

systray.ready().then(async () => {
  // Self-install autostart on first run; reflect the result in the menu.
  if (!isAutostartInstalled()) {
    installAutostart();
    loginItem.checked = true;
    systray.sendAction({ type: 'update-item', item: loginItem }).catch(() => {});
  }
  if (!(await checkHealth())) { intendedRunning = true; startServerSafely(); } // auto-start if offline
  else { intendedRunning = managedPid() !== null; }
  await refresh();
  setInterval(refresh, 2000);
}).catch((err) => {
  console.error('Piper tray failed to start:', (err && err.message) || err);
  releaseLock();
  process.exit(1);
});
