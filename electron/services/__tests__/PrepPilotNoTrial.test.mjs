// PrepPilot requests no free trial. Upstream Natively issued one from its own
// servers (billed to its owners): by itself when a meeting started with no AI,
// or when the user pressed Start trial. This fork keeps both entry points as
// no-ops. It replaces upstream's MeetingStartsTrial* tests, which described the
// removed behaviour.
//
// This EXECUTES the compiled ipcHandlers through the same harness upstream
// used, with a server stub that would happily issue a trial, and counts the
// requests that reach it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadIpcHandlers, LIVE_TRIAL } from './autoTrialHarness.mjs';

let ipc;
before(() => {
  ipc = loadIpcHandlers('preppilot-no-trial');
  ipc.state.reply = async () => LIVE_TRIAL();
});

const sent = (channel) => ipc.sends.filter((s) => s.channel === channel);

test('main still registers the meeting-start hooks AppState calls', () => {
  assert.equal(typeof ipc.appState.autoStartTrialForMeeting, 'function');
  assert.equal(ipc.appState.autoTrialSettled(), true);
});

test('a meeting with no AI configured starts no trial and tells the overlay nothing', async () => {
  ipc.appState.autoStartTrialForMeeting();
  await ipc.settle();
  assert.equal(ipc.trialStartCalls.length, 0);
  assert.deepEqual(sent('trial-auto-start'), []);
  assert.deepEqual(sent('trial-started'), []);
  const local = await ipc.handlers.get('trial:get-local')({});
  assert.equal(local.hasToken, false);
});

test('asking for a trial is refused without contacting the server', async () => {
  const res = await ipc.handlers.get('trial:start')({}, 'settings');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'trial_unavailable');
  assert.equal(ipc.trialStartCalls.length, 0);
  assert.deepEqual(sent('trial-started'), []);
});
