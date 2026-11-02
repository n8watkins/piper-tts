// ─── LocalVoice - Content Script ──────────────────────────────────────────────
// Injected into every webpage.
//   1. Selection bridge for Chrome commands
//   2. Floating "Now Playing" overlay (shadow DOM, bottom-right corner)

// Cache last known selection so modifier keys can't clear it before our handler reads it
let _lastSelection = "";
const _snapshotSel = () => {
  const s = window.getSelection()?.toString().trim();
  if (s) _lastSelection = s;
};
document.addEventListener("mouseup",         _snapshotSel, true);
document.addEventListener("selectionchange", _snapshotSel);
document.addEventListener("keyup",           _snapshotSel, true); // keyboard selections (Shift+arrow)

// ─── Local playback state (optimistic — for instant UI updates) ───────────────
let _localPlaying  = false;
let _localPaused   = false;
let _currentVolume = 1.0;
let _currentRate   = 1.0;
let _currentEngine = null; // "piper" | "kokoro" | "browser": browser TTS can't adjust live
let _runtimeUnavailable = false;
let _playbackPollTimer = null;

function isRuntimeUnavailableError(error) {
  const message = String(error?.message || error || "");
  return /Extension context invalidated|Receiving end does not exist/i.test(message);
}

function isExpectedRuntimeMessageError(error) {
  const message = String(error?.message || error || "");
  return isRuntimeUnavailableError(error) || /message port closed|message channel closed/i.test(message);
}

function markRuntimeUnavailable() {
  _runtimeUnavailable = true;
  if (_playbackPollTimer) {
    clearInterval(_playbackPollTimer);
    _playbackPollTimer = null;
  }
}

function getRuntimeLastError() {
  try {
    return chrome.runtime.lastError || null;
  } catch (error) {
    if (isRuntimeUnavailableError(error)) {
      markRuntimeUnavailable();
      return error;
    }
    console.warn("[LocalVoice] runtime lastError failed", error);
    return error;
  }
}

function safeRuntimeCallback(callback) {
  return (...args) => {
    if (_runtimeUnavailable) return;
    try {
      callback(...args);
    } catch (error) {
      if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
      else console.warn("[LocalVoice] runtime callback failed", error);
    }
  };
}

function sendRuntimeMessage(message, callback) {
  if (_runtimeUnavailable) return;

  try {
    const maybePromise = callback
      ? chrome.runtime.sendMessage(message, safeRuntimeCallback(callback))
      : chrome.runtime.sendMessage(message);

    if (maybePromise?.catch) {
      maybePromise.catch((error) => {
        if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
        else if (!isExpectedRuntimeMessageError(error)) console.warn("[LocalVoice] runtime message failed", error);
      });
    }
  } catch (error) {
    if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
    else if (!isExpectedRuntimeMessageError(error)) console.warn("[LocalVoice] runtime message failed", error);
  }
}

function applyPlaybackState(state) {
  if (!state) return;
  _localPlaying = !!state.isPlaying;
  _localPaused  = !!state.isPaused;
  if (state.volume != null) _currentVolume = state.volume;
  if (state.rate != null) _currentRate = state.rate;
  if (state.engine !== undefined) _currentEngine = state.engine;
  updateOverlay(_localPlaying, _localPaused, state.progress);
}

try {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "playback-state") {
      applyPlaybackState(message.state);
      return;
    }
    if (message.type === "get-selection") {
      const text = window.getSelection()?.toString().trim() || _lastSelection;
      sendResponse({ text });
      return;
    }
    if (message.type === "show-hint") {
      showHint(message.message || "");
    }
  });
} catch (error) {
  if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
  else console.warn("[LocalVoice] runtime listener failed", error);
}

// Stop when this tab navigates away or closes
window.addEventListener("pagehide", () => {
  sendRuntimeMessage({ type: "tab-unloading" });
});

// ─── Overlay ──────────────────────────────────────────────────────────────────
let overlayHost   = null;
let overlayShadow = null;

