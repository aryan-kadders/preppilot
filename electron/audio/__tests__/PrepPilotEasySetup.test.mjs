// PrepPilot "works without setup":
//  1. With no transcription provider chosen, a free on-device one is used:
//     Apple Speech on macOS (when its helper exists, else local Whisper),
//     local Whisper on Windows, nothing on unsupported platforms.
//  2. A capture channel that cannot start is explained in plain words, never
//     the raw error, and a missing audio module is never sent to a privacy pane.
// The platform decisions are pure and parameterised, so the macOS and Windows
// branches both run on any host.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST = path.join(ROOT, 'dist-electron/electron/audio');
const HAVE_BUILD = fs.existsSync(path.join(DIST, 'defaultSttProvider.js')) && fs.existsSync(path.join(DIST, 'captureFailureMessage.js'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { defaultSttProviderFor } = HAVE_BUILD ? require(path.join(DIST, 'defaultSttProvider.js')) : {};
const { captureStartFailureMessage, AUDIO_PART_MISSING } = HAVE_BUILD ? require(path.join(DIST, 'captureFailureMessage.js')) : {};
const { audioWarningAction } = await import(pathToFileURL(path.join(ROOT, 'src/lib/audioWarningAction.mjs')).href);

const RAW_MODULE_ERROR = new Error('Native audio engine unavailable — the audio capture module failed to load. Reinstall the app (dev: npm run build:native).');

describe('default transcription provider', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  test('macOS: Apple Speech when its helper is present, else local Whisper', () => {
    assert.equal(defaultSttProviderFor('darwin', { appleSpeechAvailable: true }), 'apple-speech');
    assert.equal(defaultSttProviderFor('darwin', { appleSpeechAvailable: false }), 'local-whisper');
  });

  test('Windows: local Whisper, whatever is said about Apple Speech', () => {
    assert.equal(defaultSttProviderFor('win32', { appleSpeechAvailable: false }), 'local-whisper');
    assert.equal(defaultSttProviderFor('win32', { appleSpeechAvailable: true }), 'local-whisper');
  });

  test('unsupported platforms are not given another platform\'s provider', () => {
    assert.equal(defaultSttProviderFor('linux', { appleSpeechAvailable: true }), 'none');
  });

  test('CredentialsManager reads "nothing chosen" as the default, and Settings shows the effective provider', () => {
    const cm = read('electron/services/CredentialsManager.ts');
    assert.match(cm, /if \(provider === 'none'\) \{[\s\S]{0,500}return defaultSttProviderFor\(process\.platform, \{ appleSpeechAvailable: appleSpeechHelperPresent\(\), deepgramKey: !!this\.getDeepgramApiKey\(\) \}\);/);
    assert.match(read('electron/ipcHandlers.ts'), /sttProvider: CredentialsManager\.getInstance\(\)\.getSttProvider\(\),/);
  });
});

describe('capture failure wording', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  test('a missing audio module is explained in plain words, per channel, without the raw error', () => {
    const mic = captureStartFailureMessage('mic', RAW_MODULE_ERROR);
    const sys = captureStartFailureMessage('system', RAW_MODULE_ERROR);
    for (const m of [mic, sys]) {
      assert.ok(m.includes(AUDIO_PART_MISSING), m);
      assert.match(m, /Reinstall PrepPilot/);
      assert.doesNotMatch(m, /native audio engine|npm run|build:native|module/i, 'no technical words');
    }
    assert.match(mic, /microphone/);
    assert.match(sys, /hear the call/);
  });

  test('any other failure says what still works, again without the raw error', () => {
    const mic = captureStartFailureMessage('mic', new Error('cpal: device busy (os error 16)'));
    const sys = captureStartFailureMessage('system', 'HAL error -50');
    assert.doesNotMatch(mic + sys, /cpal|os error|HAL|-50/);
    assert.match(mic, /keeps listening to the call/);
    assert.match(sys, /keeps listening to your microphone/);
  });

  test('main uses the plain wording for both channels', () => {
    const main = read('electron/main.ts');
    assert.match(main, /message: captureStartFailureMessage\('mic', err\),/);
    assert.match(main, /message: captureStartFailureMessage\('system', err\),/);
    assert.doesNotMatch(main, /failed to start \(\$\{\(err as Error\)\?\.message/);
  });

  test('the plain "part missing" banner opens Settings → Audio on macOS and Windows, never a privacy pane', () => {
    for (const platform of ['darwin', 'win32']) {
      for (const channel of ['mic', 'system']) {
        const message = captureStartFailureMessage(channel, RAW_MODULE_ERROR);
        assert.deepEqual(
          audioWarningAction({ platform, kind: 'audio-capture-failure', channel, titleKey: '', message }),
          { type: 'settings-tab', tab: 'audio' },
          `${platform}/${channel}`,
        );
      }
    }
  });
});

describe('starting automatically', () => {
  // A detected call (Zoom, Teams, Meet, …) starts listening after the 10 s
  // countdown unless the user presses Not now or turned the setting off. Unset
  // reads as on, in the running app and in Settings alike.
  test('Auto Answer is on unless the user turned it off', () => {
    assert.match(read('electron/main.ts'), /this\._autoAnswerEnabled = settingsManager\.get\('autoAnswerEnabled'\) \?\? true;/);
  });

  test('Start automatically is on unless the user turned it off', () => {
    assert.match(read('electron/main.ts'), /autoStart: \(\) => SettingsManager\.getInstance\(\)\.get\('meetingAutoStartEnabled'\) !== false,/);
    assert.match(read('electron/ipcHandlers.ts'), /safeHandle\('get-meeting-auto-start-enabled', async \(\) => SettingsManager\.getInstance\(\)\.get\('meetingAutoStartEnabled'\) !== false\);/);
  });
});
