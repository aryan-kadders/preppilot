// PrepPilot mock interview: delivery coaching (pace, fillers, length) for
// spoken answers, and progress across sessions. Pure functions plus the
// service over a real in-memory SQLite. No platform branches.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST = path.join(ROOT, 'dist-electron/electron/practice');
const HAVE_BUILD = fs.existsSync(path.join(DIST, 'delivery.js')) && fs.existsSync(path.join(DIST, 'progress.js'));
let Database = null;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch { Database = null; }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const d = HAVE_BUILD ? require(path.join(DIST, 'delivery.js')) : {};
const p = HAVE_BUILD ? require(path.join(DIST, 'progress.js')) : {};
const { PracticeService } = HAVE_BUILD ? require(path.join(DIST, 'PracticeService.js')) : {};

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('delivery', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  test('pace bands: slow, good, fast; none for typed or very short answers', () => {
    assert.equal(d.analyzeDelivery(words(150), 60_000).pace, 'good');
    assert.equal(d.analyzeDelivery(words(150), 60_000).wpm, 150);
    assert.equal(d.analyzeDelivery(words(90), 60_000).pace, 'slow');
    assert.equal(d.analyzeDelivery(words(200), 60_000).pace, 'fast');
    assert.equal(d.analyzeDelivery(words(150), null).wpm, null, 'typed');
    assert.equal(d.analyzeDelivery(words(10), 4_000).wpm, null, 'too short to judge');
  });

  test('fillers are counted, multi-word ones once, and ordinary uses are not', () => {
    const r = d.analyzeDelivery('Um, so I basically, uh, you know, led the team. I mean, it was, like, hard. Um yes.', 30_000);
    const byWord = Object.fromEntries(r.fillers.map((f) => [f.word, f.count]));
    assert.equal(byWord.um, 2);
    assert.equal(byWord.uh, 1);
    assert.equal(byWord['you know'], 1);
    assert.equal(byWord['i mean'], 1);
    assert.equal(byWord.basically, 1);
    assert.equal(byWord.like, 1);
    assert.equal(byWord.know, undefined);
    const clean = d.analyzeDelivery('Do you know what a hash map is? I like Python and I would like to work here.', 30_000);
    assert.equal(clean.fillerCount, 0, '"you know what" and "I like Python" are not fillers');
  });

  test('length and tips', () => {
    assert.equal(d.analyzeDelivery(words(20), null).length, 'short');
    assert.equal(d.analyzeDelivery(words(120), null).length, 'good');
    assert.equal(d.analyzeDelivery(words(320), null).length, 'long');
    const tips = d.analyzeDelivery('um uh um uh ' + words(30), 15_000).tips.join(' ');
    assert.match(tips, /Filler words came up often/);
    assert.match(tips, /This answer was short/);
    assert.match(d.analyzeDelivery(words(220), 60_000).tips.join(' '), /Slow down a little/);
  });

  test('the session summary averages pace and totals fillers over spoken answers only', () => {
    const a = d.analyzeDelivery('um ' + words(149), 60_000);
    const b = d.analyzeDelivery(words(170), 60_000);
    const s = d.summarizeDelivery([a, b]);
    assert.equal(s.spokenAnswers, 2);
    assert.equal(s.averageWpm, 160);
    assert.equal(s.totalFillers, 1);
    assert.deepEqual(s.topFillers, [{ word: 'um', count: 1 }]);
    assert.equal(d.summarizeDelivery([]), null);
  });
});

