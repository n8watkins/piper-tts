import { execFileSync, spawn } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import http from 'http';
import { dirname, join, normalize, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const extensionRoot = join(repoRoot, 'extension');
const screenshotDir = join(repoRoot, 'screenshots');
const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'));

const windowsUser = process.env.PIPER_TTS_WINDOWS_USER || 'natha';
const windowsTempRoot = `/mnt/c/Users/${windowsUser}/AppData/Local/Temp`;
const windowsTemp = `C:/Users/${windowsUser}/AppData/Local/Temp`;
const windowsPuppeteerDir = `${windowsTemp}/piper-tts-puppeteer-core`;
const wslPuppeteerDir = `${windowsTempRoot}/piper-tts-puppeteer-core`;
const windowsOutputDir = `${windowsTemp}/piper-tts-screenshot-output`;
const wslOutputDir = `${windowsTempRoot}/piper-tts-screenshot-output`;
const windowsController = `${windowsTemp}/piper-tts-capture-screenshots.cjs`;
const wslController = `${windowsTempRoot}/piper-tts-capture-screenshots.cjs`;
const chromeProfile = `${windowsTemp}/piper-tts-screenshot-chrome-${process.pid}`;
const chromeDebugPort = Number(process.env.PIPER_TTS_CHROME_DEBUG_PORT || (9350 + (process.pid % 500)));
const screenshotServerPort = Number(process.env.PIPER_TTS_SCREENSHOT_SERVER_PORT || 9488);
const chromePath = process.env.PIPER_TTS_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const windowsNode = process.env.PIPER_TTS_WINDOWS_NODE || '/mnt/c/Program Files/nodejs/node.exe';

const sampleProfiles = [
  { id: 'article', name: 'Articles', engine: 'piper', voice: 'en_US-ryan-high.onnx', rate: 1.2, volume: 1.1 },
  { id: 'long', name: 'Long Reads', engine: 'kokoro', voice: 'af_heart', rate: 1.0, volume: 1.0 },
  { id: 'study', name: 'Study Notes', engine: 'kokoro', voice: 'bf_emma', rate: 0.9, volume: 1.0 },
  { id: 'fast', name: 'Fast Review', engine: 'piper', voice: 'en_GB-alan-medium.onnx', rate: 1.6, volume: 1.2 },
];

const sampleKokoroVoices = [
  'af_bella', 'af_heart', 'af_nicole', 'am_adam', 'am_michael',
  'bf_emma', 'bm_george', 'ef_dora', 'ff_siwis', 'jf_alpha',
];

const sampleVoices = [
  'en_US-ryan-high.onnx',
  'en_US-amy-medium.onnx',
  'en_US-lessac-medium.onnx',
  'en_GB-alan-medium.onnx',
];

const chromeShim = `
<script>
(() => {
  const profiles = ${JSON.stringify(sampleProfiles)};
  const voices = ${JSON.stringify(sampleVoices)};
  const kokoroVoices = ${JSON.stringify(sampleKokoroVoices)};
  const voiceSizes = {
    'en_US-ryan-high.onnx': 146000000,
    'en_US-amy-medium.onnx': 64000000,
    'en_US-lessac-medium.onnx': 68000000,
    'en_GB-alan-medium.onnx': 52000000,
  };
  const storage = {
    profiles,
    activeId: 'article',
    favoritesByEngine: { piper: ['en_US-ryan-high.onnx', 'en_US-amy-medium.onnx'], kokoro: ['af_heart'] },
    settingsVersion: 2,
    deletedVoices: [
      { filename: 'en_US-old-low.onnx', displayName: 'Old · Low', deletedAt: '6/3/2026' },
    ],
    favsOnly: false,
    fallback: true,
    shortcuts: { read: 'Alt+Shift+R', pause: 'Alt+Shift+D', stop: 'Alt+Shift+E' },
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url && url.startsWith('http://127.0.0.1:7478')) {
      const path = new URL(url).pathname;
      const json = (body) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      if (path === '/health') return json({ status: 'ok', engine: 'kokoro', version: '1.0.0', voices: kokoroVoices.length });
      if (path === '/voices') return json({ engine: 'kokoro', voices: kokoroVoices, defaultVoice: 'af_heart' });
      if (path === '/tts') return new Response(new Blob([], { type: 'audio/wav' }), { status: 200 });
    }
    if (url && url.startsWith('http://127.0.0.1:7477')) {
      const path = new URL(url).pathname;
      if (path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', engine: 'piper', version: '1.0.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/voices') {
        return new Response(JSON.stringify({
          engine: 'piper',
          voices,
          defaultVoice: 'en_US-ryan-high.onnx',
          sizes: voiceSizes,
          voiceDir: 'C:\\\\Users\\\\${windowsUser}\\\\Projects\\\\Tools\\\\piper-tts\\\\servers\\\\piper\\\\piper\\\\voices',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/voices/open-folder') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path.startsWith('/voices/') && init.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/tts') {
        return new Response(new Blob([], { type: 'audio/wav' }), { status: 200 });
      }
    }
    return originalFetch(input, init);
  };

  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const onChanged = { addListener() {}, removeListener() {} };

  function resolveGet(keys) {
    if (keys == null) return clone(storage);
    if (typeof keys === 'string') return { [keys]: clone(storage[keys]) };
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, clone(storage[key])]));
    }
    const result = { ...keys };
    for (const key of Object.keys(keys)) {
      if (storage[key] !== undefined) result[key] = clone(storage[key]);
    }
    return result;
  }

  window.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '${manifest.version}', name: 'LocalVoice' }),
      openOptionsPage: () => {},
      sendMessage(message, callback) {
        const response = message?.type === 'get-playback-state'
          ? { isPlaying: false, isPaused: false, volume: 1.1, progress: null }
          : { ok: true, engine: message?.settings?.engine || 'piper', fellBack: false };
        if (callback) setTimeout(() => callback(response), 10);
        return Promise.resolve(response);
      },
    },
    storage: {
      onChanged,
      local: {
        get(keys, callback) {
          const result = resolveGet(keys);
          if (callback) {
            setTimeout(() => callback(result), 0);
            return undefined;
          }
          return Promise.resolve(result);
        },
        set(values, callback) {
          Object.assign(storage, values);
          if (callback) {
            setTimeout(callback, 0);
            return undefined;
          }
          return Promise.resolve();
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          if (callback) {
            setTimeout(callback, 0);
            return undefined;
          }
          return Promise.resolve();
        },
      },
    },
  };
})();
</script>`;

const screenshotNames = [
  'options-profiles.png',
  'options-voices.png',
  'options-settings.png',
  'options-about.png',
  'options-credits.png',
  'popup.png',
];

function ensureDirs() {
  mkdirSync(screenshotDir, { recursive: true });
  mkdirSync(wslOutputDir, { recursive: true });
}

function ensureWindowsPuppeteer() {
  const installed = existsSync(join(wslPuppeteerDir, 'node_modules', 'puppeteer-core'));
  if (installed) return;

  console.log('Installing puppeteer-core into Windows temp...');
  execFileSync(
    'cmd.exe',
    ['/c', 'npm', 'install', '--prefix', windowsPuppeteerDir, 'puppeteer-core'],
    { stdio: 'inherit' },
  );
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function createServer() {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.replace(/^\//, '') || 'options.html');
    const filePath = normalize(join(extensionRoot, urlPath));

    if (!filePath.startsWith(extensionRoot) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    let body = readFileSync(filePath);
    if (filePath.endsWith('.html')) {
      const html = body.toString('utf8')
        .replace('<script src="dist/options.js"></script>', `${chromeShim}\n<script src="dist/options.js"></script>`)
        .replace('<script src="dist/popup.js"></script>', `${chromeShim}\n<script src="dist/popup.js"></script>`);
      body = Buffer.from(
        html,
        'utf8',
      );
    }

    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(body);
  });
}

function startChrome() {
  const ps = `
$chrome = "${chromePath}";
$profile = "${chromeProfile}";
$args = @(
  "--remote-debugging-port=${chromeDebugPort}",
  "--user-data-dir=$profile",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1240,900"
);
Start-Process -FilePath $chrome -ArgumentList $args;
`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
}

function waitForChrome() {
  const probe = `try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:${chromeDebugPort}/json/version | Out-Null; exit 0 } catch { exit 1 }`;
  const started = Date.now();

  while (Date.now() - started < 20_000) {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', probe], { stdio: 'ignore' });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }

  throw new Error(`Chrome did not open remote debugging port ${chromeDebugPort}`);
}

function stopChrome() {
  const profilePattern = chromeProfile.replaceAll('\\', '\\\\');
  const ps = `
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "chrome.exe" -and $_.CommandLine -like "*${profilePattern}*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  } catch {
    // Do not fail screenshots on cleanup.
  }
}

function writeWindowsController(baseUrl) {
  const controller = `
const puppeteer = require('${windowsPuppeteerDir}/node_modules/puppeteer-core');
const outputDir = '${windowsOutputDir}';
const baseUrl = '${baseUrl}';
const browserUrl = 'http://127.0.0.1:${chromeDebugPort}';

const optionTabs = [
  { id: 'profiles', label: 'Profiles', waitFor: 'Articles' },
  { id: 'voices', label: 'Voices', waitFor: 'Ryan' },
  { id: 'settings', label: 'Settings', waitFor: 'Keyboard Shortcuts' },
  { id: 'about', label: 'About', waitFor: 'How It Works' },
  { id: 'credits', label: 'Credits', waitFor: 'Open Source' },
];

async function clickTab(page, label) {
  await page.evaluate((tabLabel) => {
    const tab = Array.from(document.querySelectorAll('.tab'))
      .find((button) => button.textContent && button.textContent.trim() === tabLabel);
    if (!tab) throw new Error('Missing options tab: ' + tabLabel);
    tab.click();
  }, label);
}

async function openUiPage(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8_000 });
  } catch (error) {
    if (!String(error.message || error).includes('Navigation timeout')) throw error;
  }
}

async function screenshotMeasured(page, path, selector, width, minHeight, padding) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const clip = await page.evaluate((measureSelector, measureWidth, measureMinHeight, measurePadding) => {
        const el = document.querySelector(measureSelector) || document.body;
        const rect = el.getBoundingClientRect();
        return {
          x: 0,
          y: 0,
          width: measureWidth,
          height: Math.max(Math.ceil(rect.bottom + measurePadding), measureMinHeight),
        };
      }, selector, width, minHeight, padding);
      await page.screenshot({ path, clip });
      return;
    } catch (error) {
      if (attempt === 2 || !String(error.message || error).includes('detached Frame')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function screenshotOptions(page, name) {
  await screenshotMeasured(page, outputDir + '/' + name, '.page', 620, 360, 24);
}

(async () => {
  const browser = await puppeteer.connect({ browserURL: browserUrl });

  try {
    for (const tab of optionTabs) {
      const page = await browser.newPage();
      await page.setViewport({ width: 620, height: 900, deviceScaleFactor: 2 });
      await openUiPage(page, baseUrl + '/options.html');
      await page.waitForFunction(() => document.body.textContent.includes('Piper TTS'), { timeout: 5_000 });
      await clickTab(page, tab.label);
      await page.waitForFunction((text) => document.body.textContent.includes(text), { timeout: 5_000 }, tab.waitFor);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await screenshotOptions(page, 'options-' + tab.id + '.png');
      await page.close();
    }

    const popup = await browser.newPage();
    await popup.setViewport({ width: 300, height: 520, deviceScaleFactor: 2 });
    await openUiPage(popup, baseUrl + '/popup.html');
    await popup.waitForFunction(() => document.body.textContent.includes('Piper TTS'), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await screenshotMeasured(popup, outputDir + '/popup.png', 'body', 300, 240, 0);
    await popup.close();
  } finally {
    await browser.disconnect();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

  writeFileSync(wslController, controller);
}

function runWindowsController() {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(windowsNode, [windowsController], { stdio: 'inherit' });
    child.on('error', rejectRun);
    child.on('exit', (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`Windows screenshot controller exited with code ${code}`));
    });
  });
}

function copyScreenshots() {
  for (const name of screenshotNames) {
    const from = join(wslOutputDir, name);
    const to = join(screenshotDir, name);
    copyFileSync(from, to);
    chmodSync(to, 0o644);
  }
}

async function main() {
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  ensureDirs();
  ensureWindowsPuppeteer();

  const server = createServer();
  await new Promise((resolveServer) => server.listen(screenshotServerPort, '0.0.0.0', resolveServer));
  const baseUrl = `http://127.0.0.1:${screenshotServerPort}`;

  console.log(`Serving extension render harness at ${baseUrl}`);
  console.log(`Starting Chrome remote debugging on port ${chromeDebugPort}`);

  try {
    startChrome();
    waitForChrome();
    writeWindowsController(baseUrl);
    await runWindowsController();
    copyScreenshots();
    console.log('Screenshots written to screenshots/');
  } finally {
    server.close();
    stopChrome();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
