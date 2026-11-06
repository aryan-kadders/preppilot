import React, { useState } from 'react';

export const Notice: React.FC<{ kind: 'error' | 'ok' | 'info'; children: React.ReactNode }> = ({ kind, children }) =>
  <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;

export const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="empty">{children}</div>;

export const Badge: React.FC<{ tone?: 'good' | 'warn' | 'bad' | 'accent'; dot?: boolean; children: React.ReactNode }> = ({ tone, dot, children }) =>
  <span className={`badge ${tone ?? ''}`}>{dot && <span className="dot" />}{children}</span>;

/** A button that runs an async action, shows it is busy, and reports a failure. */
export function useAction(): { busy: boolean; error: string | null; run: (fn: () => Promise<void>) => Promise<boolean>; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    busy, error, clear: () => setError(null),
    run: async (fn) => {
      setBusy(true);
      setError(null);
      try { await fn(); return true; } catch (e) { setError(friendlyError(e)); return false; } finally { setBusy(false); }
    },
  };
}

/** Database and network errors in words a manager can act on. */
export function friendlyError(e: unknown): string {
  const msg = String((e as { message?: unknown })?.message ?? e ?? '');
  if (/forbidden|row-level security|permission denied/i.test(msg)) return 'You do not have permission to do that.';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Could not reach PrepPilot Cloud. Check your connection and try again.';
  if (/duplicate key/i.test(msg)) return 'That already exists.';
  if (/ends_at|check constraint/i.test(msg)) return 'Check the times: a slot must end after it starts and last at most 24 hours.';
  return msg || 'Something went wrong.';
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
