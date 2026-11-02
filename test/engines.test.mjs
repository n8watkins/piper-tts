// Engine selection, profile normalization and the settings migration from
// Piper TTS 1.0.x (pure helpers in extension/src/shared.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENGINES,
  ENGINE_IDS,
  KOKORO_BASE_URL,
  PIPER_BASE_URL,
  SETTINGS_VERSION,
  chooseEngine,
  describeProfileVoice,
  engineBaseUrl,
  favoritesFor,
  formatVoiceName,
  inferEngine,
  kokoroVoiceDetails,
  migrateSettings,
  normalizeProfile,
  runSettingsMigration,
} from '../extension/src/shared.js';

test('engines and their ports', () => {
  assert.deepEqual(ENGINE_IDS, ['piper', 'kokoro', 'browser']);
  assert.equal(PIPER_BASE_URL, 'http://127.0.0.1:7477');
  assert.equal(KOKORO_BASE_URL, 'http://127.0.0.1:7478');
  assert.equal(engineBaseUrl('kokoro'), KOKORO_BASE_URL);
  assert.equal(engineBaseUrl('browser'), null);
  assert.equal(engineBaseUrl('nope'), null);
  assert.equal(ENGINES.browser.local, false);
});

test('inferEngine reads old voice-only profiles', () => {
  assert.equal(inferEngine(''), 'browser');
  assert.equal(inferEngine(undefined), 'browser');
  assert.equal(inferEngine('en_US-amy-medium.onnx'), 'piper');
  assert.equal(inferEngine('af_heart'), 'kokoro');
});

test('normalizeProfile fills in the engine and clamps values', () => {
  assert.deepEqual(
    normalizeProfile({ id: 'a', name: 'A', voice: 'en_US-amy-medium.onnx', rate: 9, volume: -1 }),
    { id: 'a', name: 'A', engine: 'piper', voice: 'en_US-amy-medium.onnx', rate: 2.5, volume: 0 },
  );
  assert.equal(normalizeProfile({ id: 'b', name: 'B', voice: '' }).engine, 'browser');
  // An explicit engine wins over inference.
  assert.equal(normalizeProfile({ id: 'c', name: 'C', engine: 'kokoro', voice: '' }).engine, 'kokoro');
  // A browser profile never carries a stale local voice.
  assert.equal(normalizeProfile({ id: 'd', name: 'D', engine: 'browser', voice: 'af_heart' }).voice, '');
  // Junk input still yields a usable profile.
  const junk = normalizeProfile({ engine: 'tape-deck', rate: 'fast' });
  assert.equal(junk.engine, 'browser');
  assert.equal(junk.rate, 1.0);
  assert.ok(junk.id);
});

test('normalizeProfile does not mutate its input', () => {
  const input = { id: 'a', name: 'A', voice: 'af_heart' };
  normalizeProfile(input);
  assert.deepEqual(input, { id: 'a', name: 'A', voice: 'af_heart' });
});

test('chooseEngine uses the profile engine when it is online', () => {
  const kokoro = { id: 'k', name: 'K', engine: 'kokoro', voice: 'bf_emma' };
  assert.deepEqual(chooseEngine(kokoro, { kokoro: true }), {
    engine: 'kokoro', voice: 'bf_emma', fellBack: false, reason: '',
  });
  const piper = { id: 'p', name: 'P', voice: 'en_US-amy-medium.onnx' };
  assert.equal(chooseEngine(piper, { piper: true, kokoro: false }).engine, 'piper');
});

test('chooseEngine falls back to the browser voice when the engine is down', () => {
  const kokoro = { id: 'k', name: 'K', engine: 'kokoro', voice: 'bf_emma' };
  assert.deepEqual(chooseEngine(kokoro, { kokoro: false, piper: true }), {
    engine: 'browser', voice: '', fellBack: true, reason: 'Kokoro is offline',
  });
  // Unknown status counts as offline.
  assert.equal(chooseEngine(kokoro, {}).engine, 'browser');
});

test('chooseEngine stays silent when the engine is down and fallback is off', () => {
  const piper = { id: 'p', name: 'P', engine: 'piper', voice: '' };
  assert.deepEqual(chooseEngine(piper, { piper: false }, false), {
    engine: null, voice: '', fellBack: false, reason: 'Piper is offline',
  });
});

test('chooseEngine: the browser engine never needs a server', () => {
  const browser = { id: 'b', name: 'B', engine: 'browser' };
  assert.equal(chooseEngine(browser, {}, false).engine, 'browser');
  assert.equal(chooseEngine(browser, {}, false).fellBack, false);
});

test('kokoro voice names are readable', () => {
  assert.deepEqual(kokoroVoiceDetails('af_heart'), { name: 'Heart', language: 'US English', gender: 'female' });
  assert.deepEqual(kokoroVoiceDetails('bm_george'), { name: 'George', language: 'UK English', gender: 'male' });
  assert.equal(kokoroVoiceDetails('en_US-amy-medium.onnx'), null);
  assert.equal(formatVoiceName('jf_alpha'), 'Alpha · Japanese');
  assert.equal(formatVoiceName('en_US-amy-medium.onnx'), 'Amy · Medium');
});

