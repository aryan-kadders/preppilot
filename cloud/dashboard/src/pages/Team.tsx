import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Copy, Plus, ShieldCheck, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { supabase } from '../supabase';
import { API_URL } from '../config';
import { ROLE_LABEL, isAdmin as isAdminFor, type Me, type Role, type Team } from '../lib/types';
import { Alert, Avatar, Badge, Card, Dialog, EmptyState, Field, SRow, SkeletonRows, copyText, useAction, useToast } from '../components/ui';

interface StaffRow { user_id: string; role: Role; display_name: string | null; created_at: string }
interface Membership { team_id: string; user_id: string }

const ROLE_HELP: Record<Role, string> = {
  admin: 'Everything in the organization, including staff, settings and the audit log',
  manager: 'Their teams: candidates, minutes, slots, invite codes, assignments and interviews',
  recruiter: 'Their teams: adds the client interviews candidates prepare for, and records the results. No minutes or invite codes',
  coach: 'Their teams: reviews practice sessions, adds notes, and says whether a candidate is ready for an interview',
};
const ROLES: Role[] = ['admin', 'manager', 'recruiter', 'coach'];

export const TeamPage: React.FC<{ me: Me; onSettingsChange: () => void }> = ({ me, onSettingsChange }) => {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [members, setMembers] = useState<Membership[]>([]);
  const [dialog, setDialog] = useState<null | 'team' | 'invite'>(null);
  const load = useAction();
  const edit = useAction();
  const toast = useToast();
  const isAdmin = isAdminFor(me);
  const { run } = load;

  const refresh = useCallback(() => run(async () => {
    const [t, s, m] = await Promise.all([
      supabase.from('teams').select('id, name, org_id').order('name'),
      supabase.from('staff').select('user_id, role, display_name, created_at').order('created_at'),
      supabase.from('staff_teams').select('team_id, user_id'),
    ]);
    for (const r of [t, s, m]) if (r.error) throw r.error;
    setTeams(t.data as Team[]);
    setStaff(s.data as StaffRow[]);
    setMembers(m.data as Membership[]);
  }), [run]);
  useEffect(() => { void refresh(); }, [refresh]);

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
    toast('Role updated');
    await refresh();
  });
  const remove = (s: StaffRow) => {
    if (!window.confirm(`Remove ${label(s)} from ${me.orgName}? They lose access to this dashboard.`)) return;
    void edit.run(async () => {
      const { error } = await supabase.from('staff').delete().eq('user_id', s.user_id);
      if (error) throw error;
      toast('Staff member removed');
      await refresh();
    });
  };
  const setRequireSlots = (on: boolean) => void edit.run(async () => {
    const { error } = await supabase.rpc('pp_set_require_slots', { p_require: on });
    if (error) throw error;
    toast(on ? 'Candidates now practise only inside booked slots' : 'Candidates can now practise any time they have minutes');
    onSettingsChange();
  });
  const label = (s: StaffRow) => (s.user_id === me.userId ? (s.display_name ?? me.email ?? 'You') : s.display_name ?? `Staff member ${s.user_id.slice(0, 6)}`);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Teams &amp; staff</h1>
          <p className="page-desc">Managers, recruiters and coaches see only the teams they belong to. Admins see everything.</p>
        </div>
        {isAdmin && (
          <div className="row">
            <button className="btn" onClick={() => setDialog('team')}><Plus size={15} /> New team</button>
            <button className="btn btn-cta" onClick={() => setDialog('invite')} disabled={!teams}><UserPlus size={15} /> Invite staff</button>
          </div>
        )}
      </div>
      {load.error && <div style={{ marginBottom: 16 }}><Alert kind="error">{load.error}</Alert></div>}
      {edit.error && <div style={{ marginBottom: 16 }}><Alert kind="error">{edit.error}</Alert></div>}

      <div className="stack" style={{ gap: 16 }}>
        <Card title="Teams" description="Candidates belong to one team" flush>
          {teams === null ? <SkeletonRows /> : teams.length === 0 ? (
            <EmptyState icon={<UsersRound size={20} />} title="No teams yet" description="Create a team, then add candidates to it and give managers access."
              action={isAdmin ? <button className="btn btn-cta" onClick={() => setDialog('team')}><Plus size={15} /> New team</button> : undefined} />
          ) : (
            <div className="rows">{teams.map((t) => {
              const people = staff.filter((s) => s.role !== 'admin' && members.some((m) => m.team_id === t.id && m.user_id === s.user_id));
              return (
                <div key={t.id} className="srow">
                  <div className="avatar" style={{ borderRadius: 7 }}>{t.name.slice(0, 1).toUpperCase()}</div>
                  <span className="person-name" style={{ flex: 1 }}>{t.name}</span>
                  <span className="faint">{people.length ? people.map(label).join(', ') : 'Admins only'}</span>
                </div>
              );
            })}</div>
          )}
        </Card>

        <Card title="Staff" description={`${staff.length} ${staff.length === 1 ? 'person' : 'people'} in ${me.orgName}`} flush>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Person</th><th>Role</th><th>Teams</th>{isAdmin && <th />}</tr></thead>
            <tbody>{staff.map((s) => {
              const self = s.user_id === me.userId;
              return (
                <tr key={s.user_id}>
                  <td><div className="person"><Avatar name={label(s)} /><div><div className="person-name">{label(s)}{self && <span className="faint"> (you)</span>}</div><div className="person-sub">Joined {new Date(s.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</div></div></div></td>
                  <td>{isAdmin && !self ? (
                    <select className="input" style={{ width: 130, height: 30 }} value={s.role} onChange={(e) => setRole(s.user_id, e.target.value as Role)} aria-label={`Role of ${label(s)}`}>
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  ) : <Badge tone={s.role === 'admin' ? 'accent' : undefined}>{s.role === 'admin' && <ShieldCheck size={12} />}{ROLE_LABEL[s.role]}</Badge>}</td>
                  <td>{s.role === 'admin' ? <span className="faint">All teams</span> : (
                    <div className="row">{(teams ?? []).map((t) => {
                      const on = members.some((m) => m.team_id === t.id && m.user_id === s.user_id);
                      return isAdmin
                        ? <label key={t.id} className="check"><input type="checkbox" checked={on} onChange={(e) => toggleMember(t.id, s.user_id, e.target.checked)} />{t.name}</label>
                        : on ? <Badge key={t.id}>{t.name}</Badge> : null;
                    })}</div>
                  )}</td>
                  {isAdmin && <td className="num">{!self && <button className="btn btn-ghost btn-icon" onClick={() => remove(s)} disabled={edit.busy} aria-label={`Remove ${label(s)}`}><Trash2 size={14} /></button>}</td>}
                </tr>
              );
            })}</tbody>
          </table></div>
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }} className="stack">
            {ROLES.map((r) => <div key={r} className="faint"><strong style={{ color: 'var(--text-secondary)' }}>{ROLE_LABEL[r]}</strong> · {ROLE_HELP[r]}</div>)}
          </div>
        </Card>

        <Card title="Practice rules" flush>
          <SRow icon={<CalendarClock size={16} />} title="Require booked slots"
            description={me.requireSlots
              ? 'On: candidates can use PrepPilot only inside a slot a manager booked, while they have minutes.'
              : 'Off: candidates can practise any time they have minutes. Slots are optional, for planning.'}
            aside={isAdmin
              ? <button type="button" className="toggle" role="switch" aria-checked={me.requireSlots} aria-label="Require booked slots" disabled={edit.busy} onClick={() => setRequireSlots(!me.requireSlots)} />
              : <Badge>{me.requireSlots ? 'On' : 'Off'}</Badge>} />
        </Card>
      </div>

      <NewTeamDialog open={dialog === 'team'} onClose={() => setDialog(null)} me={me} onDone={refresh} />
      {teams && <InviteStaffDialog open={dialog === 'invite'} onClose={() => setDialog(null)} teams={teams} onDone={refresh} />}
    </>
  );
};

