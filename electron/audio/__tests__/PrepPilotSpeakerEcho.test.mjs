// audio/speakerEchoFilter.ts — the microphone's copy of the call audio is
// dropped; the user's own words never are. The echo lines are the ones a
// scripted call on laptop speakers produced (2026-11-05).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPILED = path.join(ROOT, 'dist-electron/electron/audio/speakerEchoFilter.js');
const HAVE_BUILD = fs.existsSync(COMPILED);
const { SpeakerEchoFilter } = HAVE_BUILD ? require(COMPILED) : {};

describe('SpeakerEchoFilter', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  const make = () => {
    let t = 0;
    const f = new SpeakerEchoFilter({ now: () => t });
    return { f, advance: (ms) => { t += ms; } };
  };

  test('the microphone repeating the interviewer is dropped (real lines, with transcription slips)', () => {
    const { f, advance } = make();
    f.noteInterviewer('Can you tell me about a time you had a disagreement with a teammate and how you resolved it?');
    advance(400);
    assert.equal(f.isEcho('Can you tell me about the time you had a disagreement with a teammate, and how you resolved it?'), true);
    f.noteInterviewer('Please also explain what you learned from that experience and how you would handle it differently today.');
    advance(300);
    assert.equal(f.isEcho(" He's also explained what you learned from that experience and how you would handle it differently today."), true);
    assert.equal(f.dropped, 2);
  });

  test('an echo is caught from the interviewer partial, before its final', () => {
    const { f } = make();
    f.noteInterviewer('Can you tell me about a time');
    f.noteInterviewer('Can you tell me about a time you had a disagreement');
    assert.equal(f.isEcho('can you tell me about a time you had'), true);
  });

  test("the user's own answer is kept, even right after the question", () => {
    const { f, advance } = make();
    f.noteInterviewer('Can you tell me about a time you had a disagreement with a teammate and how you resolved it?');
    advance(1500);
    assert.equal(f.isEcho('Sure. At Acme my lead wanted to ship early and I thought we needed more testing, so I proposed a staged rollout.'), false);
    assert.equal(f.dropped, 0);
  });

  test('short replies are never treated as echo', () => {
    const { f } = make();
    f.noteInterviewer('Are you ready to start? Yes or no?');
    assert.equal(f.isEcho('yes sure'), false);
    assert.equal(f.isEcho('Yes, ready.'), false);
  });

  test('call audio older than the window no longer counts', () => {
    const { f, advance } = make();
    f.noteInterviewer('Tell me about your biggest project and what you built');
    advance(9_000);
    assert.equal(f.isEcho('Tell me about your biggest project and what you built'), false);
  });

  test('nothing from the call yet: nothing is dropped', () => {
    const { f } = make();
    assert.equal(f.isEcho('I worked on payments infrastructure for three years'), false);
  });
});

test('main drops the echo before the transcript reaches anything else', () => {
  const main = fs.readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf8');
  const seg = main.slice(main.indexOf('const onSegment = ('), main.indexOf('this.intelligenceManager.handleTranscript({', main.indexOf('const onSegment = (')));
  assert.match(seg, /if \(speaker === 'interviewer'\) \{\s*this\.speakerEcho\.noteInterviewer\(segment\.text\);\s*\} else if \(this\.speakerEcho\.isEcho\(segment\.text\)\) \{[\s\S]*?return;\s*\}/);
  assert.ok(seg.indexOf('speakerEcho') < seg.indexOf('meetingAutoStop.noteTranscript'), 'dropped before auto-stop, gap recovery and the transcript');
});
