// PrepPilot mock interview (electron/practice): prompts and parsing, the
// built-in question bank, the report, and the whole session flow over a real
// in-memory SQLite with an injected model. No platform branches; nothing here
// depends on macOS or Windows.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST = path.join(ROOT, 'dist-electron/electron/practice');
const HAVE_BUILD = fs.existsSync(path.join(DIST, 'PracticeService.js'));
let Database = null;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch { Database = null; }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const m = HAVE_BUILD ? require(path.join(DIST, 'mockInterview.js')) : {};
const { PracticeService } = HAVE_BUILD ? require(path.join(DIST, 'PracticeService.js')) : {};

const QUESTIONS_REPLY = '```json\n' + JSON.stringify({ questions: [
  { text: 'Tell me about yourself.', kind: 'intro', focus: 'A concise story.' },
  { text: 'Tell me about a conflict with a teammate.', kind: 'behavioral', focus: 'Resolution.' },
  { text: 'Tell me about a conflict with a teammate.', kind: 'behavioral', focus: 'duplicate' },
  { text: 'How do you design a rate limiter?', kind: 'technical', focus: 'Trade-offs.' },
  { text: 'Short', kind: 'technical', focus: 'too short' },
] }) + '\n```';
const feedbackReply = (score, extra = {}) => JSON.stringify({
  score, verdict: 'Solid answer.', strengths: ['Clear structure'], improvements: ['Quantify the result', 'Be more concise'],
  betterAnswer: 'In my last role I…', star: { situation: true, task: true, action: true, result: false }, ...extra,
});

describe('mock interview logic', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  test('config is kept within sensible bounds', () => {
    assert.deepEqual(m.normalizeConfig({ role: '  Data   Scientist ', questionCount: 50, level: 'senior', kind: 'technical' }),
      { role: 'Data Scientist', company: undefined, level: 'senior', kind: 'technical', questionCount: 10, useProfile: true });
    const d = m.normalizeConfig(null);
    assert.equal(d.role, 'Software Engineer');
    assert.equal(d.questionCount, 5);
    assert.equal(d.kind, 'mixed');
    assert.equal(m.normalizeConfig({ questionCount: 1 }).questionCount, 3);
    assert.equal(m.normalizeConfig({ useProfile: false }).useProfile, false);
  });

  test('prompts name the role, level and kind, and include the profile only when given', () => {
    const c = m.normalizeConfig({ role: 'Backend Engineer', company: 'Acme', level: 'entry', kind: 'behavioral', questionCount: 4 });
    const p = m.buildQuestionsPrompt(c, '');
    assert.match(p, /entry-level .*Backend Engineer role at Acme/);
    assert.match(p, /Write 4 interview questions: behavioural questions only/);
    assert.doesNotMatch(p, /candidate background/);
    assert.match(m.buildQuestionsPrompt(c, '<candidate_profile>X</candidate_profile>'), /<candidate_profile>X<\/candidate_profile>/);
    const q = { id: 'q1', text: 'Tell me about a conflict.', kind: 'behavioral', focus: 'Resolution.' };
    const f = m.buildFeedbackPrompt(c, q, 'I talked to them.', '<candidate_profile>X</candidate_profile>');
    assert.match(f, /QUESTION: Tell me about a conflict\./);
    assert.match(f, /I talked to them\./);
    assert.match(f, /"star"/);
    assert.match(f, /never invent employers/);
    assert.doesNotMatch(m.buildFeedbackPrompt(c, { ...q, kind: 'technical' }, 'x', ''), /"star"/, 'STAR only for behavioural');
  });

  test('questions are parsed through fences, de-duplicated, too-short ones dropped, capped at the count', () => {
    const qs = m.parseQuestions(QUESTIONS_REPLY, 5);
    assert.deepEqual(qs.map((q) => q.id), ['q1', 'q2', 'q3']);
    assert.deepEqual(qs.map((q) => q.kind), ['intro', 'behavioral', 'technical']);
    assert.equal(m.parseQuestions(QUESTIONS_REPLY, 2).length, 2);
    assert.deepEqual(m.parseQuestions('not json', 5), []);
  });

  test('feedback is clamped to 1..10, lists are capped, and STAR is kept only for behavioural questions', () => {
    const b = { id: 'q1', text: 'x', kind: 'behavioral', focus: 'y' };
    const f = m.parseFeedback(feedbackReply(14, { strengths: ['a', 'b', 'c', 'd'] }), b);
    assert.equal(f.score, 10);
    assert.equal(f.strengths.length, 3);
    assert.deepEqual(f.star, { situation: true, task: true, action: true, result: false });
    assert.equal(m.parseFeedback(feedbackReply(0), b).score, 1);
    assert.equal(m.parseFeedback(feedbackReply(7), { ...b, kind: 'technical' }).star, undefined);
    assert.equal(m.parseFeedback('{"verdict":"no score"}', b), null);
  });

  test('the built-in bank fills any count and kind', () => {
    const mixed = m.fallbackQuestions(m.normalizeConfig({ kind: 'mixed', questionCount: 5 }));
    assert.equal(mixed.length, 5);
    assert.equal(mixed[0].kind, 'intro');
    assert.ok(mixed.some((q) => q.kind === 'technical') && mixed.some((q) => q.kind === 'behavioral'));
    for (const kind of ['behavioral', 'technical']) {
      const qs = m.fallbackQuestions(m.normalizeConfig({ kind, questionCount: 3 }));
      assert.equal(qs.length, 3);
      assert.ok(qs.every((q) => q.kind === kind), kind);
    }
  });

  test('the report averages scores, finds strongest and weakest, ranks repeated improvements and counts STAR', () => {
    const qs = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }];
    const fb = (score, improvements, star) => ({ score, verdict: '', strengths: [], improvements, betterAnswer: '', ...(star ? { star } : {}) });
    const full = { situation: true, task: true, action: true, result: true };
    const answers = [
      { questionId: 'q1', answer: 'a', feedback: fb(8, ['Quantify the result.'], full), answeredAt: '' },
      { questionId: 'q2', answer: 'b', feedback: fb(5, ['quantify the result', 'Be concise'], { ...full, result: false }), answeredAt: '' },
      { questionId: 'q3', answer: 'c', feedback: null, feedbackError: 'no AI', answeredAt: '' },
    ];
    const r = m.buildReport(qs, answers);
    assert.equal(r.averageScore, 6.5);
    assert.deepEqual(r.strongest, { questionId: 'q1', score: 8 });
    assert.deepEqual(r.weakest, { questionId: 'q2', score: 5 });
    assert.equal(r.focusAreas[0], 'Quantify the result.', 'the repeated improvement leads');
    assert.deepEqual(r.starCoverage, { behavioral: 2, complete: 1 });
    assert.equal(r.answered, 3);
    assert.equal(m.buildReport(qs, []).averageScore, null);
  });
});

