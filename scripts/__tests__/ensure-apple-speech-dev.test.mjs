// scripts/ensure-apple-speech-dev.cjs — builds the Apple Speech helper for
// `npm start` when it is missing, and never fails the launch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ensureAppleSpeechDev } = require('../ensure-apple-speech-dev.cjs');
const quiet = { warn: () => {} };
const base = { root: path.join('repo'), helperName: () => 'PrepPilot-asr', log: quiet };

test('Windows: does nothing (Apple Speech is macOS-only)', () => {
  let built = false;
  const res = ensureAppleSpeechDev({ ...base, platform: 'win32', exists: () => false, build: () => { built = true; } });
  assert.equal(res.status, 'skipped-platform');
  assert.equal(built, false);
});

test('macOS with the helper already built: nothing to do', () => {
  let built = false;
  const res = ensureAppleSpeechDev({ ...base, platform: 'darwin', exists: () => true, build: () => { built = true; } });
  assert.equal(res.status, 'present');
  assert.equal(built, false);
});

test('macOS without it: builds it at resources/apple-speech/<helper>', () => {
  let opts = null;
  const res = ensureAppleSpeechDev({ ...base, platform: 'darwin', exists: () => false, build: (o) => { opts = o; } });
  assert.equal(res.status, 'built');
  assert.equal(opts.output, path.join('repo', 'resources', 'apple-speech', 'PrepPilot-asr'));
});

test('macOS whose toolchain cannot build it: warns, never throws', () => {
  const warnings = [];
  const res = ensureAppleSpeechDev({ ...base, platform: 'darwin', exists: () => false, build: () => { throw new Error('swiftc missing'); }, log: { warn: (m) => warnings.push(m) } });
  assert.equal(res.status, 'failed');
  assert.match(warnings[0], /local Whisper/);
});

test('npm start runs it before Electron', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'));
  assert.match(pkg.scripts['electron:dev'], /node scripts\/ensure-apple-speech-dev\.cjs && cross-env NODE_ENV=development electron \./);
});
