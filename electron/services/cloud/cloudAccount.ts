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

/** Test seam. */
export function _setCloudClientForTest(c: CloudClient | null): void { anchor[SLOT] = c; }
