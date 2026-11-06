// Dashboard helpers: CSV export (with spreadsheet formula injection guarded),
// repeated slots, labels, and the hash router.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../src/lib/csv.ts';
import { minutesLabel, money, relative, repeatedSlots } from '../src/lib/format.ts';
import { parseRoute, routeHash } from '../src/lib/types.ts';

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
  assert.match(msg, /Settings › Account/);
  assert.match(msg, /A146-5560-9438-D08B/);
  assert.doesNotMatch(inviteMessage('K', 'X', ''), /https:/);
});
