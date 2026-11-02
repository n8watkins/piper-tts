import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  defaultProfile,
  fmt,
  formatBytes,
  formatVoiceName,
  MAX_FAVORITES,
  MAX_PROFILES,
  PIPER_BASE_URL,
  qualityFromFilename,
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

function VoiceSelect({ value, voices, favorites, onChange }) {
  const sorted = useMemo(() => [
    ...voices.filter((voice) => favorites.includes(voice)).sort(),
    ...voices.filter((voice) => !favorites.includes(voice)).sort(),
  ], [voices, favorites]);

  return (
    <select className="form-select profile-voice-sel" value={value || ''} onChange={(event) => onChange(event.target.value)}>
      <option value="">Chrome default voice</option>
      {sorted.map((voice) => (
        <option key={voice} value={voice}>
          {favorites.includes(voice) ? '★ ' : ''}{formatVoiceName(voice)}
        </option>
      ))}
    </select>
  );
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
  const [favorites, setFavorites] = useState([]);
  const [deletedVoices, setDeletedVoices] = useState([]);
  const [favsOnly, setFavsOnly] = useState(false);
  const [fallback, setFallback] = useState(true);
  const [voices, setVoices] = useState([]);
  const [voiceSizes, setVoiceSizes] = useState({});
  const [voiceDir, setVoiceDir] = useState('');
  const [voiceLoadError, setVoiceLoadError] = useState('');
  const [serverOnline, setServerOnline] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createProfile, setCreateProfile] = useState({ name: '', voice: '', rate: 1.0, volume: 1.0 });
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
      favorites,
      deletedVoices,
      favsOnly,
      fallback,
      ...next,
    };
    chrome.storage.local.set({
      profiles: data.profiles,
      activeId: data.activeId,
      favorites: data.favorites,
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

  async function checkServerStatus() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${PIPER_BASE_URL}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      setServerOnline(res.ok);
      return res.ok;
    } catch (_) {
      setServerOnline(false);
      return false;
    }
  }

  async function fetchVoices(forceStatus = false) {
    const online = forceStatus ? await checkServerStatus() : serverOnline || await checkServerStatus();
    if (!online) {
      setVoiceLoadError('');
      return;
    }
    try {
      const res = await fetch(`${PIPER_BASE_URL}/voices`);
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();
      setVoices(data.voices || []);
      setVoiceSizes(data.sizes || {});
      setVoiceDir(data.voiceDir || '');
      setVoiceLoadError('');
    } catch (error) {
      setVoices([]);
      setVoiceSizes({});
      setVoiceDir('');
      setVoiceLoadError(`Failed to load voices: ${error.message}`);
    }
  }

  useEffect(() => {
    async function init() {
      setVersion(`v${chrome.runtime.getManifest().version}`);

      const rawKeys = await chrome.storage.local.get(['fallback', 'fallbackToBrowser']);
      if (rawKeys.fallbackToBrowser !== undefined && rawKeys.fallback === undefined) {
        await chrome.storage.local.set({ fallback: rawKeys.fallbackToBrowser });
        await chrome.storage.local.remove('fallbackToBrowser');
      }

      const stored = await chrome.storage.local.get({
        profiles: [],
        activeId: '',
        favorites: [],
        deletedVoices: [],
        favsOnly: false,
        fallback: true,
      });

      let nextProfiles = stored.profiles;
      let nextActiveId = stored.activeId;
      if (nextProfiles.length === 0) {
        const profile = defaultProfile();
        nextProfiles = [profile];
        nextActiveId = profile.id;
        await chrome.storage.local.set({ profiles: nextProfiles, activeId: nextActiveId });
      }

      const def = nextProfiles.find((profile) => profile.id === 'default' && profile.name === 'Default');
      if (def) {
        def.name = 'Profile 1';
        await chrome.storage.local.set({ profiles: nextProfiles });
      }

      setProfiles(nextProfiles);
      setActiveId(nextProfiles.some((profile) => profile.id === nextActiveId) ? nextActiveId : nextProfiles[0].id);
      setFavorites(stored.favorites);
      setDeletedVoices(stored.deletedVoices);
      setFavsOnly(stored.favsOnly);
      setFallback(stored.fallback);
      const online = await checkServerStatus();
      if (online) await fetchVoices(true);
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
    if (tab === 'voices' && voices.length === 0) fetchVoices();
  }, [tab]);

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
    const profile = {
      id: uuid(),
      name,
      voice: createProfile.voice,
      rate: Number.parseFloat(createProfile.rate),
      volume: Number.parseFloat(createProfile.volume),
    };
    updateProfiles([...profiles, profile], profiles.length === 0 ? profile.id : activeId);
    setCreateProfile({ name: '', voice: '', rate: 1.0, volume: 1.0 });
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
        ? { ...profile, name, voice: draft.voice, rate: Number.parseFloat(draft.rate), volume: Number.parseFloat(draft.volume) }
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

  async function toggleFavorite(filename) {
    let nextFavorites;
    if (favorites.includes(filename)) {
      nextFavorites = favorites.filter((favorite) => favorite !== filename);
    } else {
      if (favorites.length >= MAX_FAVORITES) {
        await showAlert(`You've reached the ${MAX_FAVORITES}-favorite limit.\n\nUnstar a voice to make room for another.`);
        return;
      }
      nextFavorites = [...favorites, filename];
    }
    setFavorites(nextFavorites);
    persist({ favorites: nextFavorites });
  }

  function testVoice(settings = {}) {
    const testSettings = {
      voice: settings.voice || '',
      rate: Number.parseFloat(settings.rate ?? 1.0),
      volume: Number.parseFloat(settings.volume ?? 1.0),
    };
    setTestingVoice(testSettings.voice || '__default__');
    chrome.runtime.sendMessage({
      type: 'test-voice',
      text: `This is a test of the voice ${formatVoiceName(testSettings.voice)}.`,
      settings: testSettings,
    }, (response) => {
      setTestingVoice('');
      const runtimeErr = chrome.runtime.lastError;
      if (runtimeErr) {
        showAlert(`Extension error: ${runtimeErr.message}`);
        return;
      }
      if (response && !response.ok) showAlert(`Test failed: ${response.error || 'Unknown error'}`);
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
      const nextFavorites = favorites.filter((favorite) => favorite !== filename);
      const nextProfiles = profiles.map((profile) => profile.voice === filename ? { ...profile, voice: '' } : profile);
      const nextVoices = voices.filter((voice) => voice !== filename);
      setDeletedVoices(nextDeleted);
      setFavorites(nextFavorites);
      setProfiles(nextProfiles);
      setVoices(nextVoices);
      persist({ deletedVoices: nextDeleted, favorites: nextFavorites, profiles: nextProfiles });
    } catch (error) {
      await showAlert(`Delete failed: ${error.message}`);
    }
  }

  function openVoicesFolder() {
    fetch(`${PIPER_BASE_URL}/voices/open-folder`, { method: 'POST' }).catch(() => {});
  }

  const visibleVoices = useMemo(() => {
    const pool = favsOnly ? voices.filter((voice) => favorites.includes(voice)) : voices;
    return [
      ...pool.filter((voice) => favorites.includes(voice)).sort(),
      ...pool.filter((voice) => !favorites.includes(voice)).sort(),
    ];
  }, [voices, favorites, favsOnly]);

  return (
    <div className="page">
      <header className="page-header">
        <img className="page-icon" src="icons/icon48.png" alt="" />
        <div className="page-header-body">
          <div className="page-header-row">
            <h1 className="page-title">Piper TTS</h1>
            <span className="page-version">{version}</span>
            <span className={`server-badge ${serverOnline ? 'online' : 'offline'}`}>{serverOnline ? 'Piper Online ✓' : 'Piper Offline ✗'}</span>
          </div>
          <p className="page-tagline">
            Reads selected text aloud using a fully local <a className="link" href="https://github.com/rhasspy/piper" target="_blank">Piper TTS</a> server — no cloud, no API keys.
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
              setCreateOpen(true);
            }}>＋ New Profile</button>
          </div>
          <p className="panel-blurb">
            A <strong>profile</strong> is a named preset that stores a voice, speed, and volume.
            Switch between profiles in the popup using the arrow buttons — useful for keeping
            separate settings for different content types, like a fast voice for articles and
            a slower one for technical material. You can have up to 5 profiles.
          </p>

          {createOpen && (
            <div className="create-form">
              <h3 className="form-title">New Profile</h3>
              <div className="form-grid">
                <label className="form-label">Name</label>
                <input ref={createNameRef} className="form-input" type="text" placeholder="e.g. Audiobooks" maxLength={40} value={createProfile.name} onChange={(event) => setCreateProfile({ ...createProfile, name: event.target.value })} />
                <label className="form-label">Voice</label>
                <VoiceSelect value={createProfile.voice} voices={voices} favorites={favorites} onChange={(voice) => setCreateProfile({ ...createProfile, voice })} />
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
                  setCreateProfile({ name: '', voice: '', rate: 1.0, volume: 1.0 });
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
                      <span className="profile-card-meta">{formatVoiceName(profile.voice)}  ·  {fmt(profile.rate)}×  ·  vol {fmt(profile.volume)}</span>
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
                        <label className="form-label">Voice</label>
                        <VoiceSelect value={draft.voice} voices={voices} favorites={favorites} onChange={(voice) => updateDraft(profile.id, { voice })} />
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
                        <button className="btn btn-ghost btn-sm" onClick={() => testVoice(draft)}>{testingVoice === (draft.voice || '__default__') ? 'Playing…' : '▶ Test'}</button>
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
          <div className="panel-toolbar">
            <h2 className="panel-heading">Installed Voices</h2>
            <span className="favs-count">{favorites.length} / {MAX_FAVORITES} favorites</span>
            <label className="toggle-label">
              <input type="checkbox" checked={favsOnly} onChange={(event) => {
                setFavsOnly(event.target.checked);
                persist({ favsOnly: event.target.checked });
              }} />
              <span>Favorites only</span>
            </label>
          </div>

          {!serverOnline && <div className="voices-offline-banner">⚠ Piper server is offline — start the server to manage voices.</div>}
          {voiceDir && (
            <div className="voices-folder-bar">
              <span className="voices-folder-label">Saved to</span>
              <code className="voices-folder-path">{voiceDir}</code>
              <button className="btn btn-ghost btn-sm" onClick={openVoicesFolder}>Open folder ↗</button>
            </div>
          )}

          <div className="voice-grid">
            {visibleVoices.length === 0 && (
              <p className="no-items">{voiceLoadError || (favsOnly ? 'No favourites yet. Star a voice to add it here.' : serverOnline ? 'No voices installed. Download voices and place them in piper/voices/.' : 'Start the Piper server to see installed voices.')}</p>
            )}
            {visibleVoices.map((voice) => {
              const isFav = favorites.includes(voice);
              const quality = qualityFromFilename(voice);
              return (
                <div key={voice} className="voice-card" data-voice={voice}>
                  <button className={`voice-fav-btn ${isFav ? 'is-fav' : ''}`} title={isFav ? 'Remove from favorites' : 'Add to favorites'} onClick={() => toggleFavorite(voice)}>{isFav ? '★' : '☆'}</button>
                  <div className="voice-card-info">
                    <span className="voice-card-name">
                      {isFav ? '★ ' : ''}{formatVoiceName(voice)}
                      {quality && <span className={`quality-badge quality-${quality}`}>{quality === 'x_low' ? 'x-low' : quality}</span>}
                    </span>
                    <span className="voice-card-file">{formatBytes(voiceSizes[voice]) ? `${voice}  ·  ${formatBytes(voiceSizes[voice])}` : voice}</span>
                  </div>
                  <div className="voice-card-btns">
                    <button className="btn btn-ghost btn-sm" onClick={() => testVoice({ voice })}>{testingVoice === voice ? 'Playing…' : '▶ Test'}</button>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteVoice(voice)}>Delete</button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="voices-footer">
            <a className="link-external" href="https://huggingface.co/rhasspy/piper-voices/tree/main/en" target="_blank">Browse &amp; download more voices on HuggingFace ↗</a>
          </div>

          {deletedVoices.length > 0 && (
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
                <span className="setting-label">Browser TTS fallback</span>
                <span className="setting-desc">When Piper is offline or generation fails, use the browser's built-in voice instead of failing silently.</span>
              </div>
            </label>
          </div>
          <div className="settings-group">
            <h3 className="settings-group-title">Piper Server</h3>
            <div className="setting-row setting-row-info">
              <span className="setting-label">Address</span>
              <code className="setting-code">http://127.0.0.1:7477</code>
            </div>
            <div className="setting-row setting-row-info">
              <span className="setting-label">Status</span>
              <span style={{ color: serverOnline ? '#a6e3a1' : '#f38ba8' }}>{serverOnline ? 'Online ✓' : 'Offline ✗'}</span>
            </div>
            <div className="setting-row setting-row-info">
              <span className="setting-label">Set up</span>
              <span className="setting-desc">
                {serverOnline ? 'Manage the server from the tray (green/red status dot). ' : 'No local server detected. '}
                Run <code className="setting-code">npm run setup</code> in <code className="setting-code">servers/piper/</code> to install Piper, a voice, and the tray.{' '}
                <a href="https://github.com/n8watkins/piper-tts#quick-setup-one-command" target="_blank" rel="noreferrer" style={{ color: '#cba6f7' }}>Setup guide ↗</a>
              </span>
            </div>
          </div>
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
              <li><span className="flow-step">2</span><div>The extension's <strong>background service worker</strong> checks if the local Piper server is reachable at <code>http://127.0.0.1:7477</code>.</div></li>
              <li><span className="flow-step">3</span><div>The text is split into sentence chunks and sent to the <strong>local Node.js server</strong>, which calls <code>piper.exe</code> and streams back WAV audio.</div></li>
              <li><span className="flow-step">4</span><div>An <strong>offscreen document</strong> receives each chunk and plays it through the Web Audio API — Chrome's Manifest V3 service workers can't play audio directly.</div></li>
              <li><span className="flow-step">5</span><div>If Piper is offline or generation fails and <em>Browser TTS fallback</em> is on (Settings), the browser's built-in voice is used instead.</div></li>
              <li><span className="flow-step">6</span><div>Use <strong>keyboard shortcuts</strong> across tabs: <kbd>Alt+Shift+R</kbd> to read selected text or stop playback, and <kbd>Alt+Shift+D</kbd> to pause/resume.</div></li>
            </ol>
          </div>
          <div className="credits-section">
            <h4 className="credits-section-title">Profiles</h4>
            <p className="credits-body">Each <strong>profile</strong> is a named preset storing a voice, speed, and volume. Create multiple profiles — for example, a fast voice for articles and a slower one for technical content — and switch between them in the popup with the arrow buttons.</p>
          </div>
          <div className="credits-section">
            <h4 className="credits-section-title">Setup</h4>
            <p className="credits-body">Full installation instructions — including how to download Piper, add local voice models, run the localhost server, and load the extension — are in the project README.</p>
            <a className="btn btn-primary credits-readme-btn" href="https://github.com/n8watkins/piper-tts#readme" target="_blank">View README &amp; Setup Guide ↗</a>
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
              <a className="dep-card" href="https://lucide.dev" target="_blank"><span className="dep-name">Lucide Icons</span><span className="dep-desc">Beautiful &amp; consistent open-source icons</span></a>
            </div>
          </div>
          <div className="credits-section">
            <h4 className="credits-section-title">Source &amp; License</h4>
            <p className="credits-body">Piper TTS is MIT licensed and runs locally: selected text is sent to your own localhost server, which calls your installed Piper executable and voice models. No cloud service or API key is required.</p>
            <a className="dep-card dep-card-github" href="https://github.com/n8watkins/piper-tts" target="_blank">
              <span className="dep-card-github-icon"><GithubIcon /></span>
              <span className="dep-card-github-text"><span className="dep-name">n8watkins/piper-tts</span><span className="dep-desc">View source on GitHub</span></span>
            </a>
          </div>
        </section>
      )}

      <Modal modal={modal} onConfirm={() => resolveModal(true)} onCancel={() => resolveModal(false)} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<OptionsApp />);
