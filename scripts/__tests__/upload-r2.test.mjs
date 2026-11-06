// scripts/upload-r2.mjs and scripts/lib/releases-url.cjs: the release host
// address, what a release uploads and in which order, and the S3 request
// signature (checked against the aws4 package's independent implementation).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { signS3Request, planUpload, filesInFeed, fixedNameFor, notesJson } from '../upload-r2.mjs';

const require = createRequire(import.meta.url);
const { normalizeReleasesUrl, resolveReleasesUrl } = require('../lib/releases-url.cjs');

test('release host: https only, no credentials or query, trailing slash dropped', () => {
  assert.equal(normalizeReleasesUrl(' https://pub-abc.r2.dev/ '), 'https://pub-abc.r2.dev');
  assert.equal(normalizeReleasesUrl('https://dl.example.com/preppilot//'), 'https://dl.example.com/preppilot');
  assert.equal(normalizeReleasesUrl('http://pub-abc.r2.dev'), '');
  assert.equal(normalizeReleasesUrl('https://u:p@pub-abc.r2.dev'), '');
  assert.equal(normalizeReleasesUrl('https://pub-abc.r2.dev/?x=1'), '');
  assert.equal(normalizeReleasesUrl('not a url'), '');
  assert.equal(resolveReleasesUrl('/nonexistent', { PREPPILOT_RELEASES_URL: 'https://a.example' }), 'https://a.example');
});

const MAC_FEED = `version: 3.2.0
files:
  - url: PrepPilot-3.2.0-arm64-mac.zip
    sha512: abc
    size: 1
  - url: PrepPilot-3.2.0-arm64.dmg
    sha512: def
    size: 2
path: PrepPilot-3.2.0-arm64-mac.zip
sha512: abc
releaseDate: '2026-11-07T00:00:00.000Z'
`;

test('the feed names its files once each', () => {
  assert.deepEqual(filesInFeed(MAC_FEED), ['PrepPilot-3.2.0-arm64-mac.zip', 'PrepPilot-3.2.0-arm64.dmg']);
});

test('fixed download names per platform', () => {
  assert.equal(fixedNameFor('PrepPilot-3.2.0-arm64.dmg'), 'PrepPilot-mac-arm64.dmg');
  assert.equal(fixedNameFor('PrepPilot-3.2.0-x64.dmg'), 'PrepPilot-mac-x64.dmg');
  assert.equal(fixedNameFor('PrepPilot-Setup-3.2.0.exe'), 'PrepPilot-Setup-win-x64.exe');
  assert.equal(fixedNameFor('PrepPilot-3.2.0-arm64-mac.zip'), null);
});

test('macOS plan: installers, then fixed copies, feed last; no feed means nothing to upload', () => {
  const files = { 'latest-mac.yml': MAC_FEED };
  const list = () => ['latest-mac.yml', 'PrepPilot-3.2.0-arm64-mac.zip', 'PrepPilot-3.2.0-arm64-mac.zip.blockmap', 'PrepPilot-3.2.0-arm64.dmg', 'PrepPilot-3.2.0-arm64.dmg.blockmap', 'builder-debug.yml'];
  const plan = planUpload('/r', list, (f) => files[path.basename(f)]);
  assert.equal(plan.version, '3.2.0');
  assert.deepEqual(plan.steps.map((s) => s.key), [
    'PrepPilot-3.2.0-arm64-mac.zip', 'PrepPilot-3.2.0-arm64-mac.zip.blockmap',
    'PrepPilot-3.2.0-arm64.dmg', 'PrepPilot-3.2.0-arm64.dmg.blockmap',
    'PrepPilot-mac-arm64.dmg',
  ]);
  assert.equal(plan.steps.at(-1).file, 'PrepPilot-3.2.0-arm64.dmg');
  assert.deepEqual(plan.feeds.map((f) => f.key), ['latest-mac.yml']);
  assert.throws(() => planUpload('/r', () => ['x.dmg'], () => ''), /build first/);
  assert.throws(() => planUpload('/r', () => ['latest-mac.yml'], () => MAC_FEED), /not in/);
});

test('Windows plan: the setup and its fixed copy', () => {
  const feed = 'version: 3.2.0\nfiles:\n  - url: PrepPilot-Setup-3.2.0.exe\n    sha512: x\n    size: 1\npath: PrepPilot-Setup-3.2.0.exe\n';
  const plan = planUpload('/r', () => ['latest.yml', 'PrepPilot-Setup-3.2.0.exe', 'PrepPilot-Setup-3.2.0.exe.blockmap'], () => feed);
  assert.deepEqual(plan.steps.map((s) => s.key), ['PrepPilot-Setup-3.2.0.exe', 'PrepPilot-Setup-3.2.0.exe.blockmap', 'PrepPilot-Setup-win-x64.exe']);
  assert.deepEqual(plan.feeds.map((f) => f.key), ['latest.yml']);
});

test('release notes keep the shape the app parses', () => {
  const n = JSON.parse(notesJson('3.2.0', '## Summary\nFaster answers.'));
  assert.deepEqual(n, { tag_name: 'v3.2.0', body: '## Summary\nFaster answers.', html_url: '' });
  assert.match(JSON.parse(notesJson('3.2.0', '')).body, /## Summary/);
});

test('S3 signature matches the aws4 package', () => {
  const aws4 = require('aws4');
  const now = new Date('2026-11-07T10:20:30.000Z');
  const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
  const host = 'acct.r2.cloudflarestorage.com';
  const objectPath = '/preppilot-releases/PrepPilot-3.2.0-arm64.dmg';
  const ours = signS3Request({ method: 'PUT', host, path: objectPath, headers: { 'content-length': 10, 'content-type': 'application/zip' }, ...creds, now });

  const theirs = { host, path: objectPath, method: 'PUT', service: 's3', region: 'auto', signQuery: false,
    headers: { 'Content-Length': 10, 'Content-Type': 'application/zip', 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD', 'X-Amz-Date': ours['x-amz-date'] } };
  aws4.sign(theirs, creds);
  assert.equal(ours.authorization, theirs.headers.Authorization);
  assert.equal(ours['x-amz-date'], '20261107T102030Z');
});
