// The desktop app's download links and the message a manager sends a new
// candidate. The file names are the fixed "newest installer" names that
// scripts/upload-r2.mjs keeps current (same layout as the app's
// electron/update/releasesUrl.ts).

export interface DownloadLink { label: string; url: string }

/** The release host without a trailing slash; '' when unset or not https. */
export function normalizeReleasesUrl(raw: string | undefined): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function downloadLinks(base: string): DownloadLink[] {
  if (!base) return [];
  return [
    { label: 'Mac (Apple silicon: M1 and newer)', url: `${base}/PrepPilot-mac-arm64.dmg` },
    { label: 'Windows', url: `${base}/PrepPilot-Setup-win-x64.exe` },
  ];
}

/** Everything the candidate needs, ready to paste into email or chat. */
export function inviteMessage(name: string, code: string, base: string): string {
  const links = downloadLinks(base);
  const first = name.trim().split(/\s+/)[0] || 'there';
  return [
    `Hi ${first},`,
    '',
    ...(links.length
      ? ['1. Download and install PrepPilot:', ...links.map((l) => `   ${l.label}: ${l.url}`)]
      : ['1. Install PrepPilot (your manager will send the download link).']),
    '2. Open PrepPilot, go to Settings › Account, and enter this code:',
    `   ${code}`,
    '',
    'The code works once, on one computer, within 7 days. Please keep it private.',
  ].join('\n');
}
