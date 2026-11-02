// ─── Constants ────────────────────────────────────────────────────────────────
// Engine URLs, the seed profile, engine selection and the settings migration
// are shared with the React UI (src/shared.js) so they can't drift apart.
import {
  LOCAL_ENGINE_IDS,
  chooseEngine,
  defaultProfile,
  engineBaseUrl,
  engineLabel,
  normalizeProfile,
  runSettingsMigration,
} from "./src/shared.js";

const OFFSCREEN_URL  = "offscreen.html";

async function getProfileState() {
  const state = await chrome.storage.local.get(["profiles", "activeId"]);
  const profiles = Array.isArray(state.profiles) ? state.profiles.map(normalizeProfile) : [];
  let activeId = state.activeId || "";

  if (profiles.length === 0) {
    const profile = defaultProfile();
    await chrome.storage.local.set({ profiles: [profile], activeId: profile.id });
    return { profiles: [profile], activeId: profile.id };
  }

  if (!activeId || !profiles.some(p => p.id === activeId)) {
    activeId = profiles[0].id;
    await chrome.storage.local.set({ activeId });
  }

  return { profiles, activeId };
}

// ─── Context Menu Builder ─────────────────────────────────────────────────────
// Rebuilds context menus from stored profiles. Called on install and whenever
// profiles change.
async function rebuildMenus() {
  await chrome.contextMenus.removeAll();

  const { profiles, activeId } = await getProfileState();

  // Main read item — uses the active profile
  chrome.contextMenus.create({
    id:       "read-selection",
    title:    "Read selected text aloud",
    contexts: ["selection"]
  });

  // Per-profile submenu (only shown when there's more than one profile)
  if (profiles.length > 1) {
    chrome.contextMenus.create({
      id:       "read-as",
      title:    "Read as…",
      contexts: ["selection"]
    });
    for (const p of profiles) {
      chrome.contextMenus.create({
        id:       `profile-${p.id}`,
        parentId: "read-as",
        title:    p.name + (p.id === activeId ? " ✓" : ""),
        contexts: ["selection"]
      });
    }
  }

  chrome.contextMenus.create({
    id:       "stop-reading",
    title:    "Stop reading",
    contexts: ["all"],
    visible:  _isPlaying
  });
}

async function setStopMenuVisible(visible) {
  try {
    await chrome.contextMenus.update("stop-reading", { visible });
  } catch (err) {
    // The menu may not exist yet immediately after install or service worker startup.
    if (!err.message?.includes("Cannot find menu item")) {
      console.error("[TTS] setStopMenuVisible failed:", err);
    }
  }
}

// Settings saved by Piper TTS 1.0.x (profiles without an engine, the single
// favorites list, fallbackToBrowser) are upgraded in place; see
// migrateSettings in src/shared.js. Runs on install/update and on browser
// startup, and is idempotent.
async function migrateAndRebuild() {
  await runSettingsMigration(chrome.storage.local);
  await rebuildMenus();
}

chrome.runtime.onInstalled.addListener(() => {
  migrateAndRebuild().catch(err => console.error("[VoiceDock] migration failed:", err));
});
chrome.runtime.onStartup?.addListener(() => {
  migrateAndRebuild().catch(err => console.error("[VoiceDock] migration failed:", err));
});

// Rebuild whenever profiles or activeId change (popup saved new data).
// Debounced to prevent concurrent rebuilds when both keys change in one save.
let _rebuildTimer = null;
chrome.storage.onChanged.addListener((changes) => {
  if (changes.profiles || changes.activeId) {
    clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(
      () => rebuildMenus().catch(err => console.error("[TTS] rebuildMenus failed:", err)),
      50
    );
  }
});

// ─── Offscreen Document ───────────────────────────────────────────────────────
async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url:           OFFSCREEN_URL,
      reasons:       ["AUDIO_PLAYBACK"],
      justification: "Play locally generated text-to-speech audio."
    });
  } catch (err) {
    if (!err.message?.includes("Only a single offscreen document")) throw err;
  }
}