const NewTeamDialog: React.FC<{ open: boolean; onClose: () => void; me: Me; onDone: () => void }> = ({ open, onClose, me, onDone }) => {
  const [name, setName] = useState('');
  const action = useAction();
  const toast = useToast();
  const save = () => void action.run(async () => {
    if (!name.trim()) throw new Error('Enter a team name.');
    const { error } = await supabase.from('teams').insert({ org_id: me.orgId, name: name.trim() });
    if (error) throw error;
    toast(`Team "${name.trim()}" created`);
    setName('');
    onClose();
    onDone();
  });
  return (
    <Dialog open={open} onClose={onClose} onSubmit={save} title="New team" description="For example a batch, a role or a client."
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy || !name.trim()}>Create team</button></>}>
      <Field label="Team name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Backend, November batch" autoFocus /></Field>
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Dialog>
  );
};

const InviteStaffDialog: React.FC<{ open: boolean; onClose: () => void; teams: Team[]; onDone: () => void }> = ({ open, onClose, teams, onDone }) => {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('manager');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();

  const close = () => { setLink(null); setEmail(''); setDisplayName(''); setTeamIds([]); onClose(); };
  const invite = () => void action.run(async () => {
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
    onDone();
  });

  return (
    <Dialog open={open} onClose={close} onSubmit={link ? close : invite} title="Invite staff" description="They get a one-time link to choose a password and sign in."
      footer={link
        ? <><button type="button" className="btn" onClick={() => void copyText(link).then(setCopied)}><Copy size={14} /> {copied ? 'Copied' : 'Copy link'}</button><button type="submit" className="btn btn-cta">Done</button></>
        : <><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy || !email.trim()}><UserPlus size={14} /> Create invitation</button></>}>
      {link ? (
        <>
          <Alert kind="ok">Invitation ready for {email}. Send them this link privately; it works once.</Alert>
          <input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invitation link" style={{ fontSize: 12 }} />
        </>
      ) : (
        <>
          <div className="form-grid">
            <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
            <Field label="Name"><input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} placeholder="Shown to your team" /></Field>
            <Field label="Role" hint={ROLE_HELP[role]} full>
              <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {(['manager', 'recruiter', 'coach', 'admin'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </Field>
          </div>
          {role !== 'admin' && (
            <div className="field"><span className="field-label">Teams</span>
              {teams.length === 0 ? <span className="faint">Create a team first.</span> : (
                <div className="row" style={{ gap: 14 }}>{teams.map((t) => (
                  <label key={t.id} className="check"><input type="checkbox" checked={teamIds.includes(t.id)}
                    onChange={(e) => setTeamIds((ids) => (e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id)))} />{t.name}</label>
                ))}</div>
              )}
            </div>
          )}
        </>
      )}
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Dialog>
  );
};
