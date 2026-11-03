// Memory history (CSV rows from /health) and the memory report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const history = require('../servers/piper/tray/memory-history.js');
const report = require('../servers/piper/tray/memory-report.js');

const T0 = Date.parse('2026-11-02T18:00:00Z');
const kokoro = (extra = {}) => ({
  pid: 10, startedAt: '2026-11-02T17:00:00Z', modelLoaded: false, rssMb: 46.9,
  modelLoadedAt: null, modelUnloadedAt: null, lastSpeakAt: null, ...extra,
});
const tmp = () => mkdtempSync(join(tmpdir(), 'voicedock-memory-'));

test('the first sample writes only a sample row (no replayed events)', () => {
  const rows = history.rowsFromHealth('kokoro', undefined, kokoro({ modelLoadedAt: '2026-11-02T17:30:00Z' }), T0);
  assert.deepEqual(rows, [{
    timestamp: '2026-11-02T18:00:00Z', engine: 'kokoro', rss_mb: 46.9, model_loaded: 'no', event: 'sample', detail: '',
  }]);
});

test('Kokoro load, speak and unload become events at their own times', () => {
  const prev = kokoro();
  const loaded = kokoro({ modelLoaded: true, rssMb: 581.2, modelLoadedAt: '2026-11-02T18:00:20Z', lastSpeakAt: '2026-11-02T18:00:23Z' });
  let rows = history.rowsFromHealth('kokoro', prev, loaded, T0 + 60000);
  assert.deepEqual(rows.map((r) => [r.timestamp, r.event, r.rss_mb, r.model_loaded]), [
    ['2026-11-02T18:00:20Z', 'load', 581.2, 'yes'],
    ['2026-11-02T18:00:23Z', 'speak', 581.2, 'yes'],
    ['2026-11-02T18:01:00Z', 'sample', 581.2, 'yes'],
  ]);
  const unloaded = { ...loaded, modelLoaded: false, rssMb: 47, modelUnloadedAt: '2026-11-02T18:10:23Z' };
  rows = history.rowsFromHealth('kokoro', loaded, unloaded, T0 + 11 * 60000);
  assert.deepEqual(rows.map((r) => [r.event, r.model_loaded]), [['unload', 'no'], ['sample', 'no']]);
});

test('Piper speak rows carry the reader peak; restarts and outages are rows too', () => {
  const prev = { pid: 1, startedAt: '2026-11-02T17:00:00Z', rssMb: 22, totalRssMb: 22 };
  const cur = { ...prev, lastSpeakAt: '2026-11-02T18:00:30Z', lastVoice: 'en_US-ryan-high.onnx', lastReaderPeakRssMb: 91.3 };
  const rows = history.rowsFromHealth('piper', prev, cur, T0 + 60000);
  assert.deepEqual(rows.map((r) => [r.event, r.rss_mb, r.detail]), [
    ['speak', 113.3, 'en_US-ryan-high.onnx'],
    ['sample', 22, ''],
  ]);
  assert.deepEqual(history.rowsFromHealth('piper', cur, null, T0).map((r) => [r.event, r.rss_mb]), [['offline', null]]);
  const back = history.rowsFromHealth('piper', null, { ...prev, pid: 2, startedAt: '2026-11-02T18:00:05Z' }, T0 + 60000);
  assert.deepEqual(back.map((r) => [r.timestamp, r.event, r.detail]), [
    ['2026-11-02T18:00:05Z', 'start', 'pid 2'],
    ['2026-11-02T18:01:00Z', 'sample', ''],
  ]);
  const restarted = history.rowsFromHealth('piper', prev, { ...prev, pid: 3, startedAt: '2026-11-02T18:00:40Z' }, T0 + 60000);
  assert.equal(restarted[0].event, 'restart');
});

test('older servers without memory fields still produce sample rows', () => {
  const rows = history.rowsFromHealth('piper', {}, { status: 'ok', engine: 'piper', version: '1.0.0' }, T0);
  assert.deepEqual(rows.map((r) => [r.event, r.rss_mb]), [['sample', null]]);
});