// ─── Browser TTS ─────────────────────────────────────────────────────────────
function speakWithBrowser(text, settings) {
  const effectiveSettings = settings || {};
  const generation = ++_browserSpeakGeneration;
  _activeEngineRequest = null;
  chrome.tts.stop();
  _isPlaying = true;   // reuse the playing flag so popup + keyboard toggle work
  _isPaused  = false;
  _playbackEngine = "browser";
  _currentVolume  = Math.min(1, effectiveSettings.volume ?? 1.0); // browser TTS capped at 1
  _currentRate    = effectiveSettings.rate ?? 1.0;
  _playbackProgress = {
    active: true,
    engine: "browser",
    current: 0,
    total: 0,
    percent: null,
    label: "Browser voice"
  };
  setStopMenuVisible(true);
  notifyPlaybackState();
  chrome.tts.speak(text, {
    rate:   effectiveSettings.rate   ?? 1.0,
    pitch:  1.0,
    volume: _currentVolume,
    enqueue: false,
    onEvent: (e) => {
      if (generation !== _browserSpeakGeneration || _playbackEngine !== "browser") return;
      if (e.type === "end" || e.type === "interrupted" || e.type === "cancelled") {
        _isPlaying = false;
        _isPaused  = false;
        _playbackEngine = null;
        resetProgress();
        setStopMenuVisible(false);
        notifyPlaybackState();
      }
      if (e.type === "error") {
        console.error("tts error:", e.errorMessage);
        _isPlaying = false;
        _isPaused  = false;
        _playbackEngine = null;
        resetProgress();
        setStopMenuVisible(false);
        notifyPlaybackState();
      }
    }
  });
}

// ─── Engine Health Checks (per engine, 5-second cache) ───────────────────────
const _engineOnlineCache = Object.fromEntries(
  LOCAL_ENGINE_IDS.map(id => [id, { value: false, expiresAt: 0 }])
);

async function checkEngineOnline(engine) {
  const cache = _engineOnlineCache[engine];
  const baseUrl = engineBaseUrl(engine);
  if (!cache || !baseUrl) return false;
  if (Date.now() < cache.expiresAt) return cache.value;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res   = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    _engineOnlineCache[engine] = { value: res.ok, expiresAt: Date.now() + 5000 };
    return res.ok;
  } catch (_) {
    _engineOnlineCache[engine] = { value: false, expiresAt: Date.now() + 2000 };
    return false;
  }
}

function invalidateEngineCache() {
  for (const id of LOCAL_ENGINE_IDS) _engineOnlineCache[id].expiresAt = 0;
}

// ─── Playback State ───────────────────────────────────────────────────────────
let _isPlaying    = false;
let _isPaused     = false;
let _playbackEngine    = null; // "piper", "kokoro" or "browser"
let _playingSourceTabId = null; // tab that triggered the current playback
let _currentVolume     = 1.0;  // cached from active profile; sent to content script overlay
let _currentRate       = 1.0;  // cached from active profile; sent to content script overlay
let _playbackProgress  = { active: false, engine: null, current: 0, total: 0, percent: null, label: "" };
let _activeEngineRequest = null;
let _browserSpeakGeneration = 0;

function resetProgress() {
  _playbackProgress = { active: false, engine: null, current: 0, total: 0, percent: null, label: "" };
}

function playbackStateForTab(tabId) {
  return {
    isPlaying: _isPlaying,
    isPaused:  _isPaused,
    volume:    _currentVolume,
    rate:      _currentRate,
    engine:    _playbackEngine,
    progress:  _playbackProgress
  };
}

function sendPlaybackStateToTab(tabId) {
  chrome.tabs.sendMessage(tabId, {
    type: "playback-state",
    state: playbackStateForTab(tabId)
  }).catch(() => {});
}

