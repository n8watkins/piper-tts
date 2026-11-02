// Deploy the built extension from this WSL repo to the Windows project folder
// that Chrome loads unpacked. Only extension/ is synced - it's the only thing
// that changes and the only thing Chrome reads. The servers/piper folder on
// Windows (with its downloaded piper.exe + .onnx voices, which are gitignored
// and live only there) is intentionally left untouched.
//
//   node tools/deploy-windows.mjs
//
// Override the destination with VOICEDOCK_WINDOWS_DIR (or the older
// PIPER_TTS_WINDOWS_DIR), or the user with PIPER_TTS_WINDOWS_USER. After it runs, reload the extension at
// chrome://extensions to pick up the changes.
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windowsUser = process.env.PIPER_TTS_WINDOWS_USER || 'natha';
const toolsDir = `/mnt/c/Users/${windowsUser}/Projects/Tools`;

// Destination: explicit override wins; otherwise the piper-tts folder Chrome
// already loads, then a voicedock clone, then the original local-tts-reader.
// piper-tts comes first on purpose: an unpacked extension's ID (and with it
// every saved profile) is derived from its folder path, so moving Chrome to a
// new folder would start from empty settings. See UPDATE_WINDOWS_SERVER.md.
const dest = process.env.VOICEDOCK_WINDOWS_DIR || process.env.PIPER_TTS_WINDOWS_DIR ||
  ['piper-tts', 'voicedock', 'local-tts-reader'].map((name) => join(toolsDir, name)).find(existsSync);

if (!dest || !existsSync(dest)) {
  console.error('Windows project folder not found. Set VOICEDOCK_WINDOWS_DIR to its path.');
  process.exit(1);
}
if (!existsSync(join(dest, 'extension'))) {
  console.error(`No extension/ folder under ${dest}.`);
  process.exit(1);
}

// rsync needs trailing slashes to copy directory *contents* (and --delete to
// drop files removed from the repo). extension/ holds no gitignored binaries,
// so a full mirror is safe.
const srcExt = join(repoRoot, 'extension') + '/';
const destExt = join(dest, 'extension') + '/';

console.log('Building bundles…');
execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });

console.log(`Syncing extension/ → ${destExt}`);
execFileSync('rsync', ['-a', '--delete', srcExt, destExt], { stdio: 'inherit' });

const version = JSON.parse(
  execFileSync('cat', [join(repoRoot, 'extension', 'manifest.json')]).toString()
).version;

console.log(`\n✓ Extension v${version} synced to ${dest}.`);
console.log('  Reload it at chrome://extensions to pick up the changes.');