test('rows round-trip through daily CSV files, with quoting', () => {
  const dir = tmp();
  try {
    const rows = [
      { timestamp: '2026-11-02T18:00:00Z', engine: 'piper', rss_mb: 22.4, model_loaded: '', event: 'speak', detail: 'odd, "voice"' },
      { timestamp: '2026-11-02T18:01:00Z', engine: 'kokoro', rss_mb: null, model_loaded: '', event: 'offline', detail: '' },
    ];
    const file = history.appendRows(dir, rows, T0);
    history.appendRows(dir, rows.slice(0, 1), T0);
    const text = readFileSync(file, 'utf8');
    assert.equal(text.split('\n')[0], history.HEADER);
    assert.equal(text.match(/^timestamp,/gm).length, 1, 'header written once');
    const back = history.readHistory(dir, 0);
    assert.equal(back.length, 3);
    assert.equal(back[0].detail, 'odd, "voice"');
    assert.equal(back[2].rss_mb, null);
    assert.equal(history.readHistory(dir, T0 + 30000).length, 1, 'filters by time');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pruneHistory keeps the configured number of days', () => {
  const dir = tmp();
  try {
    const now = new Date(2026, 10, 30, 12).getTime();
    for (const day of ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-29']) {
      writeFileSync(join(dir, `memory-${day}.csv`), history.HEADER + '\n');
    }
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    assert.deepEqual(history.pruneHistory(dir, 30, now), ['memory-2026-10-30.csv']);
    assert.deepEqual(readdirSync(dir).sort(), ['memory-2026-10-31.csv', 'memory-2026-11-01.csv', 'memory-2026-11-29.csv', 'notes.txt']);
    assert.deepEqual(history.pruneHistory(dir, 0, now), [], '0 keeps everything');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function syntheticRows() {
  const rows = [];
  for (let i = 0; i < 120; i += 1) {
    const t = T0 + i * 60000;
    const loaded = i >= 30 && i < 50;
    rows.push({ t, engine: 'kokoro', rss_mb: loaded ? 580 : 46, model_loaded: loaded ? 'yes' : 'no', event: 'sample', detail: '' });
    rows.push({ t, engine: 'piper', rss_mb: i >= 100 ? null : 22, model_loaded: '', event: i >= 100 ? 'offline' : 'sample', detail: '' });
  }
  rows.push({ t: T0 + 30 * 60000 - 5000, engine: 'kokoro', rss_mb: 580, model_loaded: 'yes', event: 'load', detail: '' });
  rows.push({ t: T0 + 30 * 60000 - 2000, engine: 'kokoro', rss_mb: 640, model_loaded: 'yes', event: 'speak', detail: 'af_heart' });
  rows.push({ t: T0 + 50 * 60000 - 3000, engine: 'kokoro', rss_mb: 47, model_loaded: 'no', event: 'unload', detail: '' });
  return rows.sort((a, b) => a.t - b.t);
}

test('computeStats reports peak, average, idle and events', () => {
  const rows = syntheticRows();
  const s = report.computeStats(rows, 'kokoro', T0 - 1, T0 + 3 * 3600000);
  assert.equal(s.peak, 640, 'speak rows count for the peak');
  assert.equal(s.idle, 46, 'idle = median while unloaded');
  assert.equal(Math.round(s.average), Math.round((20 * 580 + 100 * 46) / 120));
  assert.equal(s.loads, 1);
  assert.equal(s.unloads, 1);
  assert.equal(s.speaks, 1);
  assert.equal(Math.round(s.loadedShare * 100), 17);
  assert.equal(s.latestLoaded, 'no');
  const p = report.computeStats(rows, 'piper', T0 - 1, T0 + 3 * 3600000);
  assert.equal(p.latest, null);
  assert.equal(p.offline, 20);
});

test('offline stretches become bands, and gaps break the line', () => {
  const rows = syntheticRows();
  const bands = report.offlineBands(rows, 'piper', T0 - 1, T0 + 3 * 3600000);
  assert.equal(bands.length, 1);
  assert.equal(bands[0][0], T0 + 100 * 60000);
  const points = report.seriesPoints(rows, 'piper', T0 - 1, T0 + 3600000 * 24, 480);
  assert.ok(points.length > 10);
  assert.ok(points.every((p) => !p.gap), 'no gaps inside continuous sampling');
});

test('niceMax picks round axis tops', () => {
  assert.equal(report.niceMax(119), 160);
  assert.equal(report.niceMax(224), 300);
  assert.equal(report.niceMax(600), 800);
  assert.equal(report.niceMax(5860), 8192);
  assert.equal(report.niceMax(0), 100);
});

test('buildReport is self-contained HTML with charts, stats and event markers', () => {
  const html = report.buildReport(syntheticRows(), { now: T0 + 150 * 60000, source: '/x' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>VoiceDock Memory<\/title>/);
  assert.equal((html.match(/<svg class="chart"/g) || []).length, 6, 'piper + kokoro for 1 h, 24 h and 7 d');
  assert.match(html, /<section class="range" id="24h" aria-label/, 'opens on 24 hours once the history is older than an hour');
  assert.match(html, /Load [A-Z][a-z]{2} [A-Z][a-z]{2} \d+, \d\d:\d\d, 580 MB/);
  assert.match(html, /Not reachable/);
  assert.doesNotMatch(html, /(src|href)="https?:/, 'no network resources');
  assert.doesNotMatch(html, /\u2014/, 'no em dash');
  const young = report.buildReport(syntheticRows().filter((r) => r.t < T0 + 30 * 60000), { now: T0 + 40 * 60000 });
  assert.match(young, /<section class="range" id="1h" aria-label/, 'opens on the last hour while the history is young');
  const empty = report.buildReport([], { now: T0 });
  assert.match(empty, /No memory history yet/);
});

test('the CLI writes the report next to the CSV files', () => {
  const dir = tmp();
  try {
    history.appendRows(dir, history.rowsFromHealth('kokoro', undefined, kokoro(), T0), T0);
    const log = console.log;
    let printed = '';
    console.log = (s) => { printed += s; };
    try {
      assert.equal(report.main(['node', 'memory-report.js', dir, '--now', '2026-11-02T18:05:00Z']), 0);
    } finally { console.log = log; }
    assert.equal(printed, join(dir, 'memory-report.html'));
    assert.ok(existsSync(printed));
    assert.match(readFileSync(printed, 'utf8'), /1 row from/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
