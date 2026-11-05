// PrepPilot Profile Intelligence through the REAL compiled IPC handlers:
// profile:select-file → profile:upload-resume / profile:upload-jd →
// profile:get-status / profile:get-profile → profile:delete-jd.
//
// Runs the real SafeDocumentTextExtractor on a temp file whose folder name has
// spaces and non-ASCII characters (both are common in macOS and Windows home
// folders), and the PrepPilot ProfileOrchestrator over an in-memory SQLite.
// Only Electron itself (dialog, windows) and the model are stubbed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const IPC = path.join(ROOT, 'dist-electron/electron/ipcHandlers.js');
const PROFILE = path.join(ROOT, 'dist-electron/electron/profile');
let Database = null;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch { Database = null; }
const SKIP = !fs.existsSync(IPC) ? 'run `npm run build:electron` first' : !Database ? 'better-sqlite3 not loadable in this runtime' : false;

const RESUME = 'Ada Lovelace\nada@example.com\n\nSkills\nPython, Go\n\nExperience\nEngineer at Acme, Jan 2020 – Present\n';
const JD = 'Staff Engineer\nGlobex\n\nRequirements\n- 5+ years of Go\n- Distributed systems\n';

let h;
let dialogPick = null;
let orch;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp profile ü-'));
const resumePath = path.join(dir, 'My Résumé.txt');
const jdPath = path.join(dir, 'job description.md');

before(() => {
  if (SKIP) return;
  fs.writeFileSync(resumePath, RESUME);
  fs.writeFileSync(jdPath, JD);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-profile-ipc-'));
  process.env.NATIVELY_TEST_USERDATA = userData;
  const handlers = new Map();
  const noop = () => {};
  const win = { isDestroyed: () => false, webContents: { send: noop } };
  const fakeElectron = {
    app: {
      getPath: () => userData, getAppPath: () => ROOT, isPackaged: false,
      getVersion: () => '0.0.0-test', getName: () => 'natively',
      on: noop, once: noop, off: noop, removeAllListeners: noop,
      whenReady: () => Promise.resolve(), isReady: () => true,
    },
    BrowserWindow: Object.assign(function BrowserWindow() {}, { getAllWindows: () => [win], getFocusedWindow: () => null }),
    ipcMain: {
      handle: (c, fn) => handlers.set(c, fn), handleOnce: (c, fn) => handlers.set(c, fn),
      on: noop, once: noop, off: noop, removeHandler: noop, removeListener: noop, removeAllListeners: noop,
      listenerCount: () => 0, emit: noop,
    },
    dialog: { showOpenDialog: async () => (dialogPick ? { canceled: false, filePaths: [dialogPick] } : { canceled: true, filePaths: [] }) },
    desktopCapturer: {}, shell: {}, systemPreferences: {},
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s, 'utf8'),
      decryptString: (b) => Buffer.from(b).toString('utf8'),
      getSelectedStorageBackend: () => 'basic_text',
    },
    nativeTheme: { on: noop }, screen: { on: noop }, session: {}, globalShortcut: {}, Menu: {}, Tray: {}, clipboard: {},
  };
  const fakeNative = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : function nativeStub() {}) });
  const origLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return fakeElectron;
    if (/[\\/]native-module[\\/]index\.[^\\/]+\.node$/.test(request)) return fakeNative;
    return origLoad.call(this, request, ...rest);
  };

  const { ProfileOrchestrator } = require(path.join(PROFILE, 'ProfileOrchestrator.js'));
  const { ProfileStore } = require(path.join(PROFILE, 'ProfileStore.js'));
  orch = new ProfileOrchestrator(new ProfileStore(new Database(':memory:')));
  // The model: structured résumé / JD facts, as LLMHelper.generateContentStructured would return.
  orch.setGenerateContentFn(async (contents) => {
    const prompt = contents[0].text;
    return /résumé as JSON/.test(prompt)
      ? '```json\n{"name":"Ada Lovelace","skills":["Python","Go"],"experience":[{"role":"Engineer","company":"Acme","start_date":"Jan 2020","end_date":"Present"}]}\n```'
      : '{"title":"Staff Engineer","company":"Globex","requirements":["5+ years of Go","Distributed systems"]}';
  });

  const mod = require(IPC);
  const appState = {
    processingHelper: { getLLMHelper: () => new Proxy({}, { get: () => noop }) },
    sendModelChanged: noop,
    reconfigureSttProvider: async () => {},
    getKnowledgeOrchestrator: () => orch,
    getIntelligenceManager: () => new Proxy({}, { get: () => noop }),
    getIsMeetingActive: () => false,
  };
  try { mod.initializeIpcHandlers(appState); } catch { /* app-lifecycle wiring only */ }
  h = (channel, ...args) => {
    const fn = handlers.get(channel);
    assert.ok(fn, `${channel} is registered`);
    return fn({}, ...args);
  };
});

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('Profile Intelligence over IPC', { skip: SKIP }, () => {
  test('a résumé chosen in the file dialog uploads, and status and profile read it back', async () => {
    dialogPick = resumePath;
    const picked = await h('profile:select-file');
    assert.equal(picked.success, true);
    const up = await h('profile:upload-resume', picked.filePath);
    assert.equal(up.success, true, up.error);
    assert.equal(up.extractionMode, 'llm');

    const status = await h('profile:get-status');
    assert.equal(status.hasProfile, true);
    assert.equal(status.profileMode, true, 'uploading turns profile mode on');
    assert.equal(status.name, 'Ada Lovelace');
    assert.equal(status.role, 'Engineer');
    assert.equal(status.profileFactsReady, true);

    const profile = await h('profile:get-profile');
    assert.equal(profile.identity.name, 'Ada Lovelace');
    assert.deepEqual(profile.skillsFlat, ['Python', 'Go']);
    assert.equal(orch.activeResume.source_uri, path.resolve(resumePath), 'the path with spaces and ü survives');
  });

  test('a path the dialog did not produce is refused', async () => {
    const res = await h('profile:upload-resume', path.join(dir, 'not-picked.txt'));
    assert.equal(res.success, false);
    assert.match(res.error, /re-select/i);
  });

  test('a JD uploads beside the résumé, then delete-jd removes only the JD', async () => {
    dialogPick = jdPath;
    const picked = await h('profile:select-file');
    const up = await h('profile:upload-jd', picked.filePath);
    assert.equal(up.success, true, up.error);
    const profile = await h('profile:get-profile');
    assert.equal(profile.hasActiveJD, true);
    assert.equal(profile.activeJD.company, 'Globex');
    assert.deepEqual(profile.activeJD.requirements, ['5+ years of Go', 'Distributed systems']);

    const del = await h('profile:delete-jd');
    assert.equal(del.success, true, del.error);
    assert.equal(orch.activeJD, null);
    assert.ok(orch.activeResume, 'the résumé stays');
  });

  test('the company dossier lookup answers null instead of failing', async () => {
    assert.equal(await h('profile:get-company-dossier'), null);
  });
});
