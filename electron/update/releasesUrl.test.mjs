// PrepPilot's release host layout: the download link per platform and CPU,
// and the release-notes address (electron/update/releasesUrl.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { downloadUrl, installerFileName, releaseNotesUrl } = await import(
  pathToFileURL(path.resolve(__dirname, '../../dist-electron/electron/update/releasesUrl.js')).href
);

const BASE = 'https://pub-abc.r2.dev';

test('macOS: Apple silicon and Intel each get their own installer', () => {
  assert.equal(downloadUrl('darwin', 'arm64', BASE), `${BASE}/PrepPilot-mac-arm64.dmg`);
  assert.equal(downloadUrl('darwin', 'x64', BASE), `${BASE}/PrepPilot-mac-x64.dmg`);
});

test('Windows: the x64 setup, on any CPU (x64 runs under emulation on Arm)', () => {
  assert.equal(downloadUrl('win32', 'x64', BASE), `${BASE}/PrepPilot-Setup-win-x64.exe`);
  assert.equal(downloadUrl('win32', 'arm64', BASE), `${BASE}/PrepPilot-Setup-win-x64.exe`);
});

test('an unsupported platform or a build without a host has no link', () => {
  assert.equal(installerFileName('linux', 'x64'), null);
  assert.equal(downloadUrl('linux', 'x64', BASE), null);
  assert.equal(downloadUrl('darwin', 'arm64', ''), null);
});

test('release notes: one file per version, and "latest"', () => {
  assert.equal(releaseNotesUrl('3.2.0', BASE), `${BASE}/release-notes/v3.2.0.json`);
  assert.equal(releaseNotesUrl('V3.2.0', BASE), `${BASE}/release-notes/v3.2.0.json`);
  assert.equal(releaseNotesUrl('latest', BASE), `${BASE}/release-notes/latest.json`);
  assert.equal(releaseNotesUrl('3.2.0', ''), null);
});
