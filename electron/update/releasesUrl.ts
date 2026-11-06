// PrepPilot's release host, baked in at build time (scripts/lib/releases-url.cjs).
// Everything the app needs from it is derived here, so the upload script
// (scripts/upload-r2.mjs) and the app agree on one layout:
//
//   <base>/latest-mac.yml, <base>/latest.yml        electron-updater's feed
//   <base>/release-notes/v<version>.json              notes for the update card
//   <base>/PrepPilot-mac-arm64.dmg                    newest installer, fixed name
//   <base>/PrepPilot-mac-x64.dmg
//   <base>/PrepPilot-Setup-win-x64.exe

export const BAKED_RELEASES_URL: string = process.env.PREPPILOT_BAKED_RELEASES_URL || '';

/** The fixed name of the newest installer for a platform and CPU, or null when none is published. */
export function installerFileName(platform: NodeJS.Platform, arch: string): string | null {
  switch (platform) {
    case 'darwin':
      return arch === 'x64' ? 'PrepPilot-mac-x64.dmg' : 'PrepPilot-mac-arm64.dmg';
    case 'win32':
      return 'PrepPilot-Setup-win-x64.exe';
    default:
      return null;
  }
}

/** Where a person downloads the newest installer by hand (unsigned macOS updates, the update card's link). */
export function downloadUrl(platform: NodeJS.Platform, arch: string, base: string = BAKED_RELEASES_URL): string | null {
  const file = installerFileName(platform, arch);
  return base && file ? `${base}/${file}` : null;
}

/** Release notes for a version ("3.2.0", "v3.2.0" or "latest"), or null when no host is set. */
export function releaseNotesUrl(version: string, base: string = BAKED_RELEASES_URL): string | null {
  if (!base) return null;
  const bare = version.trim().replace(/^v/i, '');
  return `${base}/release-notes/${bare === 'latest' ? 'latest' : `v${bare}`}.json`;
}
