#!/usr/bin/env node
/**
 * Development launch step: build the Apple Speech helper once if it is missing.
 *
 * Packaged macOS builds compile the helper in after-pack, but `npm start` never
 * did, so a source checkout had no on-device transcription until someone ran
 * `npm run build:apple-speech` by hand. PrepPilot picks Apple Speech as the
 * default transcription on macOS (no key, no download), so the helper has to
 * exist in development too.
 *
 * Never fails the launch: on Windows it does nothing (Apple Speech is
 * macOS-only; local Whisper is the Windows default), and on a Mac whose
 * toolchain cannot build it the app falls back to local Whisper.
 */
const fs = require('fs');
const path = require('path');

function ensureAppleSpeechDev({
  platform = process.platform,
  root = path.resolve(__dirname, '..'),
  exists = fs.existsSync,
  build = (opts) => require('./build-apple-speech.js').buildAppleSpeech(opts),
  helperName = () => require('./build-apple-speech.js').HELPER_NAME,
  log = console,
} = {}) {
  if (platform !== 'darwin') return { status: 'skipped-platform' };
  const output = path.join(root, 'resources', 'apple-speech', helperName());
  if (exists(output)) return { status: 'present', output };
  try {
    build({ root, output });
    return { status: 'built', output };
  } catch (error) {
    log.warn(
      `[apple-speech] Could not build the on-device transcription helper (${error && error.message ? error.message : error}). ` +
        'PrepPilot will use local Whisper instead.',
    );
    return { status: 'failed', output };
  }
}

module.exports = { ensureAppleSpeechDev };

if (require.main === module) {
  ensureAppleSpeechDev();
}
