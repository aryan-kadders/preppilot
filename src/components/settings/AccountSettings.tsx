// Settings › Account: PrepPilot Cloud sign-in for a candidate. Signed out, it
// asks for the invite code a manager gave them. Signed in, it shows their
// minutes, today's slot or the next one, and their assignments, all read from
// the server (main: ipcHandlers 'cloud-status'). While signed in, answers and
// transcription run on the organization's account and the time is counted.
import React, { useCallback, useEffect, useState } from 'react';
import { Building2, Clock, CalendarClock, ListChecks, LogOut, KeyRound } from 'lucide-react';
import { useT } from '../../i18n';
import { SettingsRow, SETTINGS_BTN, SETTINGS_CARD, SETTINGS_INPUT, SETTINGS_FIELD_LABEL } from './SettingsRow';
import type { CloudAccountStatus } from '../../types/electron';

const minutes = (seconds: number) => Math.max(0, Math.floor(seconds / 60));

function formatSlot(slot: { starts_at: string; ends_at: string }): string {
  const start = new Date(slot.starts_at);
  const end = new Date(slot.ends_at);
  const day = start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time(start)}–${time(end)}`;
}

export const AccountSettings: React.FC = () => {
  const t = useT();
  const [account, setAccount] = useState<CloudAccountStatus | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await window.electronAPI?.cloudStatus?.().catch(() => null);
    if (r) setAccount(r);
  }, []);

  useEffect(() => {
    let live = true;
    void window.electronAPI?.cloudStatus?.().then((r) => { if (live && r) setAccount(r); }).catch(() => {});
    const off = window.electronAPI?.onCloudUpdate?.((e) => {
      if (e.type === 'state' || e.type === 'ended' || e.type === 'warning') void refresh();
    });
    return () => { live = false; off?.(); };
  }, [refresh]);

  const redeem = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await window.electronAPI?.cloudRedeem?.(code).catch(() => ({ success: false, error: t('Could not reach PrepPilot Cloud. Check your internet connection.') }));
      if (r?.success) { setCode(''); await refresh(); } else setError(r?.error ?? t('Something went wrong.'));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      const r = await window.electronAPI?.cloudSignOut?.().catch(() => undefined);
      if (r && !r.success) setError(r.error ?? null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!account) return null;

  if (account.state !== 'signed_in') {
    return (
      <div className="space-y-4">
        <SettingsRow
          icon={<Building2 size={20} />}
          title={t('Join your organization')}
          description={account.state === 'revoked'
            ? t('This computer was signed out by your manager. Enter a new invite code to sign in again.')
            : t('Enter the invite code from your manager. Your practice time, slots and assignments then come from your organization, and answers use its AI account.')}
        />
        <div className={`${SETTINGS_CARD} p-4 space-y-3`}>
          <label className={SETTINGS_FIELD_LABEL} htmlFor="cloud-invite-code">{t('Invite code')}</label>
          <div className="flex gap-2">
            <input
              id="cloud-invite-code"
              className={`${SETTINGS_INPUT} font-mono tracking-wider uppercase`}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              value={code}
              autoComplete="off"
              spellCheck={false}
              maxLength={24}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && code.trim() && !busy) void redeem(); }}
            />
            <button type="button" className={SETTINGS_BTN} disabled={busy || !code.trim()} onClick={() => void redeem()}>
              <KeyRound size={14} /> {busy ? t('Signing in…') : t('Sign in')}
            </button>
          </div>
          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
        </div>
      </div>
    );
  }

  const s = account.status;
  return (
    <div className="space-y-4">
      <SettingsRow
        icon={<Building2 size={20} />}
        title={s?.candidate ? t('Signed in as {name}').replace('{name}', s.candidate.name) : t('Signed in to PrepPilot Cloud')}
        description={t('Answers and transcription use your organization’s account, and your practice time is counted while a meeting runs.')}
        control={(
          <button type="button" className={SETTINGS_BTN} disabled={busy} onClick={() => void signOut()}>
            <LogOut size={14} /> {t('Sign out')}
          </button>
        )}
      />
      {account.error && <p role="alert" className="text-xs text-red-400 px-1">{account.error}</p>}
      {error && <p role="alert" className="text-xs text-red-400 px-1">{error}</p>}
      {s && (
        <>
          <SettingsRow
            icon={<Clock size={20} />}
            title={t('{n} minutes left').replace('{n}', String(minutes(s.balance_seconds)))}
            description={minutes(s.balance_seconds) === 0 ? t('Ask your manager for more time.') : t('Counted only while a meeting is running.')}
          />
          <SettingsRow
            icon={<CalendarClock size={20} />}
            title={s.current_slot ? t('Your slot is open now') : s.next_slot ? t('Next slot') : t('No slot booked')}
            description={s.current_slot ? t('Until {time}').replace('{time}', new Date(s.current_slot.ends_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
              : s.next_slot ? formatSlot(s.next_slot) : t('Your manager books the times when you can use PrepPilot.')}
          />
          {s.assignments.length > 0 && (
            <SettingsRow
              icon={<ListChecks size={20} />}
              title={t('Assignments')}
              description={s.assignments.map((a) => a.title).join(' · ')}
            />
          )}
        </>
      )}
    </div>
  );
};
