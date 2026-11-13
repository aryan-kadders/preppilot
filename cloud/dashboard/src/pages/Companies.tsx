import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Building2, Plus, RefreshCw } from 'lucide-react';
import { supabase } from '../supabase';
import type { Me } from '../lib/types';
import { minutesLabel, money } from '../lib/format';
import { Alert, Badge, Card, Dialog, EmptyState, Field, Kpi, SkeletonRows, useAction, useToast } from '../components/ui';

interface OrgRow {
  id: string; name: string; created_at: string; require_slots: boolean;
  teams: number; staff: number; candidates: number; active_candidates: number;
  used_seconds_30d: number; cost_usd_30d: number | string; upcoming_interviews: number;
}

/** Owners only: every company using PrepPilot, and which one to work in. */
export const Companies: React.FC<{ me: Me; onSwitch: () => void }> = ({ me, onSwitch }) => {
  const [rows, setRows] = useState<OrgRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useAction();
  const act = useAction();
  const { run } = load;

  const refresh = useCallback(() => run(async () => {
    const { data, error } = await supabase.rpc('pp_owner_orgs');
    if (error) throw error;
    setRows(data as OrgRow[]);
  }), [run]);
  useEffect(() => { void refresh(); }, [refresh]);

  const use = (id: string) => void act.run(async () => {
    const { error } = await supabase.rpc('pp_owner_use_org', { p_org: id });
    if (error) throw error;
    onSwitch();
  });

  const all = rows ?? [];
  const sum = (k: keyof OrgRow) => all.reduce((s, r) => s + Number(r[k] ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Companies</h1>
          <p className="page-desc">Every company using PrepPilot. Open one to work in it with full access.</p>
        </div>
        <div className="row">
          <button className="btn btn-ghost btn-icon" onClick={() => void refresh()} disabled={load.busy} aria-label="Refresh" title="Refresh"><RefreshCw size={15} /></button>
          <button className="btn btn-cta" onClick={() => setCreating(true)}><Plus size={15} /> New company</button>
        </div>
      </div>

      <div className="stats">
        <Kpi icon={<Building2 size={14} />} label="Companies" value={all.length} />
        <Kpi icon={<Building2 size={14} />} label="Candidates" value={sum('candidates')} hint={`${sum('active_candidates')} signed in`} />
        <Kpi icon={<Building2 size={14} />} label="Practised, last 30 days" value={minutesLabel(sum('used_seconds_30d'))} />
        <Kpi icon={<Building2 size={14} />} label="AI cost, last 30 days" value={money(sum('cost_usd_30d'))} hint="Estimate" />
      </div>

      {(load.error || act.error) && <div style={{ marginBottom: 16 }}><Alert kind="error">{load.error ?? act.error}</Alert></div>}

      <Card title="All companies" flush>
        {rows === null ? <SkeletonRows /> : rows.length === 0 ? (
          <EmptyState icon={<Building2 size={20} />} title="No companies yet" description="Create one, then invite its first admin from Teams & staff."
            action={<button className="btn btn-cta" onClick={() => setCreating(true)}><Plus size={15} /> New company</button>} />
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Company</th><th className="num">Staff</th><th className="num">Candidates</th><th className="num">Upcoming interviews</th><th className="num">Practised (30 d)</th><th className="num">AI cost (30 d)</th><th /></tr></thead>
            <tbody>{rows.map((o) => {
              const current = o.id === me.orgId;
              return (
                <tr key={o.id}>
                  <td>
                    <div className="person-name">{o.name} {current && <Badge tone="accent">Working in</Badge>}</div>
                    <div className="person-sub">{o.teams} {o.teams === 1 ? 'team' : 'teams'} · {o.require_slots ? 'Booked slots required' : 'Practice any time'} · since {new Date(o.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</div>
                  </td>
                  <td className="num">{o.staff}</td>
                  <td className="num">{o.candidates}</td>
                  <td className="num">{o.upcoming_interviews}</td>
                  <td className="num">{minutesLabel(o.used_seconds_30d)}</td>
                  <td className="num">{money(o.cost_usd_30d)}</td>
                  <td className="num">{current
                    ? <button className="btn" onClick={onSwitch}>Go to it</button>
                    : <button className="btn" onClick={() => use(o.id)} disabled={act.busy}>Open <ArrowRight size={14} /></button>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>

      <NewCompanyDialog open={creating} onClose={() => setCreating(false)} onDone={onSwitch} />
    </>
  );
};

const NewCompanyDialog: React.FC<{ open: boolean; onClose: () => void; onDone: () => void }> = ({ open, onClose, onDone }) => {
  const [name, setName] = useState('');
  const action = useAction();
  const toast = useToast();
  const save = () => void action.run(async () => {
    if (!name.trim()) throw new Error('Enter the company name.');
    const { error } = await supabase.rpc('pp_owner_create_org', { p_name: name.trim() });
    if (error) throw error;
    toast(`${name.trim()} created. Invite its first admin from Teams & staff.`);
    setName('');
    onClose();
    onDone();
  });
  return (
    <Dialog open={open} onClose={onClose} onSubmit={save} title="New company" description="You start working in it right away; then create its teams and invite its admin."
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy || !name.trim()}>Create company</button></>}>
      <Field label="Company name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Kadders" autoFocus /></Field>
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Dialog>
  );
};