test('describeProfileVoice names the engine', () => {
  assert.equal(describeProfileVoice({ voice: '' }), 'Chrome default voice');
  assert.equal(describeProfileVoice({ voice: 'en_US-ryan-high.onnx' }), 'Piper · Ryan · High');
  assert.equal(describeProfileVoice({ engine: 'kokoro', voice: 'af_heart' }), 'Kokoro · Heart · US English');
  assert.equal(describeProfileVoice({ engine: 'kokoro', voice: '' }), 'Kokoro · default voice');
});

test('migrateSettings upgrades Piper TTS 1.0.x settings', () => {
  const v1 = {
    profiles: [
      { id: 'default', name: 'Default', voice: '', rate: 1, volume: 1 },
      { id: 'x', name: 'Articles', voice: 'en_US-ryan-high.onnx', rate: 1.4, volume: 1.2 },
    ],
    activeId: 'x',
    favorites: ['en_US-ryan-high.onnx', 'en_GB-alan-medium.onnx'],
    fallbackToBrowser: false,
    deletedVoices: [],
  };
  const { set, remove } = migrateSettings(v1);
  assert.deepEqual(set.profiles, [
    { id: 'default', name: 'Profile 1', engine: 'browser', voice: '', rate: 1, volume: 1 },
    { id: 'x', name: 'Articles', engine: 'piper', voice: 'en_US-ryan-high.onnx', rate: 1.4, volume: 1.2 },
  ]);
  assert.deepEqual(set.favoritesByEngine, {
    piper: ['en_US-ryan-high.onnx', 'en_GB-alan-medium.onnx'],
    kokoro: [],
  });
  assert.equal(set.fallback, false);
  assert.equal(set.settingsVersion, SETTINGS_VERSION);
  assert.deepEqual(remove.sort(), ['fallbackToBrowser', 'favorites']);
  assert.equal('activeId' in set, false, 'untouched keys are not rewritten');
});

test('migrateSettings keeps an existing fallback over the legacy key', () => {
  const { set, remove } = migrateSettings({ fallback: true, fallbackToBrowser: false });
  assert.equal('fallback' in set, false);
  assert.ok(remove.includes('fallbackToBrowser'));
});

test('migrateSettings is idempotent', () => {
  const v1 = {
    profiles: [{ id: 'x', name: 'X', voice: 'af_heart', rate: 1, volume: 1 }],
    favorites: ['af_heart'],
  };
  const first = migrateSettings(v1);
  const after = { ...v1, ...first.set };
  for (const key of first.remove) delete after[key];
  assert.deepEqual(migrateSettings(after), { set: {}, remove: [] });
  assert.deepEqual(favoritesFor(after.favoritesByEngine, 'kokoro'), ['af_heart']);
});

test('migrateSettings seeds an empty install', () => {
  assert.deepEqual(migrateSettings({}), {
    set: { favoritesByEngine: { piper: [], kokoro: [] }, settingsVersion: SETTINGS_VERSION },
    remove: [],
  });
});

test('runSettingsMigration writes to storage and returns the new snapshot', async () => {
  const data = {
    profiles: [{ id: 'x', name: 'X', voice: 'en_US-amy-medium.onnx', rate: 1, volume: 1 }],
    favorites: ['en_US-amy-medium.onnx'],
    fallbackToBrowser: true,
  };
  const storage = {
    async get() { return structuredClone(data); },
    async set(obj) { Object.assign(data, obj); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
  };
  const snapshot = await runSettingsMigration(storage);
  assert.equal(data.profiles[0].engine, 'piper');
  assert.equal(data.fallback, true);
  assert.equal('favorites' in data, false);
  assert.equal('fallbackToBrowser' in data, false);
  assert.deepEqual(snapshot, data);
});

test('migrateSettings merges legacy favorites into an already-seeded map', () => {
  const { set, remove } = migrateSettings({
    favorites: ['en_US-ryan-high.onnx', 'af_heart'],
    favoritesByEngine: { piper: [], kokoro: ['bf_emma'] },
  });
  assert.deepEqual(set.favoritesByEngine, { piper: ['en_US-ryan-high.onnx'], kokoro: ['bf_emma', 'af_heart'] });
  assert.ok(remove.includes('favorites'));
});

test('describeProfileVoice compact form fits the popup', () => {
  assert.equal(describeProfileVoice({ engine: 'kokoro', voice: 'bf_emma' }, { compact: true }), 'Kokoro · Emma');
  assert.equal(describeProfileVoice({ voice: 'en_US-ryan-high.onnx' }, { compact: true }), 'Piper · Ryan · High');
});