const OVERLAY_CSS = `
  :host {
    all: initial;
    position: fixed !important;
    bottom: 24px !important;
    right: 24px !important;
    z-index: 2147483647 !important;
    pointer-events: auto !important;
    display: block !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  /* ── Main playing bar ── */
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px 7px 12px;
    background: #1e1e2e;
    border: 1px solid #45475a;
    border-radius: 999px;
    box-shadow: 0 6px 28px rgba(0,0,0,0.7),
                0 0 0 1px rgba(203,166,247,0.08);
    white-space: nowrap;
    transition: border-color 0.2s;
  }
  .bar:hover { border-color: #6c7086; }

  /* Extension label */
  .brand {
    font-size: 13px;
    line-height: 1;
    color: #cba6f7;
    flex-shrink: 0;
    margin-right: 2px;
  }

  /* Status text */
  .lbl {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #cdd6f4;
    min-width: 46px;
    text-align: left;
    transition: color 0.15s;
  }
  .lbl.paused { color: #f9e2af; }

  .prog {
    width: 42px;
    height: 4px;
    background: #45475a;
    border-radius: 999px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .prog-fill {
    display: block;
    width: 0%;
    height: 100%;
    background: #cba6f7;
    border-radius: inherit;
    transition: width 0.2s ease;
  }

  .prog-fill.is-indeterminate {
    width: 45%;
    animation: tts-progress-pulse 1s ease-in-out infinite alternate;
  }

  @keyframes tts-progress-pulse {
    from { transform: translateX(-70%); }
    to   { transform: translateX(130%); }
  }

  /* Divider */
  .sep {
    width: 1px;
    height: 14px;
    background: #313244;
    flex-shrink: 0;
    margin: 0 2px;
  }

  /* Shared button base */
  .btn {
    background: transparent;
    border: none;
    border-radius: 50%;
    width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    outline: none;
    padding: 0;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s;
  }

  /* Play/Pause button */
  .btn-pp {
    font-size: 14px;
    color: #cba6f7;
  }
  .btn-pp:hover { background: rgba(203,166,247,0.12); }

  /* Speaker button (opens the hover rocker) */
  .btn-vol {
    font-size: 14px;
    color: #a6adc8;
    width: 24px; height: 24px;
    line-height: 1;
  }
  .btn-vol:hover { background: rgba(166,173,200,0.14); color: #cdd6f4; }

  /* ── Volume + speed hover rocker ── */
  .vol-wrap { position: relative; display: flex; align-items: center; }

  .rocker {
    position: absolute;
    bottom: 100%;
    right: -6px;
    /* Transparent bridge so moving the cursor up into the panel doesn't drop the
       :hover and snap it shut. */
    padding-bottom: 10px;
    display: none;
  }
  .vol-wrap:hover .rocker,
  .rocker:hover { display: block; }

  .rocker-panel {
    background: #1e1e2e;
    border: 1px solid #45475a;
    border-radius: 12px;
    box-shadow: 0 8px 28px rgba(0,0,0,0.7), 0 0 0 1px rgba(203,166,247,0.08);
    padding: 10px 12px;
    width: 184px;
  }

  .rocker-row {
    display: grid;
    grid-template-columns: 44px 1fr 40px;
    align-items: center;
    gap: 8px;
  }
  .rocker-row + .rocker-row { margin-top: 9px; }

  .rocker-lbl {
    font-size: 11px;
    font-weight: 700;
    color: #a6adc8;
    letter-spacing: 0.02em;
  }

  .rocker-val {
    font-size: 11px;
    font-weight: 700;
    color: #cdd6f4;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .rocker-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    border-radius: 999px;
    background: #45475a;
    outline: none;
    cursor: pointer;
    margin: 0;
    padding: 0;
  }
  .rocker-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 13px; height: 13px;
    border-radius: 50%;
    background: #cba6f7;
    border: none;
    cursor: pointer;
  }
  .rocker-slider::-moz-range-thumb {
    width: 13px; height: 13px;
    border-radius: 50%;
    background: #cba6f7;
    border: none;
    cursor: pointer;
  }

  .rocker-panel.is-disabled .rocker-slider { cursor: not-allowed; background: #313244; }
  .rocker-panel.is-disabled .rocker-slider::-webkit-slider-thumb { background: #585b70; cursor: not-allowed; }
  .rocker-panel.is-disabled .rocker-slider::-moz-range-thumb { background: #585b70; }
  .rocker-panel.is-disabled .rocker-lbl,
  .rocker-panel.is-disabled .rocker-val { color: #6c7086; }

  .rocker-note {
    display: none;
    margin-top: 9px;
    font-size: 10px;
    line-height: 1.35;
    color: #f9e2af;
  }

  /* Close / Stop button */
  .btn-close {
    font-size: 10px;
    color: #585b70;
    font-weight: 700;
  }
  .btn-close:hover { background: rgba(243,139,168,0.14); color: #f38ba8; }

  /* ── Hint toast ── */
  .hint-bar {
    padding: 8px 14px;
    background: #1e1e2e;
    border: 1px solid #45475a;
    border-radius: 999px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.55);
    font-size: 12px;
    font-weight: 600;
    color: #a6adc8;
    pointer-events: none;
    user-select: none;
    white-space: nowrap;
  }
`;

