#!/usr/bin/env node
// VoiceDock memory report: one self-contained HTML file (inline SVG, no
// network) with a timeline per engine for the last 24 hours and 7 days,
// peak / average / idle figures, and model load, unload, speak and restart
// events marked on the timeline.
//
//   node memory-report.js <csv dir> [--out <file.html>] [--open] [--now <ISO time>]
//
// Reads the memory-YYYY-MM-DD.csv files written by the VoiceDock tray or the
// n8voice N8 Tray module (format in memory-history.js). No dependencies.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readHistory } = require('./memory-history');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const RANGES = [
  { id: '24h', label: 'Last 24 hours', ms: DAY, buckets: 480 },
  { id: '7d', label: 'Last 7 days', ms: 7 * DAY, buckets: 504 },
];
const ENGINES = [
  { id: 'piper', name: 'Piper', note: 'Node server plus the piper process reading, if any', lanes: ['speak', 'restart'] },
  { id: 'kokoro', name: 'Kokoro', note: 'Python server; the model is loaded only while in use', lanes: ['load', 'unload', 'speak', 'restart'] },
  { id: 'wsl', name: 'WSL VM', note: 'The whole WSL virtual machine (from devguard), when WSL runs', lanes: [] },
];
const LANE_LABEL = { load: 'Load', unload: 'Unload', speak: 'Speak', restart: 'Start' };
const laneOf = (event) => (event === 'start' || event === 'restart' ? 'restart' : event);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMb = (n) => (n == null ? '-' : n >= 1000 ? `${+(n / 1024).toFixed(2)} GB` : `${Math.round(n)} MB`);
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtTime = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDay = (t) => { const d = new Date(t); return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const fmtWhen = (t) => `${fmtDay(t)}, ${fmtTime(t)}`;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Peak, average, idle and event counts for one engine over [from, to]. */
function computeStats(rows, engine, from, to) {
  const mine = rows.filter((r) => r.engine === engine && r.t >= from && r.t <= to);
  const samples = mine.filter((r) => r.event === 'sample' && r.rss_mb != null);
  const withRss = mine.filter((r) => r.rss_mb != null);
  const values = samples.map((r) => r.rss_mb);
  const idleRows = engine === 'kokoro' ? samples.filter((r) => r.model_loaded === 'no') : samples;
  const count = (name) => mine.filter((r) => laneOf(r.event) === name).length;
  const loadedShare = engine === 'kokoro' && samples.length
    ? samples.filter((r) => r.model_loaded === 'yes').length / samples.length
    : null;
  const last = [...mine].reverse().find((r) => r.event === 'sample' || r.event === 'offline');
  return {
    samples: samples.length,
    offline: mine.filter((r) => r.event === 'offline').length,
    peak: withRss.length ? Math.max(...withRss.map((r) => r.rss_mb)) : null,
    average: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    idle: median(idleRows.map((r) => r.rss_mb)),
    latest: last ? last.rss_mb : null,
    latestLoaded: last ? last.model_loaded : '',
    loadedShare,
    loads: count('load'),
    unloads: count('unload'),
    speaks: count('speak'),
    restarts: count('restart'),
  };
}

/** Typical gap between samples, so longer gaps break the line. */
function sampleInterval(samples) {
  const gaps = [];
  for (let i = 1; i < samples.length; i += 1) gaps.push(samples[i].t - samples[i - 1].t);
  return median(gaps.filter((g) => g > 0)) || 60000;
}

/**
 * Downsample to the max per bucket (keeps peaks visible) and mark line breaks.
 * Speak rows count too: for Piper they carry the reader's peak, which a
 * once-a-minute sample would almost always miss.
 */
function seriesPoints(rows, engine, from, to, buckets) {
  const samples = rows.filter((r) => r.engine === engine && r.t >= from && r.t <= to && r.rss_mb != null && (r.event === 'sample' || r.event === 'speak'));
  const width = (to - from) / buckets;
  const byBucket = new Map();
  for (const r of samples) {
    const i = Math.min(buckets - 1, Math.floor((r.t - from) / width));
    const b = byBucket.get(i);
    if (!b || r.rss_mb > b.mb) byBucket.set(i, { t: r.t, mb: r.rss_mb, loaded: r.model_loaded });
  }
  const points = [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
  const breakAfter = Math.max(3 * sampleInterval(samples.filter((r) => r.event === 'sample')), 2.5 * width);
  points.forEach((p, i) => { p.gap = i > 0 && p.t - points[i - 1].t > breakAfter; });
  return points;
}

/** Stretches where the engine was offline, as [start, end] pairs. */
function offlineBands(rows, engine, from, to) {
  const mine = rows.filter((r) => r.engine === engine && r.t >= from && r.t <= to && (r.event === 'sample' || r.event === 'offline'));
  const step = sampleInterval(mine);
  const bands = [];
  let start = null;
  let lastOff = null;
  for (const r of mine) {
    if (r.event === 'offline') { if (start == null) start = r.t; lastOff = r.t; }
    else if (start != null) { bands.push([start, r.t]); start = null; }
  }
  if (start != null) bands.push([start, Math.min(to, lastOff + step)]);
  return bands;
}

/** A y-axis top with 4 round steps (MB below 1 GB, GB steps above). */
function niceMax(v) {
  if (!(v > 0)) return 100;
  const gb = v * 1.08 >= 1000;
  const unit = gb ? 1024 : 1;
  const rawStep = (v * 1.08) / unit / 4;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= rawStep);
  return step * 4 * unit;
}

function timeTicks(from, to, range) {
  const ticks = [];
  if (range.id === '24h') {
    const d = new Date(from); d.setMinutes(0, 0, 0);
    let t = d.getTime() + HOUR;
    while (new Date(t).getHours() % 3) t += HOUR;
    for (; t <= to; t += 3 * HOUR) ticks.push({ t, label: fmtTime(t) });
  } else {
    const d = new Date(from); d.setHours(0, 0, 0, 0);
    for (let t = d.getTime() + DAY; t <= to; t += DAY) {
      const day = new Date(t); day.setHours(0, 0, 0, 0); // DST-safe midnight
      ticks.push({ t: day.getTime(), label: fmtDay(day.getTime()) });
    }
  }
  return ticks;
}

function chartSvg(rows, engine, range, from, to, chartId) {
  const W = 960;
  const laneH = 16;
  const lanes = engine.lanes;
  const M = { left: 64, right: 16, top: lanes.length ? 8 + lanes.length * laneH + 14 : 10, bottom: 26 };
  const plotH = 150;
  const H = M.top + plotH + M.bottom;
  const plotW = W - M.left - M.right;
  const points = seriesPoints(rows, engine.id, from, to, range.buckets);
  const events = rows.filter((r) => r.engine === engine.id && r.t >= from && r.t <= to && lanes.includes(laneOf(r.event)));
  const peak = Math.max(0, ...points.map((p) => p.mb), ...events.map((e) => e.rss_mb || 0));
  const yMax = niceMax(peak);
  const x = (t) => M.left + ((t - from) / (to - from)) * plotW;
  const y = (v) => M.top + plotH - (v / yMax) * plotH;
  const parts = [];

  parts.push(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(engine.name)} memory, ${esc(range.label.toLowerCase())}, peak ${esc(fmtMb(peak || null))}" data-chart="${chartId}">`);
  // Grid and y labels.
  for (let i = 0; i <= 4; i += 1) {
    const v = (yMax / 4) * i;
    const gy = y(v).toFixed(1);
    parts.push(`<line class="grid" x1="${M.left}" x2="${W - M.right}" y1="${gy}" y2="${gy}"/>`);
    parts.push(`<text class="axis" x="${M.left - 8}" y="${gy}" dy="0.32em" text-anchor="end">${esc(fmtMb(v))}</text>`);
  }
  // Offline bands.
  for (const [a, b] of offlineBands(rows, engine.id, from, to)) {
    const bx = x(a);
    parts.push(`<rect class="offline" x="${bx.toFixed(1)}" y="${M.top}" width="${Math.max(1.5, x(b) - bx).toFixed(1)}" height="${plotH}"><title>Not reachable ${esc(fmtWhen(a))} to ${esc(fmtWhen(b))}</title></rect>`);
  }
  // Time axis.
  for (const tick of timeTicks(from, to, range)) {
    const tx = x(tick.t).toFixed(1);
    parts.push(`<line class="tick" x1="${tx}" x2="${tx}" y1="${M.top + plotH}" y2="${M.top + plotH + 4}"/>`);
    parts.push(`<text class="axis" x="${tx}" y="${M.top + plotH + 18}" text-anchor="middle">${esc(tick.label)}</text>`);
  }
  parts.push(`<line class="baseline" x1="${M.left}" x2="${W - M.right}" y1="${M.top + plotH}" y2="${M.top + plotH}"/>`);
  // Area and line, broken at gaps.
  const segments = [];
  for (const p of points) {
    if (!segments.length || p.gap) segments.push([]);
    segments[segments.length - 1].push(p);
  }
  for (const seg of segments) {
    const line = seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.mb).toFixed(1)}`).join('');
    if (seg.length === 1) {
      parts.push(`<circle class="dot" cx="${x(seg[0].t).toFixed(1)}" cy="${y(seg[0].mb).toFixed(1)}" r="2.5"/>`);
      continue;
    }
    const base = y(0).toFixed(1);
    parts.push(`<path class="area" d="${line}L${x(seg[seg.length - 1].t).toFixed(1)},${base}L${x(seg[0].t).toFixed(1)},${base}Z"/>`);
    parts.push(`<path class="line" d="${line}"/>`);
  }
  // Event lanes above the plot.
  lanes.forEach((lane, i) => {
    const ly = 8 + i * laneH + laneH / 2;
    parts.push(`<text class="lane" x="${M.left - 8}" y="${ly}" dy="0.32em" text-anchor="end">${LANE_LABEL[lane]}</text>`);
    parts.push(`<line class="lane-rule" x1="${M.left}" x2="${W - M.right}" y1="${ly}" y2="${ly}"/>`);
    for (const e of events.filter((ev) => laneOf(ev.event) === lane)) {
      const ex = x(e.t).toFixed(1);
      const tip = `${LANE_LABEL[lane] === 'Start' ? (e.event === 'restart' ? 'Restart' : 'Start') : LANE_LABEL[lane]} ${fmtWhen(e.t)}${e.rss_mb != null ? `, ${fmtMb(e.rss_mb)}` : ''}${e.detail ? `, ${e.detail}` : ''}`;
      const shape = lane === 'load' ? `<path class="mark" d="M${ex},${ly - 5}l5,9h-10z"/>`
        : lane === 'unload' ? `<path class="mark hollow" d="M${ex},${ly + 5}l5,-9h-10z"/>`
          : lane === 'speak' ? `<circle class="mark" cx="${ex}" cy="${ly}" r="3.5"/>`
            : `<path class="mark" d="M${ex},${ly - 5}l5,5l-5,5l-5,-5z"/>`;
      parts.push(`<g class="event">${shape}<title>${esc(tip)}</title></g>`);
      if (lane === 'load' || lane === 'unload' || lane === 'restart') {
        parts.push(`<line class="event-rule" x1="${ex}" x2="${ex}" y1="${M.top}" y2="${M.top + plotH}"/>`);
      }
    }
  });
  // Hover layer (crosshair + tooltip, driven by the inline script).
  parts.push(`<line class="crosshair" x1="0" x2="0" y1="${M.top}" y2="${M.top + plotH}" visibility="hidden"/>`);
  parts.push(`<circle class="hover-dot" r="4.5" cx="0" cy="0" visibility="hidden"/>`);
  parts.push(`<rect class="hit" x="${M.left}" y="${M.top}" width="${plotW}" height="${plotH}"/>`);
  parts.push('</svg>');
  const data = {
    from, to, left: M.left, plotW, top: M.top, plotH, yMax, W,
    points: points.map((p) => [p.t, p.mb, p.loaded === 'yes' ? 1 : p.loaded === 'no' ? 0 : -1]),
  };
  return { svg: parts.join(''), data, empty: points.length === 0 && events.length === 0 };
}

function statTable(rows, from, to, engines) {
  const head = '<tr><th scope="col">Engine</th><th scope="col">Peak</th><th scope="col">Average</th><th scope="col">Idle</th><th scope="col">Latest</th><th scope="col">Model loaded</th><th scope="col">Loads</th><th scope="col">Unloads</th><th scope="col">Speaks</th><th scope="col">Restarts</th></tr>';
  const body = engines.map((engine) => {
    const s = computeStats(rows, engine.id, from, to);
    const kokoro = engine.id === 'kokoro';
    const latest = s.latest == null ? (s.offline ? 'offline' : '-') : fmtMb(s.latest) + (kokoro && s.latestLoaded ? ` (${s.latestLoaded === 'yes' ? 'loaded' : 'unloaded'})` : '');
    const n = (v) => (engine.lanes.length ? String(v) : '-');
    return `<tr><th scope="row"><span class="key key-${engine.id}"></span>${esc(engine.name)}</th>` +
      `<td>${fmtMb(s.peak)}</td><td>${fmtMb(s.average)}</td><td>${fmtMb(s.idle)}</td><td>${esc(latest)}</td>` +
      `<td>${s.loadedShare == null ? '-' : `${Math.round(s.loadedShare * 100)}% of the time`}</td>` +
      `<td>${kokoro ? s.loads : '-'}</td><td>${kokoro ? s.unloads : '-'}</td><td>${n(s.speaks)}</td><td>${n(s.restarts)}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="stats"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function eventTable(rows, from, to) {
  const notable = rows.filter((r) => r.t >= from && r.t <= to && ['load', 'unload', 'start', 'restart'].includes(r.event)).reverse().slice(0, 100);
  if (!notable.length) return '<p class="muted">No model loads, unloads or restarts in this range.</p>';
  const name = (id) => (ENGINES.find((e) => e.id === id) || { name: id }).name;
  const body = notable.map((r) => `<tr><td>${esc(fmtWhen(r.t))}</td><td>${esc(name(r.engine))}</td><td>${esc(r.event)}</td><td>${fmtMb(r.rss_mb)}</td><td>${esc(r.detail)}</td></tr>`).join('');
  return `<div class="table-wrap"><table class="events"><thead><tr><th scope="col">When</th><th scope="col">Engine</th><th scope="col">Event</th><th scope="col">Memory</th><th scope="col">Detail</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

const STYLE = `
:root{color-scheme:light;--surface:#fcfcfb;--card:#ffffff;--border:#e4e3df;--grid:#ecebe7;--text:#0b0b0b;--text2:#52514e;--muted:#7a7974;--piper:#2a78d6;--kokoro:#eb6834;--wsl:#1baf7a;--offline:rgba(122,121,116,.14)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--surface:#121211;--card:#1a1a19;--border:#2e2e2b;--grid:#272725;--text:#f0efec;--text2:#c3c2b7;--muted:#97968e;--piper:#3987e5;--kokoro:#d95926;--wsl:#199e70;--offline:rgba(151,150,142,.16)}}
:root[data-theme="dark"]{color-scheme:dark;--surface:#121211;--card:#1a1a19;--border:#2e2e2b;--grid:#272725;--text:#f0efec;--text2:#c3c2b7;--muted:#97968e;--piper:#3987e5;--kokoro:#d95926;--wsl:#199e70;--offline:rgba(151,150,142,.16)}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 48px}
h1{font-size:24px;line-height:1.25;margin:0 0 4px}
h2{font-size:17px;margin:0}
h3{font-size:15px;margin:0}
.meta,.muted,.note{color:var(--text2)}
.note{font-size:12.5px}
.tabs{display:flex;gap:6px;margin:24px 0 16px}
.tabs button{font:inherit;color:var(--text2);background:transparent;border:1px solid var(--border);border-radius:999px;padding:5px 14px;cursor:pointer}
.tabs button[aria-selected="true"]{color:var(--text);background:var(--card);border-color:var(--text2)}
section.range{display:block}
.js section.range[hidden]{display:none}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px 16px 10px;margin:0 0 14px}
.card header{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.chart-wrap{position:relative;overflow-x:auto}
.chart-wrap .chart{min-width:640px}
.chart{display:block;width:100%;height:auto;overflow:visible}
.grid{stroke:var(--grid);stroke-width:1}
.baseline,.tick{stroke:var(--muted);stroke-width:1}
.axis,.lane{fill:var(--muted);font-size:11.5px}
.lane-rule{stroke:var(--grid);stroke-width:1}
.offline{fill:var(--offline)}
.line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.area{opacity:.12;stroke:none}
.mark{stroke:var(--card);stroke-width:1.5}
.mark.hollow{fill:var(--card)!important;stroke-width:1.75}
.event-rule{stroke-width:1;stroke-dasharray:none;opacity:.35}
.crosshair{stroke:var(--text2);stroke-width:1}
.hover-dot{stroke:var(--card);stroke-width:2}
.hit{fill:transparent;cursor:crosshair}
.c-piper .line,.c-piper .event-rule{stroke:var(--piper)}.c-piper .area,.c-piper .mark,.c-piper .dot,.c-piper .hover-dot{fill:var(--piper)}.c-piper .mark.hollow{stroke:var(--piper)}
.c-kokoro .line,.c-kokoro .event-rule{stroke:var(--kokoro)}.c-kokoro .area,.c-kokoro .mark,.c-kokoro .dot,.c-kokoro .hover-dot{fill:var(--kokoro)}.c-kokoro .mark.hollow{stroke:var(--kokoro)}
.c-wsl .line,.c-wsl .event-rule{stroke:var(--wsl)}.c-wsl .area,.c-wsl .mark,.c-wsl .dot,.c-wsl .hover-dot{fill:var(--wsl)}.c-wsl .mark.hollow{stroke:var(--wsl)}
.key{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:8px;vertical-align:-1px}
.key-piper{background:var(--piper)}.key-kokoro{background:var(--kokoro)}.key-wsl{background:var(--wsl)}
.table-wrap{overflow-x:auto;margin:0 0 18px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:7px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
th:first-child,td:first-child{text-align:left}
thead th{color:var(--text2);font-weight:500;font-size:12.5px}
table.events td:nth-child(2),table.events td:nth-child(3),table.events td:last-child{text-align:left}
.legend{display:flex;gap:18px;flex-wrap:wrap;color:var(--text2);font-size:12.5px;margin:0 0 16px}
.legend svg{vertical-align:-2px;margin-right:5px}
.tip{position:absolute;pointer-events:none;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 9px;font-size:12.5px;box-shadow:0 4px 14px rgba(0,0,0,.12);white-space:nowrap;transform:translate(-50%,-100%);margin-top:-10px}
.tip b{font-weight:600}
details{margin:6px 0 18px}summary{cursor:pointer;color:var(--text2)}
.empty{padding:28px 0;text-align:center;color:var(--text2)}
`;

const SCRIPT = `
document.documentElement.classList.add('js');
const tabs=[...document.querySelectorAll('.tabs button')];
const show=id=>{tabs.forEach(o=>o.setAttribute('aria-selected',String(o.dataset.range===id)));document.querySelectorAll('section.range').forEach(s=>{s.hidden=s.id!==id;});};
tabs.forEach(b=>b.addEventListener('click',()=>{show(b.dataset.range);history.replaceState(null,'','#'+b.dataset.range);}));
if(location.hash&&document.getElementById(location.hash.slice(1)))show(location.hash.slice(1));
const data=JSON.parse(document.getElementById('chart-data').textContent);
const pad=n=>String(n).padStart(2,'0');
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const when=t=>{const d=new Date(t);return DAYS[d.getDay()]+' '+pad(d.getHours())+':'+pad(d.getMinutes());};
const mb=n=>n>=1000?(n/1024).toFixed(2)+' GB':Math.round(n)+' MB';
document.querySelectorAll('svg[data-chart]').forEach(svg=>{
  const d=data[svg.dataset.chart];if(!d||!d.points.length)return;
  const wrap=svg.parentElement,tip=wrap.querySelector('.tip'),cross=svg.querySelector('.crosshair'),dot=svg.querySelector('.hover-dot'),hit=svg.querySelector('.hit');
  const X=t=>d.left+(t-d.from)/(d.to-d.from)*d.plotW,Y=v=>d.top+d.plotH-v/d.yMax*d.plotH;
  const hide=()=>{tip.hidden=true;cross.setAttribute('visibility','hidden');dot.setAttribute('visibility','hidden');};
  hit.addEventListener('pointermove',e=>{
    const r=svg.getBoundingClientRect(),sx=(e.clientX-r.left)*d.W/r.width;
    const t=d.from+(sx-d.left)/d.plotW*(d.to-d.from);
    let best=d.points[0];for(const p of d.points)if(Math.abs(p[0]-t)<Math.abs(best[0]-t))best=p;
    const px=X(best[0]),py=Y(best[1]);
    cross.setAttribute('x1',px);cross.setAttribute('x2',px);cross.setAttribute('visibility','visible');
    dot.setAttribute('cx',px);dot.setAttribute('cy',py);dot.setAttribute('visibility','visible');
    tip.innerHTML='<b>'+mb(best[1])+'</b> '+when(best[0])+(best[2]===1?', model loaded':best[2]===0?', model unloaded':'');
    const k=r.width/d.W;tip.style.left=(px*k)+'px';tip.style.top=(py*k)+'px';tip.hidden=false;
  });
  hit.addEventListener('pointerleave',hide);
});
`;

function legendHtml() {
  const icon = (shape) => `<svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true"><g fill="var(--text2)" stroke="var(--text2)">${shape}</g></svg>`;
  return `<div class="legend">` +
    `<span>${icon('<path d="M0,-5l5,9h-10z"/>')}Model loaded</span>` +
    `<span>${icon('<path d="M0,5l5,-9h-10z" fill="none" stroke-width="1.5"/>')}Model released</span>` +
    `<span>${icon('<circle r="3.5"/>')}Read aloud</span>` +
    `<span>${icon('<path d="M0,-5l5,5l-5,5l-5,-5z"/>')}Server start or restart</span>` +
    `<span>${icon('<rect x="-6" y="-6" width="12" height="12" fill="var(--offline)" stroke="none"/>')}Not reachable</span>` +
    `</div>`;
}

/** Build the report HTML from parsed rows. */
function buildReport(rows, { now = Date.now(), source = '' } = {}) {
  const engines = ENGINES.filter((e) => e.id !== 'wsl' || rows.some((r) => r.engine === 'wsl'));
  const chartData = {};
  const first = rows.length ? rows[0].t : null;
  const sections = RANGES.map((range, ri) => {
    const from = now - range.ms;
    const inRange = rows.filter((r) => r.t >= from && r.t <= now);
    let body;
    if (!inRange.length) {
      body = `<p class="empty">No memory samples in the ${esc(range.label.toLowerCase())}.</p>`;
    } else {
      const cards = engines.map((engine) => {
        const id = `${range.id}-${engine.id}`;
        const chart = chartSvg(rows, engine, range, from, now, id);
        chartData[id] = chart.data;
        return `<article class="card c-${engine.id}"><header><h3><span class="key key-${engine.id}"></span>${esc(engine.name)}</h3><span class="note">${esc(engine.note)}</span></header>` +
          (chart.empty ? `<p class="empty">No samples for ${esc(engine.name)} in this range.</p>` : `<div class="chart-wrap">${chart.svg}<div class="tip" hidden></div></div>`) +
          `</article>`;
      }).join('');
      body = statTable(rows, from, now, engines) + legendHtml() + cards +
        `<details><summary>Model loads, unloads and restarts</summary>${eventTable(rows, from, now)}</details>`;
    }
    return `<section class="range" id="${range.id}"${ri ? ' hidden' : ''} aria-label="${esc(range.label)}"><h2>${esc(range.label)}</h2><p class="note">${esc(fmtWhen(from))} to ${esc(fmtWhen(now))}. Idle is the median memory while nothing was loaded (Kokoro) or across all samples (Piper, WSL).</p>${body}</section>`;
  }).join('');
  const meta = rows.length
    ? `${rows.length.toLocaleString('en-US')} ${rows.length === 1 ? 'row' : 'rows'} from ${esc(fmtWhen(first))} to ${esc(fmtWhen(rows[rows.length - 1].t))}${source ? ` in ${esc(source)}` : ''}. Generated ${esc(fmtWhen(now))}.`
    : `No memory history yet${source ? ` in ${esc(source)}` : ''}. Turn on memory history in the tray and check back later. Generated ${esc(fmtWhen(now))}.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VoiceDock Memory</title><style>${STYLE}</style></head><body><main>` +
    `<h1>VoiceDock memory</h1><p class="meta">${meta}</p>` +
    `<div class="tabs" role="tablist">${RANGES.map((r, i) => `<button type="button" role="tab" data-range="${r.id}" aria-selected="${i === 0}">${esc(r.label)}</button>`).join('')}</div>` +
    sections +
    `</main><script type="application/json" id="chart-data">${JSON.stringify(chartData).replace(/</g, '\\u003c')}</script><script>${SCRIPT}</script></body></html>`;
}

/** Read a CSV folder and write the report; returns the output path. */
function writeReport(dir, { out, now = Date.now() } = {}) {
  const rows = readHistory(dir, now - 7 * DAY);
  const file = out || path.join(dir, 'memory-report.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildReport(rows, { now, source: dir }));
  return file;
}

/** Open a file with the OS default app (the browser for .html). */
function openFile(file) {
  let cmd;
  let args;
  if (process.platform === 'win32') { cmd = 'explorer.exe'; args = [file]; }
  else if (process.platform === 'darwin') { cmd = 'open'; args = [file]; }
  else if (process.env.WSL_DISTRO_NAME) {
    let winPath = file;
    try { winPath = require('child_process').execFileSync('wslpath', ['-w', file], { encoding: 'utf8' }).trim(); } catch { /* keep */ }
    cmd = 'explorer.exe'; args = [winPath];
  } else { cmd = 'xdg-open'; args = [file]; }
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* ignore */ }
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const flag = (name) => { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; };
  const out = opt('--out');
  const nowArg = opt('--now');
  const open = flag('--open');
  const dir = args[0];
  if (!dir || flag('--help')) {
    console.error('Usage: memory-report <csv dir> [--out <file.html>] [--open] [--now <ISO time>]');
    return 2;
  }
  const now = nowArg ? Date.parse(nowArg) : Date.now();
  const file = writeReport(path.resolve(dir), { out: out && path.resolve(out), now });
  console.log(file);
  if (open) openFile(file);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv);

module.exports = { buildReport, writeReport, computeStats, seriesPoints, offlineBands, niceMax, openFile, main };
