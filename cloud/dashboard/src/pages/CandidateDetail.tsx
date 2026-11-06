import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import type { CandidateRow, Me, Route } from '../lib/types';
import { dateTime, minutesLabel, money, relative, repeatedSlots, slotLabel } from '../lib/format';
import { Badge, Empty, Notice, copyText, useAction } from '../components/ui';
import { StatusBadge } from './Candidates';

interface Ledger { id: string; seconds: number; reason: string; note: string | null; created_at: string }
interface Invite { id: string; created_at: string; expires_at: string; redeemed_at: string | null }
interface SlotRow { id: string; starts_at: string; ends_at: string }
interface Assignment { id: string; title: string; kind: string; role_title: string | null; company: string | null; topics: string[]; due_at: string | null; max_attempts: number | null; time_limit_minutes: number | null }
interface Device { id: string; name: string | null; platform: string | null; app_version: string | null; last_seen_at: string | null; revoked_at: string | null; created_at: string }
interface SessionRow { id: string; started_at: string; ended_at: string | null; end_reason: string | null; charged_seconds: number; assignment_id: string | null }
interface Usage { session_id: string | null; cost_usd: number | null }
interface Comment { id: string; session_id: string; body: string; created_at: string }

interface Data {
  c: CandidateRow; ledger: Ledger[]; invites: Invite[]; slots: SlotRow[]; assignments: Assignment[];
  devices: Device[]; sessions: SessionRow[]; usage: Usage[]; comments: Comment[];
}

const PLATFORM: Record<string, string> = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' };
const END_REASON: Record<string, string> = { user: 'Stopped', time_up: 'Time up', stale: 'Connection lost', revoked: 'Signed out', replaced: 'Replaced' };