function ensureOverlay() {
  // Re-attach if a page framework removed our host node
  if (overlayHost && !document.contains(overlayHost)) {
    (document.body || document.documentElement).appendChild(overlayHost);
  }
  if (overlayHost) return overlayShadow;

  overlayHost   = document.createElement("div");
  overlayShadow = overlayHost.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = OVERLAY_CSS;
  overlayShadow.appendChild(style);

  (document.body || document.documentElement).appendChild(overlayHost);
  return overlayShadow;
}

function removeOverlay() {
  if (!overlayHost) return;
  overlayHost.remove();
  overlayHost = overlayShadow = null;
}

let _hintTimer = null;
function showHint(msg) {
  const shadow = ensureOverlay();
  shadow.querySelectorAll(".bar, .hint-bar").forEach(el => el.remove());

  const bar = document.createElement("div");
  bar.className = "hint-bar";
  bar.textContent = msg;
  shadow.appendChild(bar);

  clearTimeout(_hintTimer);
  _hintTimer = setTimeout(() => {
    bar.remove();
    if (!shadow.querySelector(".bar")) removeOverlay();
  }, 2500);
}

function fmtVol(v) {
  return Math.round((v ?? 1.0) * 100) + "%";
}

function fmtRate(v) {
  return (Math.round((v ?? 1.0) * 10) / 10).toFixed(1) + "×";
}

// Builds the speaker button + the hover popover holding the Speed and Volume
// sliders. Adjustments change only the current playback — they are NOT written
// back to the saved profile (background.js handles set-live-* without storage).
function buildRocker() {
  const wrap = document.createElement("div");
  wrap.className = "vol-wrap";

  const btn = document.createElement("button");
  btn.className = "btn btn-vol";
  btn.textContent = "🔊";
  btn.title = "Volume & speed";

  const rocker = document.createElement("div");
  rocker.className = "rocker";
  const panel = document.createElement("div");
  panel.className = "rocker-panel";

  const makeRow = (label, min, max, step, fmt, msgType, key) => {
    const row = document.createElement("div");
    row.className = "rocker-row";

    const lbl = document.createElement("span");
    lbl.className = "rocker-lbl";
    lbl.textContent = label;

    const slider = document.createElement("input");
    slider.className = "rocker-slider";
    slider.type = "range";
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);

    const val = document.createElement("span");
    val.className = "rocker-val";

    slider.addEventListener("input", () => {
      const v = Number.parseFloat(slider.value);
      val.textContent = fmt(v);
      if (key === "volume") _currentVolume = v; else _currentRate = v;
      sendRuntimeMessage({ type: msgType, [key]: v });
    });

    row.append(lbl, slider, val);
    return { row, slider, val };
  };

  const speed = makeRow("Speed", 0.5, 2.5, 0.1, fmtRate, "set-live-rate", "rate");
  const vol   = makeRow("Volume", 0, 2, 0.05, fmtVol, "set-live-volume", "volume");

  const note = document.createElement("div");
  note.className = "rocker-note";
  note.textContent = "Can’t change volume or speed while the default voice is playing.";

  panel.append(speed.row, vol.row, note);
  rocker.appendChild(panel);
  wrap.append(btn, rocker);

  wrap._refs = { speed, vol, note, panel };
  return wrap;
}

