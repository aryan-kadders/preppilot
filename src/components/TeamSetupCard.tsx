// PrepPilot: the Launcher's join card for a candidate on a team.
//
// Until this computer has joined with an invite code from a manager, the home
// page shows only this card: an AI key of its own does not get around it. Once
// joined it renders its children (the home page's interview prep card).
//
// The decision is src/lib/teamSetup.mjs. Start checks the same state in App.tsx
// and, while the code is missing, asks this card to focus its code box.
// No platform branches.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Building2, KeyRound, Loader2 } from 'lucide-react';
import { useT } from '../i18n';
import { SETTINGS_BTN } from './settings/SettingsRow';
import { teamSetupStep, FOCUS_INVITE_EVENT } from '../lib/teamSetup.mjs';
import type { CloudSetupState, TeamSetupStep } from '../lib/teamSetup.mjs';

export interface TeamSetupState {
  step: TeamSetupStep;
  cloudState: CloudSetupState;
}

/** Where this computer is in team setup, read fresh from main. Shared with App's Start check. */
export async function readTeamSetup(): Promise<TeamSetupState> {
  const api = window.electronAPI;
  const account = await api?.cloudStatus?.().catch(() => null);
  const cloudState = account?.state ?? null;
  return { step: teamSetupStep({ cloudState, devOwnAi: !!account?.devOwnAi }), cloudState };
}

export const TeamSetupCard: React.FC<{ className?: string; children?: React.ReactNode }> = ({ className = '', children }) => {
  const t = useT();
  const [state, setState] = useState<TeamSetupState | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Start was pressed without a code: why it waited, shown above the box.
  const [nudge, setNudge] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try { setState(await readTeamSetup()); } catch { /* keep what is shown */ }
  }, []);

  useEffect(() => {
    void refresh();
    const api = window.electronAPI;
    const offCloud = api?.onCloudUpdate?.((e) => { if (e.type === 'state') void refresh(); });
    const offCreds = api?.onCredentialsChanged?.(() => { void refresh(); });
    // A key added in Settings, or a sign-in elsewhere: read again on return.
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      try { offCloud?.(); offCreds?.(); } catch { /* already gone */ }
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  // While the join card shows, a sign-in from Settings › Account must replace
  // it promptly.
  useEffect(() => {
    if (state?.step !== 'join') return;
    const id = window.setInterval(() => { void refresh(); }, 3000);
    return () => window.clearInterval(id);
  }, [state?.step, refresh]);

  // Start pressed without a code: bring the box into view and focus it.
  useEffect(() => {
    const onFocusInvite = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      setNudge(typeof detail === 'string' && detail ? detail : t('Enter the invite code from your manager first.'));
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => inputRef.current?.focus(), 150);
    };
    window.addEventListener(FOCUS_INVITE_EVENT, onFocusInvite);
    return () => window.removeEventListener(FOCUS_INVITE_EVENT, onFocusInvite);
  }, [t]);

  const join = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.electronAPI?.cloudRedeem?.(code)
        .catch(() => ({ success: false, error: t('Could not reach PrepPilot Cloud. Check your internet connection.') }));
      if (r?.success) {
        setCode('');
        setNudge(null);
        await refresh();
      } else {
        setError(r?.error ?? t('Something went wrong.'));
      }
    } finally {
      setBusy(false);
    }
  };

  // Not loaded yet: nothing, so the join card never flashes for someone set up.
  if (!state) return null;
  if (!state.step) return <>{children}</>;

  if (state.step === 'join') {
    const revoked = state.cloudState === 'revoked';
    return (
      <section
        ref={cardRef}
        className={`rounded-2xl border ${nudge ? 'border-amber-400/70' : 'border-border-subtle'} bg-bg-elevated p-5 text-text-primary ${className}`}
        aria-labelledby="team-join-title"
        data-testid="team-join-card"
      >
        <div className="flex items-start gap-3">
          <Building2 size={20} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="team-join-title" className="text-[15px] font-bold">{t('Join your team')}</h2>
            <p className="mt-1 text-xs text-text-secondary">
              {revoked
                ? t('This computer was signed out by your manager. Enter a new invite code to sign in again.')
                : t('Enter the invite code from your manager. You then practise on your team’s account. Your team’s admins can see your sessions: transcripts, PrepPilot’s answers, notes and mock interview results, kept for 90 days.')}
            </p>
            {nudge && <p role="alert" className="mt-3 text-xs font-medium text-amber-300">{nudge}</p>}
            <div className="mt-4 flex items-center gap-2">
              <label htmlFor="team-invite-code" className="sr-only">{t('Invite code')}</label>
              <input
                ref={inputRef}
                id="team-invite-code"
                autoComplete="off"
                spellCheck={false}
                maxLength={24}
                value={code}
                onChange={(e) => { setCode(e.target.value); if (error) setError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void join(); }}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-primary px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-text-primary outline-none focus:border-text-secondary"
              />
              <button type="button" className={SETTINGS_BTN} onClick={() => void join()} disabled={busy || !code.trim()}>
                {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <KeyRound size={12} aria-hidden />}
                {busy ? t('Joining…') : t('Join')}
              </button>
            </div>
            <div aria-live="polite" className="min-h-[18px] mt-2 text-xs">
              {error && <span role="alert" className="text-red-400">{error}</span>}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return null;
};
