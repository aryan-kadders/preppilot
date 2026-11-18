// A signed-in candidate's finished meetings and mock interviews go to the
// team's dashboard: what is sent (never screenshots), and the queue that
// keeps a session that ended offline until it can be sent.
// Pure code from electron/services/cloud/sessionRecords.ts; no platform branches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { buildMeetingRecord, buildPracticeRecord, shouldRetry, SessionRecordUploader } =
  require(path.join(repo, 'dist-electron/electron/services/cloud/sessionRecords.js'));

test('a meeting record: transcript, answers without screenshots, notes, and the real start time', () => {
  const r = buildMeetingRecord({
    id: 'm1', title: 'Backend round', date: '2026-11-18T10:00:00Z',
    transcript: [{ speaker: 'interviewer', text: 'Hi', timestamp: 1000 }],
    usage: [{ type: 'assist', timestamp: 1500, question: 'Q', answer: 'A', images: ['data:image/jpeg;base64,AAA'] }],
    detailedSummary: { overview: 'ok', keyPoints: [], actionItems: [] },
  }, { startTime: Date.parse('2026-11-18T09:58:00Z'), durationMs: 61_500 });
  assert.equal(r.kind, 'meeting');
  assert.equal(r.started_at, '2026-11-18T09:58:00.000Z');
  assert.equal(r.duration_seconds, 62);
  assert.deepEqual(r.content.transcript, [{ speaker: 'interviewer', text: 'Hi', t: 1000 }]);
  assert.equal(JSON.stringify(r).includes('base64'), false, 'screenshots stay on the computer');
  assert.equal(r.content.summary.overview, 'ok');
});

test('a mock interview record is titled by role and company', () => {
  const r = buildPracticeRecord({ id: 'p1', createdAt: '2026-11-18T10:00:00Z', updatedAt: '2026-11-18T10:12:00Z',
    config: { role: 'Backend engineer', company: 'Acme' }, questions: [], answers: [], report: { averageScore: 7 } });
  assert.equal(r.title, 'Mock interview: Backend engineer at Acme');
  assert.equal(r.duration_seconds, 720);
});

test('network, sign-in and server trouble are retried; a refused record is not', () => {
  assert.equal(shouldRetry(new Error('fetch failed')), true);
  for (const status of [401, 404, 408, 429, 500, 503]) assert.equal(shouldRetry({ status }), true, String(status));
  for (const status of [400, 403, 413]) assert.equal(shouldRetry({ status }), false, String(status));
});

function harness({ signedIn = true, failures = [] } = {}) {
  const saved = [];
  const sent = [];
  const scheduled = [];
  const state = { signedIn, failures: [...failures], stored: [] };
  const u = new SessionRecordUploader({
    signedIn: () => state.signedIn,
    upload: async (body) => { const f = state.failures.shift(); if (f) throw f; sent.push(body.local_id); },
    loadMeeting: (id) => (id === 'gone' ? null : { kind: 'meeting', local_id: id }),
    loadPractice: (id) => ({ kind: 'practice', local_id: id }),
    store: { load: () => state.stored, save: (q) => { state.stored = JSON.parse(JSON.stringify(q)); saved.push(state.stored); } },
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });
  return { u, sent, scheduled, state };
}

test('sent at once while signed in; nothing is queued when signed out', async () => {
  const h = harness();
  await h.u.enqueue('meeting', 'm1');
  await h.u.enqueue('practice', 'p1');
  assert.deepEqual(h.sent, ['m1', 'p1']);
  assert.deepEqual(h.state.stored, []);

  const out = harness({ signedIn: false });
  await out.u.enqueue('meeting', 'm1');
  assert.deepEqual([out.sent, out.u.pending.length], [[], 0]);
});

test('offline: kept in the queue file, retried later, and sent by the next launch', async () => {
  const h = harness({ failures: [new Error('fetch failed')] });
  await h.u.enqueue('meeting', 'm1');
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.state.stored.map((r) => r.id), ['m1']);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0].ms, 5 * 60_000);

  // The app quit before the retry: the next launch reads the same file.
  const next = new SessionRecordUploader({
    signedIn: () => true,
    upload: async (b) => { h.sent.push(b.local_id); },
    loadMeeting: (id) => ({ kind: 'meeting', local_id: id }),
    loadPractice: () => null,
    store: { load: () => h.state.stored, save: (q) => { h.state.stored = q; } },
  });
  await next.flush();
  assert.deepEqual(h.sent, ['m1']);
  assert.deepEqual(h.state.stored, []);
});

test('a refused or deleted record is dropped, and the rest still go', async () => {
  const h = harness({ failures: [Object.assign(new Error('record_too_large'), { status: 413, code: 'record_too_large' })] });
  h.state.signedIn = false;
  await h.u.enqueue('meeting', 'x');
  h.state.signedIn = true;
  await h.u.enqueue('meeting', 'big');
  await h.u.enqueue('meeting', 'gone');
  await h.u.enqueue('meeting', 'ok');
  assert.deepEqual(h.sent, ['ok']);
  assert.deepEqual(h.state.stored, []);
});

test('the same session queued twice is sent once', async () => {
  const h = harness({ failures: [new Error('offline')] });
  await h.u.enqueue('meeting', 'm1');
  assert.equal(h.u.pending.length, 1);
  await h.u.enqueue('meeting', 'm1');
  assert.deepEqual(h.sent, ['m1'], 'one upload, not two');
  assert.equal(h.u.pending.length, 0);
});
