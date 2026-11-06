import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

// ── Feedback ────────────────────────────────────────────────

export const Alert: React.FC<{ kind: 'error' | 'ok' | 'info'; children: React.ReactNode }> = ({ kind, children }) => {
  const Icon = kind === 'error' ? AlertCircle : kind === 'ok' ? CheckCircle2 : Info;
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}><Icon size={16} style={{ marginTop: 1 }} /><div>{children}</div></div>;
};

export const EmptyState: React.FC<{ icon: React.ReactNode; title: string; description?: React.ReactNode; action?: React.ReactNode }> = ({ icon, title, description, action }) => (
  <div className="empty">
    <div className="tile">{icon}</div>
    <div className="empty-title">{title}</div>
    {description && <div className="empty-desc">{description}</div>}
    {action}
  </div>
);

export const SkeletonRows: React.FC<{ rows?: number }> = ({ rows = 4 }) => (
  <div className="rows">
    {Array.from({ length: rows }, (_, r) => (
      <div key={r} className="srow"><div className="tile" /><div className="srow-text stack" style={{ gap: 8 }}><div className="skeleton" style={{ width: '40%' }} /><div className="skeleton" style={{ width: '65%', height: 10 }} /></div></div>
    ))}
  </div>
);

export const Badge: React.FC<{ tone?: 'good' | 'warn' | 'danger' | 'accent'; dot?: boolean; pulse?: boolean; children: React.ReactNode }> = ({ tone, dot, pulse, children }) =>
  <span className={`badge ${tone ?? ''}`}>{dot && <span className={`dot ${pulse ? 'pulse' : ''}`} />}{children}</span>;

export function initials(name: string | null | undefined): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export const Avatar: React.FC<{ name: string | null | undefined; large?: boolean }> = ({ name, large }) =>
  <span className={`avatar ${large ? 'lg' : ''}`} aria-hidden="true">{initials(name)}</span>;

export const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: React.ReactNode; hint?: React.ReactNode }> = ({ icon, label, value, hint }) => (
  <div className="stat">
    <div className="stat-top"><span className="tile">{icon}</span>{label}</div>
    <div className="stat-value">{value}</div>
    {hint && <div className="stat-hint">{hint}</div>}
  </div>
);

/** A titled section, like Settings' "Speech Provider": heading and grey line above, card below. */
export const Section: React.FC<{ title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode }> = ({ title, description, actions, children }) => (
  <section className="section">
    <div className="row" style={{ alignItems: 'flex-end', marginBottom: 12, flexWrap: 'nowrap' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 className="section-title">{title}</h2>
        {description && <p className="section-desc" style={{ margin: 0 }}>{description}</p>}
      </div>
      {actions}
    </div>
    <div className="card">{children}</div>
  </section>
);

/** A Settings row: icon tile, bold title over a grey line, something on the right. */
export const SRow: React.FC<{ icon: React.ReactNode; title: React.ReactNode; description?: React.ReactNode; aside?: React.ReactNode; onClick?: () => void }> = ({ icon, title, description, aside, onClick }) => (
  <div className={`srow ${onClick ? 'clickable' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
    onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}>
    <span className="tile">{icon}</span>
    <div className="srow-text"><div className="srow-title">{title}</div>{description && <div className="srow-desc">{description}</div>}</div>
    {aside && <div className="srow-aside">{aside}</div>}
  </div>
);

export const Card: React.FC<{ title?: string; description?: string; actions?: React.ReactNode; children: React.ReactNode; flush?: boolean }> = ({ title, description, actions, children, flush }) => (
  <section className="card">
    {(title || actions) && (
      <div className="card-head">
        <div style={{ minWidth: 0 }}>
          {title && <h2 className="card-title">{title}</h2>}
          {description && <p className="card-desc">{description}</p>}
        </div>
        <span className="spacer" />
        {actions}
      </div>
    )}
    {flush ? children : <div className="card-pad">{children}</div>}
  </section>
);

export const Field: React.FC<{ label: string; hint?: string; full?: boolean; children: React.ReactNode }> = ({ label, hint, full, children }) => (
  <label className={`field ${full ? 'full' : ''}`}>
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

// ── Dialog (native <dialog>: focus trap and Esc for free) ────

export const Dialog: React.FC<{
  open: boolean; onClose: () => void; title: string; description?: string;
  children: React.ReactNode; footer?: React.ReactNode; onSubmit?: () => void; wide?: boolean;
}> = ({ open, onClose, title, description, children, footer, onSubmit, wide }) => {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" style={wide ? { width: 'min(680px, calc(100vw - 32px))' } : undefined}
      onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {open && (
        <form method="dialog" onSubmit={(e) => { e.preventDefault(); onSubmit?.(); }}>
          <div className="dialog-head">
            <div style={{ flex: 1 }}>
              <h2 className="dialog-title">{title}</h2>
              {description && <p className="dialog-desc">{description}</p>}
            </div>
            <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </form>
      )}
    </dialog>
  );
};

// ── Toasts ──────────────────────────────────────────────────

type Toast = { id: number; text: string; error?: boolean };
const ToastContext = createContext<(text: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            {t.error ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}{t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

// ── Async actions ───────────────────────────────────────────

/** Runs an async action, tracks busy, and turns a failure into a message. */
export function useAction(): { busy: boolean; error: string | null; run: (fn: () => Promise<void>) => Promise<boolean>; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); return true; } catch (e) { setError(friendlyError(e)); return false; } finally { setBusy(false); }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear };
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