describe('progress', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  const session = (id, day, kind, scores, improvements = []) => ({
    id, createdAt: `2026-11-${String(day).padStart(2, '0')}T10:00:00Z`, updatedAt: '', status: 'finished',
    config: { role: 'Engineer', level: 'mid', kind, questionCount: scores.length, useProfile: true },
    questions: scores.map((_, i) => ({ id: `q${i + 1}`, text: 'Q', kind: 'behavioral', focus: '' })),
    answers: scores.map((sc, i) => ({ questionId: `q${i + 1}`, answer: 'a', answeredAt: '', feedback: sc === null ? null : { score: sc, verdict: '', strengths: [], improvements, betterAnswer: '' } })),
    usedFallbackQuestions: false, report: null,
  });

  test('scores over time, oldest first, with the trend of the last three against the three before', () => {
    const sessions = [
      session('a', 1, 'behavioral', [4, 4]), session('b', 2, 'behavioral', [5]), session('c', 3, 'technical', [5]),
      session('d', 4, 'technical', [7]), session('e', 5, 'mixed', [8]), session('f', 6, 'mixed', [8, 6]),
    ];
    const r = p.computeProgress([...sessions].reverse());
    assert.equal(r.sessions, 6);
    assert.deepEqual(r.recent.map((x) => x.id), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.equal(r.trend, 2.7);
    assert.deepEqual(r.byKind.map((k) => [k.kind, k.averageScore]), [['mixed', 7.5], ['behavioral', 4.5], ['technical', 6]]);
    assert.equal(r.answers, 8);
  });

  test('sessions without a scored answer are left out; fewer than four sessions has no trend', () => {
    const r = p.computeProgress([session('a', 1, 'mixed', [null]), session('b', 2, 'mixed', [6])]);
    assert.equal(r.sessions, 1);
    assert.equal(r.trend, null);
    assert.equal(p.computeProgress([]).averageScore, null);
  });

  test('focus areas are the improvements that recur across sessions', () => {
    const r = p.computeProgress([
      session('a', 1, 'mixed', [5], ['Quantify the result.', 'Slow down.']),
      session('b', 2, 'mixed', [6], ['quantify the result', 'Use STAR.']),
    ]);
    assert.deepEqual(r.focusAreas, ['Quantify the result.']);
  });
});

describe('spoken answers end to end', { skip: !HAVE_BUILD ? 'run `npm run build:electron` first' : !Database ? 'better-sqlite3 not loadable' : false }, () => {
  test('a spoken answer gets delivery stats, a typed one does not, and the report summarises them', async () => {
    const db = new Database(':memory:');
    const svc = new PracticeService({ db, generate: () => async (prompt) => (/Write \d+ interview questions/.test(prompt)
      ? JSON.stringify({ questions: [{ text: 'Tell me about yourself please.', kind: 'intro', focus: 'x' }, { text: 'Describe a hard bug you fixed.', kind: 'technical', focus: 'y' }, { text: 'Why do you want this role?', kind: 'behavioral', focus: 'z' }] })
      : JSON.stringify({ score: 7, verdict: 'ok', strengths: [], improvements: [], betterAnswer: '' })), profileBlock: () => '' });
    const s = await svc.start({ questionCount: 3 });
    const spoken = await svc.answer(s.id, 'q1', 'um ' + words(149), { spoken: true, durationMs: 60_000 });
    assert.equal(spoken.answer.delivery.wpm, 150);
    const typed = await svc.answer(s.id, 'q2', words(50));
    assert.equal(typed.answer.delivery, undefined);
    const report = svc.finish(s.id).report;
    assert.equal(report.delivery.spokenAnswers, 1);
    assert.equal(report.delivery.averageWpm, 150);
    assert.equal(svc.all().length, 1);
  });
});

test('wiring: speaking time and progress reach the panel', () => {
  const ipc = read('electron/practice/practiceIpc.ts');
  assert.match(ipc, /broadcast\('practice-voice', \{ state: 'done', text, durationMs: speakingMs \}\)/);
  assert.match(ipc, /reason === 'answer-ended' \? SILENCE_MS : 0/, 'the auto-stop silence is not counted as speaking time');
  assert.match(ipc, /safeHandle\('practice:progress'/);
  assert.ok(read('electron/preload.ts').includes("ipcRenderer.invoke('practice:progress')"));
  const ui = read('src/components/practice/MockInterviewPanel.tsx');
  assert.match(ui, /const meta = spokenRef\.current\.spoken \? \{ spoken: true, durationMs: spokenRef\.current\.ms \|\| null \} : undefined;/);
  assert.match(ui, /\{progress && progress\.sessions > 0 && <ProgressView progress=\{progress\} \/>\}/);
});
