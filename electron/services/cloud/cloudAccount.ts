/**
 * The app's one PrepPilot Cloud client, wired to Electron: the refresh token
 * goes to CredentialsManager (encrypted with the OS keystore: Keychain on
 * macOS, DPAPI on Windows), and the device is named after the computer.
 *
 * The server URL is the project's `api` Edge Function. A development build
 * may point elsewhere with PREPPILOT_CLOUD_URL; a packaged build cannot.
 */
import os from 'os';
import { CloudClient } from './cloudClient';

export const DEFAULT_CLOUD_URL = 'https://uhrthebpefobnxsxoyoc.supabase.co/functions/v1/api';

export function cloudBaseUrl(env: NodeJS.ProcessEnv = process.env, isPackaged = true): string {
  const override = !isPackaged ? env.PREPPILOT_CLOUD_URL?.trim() : '';
  return (override || DEFAULT_CLOUD_URL).replace(/\/+$/, '');
}

// Anchored on globalThis, like CredentialsManager: the build inlines this
// module into several bundles, and there must be one sign-in per process.
const SLOT = Symbol.for('preppilot.cloudClient');
const anchor = globalThis as unknown as Record<symbol, CloudClient | null | undefined>;

export function getCloudClient(): CloudClient {
  const existing = anchor[SLOT];
  if (existing) return existing;
  const { app } = require('electron');
  const { CredentialsManager } = require('../CredentialsManager');
  const cm = CredentialsManager.getInstance();
  const client = new CloudClient(cloudBaseUrl(process.env, app.isPackaged), {
    fetch: (input, init) => fetch(input, init),
    store: {
      load: () => cm.getCloudCredentials(),
      save: (c) => {
        if (!cm.setCloudCredentials(c)) console.warn('[Cloud] could not save the sign-in; it lasts until the app quits');
      },
      clear: () => { cm.clearCloudCredentials(); },
    },
    appVersion: app.getVersion(),
    platform: process.platform,
    // A display name for the manager's device list only (it changes with the network).
    deviceName: (os.hostname() || 'Computer').replace(/\.(local|lan|home)$/i, '').slice(0, 100),
    log: (line) => console.log(line),
  });
  anchor[SLOT] = client;
  return client;
}

/** True when answers and transcription must go through PrepPilot Cloud. */
export function cloudModeActive(): boolean {
  try { return getCloudClient().signedIn; } catch { return false; }
}

/**
 * True when this computer may skip the invite code: only a development build
 * started with PREPPILOT_ALLOW_OWN_AI=1 (for testing with a personal AI key).
 * A packaged build always needs the code.
 */
export function devOwnAiAllowed(env: NodeJS.ProcessEnv = process.env, isPackaged = true): boolean {
  return !isPackaged && env.PREPPILOT_ALLOW_OWN_AI === '1';
}

/** Why a meeting may not start yet, or null: every computer joins with an invite code first. */
export function teamSignInBlock(signedIn: boolean, devOwnAi: boolean): string | null {
  if (signedIn || devOwnAi) return null;
  return 'To start, enter the invite code from your manager first.';
}

/**
 * The sentence shown when an invite code is refused. A failure the server
 * explained gets its own sentence; a network failure says so; anything else
 * names its code, so a screenshot is enough to find the cause.
 */
export function redeemErrorMessage(e: { code?: unknown; status?: unknown; message?: unknown; cause?: unknown } | null | undefined): string {
  const code = typeof e?.code === 'string' ? e.code : '';
  const known: Record<string, string> = {
    invalid_code: 'That code is not valid. Check it with your manager.',
    code_used: 'That code was already used. Ask your manager for a new one.',
    code_expired: 'That code has expired. Ask your manager for a new one.',
    app_update_required: 'Please update PrepPilot to sign in.',
  };
  if (known[code]) return known[code];
  // CloudError always carries an HTTP status; fetch's own failures do not.
  if (typeof e?.status !== 'number') {
    const cause = (e?.cause as { code?: unknown } | undefined)?.code;
    const detail = typeof cause === 'string' ? cause : String(e?.message ?? '').slice(0, 80);
    return `Could not reach PrepPilot Cloud. Check your internet connection${detail ? ` (${detail})` : ''}.`;
  }
  return `Sign-in failed (${code || `HTTP ${e.status}`}). Try again, or send this message to your manager.`;
}

/** Test seam. */
export function _setCloudClientForTest(c: CloudClient | null): void { anchor[SLOT] = c; }
