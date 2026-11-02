// Shared by the service worker (background.js imports this file directly) and
// the React UI bundles, so engine URLs, the seed profile, and the settings
// migration can't drift between them. Keep it free of JSX and DOM APIs.

export const APP_NAME = 'VoiceDock';

// ─── Engines ─────────────────────────────────────────────────────────────────
// Piper and Kokoro are local servers speaking the same API (docs/API.md);
// "browser" is Chrome's built-in chrome.tts voice.
export const ENGINES = {
  piper: {
    id: 'piper',
    label: 'Piper',
    baseUrl: 'http://127.0.0.1:7477',
    local: true,
    blurb: 'Fast local voices (Node.js server on port 7477).',
  },
  kokoro: {
    id: 'kokoro',
    label: 'Kokoro',
    baseUrl: 'http://127.0.0.1:7478',
    local: true,
    blurb: 'More natural local voices in 9 languages (Python server on port 7478).',
  },
  browser: {
    id: 'browser',
    label: 'Browser voice',
    baseUrl: null,
    local: false,
    blurb: "Chrome's built-in voice. Always available.",
  },
};
export const ENGINE_IDS = ['piper', 'kokoro', 'browser'];
export const LOCAL_ENGINE_IDS = ['piper', 'kokoro'];

export const PIPER_BASE_URL = ENGINES.piper.baseUrl;
export const KOKORO_BASE_URL = ENGINES.kokoro.baseUrl;

export const MAX_PROFILES = 5;
export const MAX_FAVORITES = 5; // per engine
export const SETTINGS_VERSION = 2;

export function isEngine(id) {
  return Object.prototype.hasOwnProperty.call(ENGINES, id);
}

export function engineLabel(id) {
  return isEngine(id) ? ENGINES[id].label : 'Unknown engine';
}

export function engineBaseUrl(id) {
  return isEngine(id) ? ENGINES[id].baseUrl : null;
}

// Profiles saved before engines existed only have a voice: an empty voice was
// the browser voice and every other voice was a Piper .onnx file. Kokoro voice
// ids look like "af_heart".
export function inferEngine(voice) {
  if (!voice) return 'browser';
  if (/\.onnx$/i.test(voice)) return 'piper';
  return 'kokoro';
}

function clampNumber(value, min, max, fallback) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Returns a profile with every field present and valid. Never mutates.
export function normalizeProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const voice = typeof p.voice === 'string' ? p.voice : '';
  const engine = isEngine(p.engine) ? p.engine : inferEngine(voice);
  return {
    ...p,
    id: typeof p.id === 'string' && p.id ? p.id : uuid(),
    name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Profile',
    engine,
    voice: engine === 'browser' ? '' : voice,
    rate: clampNumber(p.rate, 0.5, 2.5, 1.0),
    volume: clampNumber(p.volume, 0, 2, 1.0),
  };
}

export function defaultProfile() {
  return { id: 'default', name: 'Profile 1', engine: 'browser', voice: '', rate: 1.0, volume: 1.0 };
}

// ─── Settings migration ──────────────────────────────────────────────────────
// Pure: takes everything in chrome.storage.local and returns what to write and
// what to remove. Safe to run any number of times (idempotent), from the
// service worker on install/update/startup and from the UI pages on load.
//
// v1 (Piper TTS <= 1.0.x) → v2 (VoiceDock 1.1):
//   fallbackToBrowser    → fallback
//   profiles[].voice     → profiles[].engine + voice (engine inferred)
//   profile "Default"    → "Profile 1" (the seed profile's old name)
//   favorites (one list) → favoritesByEngine { piper, kokoro }
export function migrateSettings(raw = {}) {
  const set = {};
  const remove = [];

  if (raw.fallbackToBrowser !== undefined) {
    if (raw.fallback === undefined) set.fallback = raw.fallbackToBrowser !== false;
    remove.push('fallbackToBrowser');
  }

  if (Array.isArray(raw.profiles)) {
    const profiles = raw.profiles.map((profile) => {
      const next = normalizeProfile(profile);
      if (next.id === 'default' && next.name === 'Default') next.name = 'Profile 1';
      return next;
    });
    if (JSON.stringify(profiles) !== JSON.stringify(raw.profiles)) set.profiles = profiles;
  }

  const byEngine = raw.favoritesByEngine && typeof raw.favoritesByEngine === 'object'
    ? raw.favoritesByEngine
    : null;
  if (raw.favorites !== undefined) {
    // Merge rather than overwrite, so a legacy list is never lost even if
    // favoritesByEngine was already seeded (for example by a migration that
    // ran on an empty store moments before old settings were restored).
    const legacy = Array.isArray(raw.favorites) ? raw.favorites.filter((v) => typeof v === 'string') : [];
    const merged = {};
    for (const engine of LOCAL_ENGINE_IDS) {
      const existing = favoritesFor(byEngine, engine);
      const extra = legacy.filter((v) => inferEngine(v) === engine && !existing.includes(v));
      merged[engine] = [...existing, ...extra].slice(0, MAX_FAVORITES);
    }
    set.favoritesByEngine = merged;
    remove.push('favorites');
  } else if (!byEngine) {
    set.favoritesByEngine = { piper: [], kokoro: [] };
  }

  if (raw.settingsVersion !== SETTINGS_VERSION) set.settingsVersion = SETTINGS_VERSION;

  return { set, remove };
}