function notifyPlaybackState(tabId = null) {
  if (tabId != null) {
    sendPlaybackStateToTab(tabId);
    return;
  }

  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs) {
      if (tab.id != null) sendPlaybackStateToTab(tab.id);
    }
  });
}

// ─── Local engine TTS (Piper or Kokoro, played by the offscreen document) ────
async function speakWithEngine(engine, text, settings) {
  const online = await checkEngineOnline(engine);
  if (!online) throw new Error(`${engineLabel(engine)} server is offline`);

  _browserSpeakGeneration++;
  chrome.tts.stop();
  _activeEngineRequest = { text, settings: { ...settings } };
  _isPlaying = true;
  _isPaused  = false;
  _playbackEngine = engine;
  _currentVolume  = settings.volume ?? 1.0;
  _currentRate    = settings.rate ?? 1.0;
  _playbackProgress = {
    active: true,
    engine,
    current: 0,
    total: 0,
    percent: 0,
    label: "Starting"
  };
  setStopMenuVisible(true);
  notifyPlaybackState();
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    // Unexpected offscreen creation error — reset flag so the popup/shortcut
    // don't get stuck in "Playing" state forever.
    _isPlaying = false;
    _playbackEngine = null;
    _activeEngineRequest = null;
    resetProgress();
    setStopMenuVisible(false);
    notifyPlaybackState();
    throw err;
  }
  chrome.runtime.sendMessage({
    type:    "speak-text",
    text,
    engine,
    ttsUrl:  `${engineBaseUrl(engine)}/tts`,
    rate:    settings.rate   ?? 1.0,
    volume:  settings.volume ?? 1.0,
    voice:   settings.voice  || ""
  }).catch((err) => {
    console.error("speak-text delivery failed:", err);
    _isPlaying = false; // delivery failed - no playback-ended will ever arrive
    _playbackEngine = null;
    _activeEngineRequest = null;
    resetProgress();
    setStopMenuVisible(false);
    notifyPlaybackState();
  });
}

// ─── Stop All ────────────────────────────────────────────────────────────────
async function stopAll() {
  _isPlaying    = false;
  _isPaused     = false;
  _playbackEngine    = null;
  _playingSourceTabId = null;
  _activeEngineRequest = null;
  _browserSpeakGeneration++;
  resetProgress();
  invalidateEngineCache(); // so the next read checks the engines fresh
  await setStopMenuVisible(false);
  notifyPlaybackState();
  chrome.tts.stop();
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    if (existing.length > 0) chrome.runtime.sendMessage({ type: "stop-audio" }).catch(() => {});
  } catch (_) {}
}

// ─── Speak with a profile (its engine, falling back to the browser voice) ────
// Returns { ok, engine, fellBack, error } so callers (the popup's Test button,
// the page hint) can say what actually happened.
async function speakText(text, profile, tabId = null) {
  const settings = normalizeProfile(profile || {});
  const { fallback = true } = await chrome.storage.local.get("fallback");

  let online = {};
  if (settings.engine !== "browser") {
    online = { [settings.engine]: await checkEngineOnline(settings.engine) };
  }
  let choice = chooseEngine(settings, online, fallback);

  if (choice.engine && choice.engine !== "browser") {
    try {
      await speakWithEngine(choice.engine, text, { ...settings, voice: choice.voice });
      return { ok: true, engine: choice.engine, fellBack: false };
    } catch (err) {
      console.error(`${engineLabel(choice.engine)} failed:`, err.message);
      choice = fallback
        ? { engine: "browser", fellBack: true, reason: err.message }
        : { engine: null, reason: err.message };
    }
  }

  if (choice.engine === "browser") {
    if (choice.fellBack) {
      console.log(`${choice.reason}; falling back to the browser voice`);
      if (tabId != null) showTabHint({ id: tabId }, `${choice.reason}. Using the browser voice.`);
    }
    speakWithBrowser(text, settings);
    return { ok: true, engine: "browser", fellBack: choice.fellBack };
  }

  if (tabId != null) showTabHint({ id: tabId }, `${choice.reason}. Turn on the browser fallback in Settings to hear it anyway.`);
  return { ok: false, engine: null, fellBack: false, error: choice.reason };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getTabSelection(tab) {
  if (!tab?.id) return "";
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "get-selection" });
    return response?.text?.trim() || "";
  } catch (_) {
    return "";
  }
}

