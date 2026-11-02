/**
 * Memory reporting for the VoiceDock Piper server.
 *
 * The server itself is a small Node process; the memory that matters while
 * reading is the piper.exe child it spawns per request, which loads a voice
 * (60-150 MB) and exits when the chunk is done. This module tracks those
 * children ("readers") so GET /health can report live memory cheaply:
 *
 * - The Node server's own RSS comes from process.memoryUsage() (no syscall cost).
 * - A reader's RSS is sampled in the background while it runs (Linux /proc,
 *   `ps` on macOS, `tasklist` on Windows), never on the request path, and the
 *   peak of the last finished reader is kept so short reads still show up.
 */

const fs = require("fs/promises");
const { execFile } = require("child_process");

const MB = 1024 * 1024;
const round1 = (n) => Math.round(n * 10) / 10;

/** The Node server's own resident memory in MB. */
function serverRssMb() {
  return round1(process.memoryUsage().rss / MB);
}

/** Parse the "Mem Usage" column of `tasklist /FO CSV /NH` ("63,412 K") to MB. */
function parseTasklistMemMb(csvLine) {
  const fields = String(csvLine || "").trim().match(/"([^"]*)"/g);
  if (!fields || fields.length < 5) return null;
  const kb = parseInt(fields[4].replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(kb) ? round1(kb / 1024) : null;
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

/**
 * Resident memory of another process in MB, or null when it is gone or the
 * platform gives no cheap answer.
 */
async function processRssMb(pid, platform = process.platform) {
  if (!pid) return null;
  if (platform === "linux") {
    try {
      const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      return match ? round1(parseInt(match[1], 10) / 1024) : null;
    } catch {
      return null;
    }
  }
  if (platform === "win32") {
    const out = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    return out ? parseTasklistMemMb(out.split(/\r?\n/)[0]) : null;
  }
  const out = await run("ps", ["-o", "rss=", "-p", String(pid)]);
  const kb = out ? parseInt(out.trim(), 10) : NaN;
  return Number.isFinite(kb) ? round1(kb / 1024) : null;
}

/**
 * Tracks the piper children in flight.
 *
 * @param {object} [options]
 * @param {(pid: number) => Promise<number|null>} [options.sampleRss] reader RSS sampler
 * @param {number} [options.firstSampleMs] delay before the first sample (the voice is loading)
 * @param {number} [options.intervalMs] sampling interval while a reader runs
 * @param {() => number} [options.now] wall clock in ms
 */
function createReaderTracker({
  sampleRss = processRssMb,
  firstSampleMs = 250,
  intervalMs = 1000,
  now = Date.now,
} = {}) {
  const readers = new Map(); // pid -> { pid, voice, startedAt, rssMb, peakRssMb, timer }
  let lastSpeakAt = null;
  let lastVoice = null;
  let lastReaderPeakRssMb = null;

  async function sample(reader) {
    const rss = await sampleRss(reader.pid);
    if (!readers.has(reader.pid)) return; // finished while sampling
    if (rss != null) {
      reader.rssMb = rss;
      reader.peakRssMb = Math.max(reader.peakRssMb || 0, rss);
    }
    reader.timer = setTimeout(() => sample(reader), intervalMs);
    if (reader.timer.unref) reader.timer.unref();
  }

  function finish(pid) {
    const reader = readers.get(pid);
    if (!reader) return;
    clearTimeout(reader.timer);
    readers.delete(pid);
    if (reader.peakRssMb != null) lastReaderPeakRssMb = reader.peakRssMb;
  }

  return {
    /** Register a spawned piper child; it is dropped when it exits. */
    add(child, voice) {
      if (!child || !child.pid) return;
      const reader = {
        pid: child.pid,
        voice,
        startedAt: now(),
        rssMb: null,
        peakRssMb: null,
        timer: null,
      };
      readers.set(child.pid, reader);
      lastSpeakAt = reader.startedAt;
      lastVoice = voice;
      reader.timer = setTimeout(() => sample(reader), firstSampleMs);
      if (reader.timer.unref) reader.timer.unref();
      child.once("close", () => finish(child.pid));
      child.once("error", () => finish(child.pid));
    },

    /** Memory fields for /health. */
    snapshot() {
      const list = [...readers.values()].map((r) => ({ pid: r.pid, voice: r.voice, rssMb: r.rssMb }));
      const readerRssMb = round1(list.reduce((sum, r) => sum + (r.rssMb || 0), 0));
      const newest = [...readers.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
      return {
        speaking: list.length > 0,
        readers: list,
        readerRssMb,
        activeVoice: newest ? newest.voice : null,
        lastVoice,
        lastSpeakAt: lastSpeakAt == null ? null : new Date(lastSpeakAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
        lastReaderPeakRssMb,
      };
    },
  };
}

module.exports = { serverRssMb, processRssMb, parseTasklistMemMb, createReaderTracker };
