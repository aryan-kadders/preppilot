// PrepPilot Cloud in the desktop app: a signed-in candidate answers only on
// the organization's account (the hosted-provider path pointed at the
// cloud's /v1/chat with the device token and session id), transcribes with
// Deepgram keys fetched per connection, and every meeting is a paid session.
// The real LLMHelper request builders run against a captured fetch; the
// wiring in main, IPC, preload and Settings is pinned by source.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repo = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const { LLMHelper } = require(path.join(repo, 'dist-electron/electron/LLMHelper.js'));
const { CLOUD_SENTINEL_KEY, TRIAL_SENTINEL_KEY } = require(path.join(repo, 'dist-electron/electron/config/constants.js'));
const { cloudBaseUrl, DEFAULT_CLOUD_URL } = require(path.join(repo, 'dist-electron/electron/services/cloud/cloudAccount.js'));

const CHAT_URL = 'https://proj.supabase.co/functions/v1/api/v1/chat';
const SLOT = Symbol.for('preppilot.cloudClient');

function helper(over = {}) {
  const h = Object.create(LLMHelper.prototype);
  Object.assign(h, {
    nativelyKey: CLOUD_SENTINEL_KEY, isLocalOnlyMode: false, groqFastTextMode: true, aiResponseLanguage: 'English',
    currentModelId: 'gemini-3.1-flash-lite', getDisabledProviderFamilies: () => [], assertOutboundScopes: () => {},
    rateLimiters: {}, visionHealth: new Map(), nativelyQuotaBlockedUntil: 0, nativelyLimit: null, ...over,
  });
  return h;
}

async function withCloud(cloud, run) {
  const prev = globalThis[SLOT];
  globalThis[SLOT] = cloud;
  try { return await run(); } finally { globalThis[SLOT] = prev; }
}

async function capture(run, reply = () => new Response(JSON.stringify({ content: 'OK' }), { status: 200, headers: { 'content-type': 'application/json' } })) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) }); return reply(); };
  try { await run(); } finally { globalThis.fetch = real; }
  return calls;
}

const openSession = { chatUrl: CHAT_URL, chatHeaders: async () => ({ 'x-natively-key': 'acc-1', 'x-preppilot-session': 'ses-1', 'x-preppilot-version': '3.1.0' }) };

describe('answers go through PrepPilot Cloud while signed in', () => {
  test('every provider but the hosted one is switched off', () => {
    const h = helper();
    for (const family of ['gemini', 'openai', 'claude', 'groq', 'deepseek', 'ollama', 'custom', 'codex', 'antigravity']) {
      assert.equal(h.isProviderDisabled(family), true, family);
    }
    assert.equal(h.isProviderDisabled('natively'), false);
    assert.equal(helper({ nativelyKey: null }).isProviderDisabled('gemini'), false, 'signed out: the user\'s own setup');
  });

  test('a whole answer goes to the cloud URL with the device token and session id', async () => {
    const calls = await withCloud(openSession, () => capture(() => helper().generateWithNatively('What is React?', 'be brief')));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CHAT_URL);
    assert.equal(calls[0].headers['x-natively-key'], 'acc-1');
    assert.equal(calls[0].headers['x-preppilot-session'], 'ses-1');
    assert.equal(calls[0].body.system, 'be brief');
  });

  test('a streamed answer goes there too, and a long build asks for the long tier', async () => {
    const sse = () => new Response('data: {"delta":"OK"}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const drain = async (gen) => { let text = ''; for await (const c of gen) text += c; return text; };
    let text = '';
    const calls = await withCloud(openSession, () => capture(async () => {
      text = await drain(helper().streamWithNatively('long code for a shop', 'sys', undefined, undefined, 10_000, false, 'long'));
    }, sse));
    assert.equal(text, 'OK');
    assert.equal(calls[0].url, CHAT_URL);
    assert.equal(calls[0].headers['x-preppilot-session'], 'ses-1');
    assert.equal(calls[0].headers['Accept'], 'text/event-stream');
    assert.equal(calls[0].body.model_tier, 'long');
    const plain = await withCloud(openSession, () => capture(() => drain(helper().streamWithNatively('hi', 'sys')), sse));
    assert.equal(plain[0].body.model_tier, undefined);
  });

  test('outside a session the user is told to start PrepPilot, and nothing is sent', async () => {
    const closed = { chatUrl: CHAT_URL, chatHeaders: async () => { throw Object.assign(new Error('time_quota_exceeded'), { status: 429 }); } };
    let error;
    const calls = await withCloud(closed, () => capture(async () => {
      try { await helper().generateWithNatively('hi'); } catch (e) { error = e; }
    }));
    assert.equal(calls.length, 0);
    assert.match(error.message, /^Start PrepPilot to ask questions/);
  });

  test('a real Natively key and the trial key keep their own routes', async () => {
    for (const nativelyKey of ['nat_real_key', TRIAL_SENTINEL_KEY]) {
      const h = helper({ nativelyKey });
      assert.equal(h.isProviderDisabled('gemini'), false, nativelyKey);
    }
    const src = read('electron/LLMHelper.ts');
    assert.equal(src.match(/\} else if \(nativelyKey === CLOUD_SENTINEL_KEY\) \{\n\s+const target = await this\.cloudChatTarget\(\);/g)?.length, 2, 'both request builders');
  });
});

