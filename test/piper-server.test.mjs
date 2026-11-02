// The Piper server's HTTP contract and origin check (docs/API.md). Synthesis
// itself needs piper.exe and a voice, so a fake piper (a small Node script that
// waits briefly and writes a WAV) stands in for it on POSIX.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const voiceDir = mkdtempSync(join(tmpdir(), 'voicedock-piper-voices-'));
writeFileSync(join(voiceDir, 'en_US-test-medium.onnx'), 'x'.repeat(10));
writeFileSync(join(voiceDir, 'en_US-test-medium.onnx.json'), '{}');
process.env.VOICE_DIR = voiceDir;
// Fake piper: reads stdin, holds ~400 ms (so /health can see it reading), then
// writes a tiny WAV to --output_file.
const fakePiper = join(voiceDir, 'fake-piper');
writeFileSync(fakePiper, `#!${process.execPath}
const out = process.argv[process.argv.indexOf('--output_file') + 1];
process.stdin.resume();
process.stdin.on('end', () => setTimeout(() => {
  require('fs').writeFileSync(out, Buffer.from('RIFF\\x24\\x00\\x00\\x00WAVEfmt '));
}, 400));
`);
chmodSync(fakePiper, 0o755);
process.env.PIPER_BIN = fakePiper;
process.env.OUTPUT_DIR = join(voiceDir, 'out');

const { app, isAllowedOrigin } = require('../servers/piper/server.js');
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
let server;
let base;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(voiceDir, { recursive: true, force: true });
});

test('isAllowedOrigin allows CLI and extension origins only', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(EXT), true);
  assert.equal(isAllowedOrigin('https://example.com'), false);
  assert.equal(isAllowedOrigin('null'), false);
});

test('GET /health reports the piper engine', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.engine, 'piper');
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
});

test('GET /health reports memory without anything reading', async () => {
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(body.pid, process.pid);
  assert.ok(body.rssMb > 1, `rssMb ${body.rssMb}`);
  assert.equal(body.totalRssMb, body.rssMb);
  assert.equal(body.speaking, false);
  assert.deepEqual(body.readers, []);
  assert.equal(body.readerRssMb, 0);
  assert.equal(body.activeVoice, null);
  assert.match(body.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('GET /health shows the piper child while it reads', { skip: process.platform === 'win32' }, async () => {
  const tts = fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello there.', voice: 'en_US-test-medium.onnx' }),
  });
  let during;
  for (let i = 0; i < 40; i += 1) {
    during = await (await fetch(`${base}/health`)).json();
    if (during.speaking && during.readers[0]?.rssMb) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(during.speaking, true);
  assert.equal(during.activeVoice, 'en_US-test-medium.onnx');
  assert.equal(during.readers.length, 1);
  assert.ok(during.readers[0].rssMb > 1, 'the reader was sampled');
  assert.ok(during.totalRssMb > during.rssMb);

  const res = await tts;
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  const after = await (await fetch(`${base}/health`)).json();
  assert.equal(after.speaking, false);
  assert.deepEqual(after.readers, []);
  assert.equal(after.activeVoice, null);
  assert.equal(after.lastVoice, 'en_US-test-medium.onnx');
  assert.ok(after.lastReaderPeakRssMb > 1);
  assert.match(after.lastSpeakAt, /Z$/);
});

test('GET /voices lists installed voices with the shared shape', async () => {
  const res = await fetch(`${base}/voices`, { headers: { Origin: EXT } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), EXT);
  const body = await res.json();
  assert.equal(body.engine, 'piper');
  assert.deepEqual(body.voices, ['en_US-test-medium.onnx']);
  assert.equal(body.defaultVoice, 'en_US-ryan-high.onnx');
  assert.equal(body.sizes['en_US-test-medium.onnx'], 10);
});

test('a web page origin is rejected with a JSON 403', async () => {
  for (const [method, path] of [['GET', '/health'], ['GET', '/voices'], ['POST', '/tts'], ['OPTIONS', '/tts']]) {
    const res = await fetch(`${base}${path}`, { method, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.match((await res.json()).error, /Origin not allowed/);
  }
});

test('POST /tts validates input with JSON errors', async () => {
  const post = (body) => fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  let res = await post(JSON.stringify({ text: '' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Missing or invalid 'text' field.");

  res = await post(JSON.stringify({ text: 'hi', voice: '../evil.onnx' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Voice must be a .onnx filename.');

  res = await post('{not json');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid request body.');
});

test('unknown routes are a JSON 404', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'Not found.');
});
