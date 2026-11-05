// The overlay's Restart button (after granting Screen Recording or
// Accessibility) calls the restart-app IPC. A packaged build relaunches itself.
// A development build must NOT: `npm start` stops its Vite server when Electron
// exits, so a relaunched copy loads a dead URL and keeps the single-instance
// lock, and the next `npm start` exits with "Another instance is already
// running". This runs the real compiled handler both ways.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const IPC = path.join(ROOT, 'dist-electron/electron/ipcHandlers.js');

function loadRestartHandler(isPackaged) {
  const calls = [];
  const handlers = new Map();
  const noop = () => {};
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-restart-'));
  process.env.NATIVELY_TEST_USERDATA = userData;
  const fakeElectron = {
    app: {
      isPackaged, getPath: () => userData, getAppPath: () => ROOT,
      getVersion: () => '0.0.0-test', getName: () => 'natively',
      on: noop, once: noop, off: noop, removeAllListeners: noop,
      whenReady: () => Promise.resolve(), isReady: () => true,
      relaunch: () => calls.push('relaunch'), exit: (code) => calls.push(`exit:${code}`),
    },
    BrowserWindow: Object.assign(function BrowserWindow() {}, { getAllWindows: () => [] }),
    ipcMain: {
      handle: (c, fn) => handlers.set(c, fn), handleOnce: (c, fn) => handlers.set(c, fn),
      on: noop, once: noop, off: noop, removeHandler: noop, removeListener: noop, removeAllListeners: noop,
      listenerCount: () => 0, emit: noop,
    },
    dialog: {}, desktopCapturer: {}, shell: {}, systemPreferences: {},
    safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text' },
    nativeTheme: { on: noop }, screen: { on: noop }, session: {}, globalShortcut: {}, Menu: {}, Tray: {}, clipboard: {},
  };
  const fakeNative = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : function nativeStub() {}) });
  const origLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return fakeElectron;
    if (/[\\/]native-module[\\/]index\.[^\\/]+\.node$/.test(request)) return fakeNative;
    return origLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[IPC];
    const mod = require(IPC);
    const appState = new Proxy({ getKnowledgeOrchestrator: () => null }, { get: (t, k) => (k in t ? t[k] : noop) });
    try { mod.initializeIpcHandlers(appState); } catch { /* app-lifecycle wiring only */ }
  } finally {
    Module._load = origLoad;
    fs.rmSync(userData, { recursive: true, force: true });
  }
  return { restart: () => handlers.get('restart-app')({}), calls };
}

describe('restart-app', { skip: fs.existsSync(IPC) ? false : 'run `npm run build:electron` first' }, () => {
  test('development: quits without relaunching a copy that has no dev server', () => {
    const { restart, calls } = loadRestartHandler(false);
    restart();
    assert.deepEqual(calls, ['exit:0']);
  });

  test('packaged: relaunches, then exits', () => {
    const { restart, calls } = loadRestartHandler(true);
    restart();
    assert.deepEqual(calls, ['relaunch', 'exit:0']);
  });
});