describe('PracticeService', { skip: !HAVE_BUILD ? 'run `npm run build:electron` first' : !Database ? 'better-sqlite3 not loadable' : false }, () => {
  const make = ({ reply, profile = '', timeoutMs } = {}) => {
    const db = new Database(':memory:');
    const prompts = [];
    const generate = reply === null ? () => null : () => async (prompt) => {
      prompts.push(prompt);
      return typeof reply === 'function' ? reply(prompt) : reply;
    };
    return { db, prompts, svc: new PracticeService({ db, generate, profileBlock: () => profile, now: () => new Date('2026-11-05T10:00:00Z'), timeoutMs }) };
  };
  const smartReply = (prompt) => (/Write \d+ interview questions/.test(prompt) ? QUESTIONS_REPLY : feedbackReply(7));

  test('a session starts with model questions, scores an answer, and finishes with a report', async () => {
    const { svc, prompts } = make({ reply: smartReply, profile: '<candidate_profile>Ada</candidate_profile>' });
    const s = await svc.start({ role: 'Engineer', questionCount: 3 });
    assert.equal(s.usedFallbackQuestions, false);
    assert.equal(s.questions.length, 3);
    assert.match(prompts[0], /<candidate_profile>Ada<\/candidate_profile>/, 'the profile reaches the questions');

    const { answer, session } = await svc.answer(s.id, 'q2', 'I listened, then we agreed on a plan.');
    assert.equal(answer.feedback.score, 7);
    assert.match(prompts[1], /I listened, then we agreed on a plan\./);
    assert.equal(session.answers.length, 1);

    // Answering the same question again replaces the earlier answer.
    await svc.answer(s.id, 'q2', 'A better answer.');
    assert.equal(svc.get(s.id).answers.length, 1);

    const done = svc.finish(s.id);
    assert.equal(done.status, 'finished');
    assert.equal(done.report.averageScore, 7);
    await assert.rejects(svc.answer(s.id, 'q1', 'late'), /already finished/);
  });

  test('without a profile opt-in, nothing from the résumé is sent', async () => {
    const { svc, prompts } = make({ reply: smartReply, profile: '<candidate_profile>SECRET</candidate_profile>' });
    const s = await svc.start({ role: 'Engineer', useProfile: false });
    await svc.answer(s.id, 'q1', 'An answer.');
    assert.ok(prompts.every((p) => !p.includes('SECRET')));
  });

  test('when the model fails or is missing, built-in questions are used and the answer is kept without feedback', async () => {
    const failing = make({ reply: () => { throw new Error('boom'); } });
    const s = await failing.svc.start({ kind: 'behavioral', questionCount: 3 });
    assert.equal(s.usedFallbackQuestions, true);
    assert.equal(s.questions.length, 3);
    const r = await failing.svc.answer(s.id, 'q1', 'My answer.');
    assert.equal(r.answer.feedback, null);
    assert.match(r.answer.feedbackError, /could not score/);

    const noAi = make({ reply: null });
    const s2 = await noAi.svc.start({ questionCount: 3 });
    assert.equal(s2.usedFallbackQuestions, true);
    const r2 = await noAi.svc.answer(s2.id, 'q1', 'My answer.');
    assert.match(r2.answer.feedbackError, /Connect an AI/);
  });

  test('a model that never answers times out instead of hanging the session', async () => {
    const { svc } = make({ reply: () => new Promise(() => {}), timeoutMs: 30 });
    const s = await svc.start({ questionCount: 3 });
    assert.equal(s.usedFallbackQuestions, true);
  });

  test('empty answers and unknown questions are refused', async () => {
    const { svc } = make({ reply: smartReply });
    const s = await svc.start({ questionCount: 3 });
    await assert.rejects(svc.answer(s.id, 'q1', '   '), /Say or type an answer/);
    await assert.rejects(svc.answer(s.id, 'nope', 'x'), /Unknown question/);
    await assert.rejects(svc.answer('missing', 'q1', 'x'), /no longer exists/);
  });

  test('sessions persist, list newest first with scores, and can be deleted', async () => {
    const { svc, db } = make({ reply: smartReply });
    const a = await svc.start({ role: 'First', questionCount: 3 });
    await svc.answer(a.id, 'q1', 'x');
    svc.finish(a.id);
    const again = new PracticeService({ db, generate: () => null, profileBlock: () => '' });
    const list = again.history();
    assert.equal(list.length, 1);
    assert.equal(list[0].role, 'First');
    assert.equal(list[0].averageScore, 7);
    assert.equal(list[0].status, 'finished');
    assert.equal(again.delete(a.id), true);
    assert.equal(again.history().length, 0);
  });
});