// Applies migrateSettings to chrome.storage.local (or any object with the same
// get/set/remove promise API). Returns the migrated snapshot.
export async function runSettingsMigration(storage) {
  const raw = await storage.get(null);
  const { set, remove } = migrateSettings(raw);
  if (Object.keys(set).length > 0) await storage.set(set);
  if (remove.length > 0) await storage.remove(remove);
  const next = { ...raw, ...set };
  for (const key of remove) delete next[key];
  return next;
}

export function favoritesFor(favoritesByEngine, engine) {
  const list = favoritesByEngine?.[engine];
  return Array.isArray(list) ? list : [];
}

// ─── Formatting ──────────────────────────────────────────────────────────────
export function fmt(value) {
  return Number.parseFloat(value).toFixed(1);
}

export function uuid() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const KOKORO_LANGUAGES = {
  a: 'US English',
  b: 'UK English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Portuguese',
  z: 'Mandarin',
};

// "af_heart" → { name: "Heart", language: "US English", gender: "female" }
export function kokoroVoiceDetails(voice) {
  const match = /^([a-z])([fm])_(.+)$/i.exec(voice || '');
  if (!match) return null;
  const [, lang, gender, rest] = match;
  return {
    name: rest.charAt(0).toUpperCase() + rest.slice(1),
    language: KOKORO_LANGUAGES[lang.toLowerCase()] || 'Other',
    gender: gender.toLowerCase() === 'f' ? 'female' : 'male',
  };
}

export function formatVoiceName(voice, empty = 'Chrome default voice') {
  if (!voice) return empty;
  if (inferEngine(voice) === 'kokoro') {
    const details = kokoroVoiceDetails(voice);
    return details ? `${details.name} · ${details.language}` : voice;
  }
  const base = voice.replace(/\.onnx$/, '');
  const parts = base.split('-');
  if (parts.length >= 3) {
    const name = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    const quality = parts[2].charAt(0).toUpperCase() + parts[2].slice(1);
    return `${name} · ${quality}`;
  }
  return base;
}

// One line for a profile's voice, e.g. "Kokoro · Heart · US English".
// compact drops the Kokoro language ("Kokoro · Heart") for the narrow popup.
export function describeProfileVoice(profile, { compact = false } = {}) {
  const p = normalizeProfile(profile);
  if (p.engine === 'browser') return 'Chrome default voice';
  const kokoro = compact && p.engine === 'kokoro' ? kokoroVoiceDetails(p.voice) : null;
  const voiceName = kokoro ? kokoro.name : formatVoiceName(p.voice, 'default voice');
  return `${engineLabel(p.engine)} · ${voiceName}`;
}

export function qualityFromFilename(filename) {
  const base = filename.replace(/\.onnx$/, '');
  const parts = base.split('-');
  const tier = parts[parts.length - 1]?.toLowerCase();
  const map = { x_low: 'x_low', low: 'low', medium: 'med', high: 'high' };
  return map[tier] || null;
}

export function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

// ─── Engine selection (pure, used by the service worker) ─────────────────────
// Decides how to speak for a profile given which local engines are up:
//   { engine: "piper" | "kokoro" | "browser", voice, fellBack, reason }
// A local engine that's offline falls back to the browser voice when the
// fallback setting is on; otherwise there's nothing to play (engine: null).
export function chooseEngine(profile, onlineByEngine, fallback = true) {
  const p = normalizeProfile(profile);
  if (p.engine === 'browser') {
    return { engine: 'browser', voice: '', fellBack: false, reason: '' };
  }
  if (onlineByEngine?.[p.engine]) {
    return { engine: p.engine, voice: p.voice, fellBack: false, reason: '' };
  }
  const reason = `${engineLabel(p.engine)} is offline`;
  if (fallback) return { engine: 'browser', voice: '', fellBack: true, reason };
  return { engine: null, voice: '', fellBack: false, reason };
}