function showTabHint(tab, message) {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "show-hint", message }).catch(() => {});
}

async function readSelectionFromActiveTab() {
  if (_isPlaying) {
    await stopAll();
    return;
  }

  const tab = await getActiveTab();
  const text = await getTabSelection(tab);
  if (!text) {
    showTabHint(tab, "Select text first");
    return;
  }

  const { profiles, activeId } = await getProfileState();
  const profile = profiles.find(p => p.id === activeId) || profiles[0];
  if (!profile) return;

  _playingSourceTabId = tab.id;
  await speakText(text, profile, tab.id);
}

async function togglePauseResume() {
  if (_isPaused) {
    _isPaused = false;
    if (_playbackEngine === "browser") {
      chrome.tts.resume();
    } else {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
      }).catch(() => []);
      if (existing.length > 0) chrome.runtime.sendMessage({ type: "resume-audio" }).catch(() => {});
    }
  } else if (_isPlaying) {
    _isPaused = true;
    if (_playbackEngine === "browser") {
      chrome.tts.pause();
    } else {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
      }).catch(() => []);
      if (existing.length > 0) chrome.runtime.sendMessage({ type: "pause-audio" }).catch(() => {});
    }
  }
  notifyPlaybackState();
}

// ─── Context Menu Click Handler ───────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "stop-reading") { await stopAll(); return; }

  const text = info.selectionText?.trim();
  if (!text) return;

  let { profiles, activeId } = await getProfileState();

  // If a specific profile was chosen from the submenu, switch to it and read
  // with the newly selected profile.
  if (info.menuItemId.startsWith("profile-")) {
    activeId = info.menuItemId.replace("profile-", "");
    // Cancel any pending debounced rebuild before our own await so the
    // storage.onChanged listener (which fires when we set activeId below)
    // doesn't schedule a second rebuild that races with the one we're about to do.
    clearTimeout(_rebuildTimer);
    await chrome.storage.local.set({ activeId });
    await rebuildMenus();
    // Also read the selected text with the newly chosen profile
    const selectedProfile = profiles.find(p => p.id === activeId);
    _playingSourceTabId = tab?.id ?? null;
    if (selectedProfile && text) await speakText(text, selectedProfile, tab?.id ?? null);
    return;
  }

  const profile = profiles.find(p => p.id === activeId) || profiles[0];
  if (!profile) return;

  _playingSourceTabId = tab?.id ?? null;
  await speakText(text, profile, tab?.id ?? null);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "read-selection") {
    readSelectionFromActiveTab().catch(err => console.error("[command:read-selection]", err));
    return;
  }
  if (command === "pause-resume") {
    togglePauseResume().catch(err => console.error("[command:pause-resume]", err));
  }
});

