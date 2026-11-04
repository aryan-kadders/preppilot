// Three main-process faults a review found in the trial that starts by itself
// with a meeting (2026-10-10). Each was read from the code, not seen in a run:
// the capture rigs stub the main process, so these are pinned from the source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ipc = fs.readFileSync(path.join(ROOT, 'electron/ipcHandlers.ts'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf8');

test('no transcription selected is not a transcription failure', () => {
  // With provider 'none' createSTTProvider returns null BY DESIGN. Main used to
  // answer that with two terminal "provider \"none\" could not start" events;
  // the overlay shows them as a red banner that only a click removes, so it sat
  // beside "Free trial started" for the whole meeting once the trial arrived.
  // "Transcription Not Configured" already says the true thing for 'none'.
  const setup = main.slice(main.indexOf('// 2. Initialize STT Services if missing'), main.indexOf('// STT sample rate is now applied lazily'));
  const sends = [...setup.matchAll(/if \(([^)]*)\) \{\s*this\.sendAudioCaptureFailed\(/g)].map((m) => m[1]);
  assert.equal(sends.length, 2, 'the system and the microphone channel');
  for (const condition of sends) assert.match(condition, /sttProv !== 'none'/, `"${condition}" would report 'none' as a failure`);
  assert.ok(!/provider "none"/.test(setup));
});

test('transcription is not rebuilt under an audio start-up that is still running', () => {
  // The trial's reply lands in the first second or so of the meeting, while
  // startMeeting's audio init (seconds long) is still building the captures.
  // Stopping and rebuilding them under it is the hazard endMeeting already
  // guards by waiting for the same promise.
  const body = main.slice(main.indexOf('private async _doReconfigureSttProvider(): Promise<void> {'), main.indexOf('PR #173: Audio Recovery Handler'));
  const wait = body.indexOf('await this._audioInitPromise');
  assert.ok(wait !== -1, 'the rebuild waits for the start-up');
  assert.ok(wait < body.indexOf('this.systemAudioCapture?.stop()'), 'before any capture is stopped');
  assert.ok(wait < body.indexOf('this.googleSTT.stop()'), 'and before the transcribers are dropped');
  // The start-up itself must never wait on a rebuild, or the two would deadlock.
  const init = main.slice(main.indexOf('this._audioInitPromise = (async () => {'), main.indexOf('})(); // Defer to next event loop tick'));
  assert.ok(!/reconfigureSttProvider|_sttReconfigureChain/.test(init));
});

test('second review: the trial is live before transcription is rebuilt', () => {
  // The rebuild now waits for the meeting's audio start-up (seconds). The
  // model switch and the "trial started" broadcast must not wait behind it, or
  // a question asked in those seconds fails and the overlay says nothing.
  const flow = ipc.slice(ipc.indexOf('async function startTrialFlow('), ipc.indexOf("safeHandle('trial:status'"));
  const rebuild = flow.indexOf('await appState.reconfigureSttProvider()');
  assert.ok(rebuild !== -1);
  assert.ok(flow.indexOf('llmHelper.setNativelyKey(TRIAL_SENTINEL_KEY)') < rebuild, 'the model route first');
  assert.ok(flow.indexOf('syncNativelyModelRuntime()') < rebuild);
  assert.ok(flow.indexOf("win.webContents.send('trial-started'") < rebuild, 'and every window told');
  // Still awaited, so the automatic start's "settled" follows working transcription.
  assert.match(flow, /if \(sttProviderChanged\) await appState\.reconfigureSttProvider\(\);/);
});

test('a rebuild that outlives its meeting starts nothing and keeps nothing', () => {
  // The rebuild awaits the audio start-up, two capture stops and the pipeline
  // setup (on macOS that asks the screen-capture permission). Stop pressed in
  // one of those waits used to be followed by fresh captures and transcription
  // being STARTED, with no meeting: an open microphone and, on a trial, voice
  // minutes billed until the next meeting.
  const body = main.slice(main.indexOf('private async _doReconfigureSttProvider()'), main.indexOf('PR #173: Audio Recovery Handler'));
  assert.match(body, /const rebuildGeneration = this\._meetingGeneration;/);
  assert.match(body, /const isRebuildMeeting = \(\) => this\.isMeetingActive && this\._meetingGeneration === rebuildGeneration;/);
  const setup = body.indexOf('await this.setupSystemAudioPipeline();');
  const start = body.indexOf("this.startCaptureChannels('reconfigureSttProvider');");
  assert.ok(setup !== -1 && start > setup);
  assert.match(body.slice(setup, start), /if \(isRebuildMeeting\(\)\) \{\s*(\/\/[^\n]*\n\s*)*$/, 'started only for the meeting it was built for');
  assert.ok(body.includes('this.releaseOrphanedRebuild('), 'and what was built for a meeting that ended is released');
});

// PrepPilot: the trial that started itself with a meeting was removed (it was
// issued and billed by upstream's servers). The hook AppState calls stays, as
// a no-op, so a meeting start never reaches the trial code.
test('a meeting start never starts a trial', () => {
  assert.match(ipc, /appState\.autoStartTrialForMeeting = \(\) => \{\};/);
  assert.match(ipc, /appState\.autoTrialSettled = \(\) => true;/);
  assert.ok(!ipc.includes('const autoStartTrialForMeeting = async'), 'the old hook body is gone');
});
