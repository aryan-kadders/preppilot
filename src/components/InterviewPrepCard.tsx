// PrepPilot: the home page's "Your interview prep" card.
//
// The two documents every answer is tailored to, side by side: the résumé
// (who the candidate is) and the job description (the interview coming up).
// The JD changes with every interview, so it is changed here, on the home
// page, rather than inside the Profile panel: an old JD left in place makes
// every answer target the previous job.
//
// Uses the same main-process calls as the Profile panel (profile:select-file,
// profile:upload-resume, profile:upload-jd, profile:delete-jd). No platform
// branches: the file picker is Electron's own dialog on macOS and Windows.
import React, { useCallback, useEffect, useState } from 'react';
import { Briefcase, FileText, Loader2, Upload, X } from 'lucide-react';
import { useT } from '../i18n';
import { SETTINGS_BTN } from './settings/SettingsRow';

interface PrepState {
  hasResume: boolean;
  name: string | null;
  role: string | null;
  hasJD: boolean;
  jdTitle: string | null;
  jdCompany: string | null;
}

type Busy = 'resume' | 'jd' | 'jd-remove' | null;

async function readPrep(): Promise<PrepState> {
  const api = window.electronAPI;
  const [status, profile] = await Promise.all([
    api?.profileGetStatus?.().catch(() => undefined),
    api?.profileGetProfile?.().catch(() => null),
  ]);
  const jd = profile?.activeJD;
  return {
    hasResume: !!status?.hasProfile,
    name: (profile?.identity?.name || status?.name || '').trim() || null,
    role: (status?.role || '').trim() || null,
    hasJD: !!profile?.hasActiveJD,
    jdTitle: (jd?.title || '').trim() || null,
    jdCompany: (jd?.company || '').trim() || null,
  };
}

export const InterviewPrepCard: React.FC<{ className?: string; onOpenProfile: () => void }> = ({ className = '', onOpenProfile }) => {
  const t = useT();
  const [prep, setPrep] = useState<PrepState | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setPrep(await readPrep()); } catch { /* keep what is shown */ }
  }, []);

  useEffect(() => {
    void refresh();
    // The Profile panel can change either document; read again on return.
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    const id = window.setInterval(() => { void refresh(); }, 15000);
    return () => { window.removeEventListener('focus', onFocus); window.clearInterval(id); };
  }, [refresh]);

  const upload = async (kind: 'resume' | 'jd') => {
    if (busy) return;
    setError(null);
    const api = window.electronAPI;
    const picked = await api?.profileSelectFile?.().catch(() => undefined);
    if (!picked || picked.cancelled || !picked.filePath) return;
    setBusy(kind);
    try {
      const r = kind === 'resume'
        ? await api?.profileUploadResume?.(picked.filePath)
        : await api?.profileUploadJD?.(picked.filePath);
      if (!r?.success) setError(r?.error || (kind === 'resume' ? t('The résumé could not be read. Try a PDF or Word file.') : t('The job description could not be read. Try a PDF, Word or text file.')));
      await refresh();
    } catch (e: any) {
      setError(e?.message || t('Upload failed. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const removeJD = async () => {
    if (busy) return;
    setError(null);
    setBusy('jd-remove');
    try {
      const r = await window.electronAPI?.profileDeleteJD?.();
      if (r && !r.success) setError(r.error || t('Could not remove the job description.'));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (!prep) return null;

  const jdLabel = prep.jdTitle
    ? `${prep.jdTitle}${prep.jdCompany ? ` · ${prep.jdCompany}` : ''}`
    : prep.jdCompany || t('Job description added');

  const tile = 'flex min-w-0 flex-1 items-start gap-3 rounded-xl border border-border-muted bg-bg-primary p-4';
  const spin = <Loader2 size={12} className="animate-spin" aria-hidden />;

  return (
    <section className={`text-text-primary ${className}`} aria-labelledby="prep-title" data-testid="interview-prep-card">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 id="prep-title" className="text-[15px] font-bold">{t('Your interview prep')}</h2>
        <button type="button" className="text-[11px] text-text-tertiary underline hover:text-text-secondary" onClick={onOpenProfile}>
          {t('Full profile')}
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        {/* Résumé */}
        <div className={tile} data-testid="prep-resume">
          <FileText size={18} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">{t('Résumé')}</div>
            <p className="mt-0.5 truncate text-xs text-text-secondary" title={prep.hasResume ? (prep.name ?? '') : undefined}>
              {prep.hasResume
                ? [prep.name, prep.role].filter(Boolean).join(' · ') || t('Uploaded')
                : t('Not added. Answers about your experience use it.')}
            </p>
            <button type="button" className={`${SETTINGS_BTN} mt-3`} onClick={() => void upload('resume')} disabled={!!busy}>
              {busy === 'resume' ? spin : <Upload size={12} aria-hidden />}
              {busy === 'resume' ? t('Reading…') : prep.hasResume ? t('Replace') : t('Upload résumé')}
            </button>
          </div>
        </div>

        {/* Job description: changes with every interview. */}
        <div className={`${tile} ${prep.hasJD ? '' : 'border-dashed'}`} data-testid="prep-jd">
          <Briefcase size={18} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">{t('Job description')}</div>
            <p className="mt-0.5 truncate text-xs text-text-secondary" title={prep.hasJD ? jdLabel : undefined}>
              {prep.hasJD ? jdLabel : t('Add the JD for your next interview.')}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className={SETTINGS_BTN} onClick={() => void upload('jd')} disabled={!!busy}>
                {busy === 'jd' ? spin : <Upload size={12} aria-hidden />}
                {busy === 'jd' ? t('Reading…') : prep.hasJD ? t('Change JD') : t('Add JD')}
              </button>
              {prep.hasJD && (
                <button type="button" className="inline-flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary" onClick={() => void removeJD()} disabled={!!busy}>
                  {busy === 'jd-remove' ? spin : <X size={11} aria-hidden />} {t('Remove')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {prep.hasJD && (
        <p className="mt-3 text-[11px] text-text-tertiary">
          {t('Answers are tailored to this job. Change it before each new interview.')}
        </p>
      )}
      <div aria-live="polite" className="min-h-[16px] mt-1 text-xs">
        {error && <span role="alert" className="text-red-400">{error}</span>}
      </div>
    </section>
  );
};