// ─── Messages from Popup / Content Script / Offscreen ────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content script tab is navigating/closing — stop if it was the source tab
  if (message.type === "tab-unloading") {
    if (_playingSourceTabId !== null && sender.tab?.id === _playingSourceTabId) {
      stopAll();
    }
    return;
  }
  // stop-all: fire-and-forget — respond immediately so the popup can close
  // without leaving an open message channel that Chrome will kill mid-flight.
  if (message.type === "stop-all") {
    stopAll();
    sendResponse({ ok: true });
    return; // synchronous — no return true, no dangling channel
  }

  // Offscreen notifies us when queue finishes naturally
  if (message.type === "playback-ended") {
    _isPlaying = false;
    _isPaused  = false;
    _playbackEngine = null;
    _playingSourceTabId = null;
    _activeEngineRequest = null;
    resetProgress();
    setStopMenuVisible(false);
    notifyPlaybackState();
    return;
  }

  if (message.type === "playback-error") {
    const request = _activeEngineRequest;
    _isPlaying = false;
    _isPaused  = false;
    _playbackEngine = null;
    _playingSourceTabId = null;
    _activeEngineRequest = null;
    resetProgress();
    setStopMenuVisible(false);
    notifyPlaybackState();

    (async () => {
      const { fallback = true } = await chrome.storage.local.get("fallback");
      const label = engineLabel(message.engine || request?.settings?.engine);
      if (fallback && request?.text) {
        console.warn(`${label} playback failed; falling back to browser TTS:`, message.error);
        speakWithBrowser(request.text, request.settings || {});
      } else {
        console.error(`${label} playback failed:`, message.error);
      }
    })().catch(err => console.error("[playback-error]", err));
    return;
  }

  if (message.type === "playback-progress") {
    const current = Math.max(0, Number(message.current) || 0);
    const total = Math.max(0, Number(message.total) || 0);
    _playbackProgress = {
      active: true,
      engine: message.engine || _playbackEngine,
      current,
      total,
      percent: typeof message.percent === "number" ? Math.max(0, Math.min(1, message.percent)) : null,
      label: message.label || (total > 0 ? `${current}/${total}` : "")
    };
    notifyPlaybackState();
    return;
  }

  // Content scripts use this once on startup; playback changes are pushed to
  // every tab so the overlay follows the user across normal webpages.
  if (message.type === "get-playback-state") {
    sendResponse(playbackStateForTab(sender.tab?.id));
    return; // synchronous
  }

  // Test button (popup / options): speak with the given settings and report
  // which engine actually played, so the UI can say "Kokoro is offline, used
  // the browser voice" instead of silently sounding different.
  if (message.type === "test-voice") {
    const { text, settings = {} } = message;
    speakText(text, settings)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Keyboard shortcut: Alt+Shift+R — always START reading with selected text.
  // Stop is handled in the content script (sends stop-all when _localPlaying is true).
  // This avoids the wrong-tab problem where Tab B's poll saw Tab A as "playing"
  // and keyboard-read would stop instead of start.
  if (message.type === "keyboard-read") {
    const text = message.text || "";
    if (!text) return;
    _playingSourceTabId = sender.tab?.id ?? null;
    (async () => {
      const { profiles, activeId } = await getProfileState();
      const profile = profiles.find(p => p.id === activeId) || profiles[0];
      if (profile) await speakText(text, profile, sender.tab?.id ?? null);
    })().catch(err => console.error("[keyboard-read]", err));
    return;
  }

  // Overlay rocker: change the CURRENT playback's volume/speed only. These are
  // deliberately NOT written back to the active profile — the profile keeps its
  // saved presets; this just nudges what's playing right now.
  if (message.type === "set-live-volume" || message.type === "set-live-rate") {
    const isVolume = message.type === "set-live-volume";
    const value = isVolume
      ? Math.max(0, Math.min(2.0, message.volume ?? 1.0))
      : Math.max(0.5, Math.min(2.5, message.rate ?? 1.0));

    if (isVolume) _currentVolume = value; else _currentRate = value;

    // Forward to the offscreen player for real-time adjustment. (The
    // browser-TTS engine can't change mid-utterance, so the overlay disables
    // the rocker in that case and won't send these.)
    (async () => {
      try {
        const existing = await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
        }).catch(() => []);
        if (existing.length > 0) {
          chrome.runtime.sendMessage(
            isVolume ? { type: "set-volume", volume: value } : { type: "set-rate", rate: value }
          ).catch(() => {});
        }
      } catch (_) {}
    })();

    sendResponse({ ok: true, value });
    return true; // async response
  }

  // Keyboard shortcut: Alt+Shift+D — pause/resume toggle
  if (message.type === "keyboard-pause") {
    togglePauseResume().catch(err => console.error("[keyboard-pause]", err));
    return;
  }
});
