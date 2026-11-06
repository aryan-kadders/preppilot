import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { ReleaseNotesManager } = await import(
  pathToFileURL(path.resolve(__dirname, '../../dist-electron/electron/update/ReleaseNotesManager.js')).href
);

const parse = (body) => {
  const manager = ReleaseNotesManager.getInstance();
  return manager.parseReleaseNotes(body, 'v9.9.9', 'https://example.test/release');
};

test('release notes parser accepts GitHub H3 headings and emoji-decorated titles', () => {
  const parsed = parse(`
### 🚀 What's New
- Added automatic update diagnostics

### 🛠 Improvements & Fixes
- Fixed updater release metadata lookup
- Improved release note parsing

### Technical Notes
- Hardened auto-update state transitions
`);

  assert.equal(parsed.version, 'v9.9.9');
  assert.deepEqual(parsed.sections, [
    { title: "What's New", items: ['Added automatic update diagnostics'] },
    { title: 'Improvements', items: ['Fixed updater release metadata lookup', 'Improved release note parsing'] },
    { title: 'Technical', items: ['Hardened auto-update state transitions'] },
  ]);
});

// PrepPilot: release notes and updates come from this fork's own repository.
test('release notes come from PrepPilot\'s own release host, never upstream\'s GitHub', async () => {
  // The address layout itself is covered by releasesUrl.test.mjs; here, the
  // manager asks only that host, and a build without one (this test build:
  // PREPPILOT_RELEASES_URL unset) asks nobody.
  const { BAKED_RELEASES_URL, releaseNotesUrl } = await import(
    pathToFileURL(path.resolve(__dirname, '../../dist-electron/electron/update/releasesUrl.js')).href
  );
  const manager = ReleaseNotesManager.getInstance();
  for (const version of ['2.8.8', 'v2.8.8', 'V2.8.8', 'latest']) {
    const urls = manager.buildReleaseUrls(version);
    assert.deepEqual(urls, BAKED_RELEASES_URL ? [releaseNotesUrl(version)] : []);
    assert.ok(urls.every((u) => !u.includes('github.com')));
  }
});

test('release notes parser ignores HTML comments, including "- " lines inside them', () => {
  const parsed = parse(`
## Summary

<!-- Hard limit: 170 characters.
- not a bullet -->
A short summary.

## Fixes

<!--
  - also not a bullet
-->
- Startup — fixed the logo hang.
`);
  assert.equal(parsed.summary, 'A short summary.');
  assert.deepEqual(parsed.sections, [{ title: 'Fixes', items: ['Startup — fixed the logo hang.'] }]);
});

test('.github/RELEASE_TEMPLATE.md reads cleanly in the app, old versions included', async () => {
  const fs = await import('node:fs');
  const template = fs.readFileSync(path.resolve(__dirname, '../../.github/RELEASE_TEMPLATE.md'), 'utf8');
  const parsed = parse(template);

  // Every section the card reads, under the exact heading names.
  assert.deepEqual(parsed.sections.map((s) => s.title), ["What's New", 'Improvements', 'Fixes', 'Technical']);
  // The authoring notes never reach the card.
  assert.doesNotMatch(parsed.summary, /<!--|-->|Hard limit/);
  assert.ok(parsed.summary.length > 0 && parsed.summary.length <= 170, `summary placeholder is ${parsed.summary.length} chars`);

  // Versions up to 2.8.8 do not strip comments and print bullets verbatim:
  // no line inside a comment may look like a bullet, and no bullet may carry markdown.
  for (const comment of template.match(/<!--[\s\S]*?-->/g) ?? []) {
    for (const line of comment.split('\n')) assert.doesNotMatch(line.trim(), /^[-*] /, `bullet-like line in a comment: ${line}`);
  }
  for (const section of parsed.sections) {
    for (const item of section.items) assert.doesNotMatch(item, /\*\*|`|\]\(/, `markdown in bullet: ${item}`);
  }

  // The example summary in the notes obeys its own limit.
  const example = /Example \((\d+) characters\):\n(.+)\n/.exec(template);
  assert.ok(example, 'template keeps a worked summary example');
  assert.equal([...example[2]].length, Number(example[1]));
  assert.ok(Number(example[1]) <= 170);
});
