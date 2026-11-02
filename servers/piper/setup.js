// One-step, cross-platform setup for the local Piper server + tray.
//
//   node setup.js          (or: npm run setup)
//
// Adapts to the OS at runtime — there's no per-OS installer. It:
//   1. installs the server's Node dependencies,
//   2. downloads the Piper binary for this OS/arch (if missing),
//   3. downloads a default voice (if missing),
//   4. launches the tray, which auto-starts the server and self-installs login
//      autostart.
//
// It is idempotent: anything already in place is skipped, so it's safe to re-run
// after pulling changes. The only maintenance surface is the small config block
// below (download asset names + default voices).
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync, spawn } = require('child_process');

const SERVER_DIR = __dirname; // setup.js lives in servers/piper/
const PIPER_DIR = path.join(SERVER_DIR, 'piper');
const VOICES_DIR = path.join(PIPER_DIR, 'voices');
const TRAY = path.join(SERVER_DIR, 'tray', 'piper-tray.js');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const arm = process.arch === 'arm64';

// ── Config — the only thing that needs updating if upstream URLs change ────────
const PIPER_ASSET =
  isWin ? 'piper_windows_amd64.zip' :
  isMac ? (arm ? 'piper_macos_aarch64.tar.gz' : 'piper_macos_x64.tar.gz') :
  (arm ? 'piper_linux_aarch64.tar.gz' : 'piper_linux_x86_64.tar.gz');
// /releases/latest/download/ always resolves to the newest release's asset.
const PIPER_URL = `https://github.com/rhasspy/piper/releases/latest/download/${PIPER_ASSET}`;
const PIPER_BIN = path.join(PIPER_DIR, isWin ? 'piper.exe' : 'piper');

const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const DEFAULT_VOICES = [
  { name: 'en_US-amy-medium', dir: 'en/en_US/amy/medium' }, // ~64 MB; add more from the extension
];

const log = (m) => console.log(m);
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd, opts = {}) => execFileSync(cmd, args, { cwd, stdio: 'inherit', ...opts });

// Download a URL to a file, following redirects (GitHub + HuggingFace both 302).
function download(url, dest, redirects = 6) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    // A write failure (disk full, read-only dest) emits 'error' on the stream,
    // not on the request — without this listener it would be an unhandled event
    // that crashes the whole setup instead of rejecting cleanly.
    file.on('error', (err) => {
      try { file.close(); } catch { /* ignore */ }
      fs.rmSync(dest, { force: true });
      reject(err);
    });
    https.get(url, { headers: { 'User-Agent': 'piper-tts-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.rmSync(dest, { force: true });
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.rmSync(dest, { force: true });
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (err) => { fs.rmSync(dest, { force: true }); reject(err); });
  });
}

async function installPiper() {
  if (fs.existsSync(PIPER_BIN)) { log('• Piper binary already present — skipping.'); return; }
  const archive = path.join(os.tmpdir(), PIPER_ASSET);
  log(`• Downloading Piper (${PIPER_ASSET})…`);
  await download(PIPER_URL, archive);
  log('• Extracting Piper…');
  const tmp = path.join(os.tmpdir(), 'piper-extract');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  if (isWin) run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${archive}' -DestinationPath '${tmp}'`]);
  else run('tar', ['-xzf', archive, '-C', tmp]);
  // The archives contain a top-level "piper/" folder; merge its contents in.
  const inner = fs.existsSync(path.join(tmp, 'piper')) ? path.join(tmp, 'piper') : tmp;
  fs.cpSync(inner, PIPER_DIR, { recursive: true });
  if (!isWin) { try { fs.chmodSync(PIPER_BIN, 0o755); } catch { /* ignore */ } }
  fs.rmSync(archive, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  log('• Piper installed.');
}

async function installVoice(v) {
  const onnx = path.join(VOICES_DIR, `${v.name}.onnx`);
  const json = path.join(VOICES_DIR, `${v.name}.onnx.json`);
  if (fs.existsSync(onnx) && fs.existsSync(json)) { log(`• Voice ${v.name} already present — skipping.`); return; }
  log(`• Downloading voice ${v.name}…`);
  await download(`${HF_BASE}/${v.dir}/${v.name}.onnx`, onnx);
  await download(`${HF_BASE}/${v.dir}/${v.name}.onnx.json`, json);
  log(`• Voice ${v.name} installed.`);
}

async function main() {
  log(`Piper TTS setup (${process.platform}/${process.arch})\n`);
  fs.mkdirSync(VOICES_DIR, { recursive: true });

  log('• Installing server dependencies…');
  // shell:true is required on Windows to run npm.cmd (Node rejects spawning .cmd otherwise).
  run(npmCmd, ['install', '--no-audit', '--no-fund'], SERVER_DIR, { shell: isWin });

  await installPiper();
  for (const v of DEFAULT_VOICES) await installVoice(v);

  log('• Launching the tray…');
  spawn(process.execPath, [TRAY], { cwd: SERVER_DIR, detached: true, stdio: 'ignore', windowsHide: true }).unref();

  log('\n✓ Setup complete.');
  log('  The Piper tray is running (look for the icon — green dot = server up).');
  log('  It auto-starts the server, set up launch-at-login, and shows status.');
  log('  Add or remove voices anytime from the Chrome extension’s Settings → Voices.');
}

main().catch((err) => {
  console.error('\n✗ Setup failed:', (err && err.message) || err);
  process.exit(1);
});