describe('cloud refusals are said plainly', () => {
  const refuse = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  for (const [status, body, expected] of [
    [429, { error: 'time_quota_exceeded', reason: 'time_up' }, /^Your time for this session is up\.$/],
    [429, { error: 'time_quota_exceeded', reason: 'no_minutes' }, /no practice minutes left/],
    [403, { error: 'device_revoked' }, /signed out by your manager/],
    [502, { error: 'upstream_unavailable' }, /^PrepPilot Cloud could not get an answer right now/],
  ]) {
    test(`HTTP ${status} ${body.reason ?? body.error}: a PrepPilot sentence, and no Natively plan block`, async () => {
      const h = helper();
      let error;
      await withCloud(openSession, () => capture(async () => {
        try { await h.generateWithNatively('hi'); } catch (e) { error = e; }
      }, refuse(status, body)));
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /Natively/);
      assert.equal(h.nativelyQuotaBlockedUntil, 0, 'the next session may answer at once');
      assert.equal(h.nativelyLimit, null);
    });
  }

  test('a streamed answer refused for time says so too', async () => {
    const h = helper();
    let error;
    await withCloud(openSession, () => capture(async () => {
      try { for await (const _ of h.streamWithNatively('hi', 'sys')) { /* drain */ } } catch (e) { error = e; }
    }, refuse(429, { error: 'time_quota_exceeded', reason: 'session_ended' })));
    assert.equal(error.message, 'This session has ended.');
    assert.equal(h.nativelyQuotaBlockedUntil, 0);
  });

  test('screenshot answers have the cloud route too', () => {
    const src = read('electron/LLMHelper.ts');
    const start = src.indexOf('private async generateWithVisionFallback');
    const body = src.slice(start, src.indexOf('All AI providers failed: no vision-capable providers configured.', start));
    assert.match(body, /if \(this\.hasNatively\(\)\) \{\n\s+allProviders\.push\(\{ name: 'Natively API', execute: \(\) => this\.generateWithNatively\(userPrompt, systemPrompt, isMultimodal \? imagePaths : undefined\) \}\);/);
  });
});

describe('the cloud server address', () => {
  test('packaged builds always use the project; development may override', () => {
    assert.equal(cloudBaseUrl({ PREPPILOT_CLOUD_URL: 'http://localhost:54321/functions/v1/api/' }, true), DEFAULT_CLOUD_URL);
    assert.equal(cloudBaseUrl({ PREPPILOT_CLOUD_URL: 'http://localhost:54321/functions/v1/api/' }, false), 'http://localhost:54321/functions/v1/api');
    assert.equal(cloudBaseUrl({}, false), DEFAULT_CLOUD_URL);
  });
});

