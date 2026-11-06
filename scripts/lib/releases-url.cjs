/**
 * Where PrepPilot's installers and update files are published (a Cloudflare
 * R2 bucket's public URL, or any static HTTPS host), baked in at build time.
 *
 * One address serves three things, all derived in electron/update/releasesUrl.ts:
 *   - electron-updater's feed: <url>/latest-mac.yml and <url>/latest.yml
 *     (package.json "publish" is a generic provider at ${env.PREPPILOT_RELEASES_URL});
 *   - release notes: <url>/release-notes/v<version>.json;
 *   - fixed download links that always hold the newest installer:
 *     <url>/PrepPilot-mac-arm64.dmg, <url>/PrepPilot-mac-x64.dmg,
 *     <url>/PrepPilot-Setup-win-x64.exe (scripts/upload-r2.mjs keeps them current).
 *
 * Read from the environment, else <rootDir>/.env. Not a secret: it ships in
 * every installer. Empty when unset or malformed, which leaves the app without
 * update checks (never pointed at someone else's releases).
 */
const fs = require('fs');
const path = require('path');

const ENV_NAME = 'PREPPILOT_RELEASES_URL';
const RELEASES_URL_EXPRESSION = 'process.env.PREPPILOT_BAKED_RELEASES_URL';

/** The URL without a trailing slash, or '' when it is not a plain https URL. */
function normalizeReleasesUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
  return url.toString().replace(/\/+$/, '');
}

function resolveReleasesUrl(rootDir, env = process.env) {
  const fromEnv = normalizeReleasesUrl(env[ENV_NAME]);
  if (fromEnv) return fromEnv;
  const envFile = path.join(rootDir, '.env');
  if (!fs.existsSync(envFile)) return '';
  try {
    return normalizeReleasesUrl(require('dotenv').parse(fs.readFileSync(envFile))[ENV_NAME]);
  } catch {
    return '';
  }
}

module.exports = { ENV_NAME, RELEASES_URL_EXPRESSION, normalizeReleasesUrl, resolveReleasesUrl };