describe('wiring', () => {
  test('practice IPC is registered from ipcHandlers and bridged in preload', () => {
    assert.match(read('electron/ipcHandlers.ts'), /require\('\.\/practice\/practiceIpc'\)\.registerPracticeIpc\(safeHandle, appState\);/);
    const ipc = read('electron/practice/practiceIpc.ts');
    const preload = read('electron/preload.ts');
    for (const ch of ['practice:start', 'practice:answer', 'practice:finish', 'practice:get', 'practice:history', 'practice:delete', 'practice:voice-toggle', 'practice:voice-cancel']) {
      assert.ok(ipc.includes(`safeHandle('${ch}'`), `${ch} handled`);
      assert.ok(preload.includes(`ipcRenderer.invoke('${ch}'`), `${ch} bridged`);
    }
    assert.ok(preload.includes("ipcRenderer.on('practice-voice', subscription)"));
  });

  test('voice answers go to the practice panel, never to the clipboard or the OS', () => {
    const wire = read('electron/services/dictation/wireDictation.ts');
    const fn = wire.slice(wire.indexOf('export function wireDictationTo'), wire.indexOf('export function dictationWiring'));
    assert.match(fn, /writeClipboard: deliver,/);
    assert.match(fn, /notify: \(notice, kind\) => onNotice\(kind, notice\),/);
    assert.match(fn, /format: async \(raw\) => raw,/, 'kept as spoken for the feedback');
    assert.doesNotMatch(fn, /clipboard|Notification/);
  });

  test('the Launcher opens the panel in the manager card', () => {
    const app = read('src/App.tsx');
    assert.match(app, /type ManagerPanel = 'modes' \| 'profile' \| 'practice' \| null/);
    assert.match(app, /activeManagerPanel === 'practice' \? \(\s*<MockInterviewPanel onClose=\{closeManagerPanel\} \/>/);
    assert.match(read('src/components/Launcher.tsx'), /onClick=\{\(\) => onOpenPractice\(\)\}/);
  });
});