// Reflects current engine + values onto the rocker. Skips moving the sliders
// while the user is hovering/dragging so periodic state pushes don't fight them.
function syncRocker(wrap) {
  if (!wrap || !wrap._refs) return;
  const { speed, vol, note, panel } = wrap._refs;

  const isBrowser = _currentEngine === "browser";
  speed.slider.disabled = isBrowser;
  vol.slider.disabled = isBrowser;
  panel.classList.toggle("is-disabled", isBrowser);
  note.style.display = isBrowser ? "block" : "none";

  if (wrap.matches(":hover")) return;
  speed.slider.value = String(_currentRate);
  speed.val.textContent = fmtRate(_currentRate);
  vol.slider.value = String(_currentVolume);
  vol.val.textContent = fmtVol(_currentVolume);
}

function updateOverlay(isPlaying, isPaused, progress = null) {
  if (!isPlaying && !isPaused) {
    if (overlayHost && !overlayShadow?.querySelector(".hint-bar")) removeOverlay();
    return;
  }

  const shadow = ensureOverlay();
  shadow.querySelectorAll(".hint-bar").forEach(el => el.remove());

  let bar = shadow.querySelector(".bar");
  if (!bar) {
    // ── Brand icon ──
    const brand = document.createElement("span");
    brand.className = "brand";
    brand.textContent = "🔊";

    // ── Play/Pause button ──
    const btnPP = document.createElement("button");
    btnPP.className = "btn btn-pp";
    btnPP.addEventListener("click", () => {
      if (!_localPlaying) return;
      _localPaused = !_localPaused;
      updateOverlay(_localPlaying, _localPaused); // instant update
      sendRuntimeMessage({ type: "keyboard-pause" });
    });

    // ── Status label ──
    const lbl = document.createElement("span");
    lbl.className = "lbl";

    const prog = document.createElement("span");
    prog.className = "prog";
    const progFill = document.createElement("span");
    progFill.className = "prog-fill";
    prog.appendChild(progFill);

    // ── Separator ──
    const sep1 = document.createElement("span");
    sep1.className = "sep";

    // ── Volume + speed rocker (hover the speaker icon) ──
    const volWrap = buildRocker();

    // ── Separator ──
    const sep2 = document.createElement("span");
    sep2.className = "sep";

    // ── Stop button ──
    const btnClose = document.createElement("button");
    btnClose.className = "btn btn-close";
    btnClose.title = "Stop";
    btnClose.textContent = "✕";
    btnClose.addEventListener("click", () => {
      _localPlaying = false;
      _localPaused  = false;
      sendRuntimeMessage({ type: "stop-all" });
      removeOverlay();
    });

    bar = document.createElement("div");
    bar.className = "bar";
    bar.append(brand, btnPP, lbl, prog, sep1, volWrap, sep2, btnClose);
    shadow.appendChild(bar);
  }

  const btnPP  = bar.querySelector(".btn-pp");
  const lbl    = bar.querySelector(".lbl");
  const progFill = bar.querySelector(".prog-fill");

  // Reflect current engine + volume/speed onto the rocker
  syncRocker(bar.querySelector(".vol-wrap"));

  if (progFill) {
    if (progress?.total > 0) {
      const percent = Math.max(0, Math.min(1, progress.percent ?? progress.current / progress.total));
      progFill.classList.remove("is-indeterminate");
      progFill.style.width = Math.round(percent * 100) + "%";
    } else {
      progFill.style.width = "";
      progFill.classList.add("is-indeterminate");
    }
  }

  if (isPaused) {
    btnPP.textContent = "▶";
    btnPP.title       = "Resume";
    lbl.textContent   = "Paused";
    lbl.className     = "lbl paused";
  } else {
    btnPP.textContent = "⏸";
    btnPP.title       = "Pause";
    lbl.textContent   = "Playing";
    lbl.className     = "lbl";
  }
}

// One initial sync; later changes are pushed by background.js via playback-state.
sendRuntimeMessage({ type: "get-playback-state" }, (resp) => {
  const error = getRuntimeLastError();
  if (error) {
    if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
    return;
  }
  applyPlaybackState(resp);
});
