// End-to-end engine routing inside the service worker: a profile's engine
// decides which local server the offscreen player is pointed at, and an engine
// that is down falls back to the browser voice (or stays silent when the
// fallback is off). Runs background.js under a chrome shim with fetch mocked.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const online = { 'http://127.0.0.1:7477': true, 'http://127.0.0.1:7478': true };
const calls = { runtime: [], tts: [], hints: [] };
const store = { fallback: true };
const listeners = {};

const event = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
globalThis.chrome = {
  runtime: {
    lastError: null,
    onInstalled: event('runtime.onInstalled'),
    onStartup: event('runtime.onStartup'),
    onMessage: event('runtime.onMessage'),
    getURL: (p) => 'chrome-extension://test/' + p,
    getContexts: async () => [],
    sendMessage: async (msg) => { calls.runtime.push(msg); return { ok: true }; },
  },
  storage: {
    onChanged: event('storage.onChanged'),
    local: {
      get: async (keys) => {
        if (keys === null) return structuredClone(store);
        const list = [].concat(keys);
        return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
      },
      set: async (obj) => { Object.assign(store, obj); },
      remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
    },
  },
  contextMenus: { onClicked: event('contextMenus.onClicked'), removeAll: async () => {}, create: () => {}, update: async () => {} },
  commands: { onCommand: event('commands.onCommand') },
  tts: { stop() {}, speak(text, opts) { calls.tts.push({ text, opts }); }, pause() {}, resume() {} },
  tabs: {
    query: (_q, cb) => cb?.([]),
    sendMessage: async (tabId, msg) => { if (msg.type === 'show-hint') calls.hints.push({ tabId, message: msg.message }); },
  },
  offscreen: { createDocument: async () => {} },
};

globalThis.fetch = async (url) => {
  const base = url.replace(/\/health$/, '');
  if (!online[base]) throw new TypeError('fetch failed');
  return { ok: true, json: async () => ({ status: 'ok' }) };
};

await import('../extension/background.js');
const onMessage = listeners['runtime.onMessage'][0];

function send(message, sender = {}) {
  return new Promise((resolve) => {
    const keepOpen = onMessage(message, sender, resolve);
    if (keepOpen !== true) resolve(undefined);
  });
}

async function stop() {
  await send({ type: 'stop-all' });
}

beforeEach(async () => {
  await stop();
  calls.runtime.length = 0;
  calls.tts.length = 0;
  calls.hints.length = 0;
  online['http://127.0.0.1:7477'] = true;
  online['http://127.0.0.1:7478'] = true;
  store.fallback = true;
});

const speakTextMessages = () => calls.runtime.filter((m) => m.type === 'speak-text');

test('a Kokoro profile is sent to the Kokoro server', async () => {
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'kokoro', voice: 'bf_emma', rate: 1.2, volume: 0.8 } });
  assert.deepEqual(res, { ok: true, engine: 'kokoro', fellBack: false });
  const [msg] = speakTextMessages();
  assert.equal(msg.engine, 'kokoro');
  assert.equal(msg.ttsUrl, 'http://127.0.0.1:7478/tts');
  assert.equal(msg.voice, 'bf_emma');
  assert.equal(msg.rate, 1.2);
  assert.equal(calls.tts.length, 0);
});

test('a Piper profile (old voice-only shape) is sent to the Piper server', async () => {
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { voice: 'en_US-amy-medium.onnx' } });
  assert.equal(res.engine, 'piper');
  const [msg] = speakTextMessages();
  assert.equal(msg.ttsUrl, 'http://127.0.0.1:7477/tts');
  assert.equal(msg.voice, 'en_US-amy-medium.onnx');
});

test('an offline engine falls back to the browser voice and tells the page', async () => {
  online['http://127.0.0.1:7478'] = false;
  // keyboard-read reads with the active profile; make it a Kokoro one.
  store.profiles = [{ id: 'k', name: 'K', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];
  store.activeId = 'k';
  await send({ type: 'keyboard-read', text: 'Hello there' }, { tab: { id: 42 } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(speakTextMessages().length, 0, 'nothing is sent to the offline engine');
  assert.equal(calls.tts.length, 1);
  assert.equal(calls.tts[0].text, 'Hello there');
  assert.deepEqual(calls.hints, [{ tabId: 42, message: 'Kokoro is offline. Using the browser voice.' }]);
});

test('the Test button reports a fallback', async () => {
  online['http://127.0.0.1:7477'] = false;
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'piper', voice: '' } });
  assert.deepEqual(res, { ok: true, engine: 'browser', fellBack: true });
  assert.equal(calls.tts.length, 1);
});

test('with the fallback off, an offline engine reports an error and stays silent', async () => {
  online['http://127.0.0.1:7478'] = false;
  store.fallback = false;
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'kokoro', voice: 'af_heart' } });
  assert.deepEqual(res, { ok: false, engine: null, fellBack: false, error: 'Kokoro is offline' });
  assert.equal(calls.tts.length, 0);
  assert.equal(speakTextMessages().length, 0);
});

test('the browser engine never touches a server', async () => {
  online['http://127.0.0.1:7477'] = false;
  online['http://127.0.0.1:7478'] = false;
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'browser' } });
  assert.deepEqual(res, { ok: true, engine: 'browser', fellBack: false });
  assert.equal(calls.tts.length, 1);
});

test('install runs the settings migration', async () => {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, {
    profiles: [{ id: 'x', name: 'X', voice: 'en_US-amy-medium.onnx', rate: 1, volume: 1 }],
    favorites: ['en_US-amy-medium.onnx'],
    fallbackToBrowser: true,
  });
  for (const fn of listeners['runtime.onInstalled']) fn({ reason: 'update' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.profiles[0].engine, 'piper');
  assert.deepEqual(store.favoritesByEngine, { piper: ['en_US-amy-medium.onnx'], kokoro: [] });
  assert.equal(store.fallback, true);
  assert.equal('favorites' in store, false);
});
