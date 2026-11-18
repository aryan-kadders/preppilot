// Dashboard helpers: CSV export (with spreadsheet formula injection guarded),
// repeated slots, labels, and the hash router.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../src/lib/csv.ts';
import { minutesLabel, money, relative, repeatedSlots } from '../src/lib/format.ts';
import { canJudgeReadiness, canManage, canRecruit, isAdmin, parseRoute, routeHash } from '../src/lib/types.ts';

test('CSV quotes what needs quoting and defuses formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(null), '');
  assert.equal(toCsv(['A', 'B'], [[1, 'x']]), 'A,B\r\n1,x\r\n');
});

test('minutes read naturally', () => {
  assert.equal(minutesLabel(0), '0 min');
  assert.equal(minutesLabel(59 * 60 + 59), '59 min');
  assert.equal(minutesLabel(90 * 60), '1 h 30 min');
  assert.equal(minutesLabel(120 * 60), '2 h');
  assert.equal(minutesLabel(-50), '0 min');
});

test('money and relative times', () => {
  assert.equal(money(0), '$0.00');
  assert.equal(money(0.000013), '< $0.01');
  assert.equal(money('1.5'), '$1.50');
  const now = Date.parse('2026-11-07T10:00:00Z');
  assert.equal(relative('2026-11-07T09:59:30Z', now), 'just now');
  assert.equal(relative('2026-11-07T08:00:00Z', now), '2 h ago');
  assert.equal(relative(null, now), 'never');
});

test('repeated slots skip weekends when asked, and keep their length', () => {
  const friday = new Date('2026-11-06T18:00:00'); // a Friday, local time
  const slots = repeatedSlots(friday, 60, 3, true);
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map((s) => new Date(s.starts_at).getDay()), [5, 1, 2]);
  for (const s of slots) assert.equal(Date.parse(s.ends_at) - Date.parse(s.starts_at), 3_600_000);
  assert.equal(repeatedSlots(friday, 30, 3, false).length, 3);
});

test('routes round-trip, and anything unknown goes to Candidates', () => {
  const id = '8e3ec389-4016-4d15-9cba-74c1fa1c6414';
  assert.deepEqual(parseRoute(`#/candidates/${id}`), { page: 'candidate', id });
  assert.equal(routeHash({ page: 'candidate', id }), `#/candidates/${id}`);
  assert.deepEqual(parseRoute('#/usage'), { page: 'usage' });
  assert.deepEqual(parseRoute('#access_token=abc&type=invite'), { page: 'candidates' });
  assert.deepEqual(parseRoute('#/candidates/not-an-id'), { page: 'candidates' });
  for (const page of ['interviews', 'companies', 'team', 'audit']) {
    assert.deepEqual(parseRoute(routeHash({ page })), { page });
  }
});

test('what each role may do', () => {
  const me = (role) => ({ role, isOwner: role === 'owner' });
  const table = Object.fromEntries(['owner', 'admin', 'manager', 'recruiter', 'coach'].map((r) =>
    [r, [isAdmin(me(r)), canManage(me(r)), canRecruit(me(r)), canJudgeReadiness(me(r))]]));
  assert.deepEqual(table, {
    owner: [true, true, true, true],
    admin: [true, true, true, true],
    manager: [false, true, true, true],
    recruiter: [false, false, true, false],
    coach: [false, false, false, true],
  });
});

test('download links and the invite message', async () => {
  const { normalizeReleasesUrl, downloadLinks, inviteMessage } = await import('../src/lib/downloads.ts');
  assert.equal(normalizeReleasesUrl(' https://pub-x.r2.dev/ '), 'https://pub-x.r2.dev');
  assert.equal(normalizeReleasesUrl('http://pub-x.r2.dev'), '');
  assert.equal(normalizeReleasesUrl(undefined), '');
  assert.deepEqual(downloadLinks('https://pub-x.r2.dev').map((l) => l.url),
    ['https://pub-x.r2.dev/PrepPilot-mac-arm64.dmg', 'https://pub-x.r2.dev/PrepPilot-Setup-win-x64.exe']);
  assert.deepEqual(downloadLinks(''), []);
  const msg = inviteMessage('Kishan Patel', 'A146-5560-9438-D08B', 'https://pub-x.r2.dev');
  assert.match(msg, /^Hi Kishan,/);
  assert.match(msg, /PrepPilot-mac-arm64\.dmg/);
  assert.match(msg, /Join your team" on the home page/);
  assert.match(msg, /A146-5560-9438-D08B/);
  assert.doesNotMatch(inviteMessage('K', 'X', ''), /https:/);
});

test('session history: routes, speakers, times, one timeline, search, the text copy', async () => {
  const { speakerLabel, offsetLabel, timeline, matches, recordToText, daysLeft } = await import('../src/lib/records.ts');
  const id = '0f8e1c2a-1111-4222-8333-944455556666';
  assert.deepEqual(parseRoute(`#/sessions/${id}`), { page: 'record', id });
  assert.deepEqual(parseRoute('#/sessions'), { page: 'sessions' });
  assert.equal(routeHash({ page: 'record', id }), `#/sessions/${id}`);

  assert.equal(speakerLabel('user'), 'Candidate');
  assert.equal(speakerLabel('interviewer'), 'Interviewer');
  assert.equal(speakerLabel('speaker_2'), 'Interviewer');
  assert.equal(speakerLabel('assistant'), 'PrepPilot');

  const start = Date.parse('2026-11-18T10:00:00Z');
  assert.equal(offsetLabel(start + 65_000, start), '1:05');
  assert.equal(offsetLabel(start + 3_725_000, start), '1:02:05');
  assert.equal(offsetLabel(12_000, start), '0:12', 'an offset already');
  assert.equal(offsetLabel(null, start), '');

  const content = {
    transcript: [{ speaker: 'interviewer', text: 'Tell me about Kafka', t: start + 1000 }, { speaker: 'user', text: 'We used it for orders', t: start + 9000 }],
    answers: [{ type: 'assist', t: start + 2000, question: 'Tell me about Kafka', answer: 'Kafka is a log', items: [] }],
    summary: { overview: 'Solid.', tldr: [], keyPoints: ['Knows Kafka'], actionItems: [], sections: [], coaching: [] },
  };
  assert.deepEqual(timeline(content).map((x) => x.kind), ['line', 'answer', 'line']);
  assert.equal(timeline(content).filter((x) => matches(x, 'ORDERS')).length, 1);

  const text = recordToText({ id, candidate_id: id, session_id: null, kind: 'meeting', title: 'Round 1', started_at: '2026-11-18T10:00:00Z',
    duration_seconds: 600, line_count: 2, answer_count: 1, score: null, expires_at: '2027-02-16T10:00:00Z',
    candidate_name: 'Asha', content, created_at: '', updated_at: '', can_delete: true });
  assert.match(text, /Candidate: Asha/);
  assert.match(text, /\[0:01\] Interviewer: Tell me about Kafka/);
  assert.match(text, /\[0:02\] PrepPilot answer to "Tell me about Kafka": Kafka is a log/);
  assert.match(text, /KEY POINTS\n- Knows Kafka/);

  assert.equal(daysLeft('2026-11-20T00:00:00Z', Date.parse('2026-11-18T00:00:00Z')), 2);
});
