import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase';
import type { CandidateRow, Me, Route, Team } from '../lib/types';
import { minutesLabel, relative, slotLabel } from '../lib/format';
import { Badge, Empty, Notice, useAction } from '../components/ui';

export const Candidates: React.FC<{ me: Me; go: (r: Route) => void }> = ({ me, go }) => {
  const [rows, setRows] = useState<CandidateRow[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamFilter, setTeamFilter] = useState('');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useAction();

  const refresh = useCallback(() => load.run(async () => {
    const [c, t] = await Promise.all([
      supabase.from('candidate_overview').select('*').order('name'),
      supabase.from('teams').select('id, name, org_id').order('name'),
    ]);
    if (c.error) throw c.error;
    if (t.error) throw t.error;
    setRows(c.data as CandidateRow[]);
    setTeams(t.data as Team[]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  useEffect(() => { void refresh(); }, [refresh]);

  const visible = useMemo(() => (rows ?? []).filter((r) =>
    (showArchived || r.status !== 'archived')
    && (!teamFilter || r.team_id === teamFilter)
    && (!query || `${r.name} ${r.email ?? ''}`.toLowerCase().includes(query.toLowerCase()))), [rows, teamFilter, query, showArchived]);

  const active = (rows ?? []).filter((r) => r.status !== 'archived');
  const stats = {
    candidates: active.length,
    live: active.filter((r) => r.in_session).length,
    minutesLeft: active.reduce((s, r) => s + Math.max(0, r.balance_seconds), 0),
    used7d: active.reduce((s, r) => s + r.used_seconds_7d, 0),
  };
  const canManage = me.role !== 'coach';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Candidates</h1>
          <p className="subtitle">Give time, book slots and follow progress.</p>
        </div>
        {canManage && <button className="btn primary" onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : 'Add candidate'}</button>}
      </div>

      {adding && <AddCandidate me={me} teams={teams} onAdded={(id) => go({ page: 'candidate', id })} />}

      <div className="stats">
        <div className="stat"><div className="label">Candidates</div><div className="value">{stats.candidates}</div></div>
        <div className="stat"><div className="label">In a session now</div><div className="value">{stats.live}</div></div>
        <div className="stat"><div className="label">Minutes left (all)</div><div className="value">{minutesLabel(stats.minutesLeft)}</div></div>
        <div className="stat"><div className="label">Used, last 7 days</div><div className="value">{minutesLabel(stats.used7d)}</div></div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder="Search name or email" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search candidates" />
          <select className="input" style={{ maxWidth: 200 }} value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} aria-label="Team">
            <option value="">All teams</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <label className="row faint"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
          <span className="spacer" />
          <button className="btn small" onClick={() => void refresh()} disabled={load.busy}>Refresh</button>
        </div>
        {load.error && <Notice kind="error">{load.error}</Notice>}
        {rows === null ? <Empty>Loading…</Empty> : visible.length === 0 ? (
          <Empty>{rows.length === 0 ? (teams.length === 0 ? 'Create a team first (Teams & staff), then add candidates.' : 'No candidates yet. Add your first one.') : 'No candidates match.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Team</th><th>Status</th><th className="num">Minutes left</th><th>Slot</th><th>Last session</th></tr></thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => go({ page: 'candidate', id: r.id })}>
                    <td><strong>{r.name}</strong>{r.email && <div className="faint">{r.email}</div>}</td>
                    <td>{r.team_name}</td>
                    <td><StatusBadge row={r} /></td>
                    <td className="num">{r.balance_seconds <= 0 ? <Badge tone="warn">None</Badge> : minutesLabel(r.balance_seconds)}</td>
                    <td>{r.current_slot ? <Badge tone="good">Open until {new Date(r.current_slot.ends_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</Badge> : <span className="muted">{slotLabel(r.next_slot)}</span>}</td>
                    <td className="muted">{relative(r.last_session_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
};

export const StatusBadge: React.FC<{ row: Pick<CandidateRow, 'status' | 'in_session' | 'active_devices'> }> = ({ row }) => {
  if (row.status === 'archived') return <Badge>Archived</Badge>;
  if (row.in_session) return <Badge tone="good" dot>In session</Badge>;
  if (row.status === 'invited') return <Badge tone="accent">Invited</Badge>;
  return row.active_devices > 0 ? <Badge>Signed in</Badge> : <Badge tone="warn">No device</Badge>;
};

const AddCandidate: React.FC<{ me: Me; teams: Team[]; onAdded: (id: string) => void }> = ({ me, teams, onAdded }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '');
  const [minutes, setMinutes] = useState('60');
  const action = useAction();
  useEffect(() => { if (!teamId && teams[0]) setTeamId(teams[0].id); }, [teams, teamId]);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      if (!teamId) throw new Error('Create a team first (Teams & staff).');
      const { data, error } = await supabase.from('candidates')
        .insert({ org_id: me.orgId, team_id: teamId, name: name.trim(), email: email.trim() || null })
        .select('id').single();
      if (error) throw error;
      const m = Number.parseInt(minutes, 10);
      if (m > 0) {
        const g = await supabase.rpc('pp_grant_minutes', { p_candidate: data.id, p_minutes: m, p_note: 'Starting minutes' });
        if (g.error) throw g.error;
      }
      onAdded(data.id);
    });
  };

  return (
    <form className="card stack" style={{ marginBottom: 16 }} onSubmit={save}>
      <h2>New candidate</h2>
      <div className="form-grid">
        <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></label>
        <label className="field">Email (optional)<input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field">Team
          <select className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)} required>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">Starting minutes<input className="input" type="number" min={0} max={100000} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></label>
      </div>
      {action.error && <Notice kind="error">{action.error}</Notice>}
      <div className="row"><button className="btn primary" type="submit" disabled={action.busy || !name.trim()}>Add candidate</button>
        <span className="faint">Next: create their invite code and book a slot.</span></div>
    </form>
  );
};
