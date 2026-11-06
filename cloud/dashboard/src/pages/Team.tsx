import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { API_URL } from '../config';
import type { Me, Role, Team } from '../lib/types';
import { Badge, Empty, Notice, copyText, useAction } from '../components/ui';

interface StaffRow { user_id: string; role: Role; display_name: string | null; created_at: string }
interface Membership { team_id: string; user_id: string }

const ROLE_HELP: Record<Role, string> = {
  admin: 'Everything in the organization, including staff and the audit log.',
  manager: 'Their teams: candidates, minutes, slots, invites and assignments.',
  coach: 'Read their teams and add notes to sessions.',
};

export const TeamPage: React.FC<{ me: Me }> = ({ me }) => {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [members, setMembers] = useState<Membership[]>([]);
  const [newTeam, setNewTeam] = useState('');
  const load = useAction();
  const edit = useAction();
  const isAdmin = me.role === 'admin';

  const refresh = useCallback(() => load.run(async () => {
    const [t, s, m] = await Promise.all([
      supabase.from('teams').select('id, name, org_id').order('name'),
      supabase.from('staff').select('user_id, role, display_name, created_at').order('created_at'),
      supabase.from('staff_teams').select('team_id, user_id'),
    ]);
    for (const r of [t, s, m]) if (r.error) throw r.error;
    setTeams(t.data as Team[]);
    setStaff(s.data as StaffRow[]);
    setMembers(m.data as Membership[]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  useEffect(() => { void refresh(); }, [refresh]);

  const addTeam = (e: React.FormEvent) => {
    e.preventDefault();
    void edit.run(async () => {
      const { error } = await supabase.from('teams').insert({ org_id: me.orgId, name: newTeam.trim() });
      if (error) throw error;
      setNewTeam('');
      await refresh();
    });
  };
  const toggleMember = (teamId: string, userId: string, on: boolean) => void edit.run(async () => {
    const r = on
      ? await supabase.from('staff_teams').insert({ team_id: teamId, user_id: userId })
      : await supabase.from('staff_teams').delete().eq('team_id', teamId).eq('user_id', userId);
    if (r.error) throw r.error;
    await refresh();
  });
  const setRole = (userId: string, role: Role) => void edit.run(async () => {
    const { error } = await supabase.from('staff').update({ role }).eq('user_id', userId);
    if (error) throw error;
    await refresh();
  });
  const remove = (s: StaffRow) => {
    if (!window.confirm(`Remove ${s.display_name ?? 'this person'} from ${me.orgName}? They can no longer sign in to this dashboard's data.`)) return;
    void edit.run(async () => {
      const { error } = await supabase.from('staff').delete().eq('user_id', s.user_id);
      if (error) throw error;
      await refresh();
    });
  };

  const name = (s: StaffRow) => (s.user_id === me.userId ? `${s.display_name ?? me.email ?? 'You'} (you)` : s.display_name ?? `Staff member ${s.user_id.slice(0, 6)}`);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Teams &amp; staff</h1>
          <p className="subtitle">Managers and coaches see only the teams they belong to.</p>
        </div>
      </div>
      {load.error && <Notice kind="error">{load.error}</Notice>}
      {edit.error && <Notice kind="error">{edit.error}</Notice>}

      <div className="grid grid-2">
        <div className="card stack">
          <h2>Teams</h2>
          {teams === null ? <Empty>Loading…</Empty> : teams.length === 0 ? <span className="faint">No teams yet.</span> : (
            <table className="table"><tbody>
              {teams.map((t) => <tr key={t.id}><td><strong>{t.name}</strong></td>
                <td className="faint num">{members.filter((m) => m.team_id === t.id).length} staff</td></tr>)}
            </tbody></table>
          )}
          {isAdmin && (
            <form className="row" onSubmit={addTeam}>
              <input className="input" style={{ flex: 1 }} placeholder="New team name" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} maxLength={200} />
              <button className="btn primary" type="submit" disabled={edit.busy || !newTeam.trim()}>Add team</button>
            </form>
          )}
        </div>
        {isAdmin && teams && <InviteStaff teams={teams} onInvited={refresh} />}
      </div>

      <div className="card stack" style={{ marginTop: 16 }}>
        <h2>Staff</h2>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Name</th><th>Role</th>{(teams ?? []).map((t) => <th key={t.id}>{t.name}</th>)}{isAdmin && <th />}</tr></thead>
          <tbody>
            {staff.map((s) => {
              const self = s.user_id === me.userId;
              return (
                <tr key={s.user_id}>
                  <td><strong>{name(s)}</strong></td>
                  <td>{isAdmin && !self ? (
                    <select className="input" style={{ width: 120, padding: '4px 8px' }} value={s.role} onChange={(e) => setRole(s.user_id, e.target.value as Role)} aria-label="Role">
                      <option value="admin">Admin</option><option value="manager">Manager</option><option value="coach">Coach</option>
                    </select>
                  ) : <Badge tone={s.role === 'admin' ? 'accent' : undefined}>{s.role}</Badge>}</td>
                  {(teams ?? []).map((t) => {
                    const on = members.some((m) => m.team_id === t.id && m.user_id === s.user_id);
                    return <td key={t.id}>{s.role === 'admin' ? <span className="faint">All</span> : isAdmin
                      ? <input type="checkbox" checked={on} onChange={(e) => toggleMember(t.id, s.user_id, e.target.checked)} aria-label={`${name(s)} in ${t.name}`} />
                      : on ? '✓' : ''}</td>;
                  })}
                  {isAdmin && <td className="num">{!self && <button className="btn small danger" onClick={() => remove(s)} disabled={edit.busy}>Remove</button>}</td>}
                </tr>
              );
            })}
          </tbody>
        </table></div>
        <div className="faint">{Object.entries(ROLE_HELP).map(([r, h]) => <div key={r}><strong>{r}</strong>: {h}</div>)}</div>
      </div>
    </>
  );
};

const InviteStaff: React.FC<{ teams: Team[]; onInvited: () => void }> = ({ teams, onInvited }) => {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('manager');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Your sign-in has expired. Sign in again.');
      const res = await fetch(`${API_URL}/v1/staff/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: email.trim(), role, team_ids: role === 'admin' ? [] : teamIds, display_name: displayName.trim() || null, redirect_to: window.location.origin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const messages: Record<string, string> = {
          admins_only: 'Only admins can invite staff.', bad_email: 'Check the email address.',
          in_another_organization: 'That person already belongs to another organization.',
        };
        throw new Error(messages[body.error] ?? 'Could not create the invitation. Try again.');
      }
      setLink(body.link);
      setCopied(false);
      setEmail('');
      setDisplayName('');
      onInvited();
    });
  };

  return (
    <form className="card stack" onSubmit={invite}>
      <h2>Invite staff</h2>
      <div className="form-grid">
        <label className="field">Email<input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="field">Name<input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} /></label>
        <label className="field">Role
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="manager">Manager</option><option value="coach">Coach</option><option value="admin">Admin</option>
          </select>
        </label>
      </div>
      {role !== 'admin' && (
        <div className="row">{teams.length === 0 ? <span className="faint">Add a team first.</span> : teams.map((t) => (
          <label key={t.id} className="row faint"><input type="checkbox" checked={teamIds.includes(t.id)}
            onChange={(e) => setTeamIds((ids) => (e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id)))} /> {t.name}</label>
        ))}</div>
      )}
      {action.error && <Notice kind="error">{action.error}</Notice>}
      <div><button className="btn primary" type="submit" disabled={action.busy || !email.trim()}>Create invitation link</button></div>
      {link && (
        <div className="stack">
          <Notice kind="ok">Invitation ready. Send this one-time link to them privately; it lets them choose a password.</Notice>
          <div className="row"><input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invitation link" />
            <button className="btn" type="button" onClick={() => void copyText(link).then(setCopied)}>{copied ? 'Copied' : 'Copy'}</button></div>
        </div>
      )}
    </form>
  );
};
