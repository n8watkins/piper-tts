// VoiceDock tray helpers (servers/piper/tray/tray-core.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const core = require('../servers/piper/tray/tray-core.js');

const PIPER = { status: 'ok', engine: 'piper', rssMb: 22.4, totalRssMb: 22.4, speaking: false };
const KOKORO = { status: 'ok', engine: 'kokoro', rssMb: 46.9, modelLoaded: false };

test('Piper status shows memory, external servers and reading', () => {
  assert.equal(core.piperStatusText(PIPER, true), 'Piper: Running · 22 MB');
  assert.equal(core.piperStatusText(PIPER, false), 'Piper: Running (external) · 22 MB');
  assert.equal(core.piperStatusText({ ...PIPER, totalRssMb: 108.6, speaking: true, activeVoice: 'en_US-ryan-high.onnx' }, true),
    'Piper: Running · 109 MB, reading');
  assert.equal(core.piperStatusText({ status: 'ok' }, true), 'Piper: Running', 'old server without memory fields');
  assert.equal(core.piperStatusText(null, false), 'Piper: Stopped');
});

test('Kokoro status is running, not installed or not reachable, never a WSL call', () => {
  assert.equal(core.kokoroStatusText(KOKORO, true), 'Kokoro: Running · 47 MB (model unloaded)');
  assert.equal(core.kokoroStatusText({ ...KOKORO, rssMb: 581.2, modelLoaded: true }, true), 'Kokoro: Running · 581 MB (model loaded)');
  assert.equal(core.kokoroStatusText({ status: 'ok' }, true), 'Kokoro: Running');
  assert.equal(core.kokoroStatusText(null, false), 'Kokoro: Not installed (optional)');
  assert.equal(core.kokoroStatusText(null, true), 'Kokoro: Not reachable');
});

test('the tooltip names both engines and stays within the Windows limit', () => {
  assert.equal(core.tooltipText(PIPER, KOKORO, true), 'VoiceDock | Piper 22 MB · Kokoro 47 MB (model unloaded)');
  assert.equal(core.tooltipText(null, null, false), 'VoiceDock | Piper stopped');
  assert.equal(core.tooltipText(PIPER, null, true), 'VoiceDock | Piper 22 MB · Kokoro not reachable');
  const long = core.tooltipText({ ...PIPER, totalRssMb: 1e12, speaking: true, activeVoice: 'x'.repeat(200) }, KOKORO, true);
  assert.ok(long.length <= 127);
});

test('settings default to history off and survive bad values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voicedock-tray-'));
  try {
    const file = join(dir, 'tray-settings.json');
    const fresh = core.loadSettings(file);
    assert.deepEqual(fresh.memoryHistory, { enabled: false, intervalSeconds: 60, keepDays: 30 });
    assert.equal(fresh.autostartChosen, false);
    assert.equal(fresh.kokoroSeen, false);
    core.saveSettings(file, { ...fresh, kokoroSeen: true, memoryHistory: { enabled: true, intervalSeconds: 1, keepDays: 'x' } });
    const back = core.loadSettings(file);
    assert.equal(back.kokoroSeen, true);
    assert.deepEqual(back.memoryHistory, { enabled: true, intervalSeconds: 5, keepDays: 0 });
    writeFileSync(file, '{not json');
    assert.equal(core.loadSettings(file).memoryHistory.enabled, false);
    assert.ok(readFileSync(file, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('app data and autostart paths per OS, with the old Piper TTS entry', () => {
  assert.match(core.appDataDir('win32', { APPDATA: 'R' }, 'H'), /^R.VoiceDock$/);
  assert.equal(core.appDataDir('linux', {}, '/home/u'), '/home/u/.config/voicedock');
  assert.equal(core.appDataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/u'), '/x/voicedock');
  assert.equal(core.appDataDir('darwin', {}, '/Users/u'), '/Users/u/Library/Application Support/VoiceDock');
  const win = core.autostartPaths('win32', { APPDATA: 'A' }, 'H');
  assert.match(win.current, /Startup.VoiceDock Tray\.lnk$/);
  assert.match(win.legacy, /Startup.Piper TTS Tray\.lnk$/);
  const linux = core.autostartPaths('linux', {}, '/home/u');
  assert.equal(linux.current, '/home/u/.config/autostart/voicedock-tray.desktop');
  assert.equal(linux.legacy, '/home/u/.config/autostart/piper-tts-tray.desktop');
});

test('fetchHealth parses JSON and treats errors, non-2xx and timeouts as offline', async () => {
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    if (mode === 'ok') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(KOKORO)); }
    else if (mode === '500') { res.statusCode = 500; res.end('{}'); }
    else if (mode === 'text') { res.end('ok'); }
    // 'hang': never answer
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.deepEqual(await core.fetchHealth('127.0.0.1', port), KOKORO);
    mode = '500';
    assert.equal(await core.fetchHealth('127.0.0.1', port), null);
    mode = 'text';
    assert.deepEqual(await core.fetchHealth('127.0.0.1', port), { status: 'ok' }, 'old server without JSON');
    mode = 'hang';
    const started = Date.now();
    assert.equal(await core.fetchHealth('127.0.0.1', port, 150), null);
    assert.ok(Date.now() - started < 1500);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  assert.equal(await core.fetchHealth('127.0.0.1', port), null, 'nothing listening');
});
