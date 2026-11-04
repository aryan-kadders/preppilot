// PrepPilot sends no telemetry. Upstream Natively reported to its own servers
// through three senders: the anonymous install ping, funnel telemetry and the
// usage outbox. This fork keeps the modules (callers stay unchanged, upstream
// patches still apply) but each one's single gate is permanently off.
//
// Every case below turns on each switch upstream honoured — a packaged build,
// telemetry on in settings, the enable env vars, a dev endpoint — and checks
// that nothing reaches the network anyway. It replaces upstream's tests of the
// sending machinery (FunnelTelemetry, FunnelIpc, FunnelRepairs, UsageOutbox
// dispatch, UsageTelemetryEmission), which described behaviour this fork removed.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST = path.join(ROOT, 'dist-electron/electron/services');
const FUNNEL = path.join(DIST, 'FunnelTelemetry.js');
const OUTBOX = path.join(DIST, 'UsageOutbox.js');
const PING = path.join(DIST, 'InstallPingManager.js');
const HAVE_BUILD = [FUNNEL, OUTBOX, PING].every((f) => fs.existsSync(f));

const ENV_ON = {
  NATIVELY_FUNNEL_ENABLED: '1',
  NATIVELY_FUNNEL_ENDPOINT: 'https://example.test/v1/telemetry/funnel',
  NATIVELY_USAGE_OUTBOX_ENABLED: '1',
};

const origLoad = Module._load;
const origFetch = globalThis.fetch;
const savedEnv = Object.fromEntries(Object.keys(ENV_ON).map((k) => [k, process.env[k]]));

/** Fresh copies of the three senders, as a packaged build with telemetry switched on. */
function loadAllOn() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'preppilot-telemetry-off-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ telemetryEnabled: true }));
  Object.assign(process.env, ENV_ON);
  const noop = () => {};
  const fakeElectron = {
    app: {
      getPath: () => userData, getAppPath: () => ROOT, isPackaged: true,
      getVersion: () => '9.9.9-test', getName: () => 'natively',
      on: noop, once: noop, off: noop, removeAllListeners: noop,
      whenReady: () => Promise.resolve(), isReady: () => true,
    },
    safeStorage: { isEncryptionAvailable: () => false },
    BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: noop, on: noop },
    shell: {}, dialog: {}, nativeTheme: { on: noop }, screen: { on: noop },
  };
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return origLoad.call(this, request, ...rest);
  };
  for (const f of [FUNNEL, OUTBOX, PING]) delete require.cache[f];
  delete globalThis.__nativelySettingsManagerV1__;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  return {
    calls,
    FunnelTelemetry: require(FUNNEL).FunnelTelemetry,
    UsageOutbox: require(OUTBOX).UsageOutbox,
    ping: require(PING),
  };
}

describe('PrepPilot telemetry is off', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  afterEach(() => {
    Module._load = origLoad;
    globalThis.fetch = origFetch;
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test('funnel telemetry stays off with every upstream switch on, and sends nothing', async () => {
    const { FunnelTelemetry, calls } = loadAllOn();
    const ft = FunnelTelemetry.getInstance();
    assert.equal(ft.isEnabled(), false);
    ft.setSnapshotResolver(() => ({ entitlement: 'byok', hasOwnAi: true, hasApiKey: false, hasPro: false, meetingAi: 'own' }));
    ft.track('app_opened');
    ft.featureUsed('screenshot');
    ft.start();
    await new Promise((r) => setTimeout(r, 50));
    ft.stop();
    assert.deepEqual(calls, []);
  });

  test('the usage outbox stays off and never dispatches', async () => {
    const { UsageOutbox, calls } = loadAllOn();
    const outbox = UsageOutbox.getInstance();
    assert.equal(outbox.isEnabled(), false);
    const res = await outbox.dispatchOnce();
    assert.equal(res.skipped, 'disabled');
    assert.equal(res.sent, 0);
    assert.deepEqual(calls, []);
  });

  test('the install ping is never sent', async () => {
    const { ping, calls } = loadAllOn();
    await ping.sendAnonymousInstallPing();
    assert.deepEqual(calls, []);
  });
});
