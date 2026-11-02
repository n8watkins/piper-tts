import { test } from 'node:test';
import assert from 'node:assert/strict';

// The background service worker is a Manifest V3 *module* service worker
// (manifest "type": "module") that imports shared helpers from src/shared.js.
// If that import path were wrong, or background.js didn't parse as an ES module,
// Chrome would fail to register the worker outright. Importing it here under a
// minimal `chrome` shim exercises exactly that path: the file parses as ESM, its
// ./src/shared.js import resolves, and its top-level code - which registers every
// event listener - runs to completion without throwing.
//
// (Chrome no longer allows loading an unpacked extension from the command line,
// so this stands in for a live service-worker registration check.)

function makeChromeShim() {
  const listeners = {};
  const event = (name) => ({
    addListener: (fn) => { (listeners[name] ||= []).push(fn); },
  });
  return {
    _listeners: listeners,
    runtime: {
      lastError: null,
      onInstalled: event('runtime.onInstalled'),
      onMessage: event('runtime.onMessage'),
      getURL: (p) => 'chrome-extension://test/' + p,
      getContexts: async () => [],
      sendMessage: async () => {},
    },
    storage: {
      onChanged: event('storage.onChanged'),
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    contextMenus: {
      onClicked: event('contextMenus.onClicked'),
      removeAll: async () => {},
      create: () => {},
      update: async () => {},
    },
    commands: { onCommand: event('commands.onCommand') },
    tts: { stop() {}, speak() {}, pause() {}, resume() {} },
    tabs: { query: () => {}, sendMessage: async () => {} },
    offscreen: { createDocument: async () => {} },
  };
}

test('background service worker loads as a module and registers its listeners', async () => {
  globalThis.chrome = makeChromeShim();

  // Resolves only if background.js parses as ESM and ./src/shared.js is found -
  // the exact conditions Chrome needs to register the module service worker.
  await import('../extension/background.js');

  const l = globalThis.chrome._listeners;
  assert.ok(l['runtime.onInstalled']?.length, 'registers runtime.onInstalled');
  assert.ok(l['runtime.onMessage']?.length, 'registers runtime.onMessage');
  assert.ok(l['storage.onChanged']?.length, 'registers storage.onChanged');
  assert.ok(l['contextMenus.onClicked']?.length, 'registers contextMenus.onClicked');
  assert.ok(l['commands.onCommand']?.length, 'registers commands.onCommand');
});