export const CandidateDetail: React.FC<{ me: Me; id: string; go: (r: Route) => void }> = ({ me, id, go }) => {
  const [data, setData] = useState<Data | null>(null);
  const load = useAction();
  const canManage = me.role !== 'coach';

  const refresh = useCallback(() => load.run(async () => {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const q = await Promise.all([
      supabase.from('candidate_overview').select('*').eq('id', id).maybeSingle(),
      supabase.from('time_ledger').select('id, seconds, reason, note, created_at').eq('candidate_id', id).neq('reason', 'usage').order('created_at', { ascending: false }).limit(20),
      supabase.from('invites').select('id, created_at, expires_at, redeemed_at').eq('candidate_id', id).order('created_at', { ascending: false }).limit(10),
      supabase.from('slots').select('id, starts_at, ends_at').eq('candidate_id', id).gte('ends_at', since).order('starts_at').limit(60),
      supabase.from('assignments').select('id, title, kind, role_title, company, topics, due_at, max_attempts, time_limit_minutes').eq('candidate_id', id).order('created_at', { ascending: false }),
      supabase.from('devices').select('id, name, platform, app_version, last_seen_at, revoked_at, created_at').eq('candidate_id', id).order('created_at', { ascending: false }),
      supabase.from('sessions').select('id, started_at, ended_at, end_reason, charged_seconds, assignment_id').eq('candidate_id', id).order('started_at', { ascending: false }).limit(25),
      supabase.from('usage_events').select('session_id, cost_usd').eq('candidate_id', id).limit(5000),
      supabase.from('session_comments').select('id, session_id, body, created_at').order('created_at').limit(500),
    ]);
    const failed = q.find((r) => r.error);
    if (failed?.error) throw failed.error;
    if (!q[0].data) throw new Error('This candidate does not exist or is not in your teams.');
    const sessionIds = new Set((q[6].data as SessionRow[]).map((s) => s.id));
    setData({
      c: q[0].data as CandidateRow, ledger: q[1].data as Ledger[], invites: q[2].data as Invite[], slots: q[3].data as SlotRow[],
      assignments: q[4].data as Assignment[], devices: q[5].data as Device[], sessions: q[6].data as SessionRow[],
      usage: q[7].data as Usage[], comments: (q[8].data as Comment[]).filter((c) => sessionIds.has(c.session_id)),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [id]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!data) {
    return <>{load.error ? <Notice kind="error">{load.error}</Notice> : <Empty>Loading…</Empty>}
      <p><a href="#/candidates">Back to candidates</a></p></>;
  }
  const { c } = data;
  const archived = c.status === 'archived';

  return (
    <>
      <p style={{ margin: '0 0 8px' }}><a href="#/candidates">← Candidates</a></p>
      <div className="page-head">
        <div>
          <h1>{c.name}</h1>
          <div className="row muted">{c.team_name}{c.email && <> · {c.email}</>} · <StatusBadge row={c} /></div>
        </div>
        {canManage && !archived && <ArchiveButton id={c.id} name={c.name} onDone={() => go({ page: 'candidates' })} />}
      </div>
      {load.error && <Notice kind="error">{load.error}</Notice>}

      <div className="stats">
        <div className="stat"><div className="label">Minutes left</div><div className="value">{minutesLabel(c.balance_seconds)}</div></div>
        <div className="stat"><div className="label">Used, last 7 days</div><div className="value">{minutesLabel(c.used_seconds_7d)}</div></div>
        <div className="stat"><div className="label">{c.current_slot ? 'Slot open until' : 'Next slot'}</div><div className="value" style={{ fontSize: 15 }}>{c.current_slot ? new Date(c.current_slot.ends_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : slotLabel(c.next_slot)}</div></div>
        <div className="stat"><div className="label">AI cost, all time</div><div className="value">{money(data.usage.reduce((s, u) => s + Number(u.cost_usd ?? 0), 0))}</div></div>
      </div>

      <div className="grid grid-2">
        {canManage && !archived && <MinutesCard id={c.id} ledger={data.ledger} onChange={refresh} />}
        {canManage && !archived && <InviteCard id={c.id} invites={data.invites} onChange={refresh} />}
        <SlotsCard id={c.id} slots={data.slots} canManage={canManage && !archived} onChange={refresh} />
        <DevicesCard devices={data.devices} canManage={canManage} onChange={refresh} />
      </div>
      <div className="stack" style={{ marginTop: 16, gap: 16 }}>
        <AssignmentsCard id={c.id} assignments={data.assignments} sessions={data.sessions} canManage={canManage && !archived} onChange={refresh} />
        <SessionsCard me={me} data={data} onChange={refresh} />
      </div>
    </>
  );
};

const MinutesCard: React.FC<{ id: string; ledger: Ledger[]; onChange: () => void }> = ({ id, ledger, onChange }) => {
  const [minutes, setMinutes] = useState('30');
  const [note, setNote] = useState('');
  const action = useAction();
  const grant = (sign: 1 | -1) => void action.run(async () => {
    const m = Number.parseInt(minutes, 10);
    if (!(m > 0)) throw new Error('Enter a number of minutes.');
    const { error } = await supabase.rpc('pp_grant_minutes', { p_candidate: id, p_minutes: sign * m, p_note: note.trim() || null });
    if (error) throw error;
    setNote('');
    onChange();
  });
  return (
    <div className="card stack">
      <h2>Minutes</h2>
      <div className="row">
        <input className="input" style={{ width: 90 }} type="number" min={1} max={100000} value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Minutes" />
        <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        <button className="btn primary" disabled={action.busy} onClick={() => grant(1)}>Give</button>
        <button className="btn" disabled={action.busy} onClick={() => grant(-1)}>Take back</button>
      </div>
      {action.error && <Notice kind="error">{action.error}</Notice>}
      {ledger.length === 0 ? <span className="faint">No minutes given yet.</span> : (
        <table className="table"><tbody>
          {ledger.map((l) => (
            <tr key={l.id}><td className="num" style={{ width: 90 }}>{l.seconds > 0 ? '+' : '−'}{minutesLabel(Math.abs(l.seconds))}</td>
              <td className="muted">{l.note ?? (l.seconds > 0 ? 'Given' : 'Taken back')}</td><td className="faint">{dateTime(l.created_at)}</td></tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
};

const InviteCard: React.FC<{ id: string; invites: Invite[]; onChange: () => void }> = ({ id, invites, onChange }) => {
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const create = () => void action.run(async () => {
    const { data, error } = await supabase.rpc('pp_create_invite', { p_candidate: id, p_ttl_days: 7 });
    if (error) throw error;
    setCode(data as string);
    setCopied(false);
    onChange();
  });
  const now = Date.now();
  return (
    <div className="card stack">
      <h2>Invite code</h2>
      <p className="muted" style={{ margin: 0 }}>The candidate enters it in PrepPilot under Settings › Account. Each code works once, for 7 days.</p>
      {code && (
        <div className="stack">
          <div className="code-box">{code}</div>
          <div className="row">
            <button className="btn" onClick={() => void copyText(code).then(setCopied)}>{copied ? 'Copied' : 'Copy code'}</button>
            <span className="faint">Shown only now. Send it to the candidate privately.</span>
          </div>
        </div>
      )}
      {action.error && <Notice kind="error">{action.error}</Notice>}
      <div><button className="btn primary" onClick={create} disabled={action.busy}>{code ? 'Create another code' : 'Create invite code'}</button></div>
      {invites.length > 0 && (
        <table className="table"><tbody>
          {invites.map((i) => (
            <tr key={i.id}><td className="faint">Created {dateTime(i.created_at)}</td>
              <td>{i.redeemed_at ? <Badge tone="good">Used {relative(i.redeemed_at)}</Badge> : new Date(i.expires_at).getTime() < now ? <Badge>Expired</Badge> : <Badge tone="accent">Unused, expires {dateTime(i.expires_at)}</Badge>}</td></tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
};

function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const SlotsCard: React.FC<{ id: string; slots: SlotRow[]; canManage: boolean; onChange: () => void }> = ({ id, slots, canManage, onChange }) => {
  const nextHour = new Date(Math.ceil(Date.now() / 3600_000) * 3600_000);
  const [start, setStart] = useState(localInputValue(nextHour));
  const [duration, setDuration] = useState('60');
  const [days, setDays] = useState('1');
  const [skipWeekends, setSkipWeekends] = useState(true);
  const action = useAction();
  const add = () => void action.run(async () => {
    const first = new Date(start);
    const mins = Number.parseInt(duration, 10);
    const count = Math.min(60, Math.max(1, Number.parseInt(days, 10) || 1));
    if (Number.isNaN(first.getTime())) throw new Error('Choose a start date and time.');
    if (!(mins >= 5 && mins <= 1440)) throw new Error('A slot lasts between 5 minutes and 24 hours.');
    const rows = repeatedSlots(first, mins, count, skipWeekends).map((s) => ({ ...s, candidate_id: id }));
    const { error } = await supabase.from('slots').insert(rows);
    if (error) throw error;
    onChange();
  });
  const remove = (slotId: string) => void action.run(async () => {
    const { error } = await supabase.from('slots').delete().eq('id', slotId);
    if (error) throw error;
    onChange();
  });
  const now = Date.now();
  const upcoming = slots.filter((s) => new Date(s.ends_at).getTime() > now);
  return (
    <div className="card stack">
      <h2>Slots</h2>
      <p className="muted" style={{ margin: 0 }}>PrepPilot only works for the candidate inside a slot, while they have minutes left.</p>
      {canManage && (
        <>
          <div className="form-grid">
            <label className="field">Starts<input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label className="field">Length (minutes)<input className="input" type="number" min={5} max={1440} value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
            <label className="field">Days in a row<input className="input" type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="row faint"><input type="checkbox" checked={skipWeekends} onChange={(e) => setSkipWeekends(e.target.checked)} /> Skip weekends</label>
            <span className="spacer" />
            <button className="btn primary" onClick={add} disabled={action.busy}>Add slots</button>
          </div>
        </>
      )}
      {action.error && <Notice kind="error">{action.error}</Notice>}
      {upcoming.length === 0 ? <span className="faint">No upcoming slots.</span> : (
        <table className="table"><tbody>
          {upcoming.map((s) => {
            const open = new Date(s.starts_at).getTime() <= now;
            return (
              <tr key={s.id}><td>{slotLabel(s)} {open && <Badge tone="good">Open now</Badge>}</td>
                <td className="num">{canManage && <button className="btn small danger" onClick={() => remove(s.id)} disabled={action.busy}>Remove</button>}</td></tr>
            );
          })}
        </tbody></table>
      )}
    </div>
  );
};

const DevicesCard: React.FC<{ devices: Device[]; canManage: boolean; onChange: () => void }> = ({ devices, canManage, onChange }) => {
  const action = useAction();
  const revoke = (d: Device) => {
    if (!window.confirm(`Sign out ${d.name ?? 'this computer'}? The candidate will need a new invite code to sign in on it again.`)) return;
    void action.run(async () => {
      const { error } = await supabase.rpc('pp_revoke_device', { p_device: d.id });
      if (error) throw error;
      onChange();
    });
  };
  return (
    <div className="card stack">
      <h2>Computers</h2>
      {action.error && <Notice kind="error">{action.error}</Notice>}
      {devices.length === 0 ? <span className="faint">Not signed in on any computer yet.</span> : (
        <table className="table"><tbody>
          {devices.map((d) => (
            <tr key={d.id}>
              <td><strong>{d.name ?? 'Computer'}</strong><div className="faint">{PLATFORM[d.platform ?? ''] ?? d.platform ?? ''}{d.app_version && ` · PrepPilot ${d.app_version}`}</div></td>
              <td className="muted">{d.revoked_at ? <Badge>Signed out</Badge> : `Seen ${relative(d.last_seen_at)}`}</td>
              <td className="num">{canManage && !d.revoked_at && <button className="btn small danger" onClick={() => revoke(d)} disabled={action.busy}>Sign out</button>}</td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
};

const AssignmentsCard: React.FC<{ id: string; assignments: Assignment[]; sessions: SessionRow[]; canManage: boolean; onChange: () => void }> = ({ id, assignments, sessions, canManage, onChange }) => {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', role_title: '', company: '', topics: '', due_at: '', max_attempts: '', time_limit_minutes: '', job_description: '' });
  const action = useAction();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const int = (v: string) => (v.trim() ? Number.parseInt(v, 10) : null);
      const { error } = await supabase.from('assignments').insert({
        candidate_id: id, title: form.title.trim(), kind: 'mock_interview',
        role_title: form.role_title.trim() || null, company: form.company.trim() || null,
        topics: form.topics.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20),
        due_at: form.due_at ? new Date(form.due_at).toISOString() : null,
        max_attempts: int(form.max_attempts), time_limit_minutes: int(form.time_limit_minutes),
        job_description: form.job_description.trim() || null,
      });
      if (error) throw error;
      setForm({ title: '', role_title: '', company: '', topics: '', due_at: '', max_attempts: '', time_limit_minutes: '', job_description: '' });
      setOpen(false);
      onChange();
    });
  };
  const remove = (a: Assignment) => {
    if (!window.confirm(`Delete the assignment "${a.title}"?`)) return;
    void action.run(async () => {
      const { error } = await supabase.from('assignments').delete().eq('id', a.id);
      if (error) throw error;
      onChange();
    });
  };
  return (
    <div className="card stack">
      <div className="row"><h2 style={{ margin: 0 }}>Assignments</h2><span className="spacer" />
        {canManage && <button className="btn" onClick={() => setOpen((v) => !v)}>{open ? 'Close' : 'New assignment'}</button>}</div>
      {open && (
        <form className="stack" onSubmit={save}>
          <div className="form-grid">
            <label className="field">Title<input className="input" value={form.title} onChange={set('title')} placeholder="Mock interview: backend" required maxLength={300} /></label>
            <label className="field">Role<input className="input" value={form.role_title} onChange={set('role_title')} placeholder="Backend developer" /></label>
            <label className="field">Company<input className="input" value={form.company} onChange={set('company')} /></label>
            <label className="field">Topics (comma-separated)<input className="input" value={form.topics} onChange={set('topics')} placeholder="SQL, REST, system design" /></label>
            <label className="field">Due<input className="input" type="datetime-local" value={form.due_at} onChange={set('due_at')} /></label>
            <label className="field">Attempts allowed<input className="input" type="number" min={1} value={form.max_attempts} onChange={set('max_attempts')} placeholder="Unlimited" /></label>
            <label className="field">Time limit (minutes)<input className="input" type="number" min={1} value={form.time_limit_minutes} onChange={set('time_limit_minutes')} placeholder="None" /></label>
          </div>
          <label className="field">Job description (optional)<textarea className="input" value={form.job_description} onChange={set('job_description')} maxLength={20000} /></label>
          <div><button className="btn primary" type="submit" disabled={action.busy || !form.title.trim()}>Save assignment</button></div>
        </form>
      )}
      {action.error && <Notice kind="error">{action.error}</Notice>}
      {assignments.length === 0 ? <span className="faint">No assignments.</span> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Title</th><th>Topics</th><th>Due</th><th className="num">Attempts</th><th /></tr></thead>
          <tbody>
            {assignments.map((a) => {
              const used = sessions.filter((s) => s.assignment_id === a.id).length;
              const overdue = a.due_at && new Date(a.due_at).getTime() < Date.now() && used === 0;
              return (
                <tr key={a.id}>
                  <td><strong>{a.title}</strong><div className="faint">{[a.role_title, a.company].filter(Boolean).join(' · ')}{a.time_limit_minutes ? ` · ${a.time_limit_minutes} min limit` : ''}</div></td>
                  <td className="muted">{a.topics.join(', ') || '—'}</td>
                  <td>{a.due_at ? (overdue ? <Badge tone="bad">Overdue</Badge> : dateTime(a.due_at)) : '—'}</td>
                  <td className="num">{used}{a.max_attempts ? ` / ${a.max_attempts}` : ''}</td>
                  <td className="num">{canManage && <button className="btn small danger" onClick={() => remove(a)} disabled={action.busy}>Delete</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </div>
  );
};

const SessionsCard: React.FC<{ me: Me; data: Data; onChange: () => void }> = ({ me, data, onChange }) => {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const action = useAction();
  const costBySession = new Map<string, number>();
  for (const u of data.usage) if (u.session_id) costBySession.set(u.session_id, (costBySession.get(u.session_id) ?? 0) + Number(u.cost_usd ?? 0));
  const comment = (sessionId: string) => void action.run(async () => {
    const body = (drafts[sessionId] ?? '').trim();
    if (!body) return;
    const { error } = await supabase.from('session_comments').insert({ session_id: sessionId, author_id: me.userId, body });
    if (error) throw error;
    setDrafts((d) => ({ ...d, [sessionId]: '' }));
    onChange();
  });
  const assignmentTitle = new Map(data.assignments.map((a) => [a.id, a.title]));
  return (
    <div className="card stack">
      <h2>Sessions</h2>
      {action.error && <Notice kind="error">{action.error}</Notice>}
      {data.sessions.length === 0 ? <span className="faint">No sessions yet.</span> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Started</th><th>For</th><th className="num">Time charged</th><th className="num">AI cost</th><th>Ended</th><th>Coach notes</th></tr></thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.id}>
                <td>{dateTime(s.started_at)}</td>
                <td className="muted">{s.assignment_id ? assignmentTitle.get(s.assignment_id) ?? 'Assignment' : 'Free practice'}</td>
                <td className="num">{minutesLabel(s.charged_seconds)}</td>
                <td className="num">{money(costBySession.get(s.id) ?? 0)}</td>
                <td>{s.ended_at ? END_REASON[s.end_reason ?? ''] ?? 'Ended' : <Badge tone="good" dot>Live</Badge>}</td>
                <td style={{ minWidth: 220 }}>
                  <div className="stack" style={{ gap: 6 }}>
                    {data.comments.filter((c) => c.session_id === s.id).map((c) => <div key={c.id} className="muted">“{c.body}” <span className="faint">{relative(c.created_at)}</span></div>)}
                    <div className="row">
                      <input className="input" style={{ flex: 1, padding: '5px 8px' }} placeholder="Add a note" value={drafts[s.id] ?? ''} maxLength={4000}
                        onChange={(e) => setDrafts((d) => ({ ...d, [s.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') comment(s.id); }} aria-label="Coach note" />
                      <button className="btn small" onClick={() => comment(s.id)} disabled={action.busy || !(drafts[s.id] ?? '').trim()}>Add</button>
                    </div>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
};

const ArchiveButton: React.FC<{ id: string; name: string; onDone: () => void }> = ({ id, name, onDone }) => {
  const action = useAction();
  const archive = () => {
    if (!window.confirm(`Archive ${name}? Their computers are signed out and they can no longer use PrepPilot. Their history is kept.`)) return;
    void action.run(async () => {
      const { error } = await supabase.rpc('pp_archive_candidate', { p_candidate: id });
      if (error) throw error;
      onDone();
    });
  };
  return <div className="stack" style={{ alignItems: 'flex-end' }}>
    <button className="btn danger" onClick={archive} disabled={action.busy}>Archive</button>
    {action.error && <Notice kind="error">{action.error}</Notice>}
  </div>;
};
