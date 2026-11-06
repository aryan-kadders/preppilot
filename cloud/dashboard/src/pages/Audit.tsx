import React, { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { dateTime } from '../lib/format';
import { Empty, Notice, useAction } from '../components/ui';

interface AuditRow { id: number; action: string; target_type: string | null; target_id: string | null; actor_id: string | null; details: Record<string, unknown> | null; created_at: string }

const ACTIONS: Record<string, string> = {
  'invite.create': 'Invite code created', 'invite.redeem': 'Invite code used', 'minutes.grant': 'Minutes changed',
  'device.revoke': 'Computer signed out', 'device.refresh_reuse': 'Computer locked out (copied sign-in)',
  'staff.add': 'Staff added', 'candidate.archive': 'Candidate archived',
};

export const Audit: React.FC = () => {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const load = useAction();
  useEffect(() => {
    void load.run(async () => {
      const { data, error } = await supabase.from('audit_log').select('id, action, target_type, target_id, actor_id, details, created_at').order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      setRows(data as AuditRow[]);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="page-head"><div><h1>Audit log</h1><p className="subtitle">Who changed what, newest first.</p></div></div>
      <div className="card">
        {load.error && <Notice kind="error">{load.error}</Notice>}
        {rows === null ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>Nothing yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>When</th><th>What</th><th>Details</th><th>By</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(r.created_at)}</td>
                  <td>{ACTIONS[r.action] ?? r.action}{r.target_type === 'candidate' && r.target_id && <> · <a href={`#/candidates/${r.target_id}`}>candidate</a></>}</td>
                  <td className="muted mono" style={{ fontSize: 12 }}>{r.details ? Object.entries(r.details).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join(', ') : ''}</td>
                  <td className="faint">{r.actor_id ? r.actor_id.slice(0, 8) : 'System'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </>
  );
};
