// Memory history for the VoiceDock engines: turns /health snapshots into CSV
// rows, writes them to one file per day and prunes old days.
//
// CSV columns (shared with the n8voice N8 Tray module, which writes the same
// format from PowerShell):
//
//   timestamp,engine,rss_mb,model_loaded,event,detail
//
// - timestamp: ISO 8601 UTC ("2026-11-02T18:05:00Z")
// - engine: piper | kokoro | wsl
// - rss_mb: resident memory in MB, empty when the engine is not reachable
// - model_loaded: yes | no for Kokoro, empty otherwise
// - event: sample | load | unload | speak | start | restart | offline
// - detail: free text (the voice for speak, the pid for restart)
//
// No dependencies, so it runs anywhere Node runs.
const fs = require('fs');
const path = require('path');

const HEADER = 'timestamp,engine,rss_mb,model_loaded,event,detail';
const FILE_RE = /^memory-(\d{4}-\d{2}-\d{2})\.csv$/;

const isoSeconds = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
const localDay = (date) => {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const csvField = (value) => {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const mb = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10);

/** The memory figure to chart for one engine's /health body. */
function healthRssMb(engine, health) {
  if (!health) return null;
  if (engine === 'piper') return mb(health.totalRssMb ?? health.rssMb);
  return mb(health.rssMb);
}

/**
 * Rows for one engine from the previous and current /health bodies.
 * `current` is null when the engine did not answer. `previous` is undefined on
 * the first sample after the sampler starts: then only the sample row is
 * written, so restarting a tray never re-logs old load/speak events.
 */
function rowsFromHealth(engine, previous, current, now = Date.now()) {
  const rows = [];
  const at = isoSeconds(now);
  const loaded = (h) => (engine === 'kokoro' && h && 'modelLoaded' in h ? (h.modelLoaded ? 'yes' : 'no') : '');
  if (!current) {
    rows.push({ timestamp: at, engine, rss_mb: null, model_loaded: '', event: 'offline', detail: '' });
    return rows;
  }
  const rss = healthRssMb(engine, current);
  const event = (name, when, extra = {}) => rows.push({
    timestamp: when ? isoSeconds(when) : at,
    engine,
    rss_mb: rss,
    model_loaded: loaded(current),
    event: name,
    detail: '',
    ...extra,
  });
  if (previous !== undefined) {
    if (previous === null) {
      event('start', current.startedAt || now, { detail: current.pid ? `pid ${current.pid}` : '' });
    } else if (current.pid && previous.pid && current.pid !== previous.pid) {
      event('restart', current.startedAt || now, { detail: `pid ${current.pid}` });
    }
    const changed = (key) => current[key] && current[key] !== (previous && previous[key]);
    if (engine === 'kokoro' && changed('modelLoadedAt')) {
      event('load', current.modelLoadedAt, { model_loaded: 'yes' });
    }
    if (engine === 'kokoro' && changed('modelUnloadedAt')) {
      event('unload', current.modelUnloadedAt, { model_loaded: 'no' });
    }
    if (changed('lastSpeakAt')) {
      // Piper's readers are short-lived, so a speak row carries the server plus
      // the last reader's peak: what that read cost at its highest.
      const speakRss = engine === 'piper' && current.lastReaderPeakRssMb != null
        ? mb((current.rssMb || 0) + current.lastReaderPeakRssMb)
        : rss;
      event('speak', current.lastSpeakAt, {
        rss_mb: speakRss,
        detail: current.activeVoice || current.lastVoice || '',
      });
    }
  }
  event('sample', null);
  rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return rows;
}

function rowToCsv(row) {
  return [row.timestamp, row.engine, row.rss_mb == null ? '' : row.rss_mb, row.model_loaded || '', row.event, row.detail || '']
    .map(csvField).join(',');
}

/** Append rows to dir/memory-<local date>.csv, writing the header for a new file. */
function appendRows(dir, rows, now = Date.now()) {
  if (!rows.length) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `memory-${localDay(now)}.csv`);
  const body = rows.map(rowToCsv).join('\n') + '\n';
  const fresh = !fs.existsSync(file);
  fs.appendFileSync(file, (fresh ? HEADER + '\n' : '') + body);
  return file;
}

/** Delete memory-<date>.csv files older than keepDays (by their date). */
function pruneHistory(dir, keepDays, now = Date.now()) {
  if (!(keepDays > 0)) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const cutoff = localDay(new Date(now).getTime() - keepDays * 86400000);
  const removed = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (m && m[1] < cutoff) {
      try { fs.unlinkSync(path.join(dir, name)); removed.push(name); } catch { /* in use: next time */ }
    }
  }
  return removed;
}

/** Split one CSV line into fields (handles quoted fields with commas and quotes). */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse a memory CSV's text into rows (skips the header and malformed lines). */
function parseCsv(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '');
    if (!line.trim() || line.startsWith('timestamp,')) continue;
    const [timestamp, engine, rss, modelLoaded, event, detail] = parseCsvLine(line);
    const t = Date.parse(timestamp);
    if (!Number.isFinite(t) || !engine) continue;
    const rssNum = rss === '' || rss == null ? null : Number(rss);
    rows.push({
      t,
      timestamp,
      engine,
      rss_mb: Number.isFinite(rssNum) ? rssNum : null,
      model_loaded: modelLoaded || '',
      event: event || 'sample',
      detail: detail || '',
    });
  }
  return rows;
}

/** Read every memory-*.csv in dir with rows at or after sinceMs, sorted by time. */
function readHistory(dir, sinceMs = 0) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const sinceDay = localDay(sinceMs - 86400000); // a day of slack for time zones
  const rows = [];
  for (const name of names.sort()) {
    const m = FILE_RE.exec(name);
    if (!m || m[1] < sinceDay) continue;
    try {
      for (const row of parseCsv(fs.readFileSync(path.join(dir, name), 'utf8'))) {
        if (row.t >= sinceMs) rows.push(row);
      }
    } catch { /* unreadable file: skip */ }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

module.exports = {
  HEADER, isoSeconds, localDay, healthRssMb, rowsFromHealth, rowToCsv,
  appendRows, pruneHistory, parseCsv, parseCsvLine, readHistory,
};
