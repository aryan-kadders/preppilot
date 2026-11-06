#!/usr/bin/env node
// scripts/upload-r2.mjs: publish a built release to PrepPilot's Cloudflare R2
// bucket, in the layout the app reads (electron/update/releasesUrl.ts).
//
//   npm run release:upload               upload what is in release/
//   npm run release:upload -- --dry-run  list what would be uploaded
//
// Run after `npm run dist:mac` (and, on a Windows PC, `npm run dist`). Each
// platform uploads its own files; the other platform's are left alone.
//
// What goes up, in this order (installers before the feed, so an app never
// sees an update whose files are not there yet):
//   1. every file the update feed names (zip/dmg/exe) and its .blockmap;
//   2. fixed-name copies of the newest installers, the links managers send:
//        PrepPilot-mac-arm64.dmg / PrepPilot-mac-x64.dmg / PrepPilot-Setup-win-x64.exe;
//   3. release notes: release-notes/v<version>.json and release-notes/latest.json,
//      from release-notes/v<version>.md in the repo when it exists;
//   4. the feed itself: latest-mac.yml (macOS) / latest.yml (Windows).
//
// Credentials, from the environment or .env (an R2 API token with "Object
// Read & Write" on this one bucket; Cloudflare dashboard → R2 → Manage API
// tokens): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
// They are never printed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isEntryScript } from './lib/is-entry-script.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FIXED_NAMES = {
  'mac-arm64': 'PrepPilot-mac-arm64.dmg',
  'mac-x64': 'PrepPilot-mac-x64.dmg',
  'win-x64': 'PrepPilot-Setup-win-x64.exe',
};

// ─── AWS Signature V4 (R2 speaks the S3 API; region "auto") ────────────────
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
/** RFC 3986 encoding of one path segment, as S3 expects. */
const encodeSegment = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Headers for an S3 request signed with an unsigned payload (the body is
 * streamed, so it is not hashed). Pure: the time is passed in, for tests.
 */
