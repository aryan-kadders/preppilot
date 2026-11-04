/**
 * Runs the Electron test files for `npm test`.
 *
 * Usage (from package.json, under run-with-env so the env is set):
 *
 *   node scripts/run-electron-tests.mjs "<glob>" ["<glob>" ...]
 *
 * Why this exists instead of a bare `electron --test "<glob>" …`:
 *
 * 1. PrepPilot never has upstream's private `premium/` folder. About fifty test
 *    files load premium sources (KnowledgeOrchestrator, IntentClassifier,
 *    LicenseManager, …) at import time, so without it they fail before a single
 *    assertion runs — in every checkout of the public repo, not just here.
 *    When `premium/` is absent those files are left out and counted, so the
 *    run reports real failures only. With `premium/` present nothing changes.
 *    A file that already skips itself when premium is missing is kept.
 *
 * 2. Passing the remaining ~1,200 paths explicitly would overflow the Windows
 *    command-line limit (32,767 characters for CreateProcess), so the files are
 *    run in batches that each fit, one `electron --test` per batch.
 *
 * Globs are expanded with Node's own fs.globSync, the same matcher
 * `node --test` uses, and the child is spawned without a shell (see
 * run-with-env.mjs resolveCommand), so this behaves the same on macOS and Windows.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryScript } from './lib/is-entry-script.mjs';
import { resolveCommand, exitCodeFor } from './run-with-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** Windows' CreateProcess limit is 32,767; leave room for the binary and flags. */
export const MAX_ARGS_CHARS = 24_000;

const COMMENT_BLOCK = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^\s*\/\/.*$/gm;
// A string that names a file under premium/electron or premium/src, or a
// path.join(…, 'premium', 'electron' | 'src', …) — i.e. code that loads it.
const LOADS_PREMIUM = /(['"`][^'"`\n]*premium\/(?:electron|src)\/[^'"`\n]*['"`])|(['"]premium['"]\s*,\s*['"](?:electron|src)['"])/;
// The file checks for the premium build itself and skips (e.g.
// `fs.existsSync(classifierPath) ? require(…) : null` with `{ skip: … }`).
const SELF_SKIPS = /existsSync\([\s\S]*?\bskip\b/;

/** True when a test file cannot run without upstream's private premium sources. */
export function needsPremium(source) {
  const code = source.replace(COMMENT_BLOCK, '').replace(LINE_COMMENT, '');
  return LOADS_PREMIUM.test(code) && !SELF_SKIPS.test(code);
}

/**
 * Split file paths into batches whose joined length (with a space and two
 * quote characters per path, as Windows would quote them) stays under `max`.
 * A single path longer than `max` still gets a batch of its own.
 */
export function batchByLength(files, max = MAX_ARGS_CHARS) {
  const batches = [];
  let current = [];
  let length = 0;
  for (const file of files) {
    const cost = file.length + 3;
    if (current.length && length + cost > max) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Expand globs relative to `cwd` into a sorted, de-duplicated list of files. */
export function expandGlobs(patterns, { cwd = repoRoot, globSync = fs.globSync } = {}) {
  const found = new Set();
  for (const pattern of patterns) {
    for (const file of globSync(pattern, { cwd })) found.add(file.split(path.sep).join('/'));
  }
  return [...found].sort();
}

function main(patterns) {
  if (!patterns.length) {
    console.error('Usage: node scripts/run-electron-tests.mjs "<glob>" ["<glob>" ...]');
    return 2;
  }

  let files = expandGlobs(patterns);
  const hasPremium = fs.existsSync(path.join(repoRoot, 'premium', 'electron'));
  if (!hasPremium) {
    const excluded = files.filter((f) => needsPremium(fs.readFileSync(path.join(repoRoot, f), 'utf8')));
    files = files.filter((f) => !excluded.includes(f));
    console.log(`[run-electron-tests] premium/ is not present: leaving out ${excluded.length} test files that load it.`);
  }
  if (!files.length) {
    console.error('[run-electron-tests] No test files matched.');
    return 1;
  }

  const { file, args } = resolveCommand('electron');
  const batches = batchByLength(files);
  let exitCode = 0;
  batches.forEach((batch, i) => {
    if (batches.length > 1) console.log(`[run-electron-tests] batch ${i + 1}/${batches.length}: ${batch.length} files`);
    const result = spawnSync(file, [...args, '--test', ...batch], { stdio: 'inherit', cwd: repoRoot, env: process.env });
    if (result.error) console.error(`[run-electron-tests] Failed to launch electron: ${result.error.message}`);
    const code = exitCodeFor(result);
    if (code !== 0 && exitCode === 0) exitCode = code;
  });
  return exitCode;
}

if (isEntryScript(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
