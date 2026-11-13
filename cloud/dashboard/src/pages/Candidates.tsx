import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Clock, Plus, RefreshCw, Search, Timer, UserPlus, Users, UsersRound } from 'lucide-react';
import { supabase } from '../supabase';
import { canManage as canManageFor, isAdmin, type CandidateRow, type Me, type Route, type Team } from '../lib/types';
import { minutesLabel, relative, slotLabel } from '../lib/format';
import { Alert, Avatar, Badge, Dialog, EmptyState, Field, Kpi, SkeletonRows, useAction, useToast } from '../components/ui';

export const Candidates: React.FC<{ me: Me; go: (r: Route) => void }> = ({ me, go }) => {
  const [rows, setRows] = useState<CandidateRow[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamFilter, setTeamFilter] = useState('');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useAction();
  const { run } = load;

  const refresh = useCallback(() => run(async () => {
    const [c, t] = await Promise.all([
      supabase.from('candidate_overview').select('*').order('name'),
      supabase.from('teams').select('id, name, org_id').order('name'),
    ]);
    if (c.error) throw c.error;
    if (t.error) throw t.error;
    setRows(c.data as CandidateRow[]);
    setTeams(t.data as Team[]);
  }), [run]);

  useEffect(() => { void refresh(); }, [refresh]);

  const visible = useMemo(() => (rows ?? []).filter((r) =>
    (showArchived || r.status !== 'archived')
    && (!teamFilter || r.team_id === teamFilter)
    && (!query || `${r.name} ${r.email ?? ''}`.toLowerCase().includes(query.toLowerCase()))), [rows, teamFilter, query, showArchived]);

  const active = (rows ?? []).filter((r) => r.status !== 'archived');
  const live = active.filter((r) => r.in_session).length;
  const minutesLeft = active.reduce((s, r) => s + Math.max(0, r.balance_seconds), 0);
  const used7d = active.reduce((s, r) => s + r.used_seconds_7d, 0);
  const outOfTime = active.filter((r) => r.balance_seconds <= 0).length;
  const canManage = canManageFor(me);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Candidates</h1>
          <p className="page-desc">{canManage ? 'Give practice time, send invite codes and follow progress.' : 'Follow your teams\' practice and progress.'}</p>
        </div>
        {canManage && teams.length > 0 && <button className="btn btn-cta" onClick={() => setAdding(true)}><Plus size={15} /> Add candidate</button>}
      </div>

      <div className="stats">
        <Kpi icon={<Users size={14} />} label="Active candidates" value={active.length} hint={rows && rows.length > active.length ? `${rows.length - active.length} archived` : undefined} />
        <Kpi icon={<Activity size={14} />} label="In a session now" value={live} hint={live ? 'Live right now' : active.length ? 'Nobody practising' : undefined} />
        <Kpi icon={<Timer size={14} />} label="Minutes available" value={minutesLabel(minutesLeft)} hint={outOfTime ? `${outOfTime} with no minutes left` : active.length ? 'Everyone has time' : undefined} />
        <Kpi icon={<Clock size={14} />} label="Practised, last 7 days" value={minutesLabel(used7d)} />
      </div>

      <section className="card">
        <div className="toolbar">
          <div className="search" style={{ width: 260 }}>
            <Search size={15} />
            <input className="input" placeholder="Search candidates" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search candidates" />
          </div>
          <select className="input" style={{ width: 180 }} value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} aria-label="Team">
            <option value="">All teams</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived</label>
          <span className="spacer" />
          <button className="btn btn-ghost btn-icon" onClick={() => void refresh()} disabled={load.busy} aria-label="Refresh" title="Refresh"><RefreshCw size={15} /></button>
        </div>
        {load.error && <div style={{ padding: 12 }}><Alert kind="error">{load.error}</Alert></div>}
        {rows === null ? <SkeletonRows /> : visible.length === 0 ? (
          teams.length === 0 ? (
            <EmptyState icon={<UsersRound size={20} />} title="Create your first team"
              description="Candidates belong to a team, and managers see the teams they are in."
              action={isAdmin(me) ? <a className="btn btn-cta" href="#/team"><Plus size={15} /> Create a team</a> : undefined} />
          ) : rows.length === 0 ? (
            <EmptyState icon={<UserPlus size={20} />} title="No candidates yet"
              description="Add a candidate, then send them an invite code to sign in to PrepPilot."
              action={canManage ? <button className="btn btn-cta" onClick={() => setAdding(true)}><Plus size={15} /> Add candidate</button> : undefined} />
          ) : <EmptyState icon={<Search size={20} />} title="No matches" description="Try another name or team." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Candidate</th><th>Team</th><th>Status</th><th className="num">Minutes left</th><th>Slot</th><th>Last session</th></tr></thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => go({ page: 'candidate', id: r.id })}>
                    <td><div className="person"><Avatar name={r.name} /><div style={{ minWidth: 0 }}><div className="person-name">{r.name}</div>{r.email && <div className="person-sub">{r.email}</div>}</div></div></td>
                    <td className="muted">{r.team_name}</td>
                    <td><StatusBadge row={r} /></td>
                    <td className="num">{r.balance_seconds <= 0 ? <Badge tone="warn">None left</Badge> : minutesLabel(r.balance_seconds)}</td>
                    <td>{r.current_slot ? <Badge tone="good" dot>Open until {new Date(r.current_slot.ends_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</Badge>
                      : r.next_slot ? <span className="muted">{slotLabel(r.next_slot)}</span> : <span className="faint">{me.requireSlots ? 'No slot booked' : 'Any time'}</span>}</td>
                    <td className="muted">{relative(r.last_session_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AddCandidate open={adding} onClose={() => setAdding(false)} me={me} teams={teams} onAdded={(id) => go({ page: 'candidate', id })} />
    </>
  );
};

export const StatusBadge: React.FC<{ row: Pick<CandidateRow, 'status' | 'in_session' | 'active_devices'> }> = ({ row }) => {
  if (row.status === 'archived') return <Badge>Archived</Badge>;
  if (row.in_session) return <Badge tone="good" dot pulse>In session</Badge>;
  if (row.status === 'invited') return <Badge tone="accent">Invited</Badge>;
  return row.active_devices > 0 ? <Badge>Ready</Badge> : <Badge tone="warn">Signed out</Badge>;
};

const AddCandidate: React.FC<{ open: boolean; onClose: () => void; me: Me; teams: Team[]; onAdded: (id: string) => void }> = ({ open, onClose, me, teams, onAdded }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [teamId, setTeamId] = useState('');
  const [minutes, setMinutes] = useState('60');
  const action = useAction();
  const toast = useToast();
  useEffect(() => { if (open && !teamId && teams[0]) setTeamId(teams[0].id); }, [open, teams, teamId]);

  const save = () => void action.run(async () => {
    if (!name.trim()) throw new Error('Enter a name.');
    const { data, error } = await supabase.from('candidates')
      .insert({ org_id: me.orgId, team_id: teamId, name: name.trim(), email: email.trim() || null })
      .select('id').single();
    if (error) throw error;
    const m = Number.parseInt(minutes, 10);
    if (m > 0) {
      const g = await supabase.rpc('pp_grant_minutes', { p_candidate: data.id, p_minutes: m, p_note: 'Starting minutes' });
      if (g.error) throw g.error;
    }
    toast(`${name.trim()} added`);
    setName(''); setEmail(''); setMinutes('60');
    onClose();
    onAdded(data.id);
  });

  return (
    <Dialog open={open} onClose={onClose} onSubmit={save} title="Add candidate" description="Next, create their invite code so they can sign in to PrepPilot."
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy || !name.trim()}>Add candidate</button></>}>
      <div className="form-grid">
        <Field label="Full name" full><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus /></Field>
        <Field label="Email" hint="Optional, for your records."><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Team"><select className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        <Field label="Starting minutes" hint="You can give more any time."><input className="input" type="number" min={0} max={100000} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field>
      </div>
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Dialog>
  );
};
