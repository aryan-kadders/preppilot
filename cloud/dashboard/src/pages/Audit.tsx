import React, { useEffect, useState } from 'react';
import { Archive, KeyRound, Laptop, ScrollText, ShieldAlert, Timer, UserPlus } from 'lucide-react';
import { supabase } from '../supabase';
import { dateTime } from '../lib/format';
import { Alert, EmptyState, SkeletonRows, useAction } from '../components/ui';

interface AuditRow { id: number; action: string; target_type: string | null; target_id: string | null; actor_id: string | null; details: Record<string, unknown> | null; created_at: string }

const ACTIONS: Record<string, { label: string; icon: React.ReactNode }> = {
  'invite.create': { label: 'Invite code created', icon: <KeyRound size={15} /> },
  'invite.redeem': { label: 'Invite code used on a computer', icon: <Laptop size={15} /> },
  'minutes.grant': { label: 'Minutes changed', icon: <Timer size={15} /> },
  'device.revoke': { label: 'Computer signed out', icon: <Laptop size={15} /> },
  'device.refresh_reuse': { label: 'Computer locked out: copied sign-in detected', icon: <ShieldAlert size={15} /> },
  'staff.add': { label: 'Staff member added', icon: <UserPlus size={15} /> },
  'candidate.archive': { label: 'Candidate archived', icon: <Archive size={15} /> },
};

function describe(r: AuditRow): string {
  const d = r.details ?? {};
  if (r.action === 'minutes.grant' && typeof d.minutes === 'number') return `${d.minutes > 0 ? '+' : ''}${d.minutes} min${d.note ? ` · ${d.note}` : ''}`;
  if (r.action === 'staff.add' && d.role) return `as ${d.role}`;
  if (r.action === 'invite.redeem' && d.platform) return String(d.platform) === 'win32' ? 'Windows' : String(d.platform) === 'darwin' ? 'macOS' : String(d.platform);
  if (r.action === 'invite.create' && d.ttl_days) return `valid ${d.ttl_days} days`;
  return '';
}

export const Audit: React.FC = () => {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const load = useAction();
  const { run } = load;
  useEffect(() => {
    void run(async () => {
      const { data, error } = await supabase.from('audit_log').select('id, action, target_type, target_id, actor_id, details, created_at').order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      setRows(data as AuditRow[]);
    });
  }, [run]);
  return (
    <>
      <div className="page-head"><div><h1 className="page-title">Audit log</h1><p className="page-desc">Every change to candidates, minutes, computers and staff, newest first.</p></div></div>
      <section className="card">
        {load.error && <div style={{ padding: 12 }}><Alert kind="error">{load.error}</Alert></div>}
        {rows === null ? <SkeletonRows /> : rows.length === 0 ? <EmptyState icon={<ScrollText size={20} />} title="Nothing recorded yet" /> : (
          <div className="rows">{rows.map((r) => {
            const a = ACTIONS[r.action] ?? { label: r.action, icon: <ScrollText size={15} /> };
            return (
              <div key={r.id} className="srow">
                <span className="tile sm">{a.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{a.label}{r.target_type === 'candidate' && r.target_id && <> · <a href={`#/candidates/${r.target_id}`} style={{ color: 'var(--accent)' }}>view candidate</a></>}</div>
                  {describe(r) && <div className="faint">{describe(r)}</div>}
                </div>
                <span className="faint" style={{ whiteSpace: 'nowrap' }}>{dateTime(r.created_at)}</span>
              </div>
            );
          })}</div>
        )}
      </section>
    </>
  );
};
