// The Piper server's HTTP contract and origin check (docs/API.md). Synthesis
// itself needs piper.exe and a voice, so it is not exercised here; the routes
// that don't spawn Piper are.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const voiceDir = mkdtempSync(join(tmpdir(), 'voicedock-piper-voices-'));
writeFileSync(join(voiceDir, 'en_US-test-medium.onnx'), 'x'.repeat(10));
writeFileSync(join(voiceDir, 'en_US-test-medium.onnx.json'), '{}');
process.env.VOICE_DIR = voiceDir;

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