describe('wiring', () => {
  const main = read('electron/main.ts');
  test('a meeting opens the paid session before any window changes, and stops charging when it ends or fails', () => {
    const open = main.indexOf('await this.openCloudSessionOrThrow(metadata);');
    const swap = main.indexOf("this.windowHelper.setWindowMode('overlay', undefined, { hidden: startPlan.overlayHidden });");
    assert.ok(open > 0 && swap > open, 'session first, then the overlay');
    assert.match(main, /err\.code = e\?\.status === 429 \? 'cloud-time'/);
    const endIdx = main.search(/private async endMeetingTransition/);
    const stopCharging = main.indexOf("// PrepPilot Cloud: stop charging", endIdx);
    assert.ok(stopCharging > endIdx && stopCharging - endIdx < 3000, 'endMeetingTransition stops charging first thing');
    assert.match(main.slice(stopCharging, stopCharging + 250), /getCloudClient\(\)\.endSession\(\)/);
    assert.match(main, /A start that failed after the cloud session opened must not keep charging/);
    assert.match(main, /if \(e\.type === 'ended' && this\.isMeetingActive\) \{[\s\S]{0,200}this\.endMeeting\(\)/);
  });

  test('signing in or out switches answers and transcription at once; the app starts in the right mode', () => {
    assert.match(main, /if \(e\.type === 'state'\) \{\n\s+this\.applyCloudMode\(e\.state === 'signed_in'\);[\s\S]{0,200}this\.reconfigureSttProvider\(\)/);
    assert.match(main, /appState\.initCloud\(\);\n\s+appState\.prewarmSttProviders\(\);/);
  });

  test('transcription uses the cloud\'s Deepgram with a key per connection, on macOS and Windows alike', () => {
    assert.match(main, /if \(cloudModeActive\(\)\) \{[\s\S]{0,200}new DeepgramStreamingSTT\('preppilot-cloud', CredentialsManager\.getInstance\(\)\.getSttModel\('deepgram'\), \(\) => getCloudClient\(\)\.sttToken\(\)\)/);
    const dg = read('electron/audio/DeepgramStreamingSTT.ts');
    assert.match(dg, /Authorization: `Bearer \$\{token\}`/);
    assert.match(dg, /if \(token\) \(this\.live as any\)\.setupConnection\?\.\(\);/);
  });

  test('Settings › Account reaches main through the bridge', () => {
    const ipc = read('electron/ipcHandlers.ts');
    const preload = read('electron/preload.ts');
    for (const ch of ['cloud-status', 'cloud-redeem', 'cloud-sign-out']) {
      assert.ok(ipc.includes(`safeHandle('${ch}'`), ch);
      assert.ok(preload.includes(`ipcRenderer.invoke('${ch}'`), ch);
    }
    assert.ok(preload.includes("ipcRenderer.on('cloud-update'"));
    const settings = read('src/components/SettingsOverlay.tsx');
    assert.match(settings, /\{activeTab === 'account' && <AccountSettings \/>\}/);
    assert.match(read('src/components/NativelyInterface.tsx'), /<CloudTimeNoticeBanner secondsLeft=\{cloudSecondsLeft\} \/>/);
  });

  test('the refresh token is stored encrypted with the other credentials; the access token never is', () => {
    const cm = read('electron/services/CredentialsManager.ts');
    assert.match(cm, /cloudCredentials\?: \{\n\s+refreshToken: string;\n\s+deviceId: string;\n\s+baseUrl: string;\n\s+\};/);
    assert.match(cm, /public setCloudCredentials\(c: [^)]*\): boolean \{\n\s+if \(this\.refuseWriteWhileDegraded/);
    assert.doesNotMatch(read('electron/services/cloud/cloudClient.ts'), /store\.save\([^)]*access/);
  });
});
