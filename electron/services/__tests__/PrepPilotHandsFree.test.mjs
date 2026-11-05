// Hands-free mock interview (PrepPilot): a spoken answer ends by itself when
// the speaker stops talking (electron/practice/endOfAnswer.ts), and the panel
// listens after each question and submits what was said. The detector is pure;
// the PCM below is synthetic, so this runs the same on macOS and Windows.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPILED = path.join(ROOT, 'dist-electron/electron/practice/endOfAnswer.js');
const HAVE_BUILD = fs.existsSync(COMPILED);
const { EndOfAnswerDetector, pcmRms } = HAVE_BUILD ? require(COMPILED) : {};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 20 ms of 16 kHz mono int16 at a given amplitude (a square-ish wave). */
const chunk = (amp) => {
  const b = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
};

describe('EndOfAnswerDetector', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  const run = (plan, opts = {}) => {
    let t = 0;
    const d = new EndOfAnswerDetector({ now: () => t, ...opts });
    for (const [amp, ms] of plan) {
      for (let elapsed = 0; elapsed < ms; elapsed += 20) {
        t += 20;
        const v = d.push(chunk(amp));
        if (v !== 'continue') return { verdict: v, at: t };
      }
    }
    return { verdict: 'continue', at: t };
  };

  test('RMS of a constant-amplitude chunk is that amplitude', () => {
    assert.equal(Math.round(pcmRms(chunk(1000))), 1000);
    assert.equal(pcmRms(Buffer.alloc(0)), 0);
  });

  test('the answer ends after speech followed by the silence window', () => {
    const r = run([[60, 500], [3000, 4000], [60, 3000]]);
    assert.equal(r.verdict, 'answer-ended');
    assert.ok(r.at >= 4500 + 2200 && r.at <= 4500 + 2300, `ended at ${r.at}`);
  });

  test('a long unbroken answer is not cut short (the floor rises slowly)', () => {
    const r = run([[60, 500], [3000, 10_000], [60, 3000]]);
    assert.equal(r.verdict, 'answer-ended');
    assert.ok(r.at >= 10_500 + 2200, `ended at ${r.at}, before the speaker finished`);
  });

  test('a short pause between sentences does not end the answer', () => {
    const r = run([[3000, 2000], [60, 1200], [3000, 2000], [60, 1000]]);
    assert.equal(r.verdict, 'continue');
  });

  test('steady background noise is not mistaken for speech', () => {
    const r = run([[250, 13_000]]);
    assert.equal(r.verdict, 'no-speech', 'nothing above the floor: gives up instead of recording forever');
  });

  test('a noisy room raises the bar for speech, but real speech still counts', () => {
    const r = run([[400, 3000], [5000, 3000], [400, 3000]]);
    assert.equal(r.verdict, 'answer-ended');
  });

  test('only the first ending is reported', () => {
    let t = 0;
    const d = new EndOfAnswerDetector({ now: () => t, noSpeechMs: 100, calibrationMs: 0 });
    t = 200;
    assert.equal(d.push(chunk(10)), 'no-speech');
    t = 400;
    assert.equal(d.push(chunk(10)), 'continue');
  });
});

describe('wiring', () => {
  test('practice recordings stop themselves through the detector, fed by the microphone', () => {
    const ipc = read('electron/practice/practiceIpc.ts');
    assert.match(ipc, /const verdict = detector\.push\(chunk\);\s*if \(verdict !== 'continue'\) stopVoice\(verdict\);/);
    assert.match(ipc, /\} else \{\s*detector = new EndOfAnswerDetector\(\{ silenceMs: SILENCE_MS \}\);/, 'a fresh detector for each recording');
    const wire = read('electron/services/dictation/wireDictation.ts');
    assert.match(wire, /onAudio\?: \(chunk: Buffer, sampleRate: number\) => void,/);
    assert.match(wire, /sink\.onAudio\(chunk, rate\); try \{ onAudio\(chunk, rate\); \} catch/, 'the listener sees audio after the controller, and cannot break it');
  });

  test('the panel listens after the question is read, and submits the spoken answer', () => {
    const ui = read('src/components/practice/MockInterviewPanel.tsx');
    assert.match(ui, /if \(readAloud\) speak\(question\.text, listen\);/);
    assert.match(ui, /if \(handsFreeRef\.current\) \{ autoSubmitRef\.current\(e\.text\); return; \}/);
    assert.match(ui, /autoSubmitRef\.current = \(text: string\) => \{ void submit\(text\); \};/);
    assert.match(ui, /Hands-free: listen after each question and submit when I stop talking/);
  });
});
