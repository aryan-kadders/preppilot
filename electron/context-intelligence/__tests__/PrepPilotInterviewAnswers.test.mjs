// PrepPilot (2026-11-05), measured live on gemini-3.1-flash-lite in General:
//   "I want a long code for any ecommerce website like Amazon or Flipkart"
//     → one paragraph and a six-line schema;
//   "Can you write a code for home page of any website?" → a bare skeleton;
//   a scenario question → "I will be back with a summary … shortly".
// Code turns now drop the spoken two-to-four-sentence rules and get a
// build-size section; behavioral and scenario questions get a STAR answer
// (the real story when the evidence holds one, else a realistic example).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const base = path.resolve(process.cwd(), 'dist-electron/electron');
const ci = path.join(base, 'context-intelligence');
const composer = await import(pathToFileURL(path.join(ci, 'generation/prompt-composer.js')).href);
const { composePrompt, BEHAVIORAL_ASK_RE, LARGE_BUILD_RE } = composer;
const { decide } = await import(pathToFileURL(path.join(ci, 'orchestration/orchestrator.js')).href);
const { MODE_POLICIES } = await import(pathToFileURL(path.join(ci, 'policies/mode-policy-registry.js')).href);

const heard = (q, modeId = 'technical-interview') => decide({
  requestId: 'r1', requestSequence: 1, surface: 'what-to-answer', modeId,
  scope: { userId: 'u1', sessionId: 's1' }, sessionId: 's1', transcriptQuestion: q,
});
const compose = (q, modeId = 'technical-interview') => composePrompt({
  decision: heard(q, modeId), policy: MODE_POLICIES[modeId], evidence: [], attachedSourceCount: 0, profileSourceCount: 0, heardQuestion: true,
});
const SPOKEN = 'Keep it short enough to say out loud';

describe('code requests', () => {
  for (const q of [
    'I want a long code for any ecommerce website like Amazon or Flipkart.',
    'Can you write a code for home page of any website?',
    'Give me the code for a login page.',
    'Build a todo app in React.',
  ]) {
    test(`a coding turn without the spoken-length rule: ${q}`, () => {
      const d = heard(q);
      assert.ok(d.questionTypes.includes('CODING_TASK'), d.questionTypes.join(','));
      const p = compose(q);
      assert.ok(!p.system.includes(SPOKEN), 'spoken length rule still present');
      assert.ok(p.sections.includes('build_scope'), p.sections.join(','));
    });
  }
  test('a long or whole-project ask gets the multi-file build', () => {
    assert.match(compose('I want a long code for any ecommerce website like Amazon or Flipkart.').user, /real multi-file implementation/);
    assert.match(compose('Write the complete code for a food delivery app.').user, /real multi-file implementation/);
  });
  test('a page gets complete, finished-looking code, not the multi-file build', () => {
    const p = compose('Give me the code for a login page.');
    assert.match(p.user, /Never a bare skeleton/);
    assert.doesNotMatch(p.user, /multi-file/);
  });
  test('a small algorithm keeps its contract and gets no build section', () => {
    const p = compose('Reverse a linked list in place.');
    assert.ok(!p.sections.includes('build_scope'), p.sections.join(','));
  });
  test('a spoken question keeps the spoken rules', () => {
    const p = compose('What is the difference between a process and a thread?');
    assert.ok(p.system.includes(SPOKEN));
    assert.ok(!p.sections.includes('build_scope'));
  });
  test('"code" as a noun is not a request for code', () => {
    for (const q of ['What is the code review process at your company?', 'explain this code', 'give me the code']) {
      assert.ok(!heard(q).questionTypes.includes('CODING_TASK'), q);
    }
  });
  test('LARGE_BUILD_RE: long builds yes, ordinary asks no', () => {
    for (const q of ['long code for an ecommerce website', 'full stack app for a library', 'a website like Amazon', 'netflix clone']) assert.ok(LARGE_BUILD_RE.test(q), q);
    for (const q of ['write fibonacci', 'code for a login page', 'reverse a string']) assert.ok(!LARGE_BUILD_RE.test(q), q);
  });
});

describe('behavioral and scenario questions', () => {
  const STORIES = [
    'Tell me about a time you handled a conflict with a teammate.',
    'How would you handle a disagreement with your manager about a deadline?',
    'What would you do if production went down on a Friday evening?',
    'Describe a situation where you had to learn something quickly.',
    'Give me an example of when you missed a deadline.',
  ];
  for (const q of STORIES) {
    test(`a STAR answer, with no "tell no story": ${q}`, () => {
      assert.ok(BEHAVIORAL_ASK_RE.test(q), q);
      const p = compose(q);
      assert.ok(p.sections.includes('practice_story'), p.sections.join(','));
      assert.match(p.user, /one complete STAR answer/);
      assert.doesNotMatch(p.user + p.system, /tell no story/);
      assert.match(p.user, /never promise to follow up/);
    });
  }
  test('General and Looking for work get it too', () => {
    for (const mode of ['general', 'looking-for-work']) {
      assert.ok(compose(STORIES[0], mode).sections.includes('practice_story'), mode);
    }
  });
  test('modes where the user speaks to colleagues or customers keep the no-story rules', () => {
    for (const mode of ['team-meet', 'sales', 'recruiting']) {
      if (!MODE_POLICIES[mode]) continue;
      assert.ok(!compose(STORIES[0], mode).sections.includes('practice_story'), mode);
    }
  });
  // 2026-11-13: an invented example must say it is a sample, never pass as
  // the candidate's own history; a real story from the evidence is unlabelled.
  test('with nothing on file, the invented example is labelled as a sample', () => {
    const p = compose(STORIES[0]);
    assert.match(p.user, /first line is exactly "Sample story \(replace with your own\):"/);
    assert.match(p.user, /"Sample example \(replace with your own\):"/);
    assert.match(p.user, /Nothing about the user's own past is on file/);
    assert.match(p.user, /Never present an invented example as something that happened to the user/);
    assert.doesNotMatch(p.user, /never say the example is hypothetical/);
  });
  test('with evidence, a real story is told unlabelled and only an invented one is labelled', () => {
    const n = composer.practiceStoryNotice(heard(STORIES[0]), true);
    assert.match(n, /tell that one with only its real details and no label/);
    assert.match(n, /does not come from the evidence is NOT the user's own experience/);
    assert.doesNotMatch(n, /Nothing about the user's own past is on file/);
  });
  test('a fact about the user is still never invented', () => {
    for (const q of ['How big was your team at your last company?', 'What is your CGPA?', 'Tell me about yourself.']) {
      assert.ok(!BEHAVIORAL_ASK_RE.test(q), q);
      assert.ok(!compose(q).sections.includes('practice_story'), q);
    }
  });
});
