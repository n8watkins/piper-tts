import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  APP_NAME,
  defaultProfile,
  describeProfileVoice,
  engineBaseUrl,
  engineLabel,
  fmt,
  MAX_PROFILES,
  normalizeProfile,
  runSettingsMigration,
} from './shared.js';

function PopupApp() {
  const [profiles, setProfiles] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [newProfileOpen, setNewProfileOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('checking');
  const [version, setVersion] = useState('');
  const [testing, setTesting] = useState(false);
  const [playback, setPlayback] = useState({ isPlaying: false, isPaused: false, progress: null });
  const errorTimer = useRef(null);
  const inputRef = useRef(null);

  const activeIdx = Math.max(0, profiles.findIndex((profile) => profile.id === activeId));
  const activeProfile = profiles[activeIdx] || null;

  function showError(message) {
    setError(message);
    clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(''), 5000);
  }

  async function persist(nextProfiles, nextActiveId = activeId) {
    setProfiles(nextProfiles);
    setActiveId(nextActiveId);
    await chrome.storage.local.set({ profiles: nextProfiles, activeId: nextActiveId });
  }

  useEffect(() => {
    let disposed = false;
    async function init() {
      setVersion(`v${chrome.runtime.getManifest().version}`);
      // Upgrades settings saved by Piper TTS 1.0.x before reading them.
      const stored = await runSettingsMigration(chrome.storage.local);
      let nextProfiles = Array.isArray(stored.profiles) ? stored.profiles.map(normalizeProfile) : [];
      let nextActiveId = stored.activeId || '';

      if (nextProfiles.length === 0) {
        const profile = defaultProfile();
        nextProfiles = [profile];
        nextActiveId = profile.id;
        await chrome.storage.local.set({ profiles: nextProfiles, activeId: nextActiveId });
      }

      if (!disposed) {
        setProfiles(nextProfiles);
        setActiveId(nextProfiles.some((profile) => profile.id === nextActiveId) ? nextActiveId : nextProfiles[0].id);
      }
    }
    init();
    return () => {
      disposed = true;
      clearTimeout(errorTimer.current);
    };
  }, []);

  // The status dot follows the active profile's engine; the browser voice is
  // always available.
  const activeEngine = activeProfile?.engine || 'browser';
  useEffect(() => {
    let disposed = false;
    async function checkStatus() {
      const baseUrl = engineBaseUrl(activeEngine);
      if (!baseUrl) {
        setStatus('online');
        return;
      }
      setStatus('checking');
      let ok = false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
        clearTimeout(timer);
        ok = res.ok;
      } catch (_) {
        ok = false;
      }
      if (!disposed) setStatus(ok ? 'online' : 'offline');
    }
    checkStatus();
    return () => { disposed = true; };
  }, [activeEngine]);

  useEffect(() => {
    function poll() {
      chrome.runtime.sendMessage({ type: 'get-playback-state' }, (response) => {
        if (chrome.runtime.lastError || !response) return;
        setPlayback(response);
      });
    }
    poll();
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (newProfileOpen) inputRef.current?.focus();
  }, [newProfileOpen]);

  async function selectProfile(index) {
    if (profiles.length <= 1) return;
    const next = profiles[(index + profiles.length) % profiles.length];
    setActiveId(next.id);
    await chrome.storage.local.set({ activeId: next.id });
  }

  async function updateActiveProfile(patch) {
    if (!activeProfile) return;
    const nextProfiles = profiles.map((profile) =>
      profile.id === activeProfile.id ? { ...profile, ...patch } : profile,
    );
    await persist(nextProfiles, activeProfile.id);
  }

  async function saveNewProfile() {
    const name = newProfileName.trim();
    if (!name) {
      inputRef.current?.focus();
      return;
    }
    if (profiles.length >= MAX_PROFILES) {
      setNewProfileOpen(false);
      setNewProfileName('');
      showError(`You're at the ${MAX_PROFILES}-profile limit. Delete one in Settings first.`);
      return;
    }
    if (profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
      showError('A profile with this name already exists.');
      return;
    }

    const base = activeProfile || defaultProfile();
    const profile = {
      id: crypto.randomUUID(),
      name,
      engine: base.engine,
      voice: base.voice,
      rate: base.rate,
      volume: base.volume,
    };
    await persist([...profiles, profile], profile.id);
    setNewProfileOpen(false);
    setNewProfileName('');
  }

  function testVoice() {
    setTesting(true);
    chrome.runtime.sendMessage({
      type: 'test-voice',
      text: 'This is a local text to speech test.',
      settings: normalizeProfile(activeProfile || defaultProfile()),
    }, (response) => {
      setTesting(false);
      const runtimeErr = chrome.runtime.lastError;
      if (runtimeErr) {
        showError(`Extension error: ${runtimeErr.message}`);
        return;
      }
      if (response && !response.ok) {
        showError(response.error || 'Test failed.');
      } else if (response?.fellBack) {
        showError(`${engineLabel(activeEngine)} is offline. Played the browser voice instead.`);
      }
    });
  }

  function stopReading() {
    chrome.runtime.sendMessage({ type: 'stop-all' });
    setPlayback({ isPlaying: false, isPaused: false, progress: null });
  }

  function openSettings() {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html#settings') });
  }

  const progress = playback?.progress;
  const showProgress = playback?.isPlaying || progress?.active;
  const progressPercent = useMemo(() => {
    if (!progress?.total) return 0;
    return Math.round(Math.max(0, Math.min(1, progress.percent ?? progress.current / progress.total)) * 100);
  }, [progress]);

  return (
    <div className="app">
      <header className="app-header">
        <img className="app-icon" src="icons/icon48.png" alt="" />
        <span className="app-title">{APP_NAME}</span>
        <span className={`status-dot ${status}`} title={status === 'online' ? `${engineLabel(activeEngine)} online` : status === 'offline' ? `${engineLabel(activeEngine)} offline` : 'Checking...'} />
        <span className="app-version">{version}</span>
        <button className="btn-gear" title="Open settings" onClick={openSettings}>⚙</button>
      </header>

      <div className="profile-card">
        <button className="btn-nav" title="Previous profile" disabled={profiles.length <= 1} onClick={() => selectProfile(activeIdx - 1)}>‹</button>
        <div className="profile-info">
          <span className="profile-name">{activeProfile?.name || 'No profiles'}</span>
          <span className="profile-voice" title={activeProfile ? describeProfileVoice(activeProfile) : ''}>{activeProfile ? describeProfileVoice(activeProfile, { compact: true }) : 'Open Settings to create one'}</span>
        </div>
        <button className="btn-nav" title="Next profile" disabled={profiles.length <= 1} onClick={() => selectProfile(activeIdx + 1)}>›</button>
        <button className="btn-add-profile" title="New profile" onClick={() => {
          if (profiles.length >= MAX_PROFILES) {
            showError(`You're at the ${MAX_PROFILES}-profile limit. Delete one in Settings first.`);
            return;
          }
          setNewProfileOpen(true);
        }}>＋</button>
      </div>

      {newProfileOpen && (
        <div className="new-profile-form">
          <span className="new-profile-header">New Profile</span>
          <input
            ref={inputRef}
            className="new-profile-input"
            type="text"
            placeholder="e.g. Audiobooks"
            maxLength={40}
            value={newProfileName}
            onChange={(event) => setNewProfileName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveNewProfile();
              if (event.key === 'Escape') {
                setNewProfileOpen(false);
                setNewProfileName('');
              }
            }}
          />
          <div className="new-profile-actions">
            <button className="btn new-profile-save" onClick={saveNewProfile}>Save</button>
            <button className="btn new-profile-cancel" onClick={() => {
              setNewProfileOpen(false);
              setNewProfileName('');
            }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="sliders">
        <div className="slider-row">
          <span className="slider-lbl">Speed</span>
          <input className="slider" type="range" min="0.5" max="2.5" step="0.1" value={activeProfile?.rate ?? 1.0} disabled={!activeProfile} onChange={(event) => updateActiveProfile({ rate: Number.parseFloat(event.target.value) })} />
          <span className="slider-val">{fmt(activeProfile?.rate ?? 1.0)}×</span>
        </div>
        <div className="slider-row">
          <span className="slider-lbl">Vol</span>
          <input className="slider" type="range" min="0" max="2" step="0.05" value={activeProfile?.volume ?? 1.0} disabled={!activeProfile} onChange={(event) => updateActiveProfile({ volume: Number.parseFloat(event.target.value) })} />
          <span className="slider-val">{fmt(activeProfile?.volume ?? 1.0)}</span>
        </div>
      </div>

      <div className="actions">
        <button className="btn btn-test" disabled={!activeProfile || testing} onClick={testVoice}>{testing ? 'Playing…' : '▶ Test'}</button>
        <button className="btn btn-stop" onClick={stopReading}>■ Stop</button>
      </div>

      {showProgress && (
        <div className="progress-card">
          <div className="progress-row">
            <span className="progress-status">{playback.isPaused ? 'Paused' : 'Reading'}</span>
            <span className="progress-label">{progress?.total > 0 ? (progress.label || `${progress.current}/${progress.total}`) : (progress?.label || 'Browser voice')}</span>
          </div>
          <div className="progress-track">
            <span className={`progress-fill ${progress?.total > 0 ? '' : 'is-indeterminate'}`} style={progress?.total > 0 ? { width: `${progressPercent}%` } : undefined} />
          </div>
        </div>
      )}

      {error && <p className="test-error">{error}</p>}

      <p className="footer-hint">Select text → right-click → <em>Read aloud</em></p>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<PopupApp />);
