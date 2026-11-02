// Memory reporting helpers of the Piper server (servers/piper/memory.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { serverRssMb, processRssMb, parseTasklistMemMb, createReaderTracker } =
  require('../servers/piper/memory.js');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  return child;
}

test('serverRssMb is this process in MB', () => {
  const rss = serverRssMb();
  assert.ok(rss > 1 && rss < 100_000, String(rss));
});

test('processRssMb reads another process, and null when it is gone', async (t) => {
  if (process.platform === 'win32') return t.skip('uses tasklist on Windows');
  assert.ok((await processRssMb(process.pid)) > 1);
  assert.equal(await processRssMb(0), null);
  assert.equal(await processRssMb(2 ** 22 + 12345), null);
});

test('parseTasklistMemMb reads the Mem Usage column', () => {
  assert.equal(parseTasklistMemMb('"piper.exe","4242","Console","1","63,412 K"'), 61.9);
  assert.equal(parseTasklistMemMb('"piper.exe","4242","Console","1","63.412 K"'), 61.9);
  assert.equal(parseTasklistMemMb('INFO: No tasks are running which match the specified criteria.'), null);
  assert.equal(parseTasklistMemMb(''), null);
});

test('the reader tracker samples readers while they run and keeps the last peak', async () => {
  const samples = { 101: [80, 120, 110] };
  const tracker = createReaderTracker({
    sampleRss: async (pid) => (samples[pid] || []).shift() ?? null,
    firstSampleMs: 1,
    intervalMs: 5,
    now: () => Date.UTC(2026, 10, 2, 18, 0, 0),
  });
  assert.deepEqual(tracker.snapshot(), {
    speaking: false, readers: [], readerRssMb: 0, activeVoice: null,
    lastVoice: null, lastSpeakAt: null, lastReaderPeakRssMb: null,
  });

  const child = fakeChild(101);
  tracker.add(child, 'en_US-amy-medium.onnx');
  let snap = tracker.snapshot();
  assert.equal(snap.speaking, true);
  assert.equal(snap.activeVoice, 'en_US-amy-medium.onnx');
  assert.equal(snap.lastSpeakAt, '2026-11-02T18:00:00Z');
  assert.deepEqual(snap.readers, [{ pid: 101, voice: 'en_US-amy-medium.onnx', rssMb: null }]);

  await tick(40);
  snap = tracker.snapshot();
  assert.equal(snap.readers[0].rssMb, 110, 'latest sample');
  assert.equal(snap.readerRssMb, 110);

  child.emit('close', 0);
  snap = tracker.snapshot();
  assert.equal(snap.speaking, false);
  assert.deepEqual(snap.readers, []);
  assert.equal(snap.activeVoice, null);
  assert.equal(snap.lastVoice, 'en_US-amy-medium.onnx');
  assert.equal(snap.lastReaderPeakRssMb, 120, 'peak of the finished reader');
});

test('the reader tracker sums concurrent readers and ignores children without a pid', async () => {
  const tracker = createReaderTracker({ sampleRss: async (pid) => pid / 10, firstSampleMs: 1, intervalMs: 1000 });
  tracker.add(fakeChild(0), 'ignored.onnx');
  const a = fakeChild(600);
  const b = fakeChild(900);
  tracker.add(a, 'a.onnx');
  await tick(2);
  tracker.add(b, 'b.onnx');
  await tick(20);
  const snap = tracker.snapshot();
  assert.equal(snap.readers.length, 2);
  assert.equal(snap.readerRssMb, 150);
  assert.equal(snap.activeVoice, 'b.onnx', 'the newest reader');
  a.emit('error', new Error('boom'));
  b.emit('close', 0);
  assert.equal(tracker.snapshot().speaking, false);
});
