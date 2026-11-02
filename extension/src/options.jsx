import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  APP_NAME,
  defaultProfile,
  describeProfileVoice,
  ENGINES,
  engineBaseUrl,
  engineLabel,
  ENGINE_IDS,
  favoritesFor,
  fmt,
  formatBytes,
  formatVoiceName,
  kokoroVoiceDetails,
  LOCAL_ENGINE_IDS,
  MAX_FAVORITES,
  MAX_PROFILES,
  normalizeProfile,
  PIPER_BASE_URL,
  qualityFromFilename,
  runSettingsMigration,
  uuid,
} from './shared.js';

const TABS = ['profiles', 'voices', 'settings', 'about', 'credits'];
const CHROME_COMMANDS = [
  ['read-selection', 'Read / Stop toggle'],
  ['pause-resume', 'Pause / Resume'],
];

function tabFromHash() {
  const route = window.location.hash.replace(/^#\/?/, '').toLowerCase();
  return TABS.includes(route) ? route : 'profiles';
}

function IconPencil() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

const ENGINE_SETUP = {
  piper: {
    folder: 'servers/piper/',
    command: 'npm run setup',
    what: 'to install Piper, a voice, and the tray.',
    anchor: 'piper-server',
  },
  kokoro: {
    folder: 'servers/kokoro/',
    command: './setup.sh && ./install-service.sh',
    what: 'in WSL or Linux to download the Kokoro model (338 MB, once) and run it as a service.',
    anchor: 'kokoro-server',
  },
};

function statusText(online) {
  if (online === null || online === undefined) return 'checking…';
  return online ? 'online' : 'offline';
}

function EngineSelect({ value, engineStatus, onChange }) {
  return (
    <select className="form-select profile-engine-sel" value={value} onChange={(event) => onChange(event.target.value)}>
      {ENGINE_IDS.map((id) => (
        <option key={id} value={id}>
          {ENGINES[id].label}{ENGINES[id].local ? ` (${statusText(engineStatus[id])})` : ''}
        </option>
      ))}
    </select>
  );
}

function VoiceSelect({ engine, value, voices, favorites, online, defaultVoice, onChange }) {
  const sorted = useMemo(() => [
    ...voices.filter((voice) => favorites.includes(voice)).sort(),
    ...voices.filter((voice) => !favorites.includes(voice)).sort(),
  ], [voices, favorites]);

  if (engine === 'browser') {
    return (
      <select className="form-select profile-voice-sel" value="" disabled>
        <option value="">Chrome default voice</option>
      </select>
    );
  }

  // A saved voice the engine doesn't list right now (engine offline, or the
  // voice was removed) stays selectable so editing other fields never drops it.
  const missing = value && !voices.includes(value);
  const defaultLabel = defaultVoice ? `Default voice (${formatVoiceName(defaultVoice)})` : 'Default voice';
  return (
    <select className="form-select profile-voice-sel" value={value || ''} onChange={(event) => onChange(event.target.value)}>
      <option value="">{online === false ? `${defaultLabel}, ${engineLabel(engine)} offline` : defaultLabel}</option>
      {missing && <option value={value}>{formatVoiceName(value)} (not available now)</option>}
      {sorted.map((voice) => (
        <option key={voice} value={voice}>
          {favorites.includes(voice) ? '★ ' : ''}{formatVoiceName(voice)}
        </option>
      ))}
    </select>
  );
}

function emptyEngineMap(value) {
  return Object.fromEntries(LOCAL_ENGINE_IDS.map((id) => [id, typeof value === 'function' ? value() : value]));
}

function Modal({ modal, onConfirm, onCancel }) {
  if (!modal) return null;
  const alertMode = modal.kind === 'alert';
  return (
    <div className="modal-overlay">
      <div className="modal-box" role="dialog" aria-modal="true">
        <p className="modal-msg">{modal.message}</p>
        <div className="modal-actions">
          <button className={`btn ${alertMode ? 'btn-primary' : 'btn-danger'}`} onClick={onConfirm}>{alertMode ? 'Got it' : 'Delete'}</button>
          {!alertMode && <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}

function OptionsApp() {
  const [tab, setTab] = useState(tabFromHash);
  const [version, setVersion] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [favoritesByEngine, setFavoritesByEngine] = useState(() => emptyEngineMap(() => []));
  const [deletedVoices, setDeletedVoices] = useState([]);
  const [favsOnly, setFavsOnly] = useState(false);
  const [fallback, setFallback] = useState(true);
  const [voicesByEngine, setVoicesByEngine] = useState(() => emptyEngineMap(() => []));
  const [defaultVoiceByEngine, setDefaultVoiceByEngine] = useState(() => emptyEngineMap(''));
  const [voiceSizes, setVoiceSizes] = useState({});
  const [voiceDir, setVoiceDir] = useState('');
  const [voiceLoadError, setVoiceLoadError] = useState(() => emptyEngineMap(''));
  const [engineStatus, setEngineStatus] = useState(() => emptyEngineMap(null));
  const [voicesEngine, setVoicesEngine] = useState('piper');
  const [createOpen, setCreateOpen] = useState(false);
  const blankProfile = { name: '', engine: 'piper', voice: '', rate: 1.0, volume: 1.0 };
  const [createProfile, setCreateProfile] = useState(blankProfile);
  const [editingId, setEditingId] = useState('');
  const [editDrafts, setEditDrafts] = useState({});
  const [modal, setModal] = useState(null);
  const [chromeCommands, setChromeCommands] = useState([]);
  const [testingVoice, setTestingVoice] = useState('');
  const createNameRef = useRef(null);

  const activeProfile = profiles.find((profile) => profile.id === activeId) || profiles[0] || null;

  function persist(next) {
    const data = {
      profiles,
      activeId,
      favoritesByEngine,
      deletedVoices,
      favsOnly,
      fallback,
      ...next,
    };
    chrome.storage.local.set({
      profiles: data.profiles,
      activeId: data.activeId,
      favoritesByEngine: data.favoritesByEngine,
      deletedVoices: data.deletedVoices,
      favsOnly: data.favsOnly,
      fallback: data.fallback,
    });
  }

  function showAlert(message) {
    return new Promise((resolve) => {
      setModal({ kind: 'alert', message, resolve });
    });
  }

  function showConfirm(message) {
    return new Promise((resolve) => {
      setModal({ kind: 'confirm', message, resolve });
    });
  }

  function resolveModal(value) {
    modal?.resolve(value);
    setModal(null);
  }

  async function refreshChromeCommands() {
    const commands = await chrome.commands.getAll();
    setChromeCommands(commands);
  }

  function shortcutForCommand(name) {
    return chromeCommands.find((command) => command.name === name)?.shortcut || '';
  }

  function openChromeShortcuts() {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }

  function navigateTab(nextTab) {
    if (!TABS.includes(nextTab)) return;
    window.location.hash = nextTab;
  }

  async function checkEngineStatus(engine) {
    let ok = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${engineBaseUrl(engine)}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      ok = res.ok;
    } catch (_) {
      ok = false;
    }
    setEngineStatus((prev) => ({ ...prev, [engine]: ok }));
    return ok;
  }

  // Loads one engine's voice list. An offline engine keeps its last list (so
  // saved profile voices still show) and reports no error: the offline banner
  // already says what's wrong.
  async function fetchVoices(engine) {
    const online = await checkEngineStatus(engine);
    if (!online) {
      setVoiceLoadError((prev) => ({ ...prev, [engine]: '' }));
      return;
    }
    try {
      const res = await fetch(`${engineBaseUrl(engine)}/voices`);
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();
      setVoicesByEngine((prev) => ({ ...prev, [engine]: Array.isArray(data.voices) ? data.voices : [] }));
      setDefaultVoiceByEngine((prev) => ({ ...prev, [engine]: data.defaultVoice || '' }));
      if (engine === 'piper') {
        setVoiceSizes(data.sizes || {});
        setVoiceDir(data.voiceDir || '');
      }
      setVoiceLoadError((prev) => ({ ...prev, [engine]: '' }));
    } catch (error) {
      setVoicesByEngine((prev) => ({ ...prev, [engine]: [] }));
      if (engine === 'piper') {
        setVoiceSizes({});
        setVoiceDir('');
      }
      setVoiceLoadError((prev) => ({ ...prev, [engine]: `Failed to load ${engineLabel(engine)} voices: ${error.message}` }));
    }
  }

  function fetchAllVoices() {
    return Promise.all(LOCAL_ENGINE_IDS.map((engine) => fetchVoices(engine)));
  }

  useEffect(() => {
    async function init() {
      setVersion(`v${chrome.runtime.getManifest().version}`);

      // Upgrades settings saved by Piper TTS 1.0.x (see migrateSettings).
      const stored = await runSettingsMigration(chrome.storage.local);

      let nextProfiles = Array.isArray(stored.profiles) ? stored.profiles.map(normalizeProfile) : [];
      let nextActiveId = stored.activeId || '';
      if (nextProfiles.length === 0) {
        const profile = defaultProfile();
        nextProfiles = [profile];
        nextActiveId = profile.id;
        await chrome.storage.local.set({ profiles: nextProfiles, activeId: nextActiveId });
      }

      const resolvedActiveId = nextProfiles.some((profile) => profile.id === nextActiveId) ? nextActiveId : nextProfiles[0].id;
      setProfiles(nextProfiles);
      setActiveId(resolvedActiveId);
      setFavoritesByEngine({
        piper: favoritesFor(stored.favoritesByEngine, 'piper'),
        kokoro: favoritesFor(stored.favoritesByEngine, 'kokoro'),
      });
      setDeletedVoices(Array.isArray(stored.deletedVoices) ? stored.deletedVoices : []);
      setFavsOnly(stored.favsOnly === true);
      setFallback(stored.fallback !== false);
      const activeEngine = nextProfiles.find((profile) => profile.id === resolvedActiveId)?.engine;
      if (LOCAL_ENGINE_IDS.includes(activeEngine)) setVoicesEngine(activeEngine);
      await fetchAllVoices();
      await refreshChromeCommands();
    }
    init();
  }, []);

  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash());
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (!document.hidden) refreshChromeCommands();
    };
    window.addEventListener('focus', refreshChromeCommands);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.removeEventListener('focus', refreshChromeCommands);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, []);

  useEffect(() => {
    if (tab === 'voices') fetchVoices(voicesEngine);
  }, [tab, voicesEngine]);

  useEffect(() => {
    if (createOpen) createNameRef.current?.focus();
  }, [createOpen]);

  function setActive(profileId) {
    setActiveId(profileId);
    persist({ activeId: profileId });
  }

  function updateProfiles(nextProfiles, nextActiveId = activeId) {
    setProfiles(nextProfiles);
    setActiveId(nextActiveId);
    persist({ profiles: nextProfiles, activeId: nextActiveId });
  }

  async function createNewProfile() {
    const name = createProfile.name.trim();
    if (!name) {
      createNameRef.current?.focus();
      return;
    }
    if (profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
      await showAlert('A profile with this name already exists.');
      return;
    }
    const profile = normalizeProfile({
      id: uuid(),
      name,
      engine: createProfile.engine,
      voice: createProfile.voice,
      rate: createProfile.rate,
      volume: createProfile.volume,
    });
    updateProfiles([...profiles, profile], profiles.length === 0 ? profile.id : activeId);
    setCreateProfile(blankProfile);
    setCreateOpen(false);
  }

  async function deleteProfile(profileId) {
    if (profiles.length <= 1) return;
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    const confirmed = await showConfirm(`Delete profile "${profile.name}"?`);
    if (!confirmed) return;
    const nextProfiles = profiles.filter((item) => item.id !== profileId);
    updateProfiles(nextProfiles, activeId === profileId ? nextProfiles[0].id : activeId);
  }

  function beginEdit(profile) {
    setEditingId(profile.id);
    setEditDrafts({
      ...editDrafts,
      [profile.id]: {
        name: profile.name,
        engine: profile.engine,
        voice: profile.voice,
        rate: profile.rate ?? 1.0,
        volume: profile.volume ?? 1.0,
      },
    });
  }

  async function saveEdit(profileId) {
    const draft = editDrafts[profileId];
    const name = draft.name.trim();
    if (!name) return;
    if (profiles.some((profile) => profile.id !== profileId && profile.name.toLowerCase() === name.toLowerCase())) {
      await showAlert('A profile with this name already exists.');
      return;
    }
    updateProfiles(profiles.map((profile) =>
      profile.id === profileId
        ? normalizeProfile({ ...profile, name, engine: draft.engine, voice: draft.voice, rate: draft.rate, volume: draft.volume })
        : profile,
    ));
    setEditingId('');
  }

  function updateDraft(profileId, patch) {
    setEditDrafts({
      ...editDrafts,
      [profileId]: { ...editDrafts[profileId], ...patch },
    });
  }

  async function toggleFavorite(engine, voice) {
    const current = favoritesFor(favoritesByEngine, engine);
    let nextList;
    if (current.includes(voice)) {
      nextList = current.filter((favorite) => favorite !== voice);
    } else {
      if (current.length >= MAX_FAVORITES) {
        await showAlert(`You've reached the ${MAX_FAVORITES}-favorite limit for ${engineLabel(engine)}.\n\nUnstar a voice to make room for another.`);
        return;
      }
      nextList = [...current, voice];
    }
    const next = { ...favoritesByEngine, [engine]: nextList };
    setFavoritesByEngine(next);
    persist({ favoritesByEngine: next });
  }

  function testKey(settings) {
    return `${settings.engine}:${settings.voice || ''}`;
  }

  function testVoice(settings = {}) {
    const testSettings = normalizeProfile({ ...settings, name: 'Test' });
    setTestingVoice(testKey(testSettings));
    const voiceName = testSettings.engine === 'browser'
      ? 'Chrome default voice'
      : formatVoiceName(testSettings.voice, `${engineLabel(testSettings.engine)} default voice`);
    chrome.runtime.sendMessage({
      type: 'test-voice',
      text: `This is a test of the voice ${voiceName}.`,
      settings: testSettings,
    }, (response) => {
      setTestingVoice('');
      const runtimeErr = chrome.runtime.lastError;
      if (runtimeErr) {
        showAlert(`Extension error: ${runtimeErr.message}`);
        return;
      }
      if (response && !response.ok) {
        showAlert(`Test failed: ${response.error || 'Unknown error'}`);
      } else if (response?.fellBack) {
        showAlert(`${engineLabel(testSettings.engine)} is offline, so the browser voice played instead.\n\nStart the ${engineLabel(testSettings.engine)} server to hear this voice (see Settings).`);
      }
    });
  }

  async function deleteVoice(filename) {
    const confirmed = await showConfirm(`Delete "${formatVoiceName(filename)}"?\nThis removes the voice file from disk and cannot be undone.`);
    if (!confirmed) return;
    try {
      const res = await fetch(`${PIPER_BASE_URL}/voices/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server responded ${res.status}`);
      }
      const nextDeleted = [
        { filename, displayName: formatVoiceName(filename), deletedAt: new Date().toLocaleDateString() },
        ...deletedVoices.filter((item) => item.filename !== filename),
      ];
      const nextFavorites = {
        ...favoritesByEngine,
        piper: favoritesFor(favoritesByEngine, 'piper').filter((favorite) => favorite !== filename),
      };
      const nextProfiles = profiles.map((profile) =>
        profile.engine === 'piper' && profile.voice === filename ? { ...profile, voice: '' } : profile,
      );
      setDeletedVoices(nextDeleted);
      setFavoritesByEngine(nextFavorites);
      setProfiles(nextProfiles);
      setVoicesByEngine((prev) => ({ ...prev, piper: prev.piper.filter((voice) => voice !== filename) }));
      persist({ deletedVoices: nextDeleted, favoritesByEngine: nextFavorites, profiles: nextProfiles });
    } catch (error) {
      await showAlert(`Delete failed: ${error.message}`);
    }
  }

  function openVoicesFolder() {
    fetch(`${PIPER_BASE_URL}/voices/open-folder`, { method: 'POST' }).catch(() => {});
  }

  const viewFavorites = favoritesFor(favoritesByEngine, voicesEngine);
  const visibleVoices = useMemo(() => {
    const all = voicesByEngine[voicesEngine] || [];
    const pool = favsOnly ? all.filter((voice) => viewFavorites.includes(voice)) : all;
    return [
      ...pool.filter((voice) => viewFavorites.includes(voice)).sort(),
      ...pool.filter((voice) => !viewFavorites.includes(voice)).sort(),
    ];
  }, [voicesByEngine, voicesEngine, viewFavorites, favsOnly]);
  const viewOnline = engineStatus[voicesEngine];

  // The voice picker for a profile form (create or edit).
  function voicePicker(draft, onChange) {
    const engine = draft.engine || 'browser';
    return (
      <VoiceSelect
        engine={engine}
        value={draft.voice}
        voices={voicesByEngine[engine] || []}
        favorites={favoritesFor(favoritesByEngine, engine)}
        online={engineStatus[engine]}
        defaultVoice={defaultVoiceByEngine[engine]}
        onChange={onChange}
      />
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <img className="page-icon" src="icons/icon48.png" alt="" />
        <div className="page-header-body">
          <div className="page-header-row">
            <h1 className="page-title">{APP_NAME}</h1>
            <span className="page-version">{version}</span>
            {LOCAL_ENGINE_IDS.map((engine) => {
              const online = engineStatus[engine];
              const state = online === null ? '' : online ? 'online' : 'offline';
              return (
                <span key={engine} className={`server-badge ${state}`} title={ENGINES[engine].baseUrl}>
                  {engineLabel(engine)} {online === null ? '…' : online ? 'online ✓' : 'offline ✗'}
                </span>
              );
            })}
          </div>
          <p className="page-tagline">
            Reads selected text aloud with local <a className="link" href="https://github.com/rhasspy/piper" target="_blank">Piper</a> or <a className="link" href="https://huggingface.co/hexgrad/Kokoro-82M" target="_blank">Kokoro</a> voices on your own machine. No cloud, no API keys.
          </p>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((name) => (
          <button key={name} className={`tab ${tab === name ? 'active' : ''}`} role="tab" aria-selected={tab === name} onClick={() => navigateTab(name)}>
            {name.charAt(0).toUpperCase() + name.slice(1)}
          </button>
        ))}
      </nav>

      {tab === 'profiles' && (
        <section className="tab-panel" role="tabpanel">
          <div className="panel-toolbar">
            <h2 className="panel-heading">Profiles</h2>
            <span className="panel-hint">{profiles.length} / {MAX_PROFILES}</span>
            <button className="btn btn-primary" disabled={profiles.length >= MAX_PROFILES} onClick={async () => {
              if (profiles.length >= MAX_PROFILES) {
                await showAlert(`You've reached the ${MAX_PROFILES}-profile limit.\n\nDelete an existing profile to make room for a new one.`);
                return;
              }
              setCreateProfile({ ...blankProfile, engine: activeProfile?.engine || 'piper' });
              setCreateOpen(true);
            }}>＋ New Profile</button>
          </div>
          <p className="panel-blurb">
            A <strong>profile</strong> is a named preset that stores an engine (Piper, Kokoro, or
            the browser voice), a voice, speed, and volume. Switch between profiles in the popup
            using the arrow buttons, for example a fast Piper voice for articles and a natural
            Kokoro voice for long reads. You can have up to 5 profiles.
          </p>

          {createOpen && (
            <div className="create-form">
              <h3 className="form-title">New Profile</h3>
              <div className="form-grid">
                <label className="form-label">Name</label>
                <input ref={createNameRef} className="form-input" type="text" placeholder="e.g. Audiobooks" maxLength={40} value={createProfile.name} onChange={(event) => setCreateProfile({ ...createProfile, name: event.target.value })} />
                <label className="form-label">Engine</label>
                <EngineSelect value={createProfile.engine} engineStatus={engineStatus} onChange={(engine) => setCreateProfile({ ...createProfile, engine, voice: '' })} />
                <label className="form-label">Voice</label>
                {voicePicker(createProfile, (voice) => setCreateProfile({ ...createProfile, voice }))}
                <label className="form-label">Speed</label>
                <div className="slider-inline">
                  <input className="slider" type="range" min="0.5" max="2.5" step="0.1" value={createProfile.rate} onChange={(event) => setCreateProfile({ ...createProfile, rate: event.target.value })} />
                  <span className="slider-val">{fmt(createProfile.rate)}×</span>
                </div>
                <label className="form-label">Volume</label>
                <div className="slider-inline">
                  <input className="slider" type="range" min="0" max="2" step="0.05" value={createProfile.volume} onChange={(event) => setCreateProfile({ ...createProfile, volume: event.target.value })} />
                  <span className="slider-val">{fmt(createProfile.volume)}</span>
                </div>
              </div>
              <div className="form-actions">
                <button className="btn btn-primary" onClick={createNewProfile}>Save Profile</button>
                <button className="btn btn-ghost" onClick={() => {
                  setCreateOpen(false);
                  setCreateProfile(blankProfile);
                }}>Cancel</button>
              </div>
            </div>
          )}

          <div className="profile-list">
            {profiles.length === 0 && <p className="no-items">No profiles yet. Click "+ New Profile" to get started.</p>}
            {profiles.map((profile) => {
              const isActive = profile.id === activeProfile?.id;
              const draft = editDrafts[profile.id] || profile;
              const editing = editingId === profile.id;
              return (
                <div key={profile.id} className={`profile-card ${isActive ? 'is-active' : ''}`} data-id={profile.id}>
                  <div className="profile-card-header">
                    <button className={`btn btn-sm profile-status-btn ${isActive ? 'is-active-state' : 'btn-ghost'}`} disabled={isActive} onClick={() => setActive(profile.id)}>
                      {isActive ? 'Active' : 'Set Active'}
                    </button>
                    <div className="profile-card-info">
                      <span className="profile-card-name">{profile.name}</span>
                      <span className="profile-card-meta">{describeProfileVoice(profile)}  ·  {fmt(profile.rate)}×  ·  vol {fmt(profile.volume)}</span>
                    </div>
                    <div className="profile-card-btns">
                      <button className="btn-icon btn-icon-edit" title="Edit profile" onClick={() => editing ? setEditingId('') : beginEdit(profile)}><IconPencil /></button>
                      <button className="btn-icon btn-icon-delete" disabled={profiles.length <= 1} title={profiles.length <= 1 ? "Can't delete the only profile" : 'Delete profile'} onClick={() => deleteProfile(profile.id)}><IconTrash /></button>
                    </div>
                  </div>

                  {editing && (
                    <div className="profile-edit-form">
                      <div className="form-grid">
                        <label className="form-label">Name</label>
                        <input className="form-input" type="text" maxLength={40} value={draft.name} onChange={(event) => updateDraft(profile.id, { name: event.target.value })} />
                        <label className="form-label">Engine</label>
                        <EngineSelect value={draft.engine || 'browser'} engineStatus={engineStatus} onChange={(engine) => updateDraft(profile.id, { engine, voice: '' })} />
                        <label className="form-label">Voice</label>
                        {voicePicker(draft, (voice) => updateDraft(profile.id, { voice }))}
                        <label className="form-label">Speed</label>
                        <div className="slider-inline">
                          <input className="slider" type="range" min="0.5" max="2.5" step="0.1" value={draft.rate} onChange={(event) => updateDraft(profile.id, { rate: event.target.value })} />
                          <span className="slider-val">{fmt(draft.rate)}×</span>
                        </div>
                        <label className="form-label">Volume</label>
                        <div className="slider-inline">
                          <input className="slider" type="range" min="0" max="2" step="0.05" value={draft.volume} onChange={(event) => updateDraft(profile.id, { volume: event.target.value })} />
                          <span className="slider-val">{fmt(draft.volume)}</span>
                        </div>
                      </div>
                      <div className="profile-edit-actions">
                        <button className="btn btn-primary btn-sm" onClick={() => saveEdit(profile.id)}>Save</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingId('')}>Cancel</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => testVoice(draft)}>{testingVoice === testKey(normalizeProfile(draft)) ? 'Playing…' : '▶ Test'}</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {tab === 'voices' && (
        <section className="tab-panel" role="tabpanel">
          <div className="engine-switch" role="tablist" aria-label="Engine">
            {LOCAL_ENGINE_IDS.map((engine) => (
              <button
                key={engine}
                role="tab"
                aria-selected={voicesEngine === engine}
                className={`engine-switch-btn ${voicesEngine === engine ? 'active' : ''}`}
                onClick={() => setVoicesEngine(engine)}
              >
                <span className={`engine-dot ${engineStatus[engine] === null ? '' : engineStatus[engine] ? 'online' : 'offline'}`} />
                {engineLabel(engine)}
                <span className="engine-switch-count">{(voicesByEngine[engine] || []).length}</span>
              </button>
            ))}
          </div>

          <div className="panel-toolbar">
            <h2 className="panel-heading">{engineLabel(voicesEngine)} voices</h2>
            <span className="favs-count">{viewFavorites.length} / {MAX_FAVORITES} favorites</span>
            <label className="toggle-label">
              <input type="checkbox" checked={favsOnly} onChange={(event) => {
                setFavsOnly(event.target.checked);
                persist({ favsOnly: event.target.checked });
              }} />
              <span>Favorites only</span>
            </label>
          </div>

          {viewOnline === false && (
            <div className="voices-offline-banner">
              ⚠ The {engineLabel(voicesEngine)} server is offline at <code>{ENGINES[voicesEngine].baseUrl}</code>.
              {' '}Start it to {voicesEngine === 'piper' ? 'manage' : 'list'} voices; profiles that use it read with the browser voice until then (if the fallback is on).
            </div>
          )}
          {voicesEngine === 'piper' && voiceDir && (
            <div className="voices-folder-bar">
              <span className="voices-folder-label">Saved to</span>
              <code className="voices-folder-path">{voiceDir}</code>
              <button className="btn btn-ghost btn-sm" onClick={openVoicesFolder}>Open folder ↗</button>
            </div>
          )}

          <div className="voice-grid">
            {visibleVoices.length === 0 && (
              <p className="no-items">{voiceLoadError[voicesEngine] || (favsOnly
                ? 'No favourites yet. Star a voice to add it here.'
                : viewOnline
                  ? (voicesEngine === 'piper' ? 'No voices installed. Download voices and place them in piper/voices/.' : 'The Kokoro server reported no voices.')
                  : `Start the ${engineLabel(voicesEngine)} server to see its voices.`)}</p>
            )}
            {visibleVoices.map((voice) => {
              const isFav = viewFavorites.includes(voice);
              const quality = voicesEngine === 'piper' ? qualityFromFilename(voice) : null;
              const kokoro = voicesEngine === 'kokoro' ? kokoroVoiceDetails(voice) : null;
              const isDefault = voice === defaultVoiceByEngine[voicesEngine];
              const settings = { engine: voicesEngine, voice };
              return (
                <div key={voice} className="voice-card" data-voice={voice}>
                  <button className={`voice-fav-btn ${isFav ? 'is-fav' : ''}`} title={isFav ? 'Remove from favorites' : 'Add to favorites'} onClick={() => toggleFavorite(voicesEngine, voice)}>{isFav ? '★' : '☆'}</button>
                  <div className="voice-card-info">
                    <span className="voice-card-name">
                      {kokoro ? kokoro.name : formatVoiceName(voice)}
                      {quality && <span className={`quality-badge quality-${quality}`}>{quality === 'x_low' ? 'x-low' : quality}</span>}
                      {kokoro && <span className="lang-badge">{kokoro.language}</span>}
                      {isDefault && <span className="lang-badge lang-badge-default">default</span>}
                    </span>
                    <span className="voice-card-file">
                      {voicesEngine === 'piper'
                        ? (formatBytes(voiceSizes[voice]) ? `${voice}  ·  ${formatBytes(voiceSizes[voice])}` : voice)
                        : `${voice}  ·  ${kokoro ? kokoro.gender : 'voice'}`}
                    </span>
                  </div>
                  <div className="voice-card-btns">
                    <button className="btn btn-ghost btn-sm" onClick={() => testVoice(settings)}>{testingVoice === testKey(settings) ? 'Playing…' : '▶ Test'}</button>
                    {voicesEngine === 'piper' && <button className="btn btn-danger btn-sm" onClick={() => deleteVoice(voice)}>Delete</button>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="voices-footer">
            {voicesEngine === 'piper'
              ? <a className="link-external" href="https://huggingface.co/rhasspy/piper-voices/tree/main/en" target="_blank">Browse &amp; download more Piper voices on HuggingFace ↗</a>
              : <a className="link-external" href="https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md" target="_blank">About the Kokoro voices and their quality grades ↗</a>}
          </div>

          {voicesEngine === 'piper' && deletedVoices.length > 0 && (
            <details className="deleted-section">
              <summary className="deleted-summary">
                <span>Deleted voices</span>
                <span className="deleted-count">({deletedVoices.length})</span>
              </summary>
              <div className="deleted-list">
                {deletedVoices.map((deleted) => (
                  <div key={deleted.filename} className="deleted-item">
                    <span>{deleted.displayName}</span>
                    <span className="deleted-item-date">{deleted.deletedAt}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      {tab === 'settings' && (
        <section className="tab-panel" role="tabpanel">
          <div className="panel-toolbar"><h2 className="panel-heading">Settings</h2></div>
          <div className="settings-group">
            <h3 className="settings-group-title">Text-to-Speech Engine</h3>
            <label className="setting-row">
              <input type="checkbox" checked={fallback} onChange={(event) => {
                setFallback(event.target.checked);
                persist({ fallback: event.target.checked });
              }} />
              <div>
                <span className="setting-label">Browser voice fallback</span>
                <span className="setting-desc">When a profile's engine (Piper or Kokoro) is offline or fails, read with the browser's built-in voice instead of staying silent.</span>
              </div>
            </label>
          </div>
          {LOCAL_ENGINE_IDS.map((engine) => {
            const setup = ENGINE_SETUP[engine];
            const online = engineStatus[engine];
            return (
              <div className="settings-group" key={engine}>
                <h3 className="settings-group-title">{engineLabel(engine)} server</h3>
                <div className="setting-row setting-row-info">
                  <span className="setting-label">Address</span>
                  <code className="setting-code">{ENGINES[engine].baseUrl}</code>
                </div>
                <div className="setting-row setting-row-info">
                  <span className="setting-label">Status</span>
                  <span className={`setting-status ${online === null ? '' : online ? 'online' : 'offline'}`}>{online === null ? 'Checking…' : online ? 'Online ✓' : 'Offline ✗'}</span>
                  <button className="btn btn-ghost btn-sm setting-recheck" onClick={() => fetchVoices(engine)}>Check again</button>
                </div>
                <div className="setting-row setting-row-info">
                  <span className="setting-label">Set up</span>
                  <span className="setting-desc">
                    {ENGINES[engine].blurb}{' '}
                    {online ? '' : 'No server detected. '}
                    Run <code className="setting-code">{setup.command}</code> in <code className="setting-code">{setup.folder}</code> {setup.what}{' '}
                    <a href={`https://github.com/n8watkins/voicedock#${setup.anchor}`} target="_blank" rel="noreferrer" className="setting-link">Setup guide ↗</a>
                  </span>
                </div>
              </div>
            );
          })}
          <div className="settings-group">
            <h3 className="settings-group-title">Keyboard Shortcuts</h3>
            <p className="setting-desc settings-shortcut-disclaimer">
              Default shortcuts are registered as Chrome commands and work across tabs.
              Rebinding lives in Chrome's extension shortcuts page; this list shows what Chrome currently has assigned.
            </p>
            <div className="shortcut-manager-row">
              <div>
                <span className="setting-label">Chrome shortcut manager</span>
                <span className="setting-desc">Confirm or rebind the cross-tab shortcuts in Chrome.</span>
              </div>
              <div className="shortcut-manager-actions">
                <button className="btn btn-ghost btn-sm" onClick={refreshChromeCommands}>Refresh</button>
                <button className="btn btn-ghost btn-sm" onClick={openChromeShortcuts}>Open shortcuts ↗</button>
              </div>
            </div>
            {CHROME_COMMANDS.map(([command, label]) => {
              const shortcut = shortcutForCommand(command);
              return (
              <div className="shortcut-row" key={command}>
                <span className="shortcut-label">{label}</span>
                <span className={`shortcut-bind-btn ${shortcut ? '' : 'is-unset'}`}>
                  {shortcut || 'Not set'}
                </span>
              </div>
              );
            })}
          </div>
        </section>
      )}

      {tab === 'about' && (
        <section className="tab-panel" role="tabpanel">
          <div className="credits-section">
            <h4 className="credits-section-title">How It Works</h4>
            <ol className="how-it-works-list">
              <li><span className="flow-step">1</span><div><strong>Highlight text</strong> on any webpage and right-click → <em>Read selected text aloud</em>.</div></li>
              <li><span className="flow-step">2</span><div>The extension's <strong>background service worker</strong> checks that the active profile's engine is reachable: <strong>Piper</strong> at <code>http://127.0.0.1:7477</code> or <strong>Kokoro</strong> at <code>http://127.0.0.1:7478</code>.</div></li>
              <li><span className="flow-step">3</span><div>The text is split into sentence chunks and sent to that <strong>local server</strong> (Node.js running <code>piper.exe</code>, or Python running Kokoro-82M), which sends back WAV audio.</div></li>
              <li><span className="flow-step">4</span><div>An <strong>offscreen document</strong> receives each chunk and plays it through the Web Audio API, because Chrome's Manifest V3 service workers can't play audio directly.</div></li>
              <li><span className="flow-step">5</span><div>If the engine is offline or generation fails and <em>Browser voice fallback</em> is on (Settings), the browser's built-in voice is used instead, and the page shows a short note saying so.</div></li>
              <li><span className="flow-step">6</span><div>Use <strong>keyboard shortcuts</strong> across tabs: <kbd>Alt+Shift+R</kbd> to read selected text or stop playback, and <kbd>Alt+Shift+D</kbd> to pause/resume.</div></li>
            </ol>
          </div>
          <div className="credits-section">
            <h4 className="credits-section-title">Profiles</h4>
            <p className="credits-body">Each <strong>profile</strong> is a named preset storing an engine, a voice, speed, and volume. Create multiple profiles, for example a fast Piper voice for articles and a natural Kokoro voice for long reads, and switch between them in the popup with the arrow buttons.</p>
          </div>
          <div className="credits-section">
            <h4 className="credits-section-title">Setup</h4>
            <p className="credits-body"><strong>Piper</strong> is the light default: about 20 MB of RAM when idle, plus a voice while it reads. <strong>Kokoro</strong> is optional: a 338 MB one-time download and about 300-700 MB of RAM while its model is loaded (it is released after 10 idle minutes), and it needs Python, in WSL on Windows. The <strong>browser voice</strong> needs no setup at all and is the fallback when an engine is offline.</p>
            <p className="credits-body">Full installation instructions, including how to set up the Piper and Kokoro servers, add voices, and load the extension, are in the project README.</p>
            <a className="btn btn-primary credits-readme-btn" href="https://github.com/n8watkins/voicedock#readme" target="_blank">View README &amp; Setup Guide ↗</a>
          </div>
        </section>
      )}

      {tab === 'credits' && (
        <section className="tab-panel" role="tabpanel">
          <div className="credits-section">
            <h4 className="credits-section-title">Open Source</h4>
            <div className="credits-deps">
              <a className="dep-card" href="https://github.com/rhasspy/piper" target="_blank"><span className="dep-name">Piper TTS</span><span className="dep-desc">Fast, local neural text-to-speech by rhasspy</span></a>
              <a className="dep-card" href="https://huggingface.co/rhasspy/piper-voices/tree/main/en" target="_blank"><span className="dep-name">Piper Voices</span><span className="dep-desc">Free English voice models on HuggingFace</span></a>
              <a className="dep-card" href="https://huggingface.co/hexgrad/Kokoro-82M" target="_blank"><span className="dep-name">Kokoro-82M</span><span className="dep-desc">Natural-sounding open-weight TTS model by hexgrad (Apache 2.0)</span></a>
              <a className="dep-card" href="https://github.com/thewh1teagle/kokoro-onnx" target="_blank"><span className="dep-name">kokoro-onnx</span><span className="dep-desc">Runs Kokoro with ONNX Runtime, by thewh1teagle</span></a>
              <a className="dep-card" href="https://lucide.dev" target="_blank"><span className="dep-name">Lucide Icons</span><span className="dep-desc">Beautiful &amp; consistent open-source icons</span></a>
            </div>
          </div>
          <div className="credits-section">
            <h4 className="credits-section-title">Source &amp; License</h4>
            <p className="credits-body">VoiceDock is MIT licensed and runs locally: selected text is sent only to your own localhost server, which runs your installed Piper or Kokoro voices. No cloud service or API key is required.</p>
            <a className="dep-card dep-card-github" href="https://github.com/n8watkins/voicedock" target="_blank">
              <span className="dep-card-github-icon"><GithubIcon /></span>
              <span className="dep-card-github-text"><span className="dep-name">n8watkins/voicedock</span><span className="dep-desc">View source on GitHub</span></span>
            </a>
          </div>
        </section>
      )}

      <Modal modal={modal} onConfirm={() => resolveModal(true)} onCancel={() => resolveModal(false)} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<OptionsApp />);