export function signS3Request({ method, host, path: objectPath, headers = {}, accessKeyId, secretAccessKey, region = 'auto', now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const canonicalUri = objectPath.split('/').map(encodeSegment).join('/');
  const canonical = [method, canonicalUri, '', names.map((n) => `${n}:${all[n]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const signature = hmac(key, toSign).toString('hex');
  delete all.host;
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

// ─── What to upload ─────────────────────────────────────────────────────────
/** File names a latest*.yml names (its `files[].url` and `path`). */
export function filesInFeed(yml) {
  const names = new Set();
  for (const m of yml.matchAll(/^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$/gm)) names.add(m[1].replace(/^['"]|['"]$/g, ''));
  return [...names];
}

export function versionInFeed(yml) {
  return /^version:\s*['"]?([^'"\s]+)/m.exec(yml)?.[1] ?? null;
}

/** The fixed-name copy for an installer file name, or null. */
export function fixedNameFor(file) {
  if (/\.dmg$/i.test(file)) return /x64|intel/i.test(file) && !/arm64/i.test(file) ? FIXED_NAMES['mac-x64'] : FIXED_NAMES['mac-arm64'];
  if (/setup.*\.exe$/i.test(file)) return FIXED_NAMES['win-x64'];
  return null;
}

/** The ordered upload plan for the files in a release directory. */
export function planUpload(releaseDir, list = (d) => fs.readdirSync(d), read = (f) => fs.readFileSync(f, 'utf8')) {
  const present = new Set(list(releaseDir));
  const feeds = ['latest-mac.yml', 'latest.yml'].filter((f) => present.has(f));
  if (feeds.length === 0) throw new Error(`no latest-mac.yml or latest.yml in ${releaseDir}: build first (npm run dist:mac)`);
  const steps = [];
  const version = versionInFeed(read(path.join(releaseDir, feeds[0])));
  for (const feed of feeds) {
    const yml = read(path.join(releaseDir, feed));
    const v = versionInFeed(yml);
    if (v !== version) throw new Error(`${feed} is version ${v} but ${feeds[0]} is ${version}: build both from the same version`);
    for (const name of filesInFeed(yml)) {
      if (!present.has(name)) throw new Error(`${feed} names ${name}, which is not in ${releaseDir}`);
      steps.push({ file: name, key: name });
      if (present.has(`${name}.blockmap`)) steps.push({ file: `${name}.blockmap`, key: `${name}.blockmap` });
    }
  }
  // The dmg is not in the macOS feed (updates use the zip), but it is the installer people download.
  for (const name of present) {
    if (/\.dmg$/i.test(name) && name.includes(version) && !steps.some((s) => s.file === name)) steps.push({ file: name, key: name });
  }
  for (const s of [...steps]) {
    const fixed = fixedNameFor(s.file);
    if (fixed && !/\.blockmap$/.test(s.file)) steps.push({ file: s.file, key: fixed, cacheControl: 'no-cache' });
  }
  return { version, steps, feeds: feeds.map((f) => ({ file: f, key: f, cacheControl: 'no-cache' })) };
}

/** Release notes in the shape the app parses (GitHub's: tag_name + markdown body). */
export function notesJson(version, markdown) {
  return JSON.stringify({ tag_name: `v${version}`, body: markdown || `## Summary\nPrepPilot ${version}.`, html_url: '' });
}

// ─── Upload ─────────────────────────────────────────────────────────────────
function readCredentials() {
  let fromFile = {};
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    try { fromFile = require('dotenv').parse(fs.readFileSync(envFile)); } catch { fromFile = {}; }
  }
  const pick = (n) => (process.env[n] || fromFile[n] || '').trim();
  const c = { accountId: pick('R2_ACCOUNT_ID'), accessKeyId: pick('R2_ACCESS_KEY_ID'), secretAccessKey: pick('R2_SECRET_ACCESS_KEY'), bucket: pick('R2_BUCKET') };
  const missing = Object.entries({ R2_ACCOUNT_ID: c.accountId, R2_ACCESS_KEY_ID: c.accessKeyId, R2_SECRET_ACCESS_KEY: c.secretAccessKey, R2_BUCKET: c.bucket })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`missing ${missing.join(', ')} (set them in .env; see the top of scripts/upload-r2.mjs)`);
  return c;
}

const CONTENT_TYPES = { '.yml': 'text/yaml', '.json': 'application/json', '.dmg': 'application/x-apple-diskimage', '.zip': 'application/zip', '.exe': 'application/vnd.microsoft.portable-executable', '.blockmap': 'application/octet-stream' };

async function put(creds, key, body, { size, contentType, cacheControl }) {
  const host = `${creds.accountId}.r2.cloudflarestorage.com`;
  const objectPath = `/${creds.bucket}/${key}`;
  const headers = signS3Request({
    method: 'PUT', host, path: objectPath, accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey,
    headers: { 'content-length': size, 'content-type': contentType, ...(cacheControl ? { 'cache-control': cacheControl } : {}) },
  });
  const res = await fetch(`https://${host}${objectPath.split('/').map(encodeSegment).join('/')}`, { method: 'PUT', headers, body, duplex: 'half' });
  if (!res.ok) throw new Error(`upload of ${key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function putFile(creds, file, key, cacheControl) {
  const size = fs.statSync(file).size;
  const started = Date.now();
  const stream = fs.createReadStream(file);
  const { Readable } = await import('node:stream');
  await put(creds, key, Readable.toWeb(stream), { size, contentType: CONTENT_TYPES[path.extname(file)] || 'application/octet-stream', cacheControl });
  console.log(`  ✓ ${key}  (${(size / 1048576).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const releaseDir = path.join(ROOT, 'release');
  const plan = planUpload(releaseDir);
  const notesFile = path.join(ROOT, 'release-notes', `v${plan.version}.md`);
  const notes = notesJson(plan.version, fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '');
  const { resolveReleasesUrl } = require('./lib/releases-url.cjs');
  const publicUrl = resolveReleasesUrl(ROOT);

  console.log(`PrepPilot ${plan.version}${dryRun ? ' (dry run)' : ''}`);
  const all = [...plan.steps, { key: `release-notes/v${plan.version}.json` }, { key: 'release-notes/latest.json' }, ...plan.feeds];
  if (dryRun) {
    for (const s of all) console.log(`  ${s.key}${s.file && s.file !== s.key ? `  ← ${s.file}` : ''}`);
    return;
  }
  const creds = readCredentials();
  for (const s of plan.steps) await putFile(creds, path.join(releaseDir, s.file), s.key, s.cacheControl);
  for (const key of [`release-notes/v${plan.version}.json`, 'release-notes/latest.json']) {
    await put(creds, key, notes, { size: Buffer.byteLength(notes), contentType: 'application/json', cacheControl: 'no-cache' });
    console.log(`  ✓ ${key}`);
  }
  for (const s of plan.feeds) await putFile(creds, path.join(releaseDir, s.file), s.key, s.cacheControl);

  if (publicUrl) {
    console.log('\nDownload links to send:');
    for (const s of plan.steps) if (Object.values(FIXED_NAMES).includes(s.key)) console.log(`  ${publicUrl}/${s.key}`);
  } else {
    console.log('\nSet PREPPILOT_RELEASES_URL in .env to the bucket\'s public URL, then rebuild: installed apps find updates there.');
  }
}

if (isEntryScript(import.meta.url)) {
  main().catch((e) => { console.error(`[upload-r2] ${e.message}`); process.exit(1); });
}
