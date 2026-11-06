import React, { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { OverlayBanner } from '../ui/OverlayBanner';
import { useT } from '../../i18n';
import '../ui/OverlayBanner.css';

/**
 * PrepPilot Cloud: the session's time, as the overlay sees it (main:
 * services/cloud/cloudClient.ts, pushed on 'cloud-update'). Five minutes
 * before the slot or the minutes run out, a warning; the server ending the
 * session stops the meeting itself, which clears this.
 */
export function useCloudTimeWarning(): number | null {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    const api = window.electronAPI;
    const offCloud = api?.onCloudUpdate?.((e) => {
      if (e.type === 'warning') setSecondsLeft(e.secondsLeft);
      else if (e.type === 'session' && secondsLeftOf(e) !== null) setSecondsLeft((prev) => (prev === null ? null : secondsLeftOf(e)));
      else if (e.type === 'ended' || e.type === 'state') setSecondsLeft(null);
    });
    const offState = api?.onMeetingStateChanged?.((data) => { if (!data?.isActive) setSecondsLeft(null); });
    return () => { offCloud?.(); offState?.(); };
  }, []);
  return secondsLeft;
}

function secondsLeftOf(e: { type: 'session'; session: { seconds_left: number } }): number | null {
  return Number.isFinite(e.session?.seconds_left) ? e.session.seconds_left : null;
}

export const CloudTimeNoticeBanner: React.FC<{ secondsLeft: number | null }> = ({ secondsLeft }) => {
  const t = useT();
  if (secondsLeft === null) return null;
  const minutes = Math.max(1, Math.ceil(secondsLeft / 60));
  return (
    <OverlayBanner
      className="mx-4"
      tone="warning"
      icon={<Timer strokeWidth={2.2} />}
      message={minutes === 1
        ? t('About 1 minute left in this session. PrepPilot stops when the time is up.')
        : t('About {n} minutes left in this session. PrepPilot stops when the time is up.').replace('{n}', String(minutes))}
    />
  );
};
