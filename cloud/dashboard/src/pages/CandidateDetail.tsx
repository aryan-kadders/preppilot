import React, { useCallback, useEffect, useState } from 'react';
import { Archive, CalendarClock, CalendarPlus, ClipboardList, Copy, DollarSign, KeyRound, Laptop, MessageSquare, Plus, Timer, TrendingUp, Trash2 } from 'lucide-react';
import { supabase } from '../supabase';
import type { CandidateRow, Me, Route } from '../lib/types';
import { dateTime, minutesLabel, money, relative, repeatedSlots, slotLabel } from '../lib/format';
import { Alert, Avatar, Badge, Card, Dialog, EmptyState, Field, Kpi, SkeletonRows, copyText, useAction, useToast } from '../components/ui';
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

type Tab = 'overview' | 'schedule' | 'assignments' | 'sessions' | 'computers';

const PLATFORM: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const END_REASON: Record<string, string> = { user: 'Stopped', time_up: 'Time up', stale: 'Connection lost', revoked: 'Signed out', replaced: 'Replaced' };

export const CandidateDetail: React.FC<{ me: Me; id: string; go: (r: Route) => void; onName: (name: string | null) => void }> = ({ me, id, go, onName }) => {
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [dialog, setDialog] = useState<null | 'minutes' | 'invite' | 'slots' | 'assignment'>(null);
  const load = useAction();
  const { run } = load;
  const canManage = me.role !== 'coach';

  const refresh = useCallback(() => run(async () => {
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
  }), [id, run]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { onName(data?.c.name ?? null); }, [data, onName]);

  if (!data) {
    return load.error ? <Alert kind="error">{load.error}</Alert> : <section className="card"><SkeletonRows /></section>;
  }
  const { c } = data;
  const archived = c.status === 'archived';
  const manage = canManage && !archived;
  const now = Date.now();
  const upcomingSlots = data.slots.filter((s) => new Date(s.ends_at).getTime() > now);
  const totalCost = data.usage.reduce((s, u) => s + Number(u.cost_usd ?? 0), 0);
  const activeDevices = data.devices.filter((d) => !d.revoked_at).length;

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'schedule', label: 'Schedule', count: upcomingSlots.length },
    { id: 'assignments', label: 'Assignments', count: data.assignments.length },
    { id: 'sessions', label: 'Sessions', count: data.sessions.length },
    { id: 'computers', label: 'Computers', count: activeDevices },
  ];

  return (
    <>
      <div className="page-head" style={{ alignItems: 'center' }}>
        <div className="row" style={{ gap: 14, flexWrap: 'nowrap', minWidth: 0 }}>
          <Avatar name={c.name} large />
          <div style={{ minWidth: 0 }}>
            <h1 className="page-title">{c.name}</h1>
            <div className="row muted" style={{ fontSize: 13, marginTop: 2 }}>{c.team_name}{c.email && <><span className="faint">·</span>{c.email}</>}<StatusBadge row={c} /></div>
          </div>
        </div>
        {manage && (
          <div className="row">
            <button className="btn" onClick={() => setDialog('invite')}><KeyRound size={15} /> Invite code</button>
            <button className="btn btn-cta" onClick={() => setDialog('minutes')}><Plus size={15} /> Give minutes</button>
          </div>
        )}
      </div>
      {load.error && <div style={{ marginBottom: 16 }}><Alert kind="error">{load.error}</Alert></div>}

      <div className="stats">
        <Kpi icon={<Timer size={14} />} label="Minutes left" value={minutesLabel(c.balance_seconds)} hint={c.balance_seconds <= 0 ? 'Give minutes to let them practise' : undefined} />
        <Kpi icon={<TrendingUp size={14} />} label="Practised, last 7 days" value={minutesLabel(c.used_seconds_7d)} hint={`Last session ${relative(c.last_session_at)}`} />
        <Kpi icon={<CalendarClock size={14} />} label={c.current_slot ? 'Slot open until' : 'Next slot'}
          value={<span style={{ fontSize: 16 }}>{c.current_slot ? new Date(c.current_slot.ends_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : c.next_slot ? slotLabel(c.next_slot) : 'None booked'}</span>} />
        <Kpi icon={<DollarSign size={14} />} label="AI cost, all time" value={money(totalCost)} hint="Estimate" />
      </div>

      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}{t.count !== undefined && t.count > 0 && <span className="count">{t.count}</span>}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid-2">
          <Card title="Minutes" description="Given and taken back" actions={manage && <button className="btn" onClick={() => setDialog('minutes')}><Plus size={14} /> Give</button>} flush>
            {data.ledger.length === 0 ? <EmptyState icon={<Timer size={18} />} title="No minutes given yet" /> : (
              <div className="rows">{data.ledger.map((l) => (
                <div key={l.id} className="srow">
                  <span className={`badge ${l.seconds > 0 ? 'good' : 'danger'}`}>{l.seconds > 0 ? '+' : '−'}{minutesLabel(Math.abs(l.seconds))}</span>
                  <span className="muted" style={{ flex: 1 }}>{l.note ?? (l.seconds > 0 ? 'Given' : 'Taken back')}</span>
                  <span className="faint">{dateTime(l.created_at)}</span>
                </div>
              ))}</div>
            )}
          </Card>
          <Card title="Invite codes" description="Each code signs in one computer, once, within 7 days" actions={manage && <button className="btn" onClick={() => setDialog('invite')}><Plus size={14} /> New code</button>} flush>
            {data.invites.length === 0 ? <EmptyState icon={<KeyRound size={18} />} title="No invite codes yet" description="Create one and send it to the candidate." /> : (
              <div className="rows">{data.invites.map((i) => (
                <div key={i.id} className="srow">
                  <span style={{ flex: 1 }} className="muted">Created {dateTime(i.created_at)}</span>
                  {i.redeemed_at ? <Badge tone="good">Used {relative(i.redeemed_at)}</Badge> : new Date(i.expires_at).getTime() < now ? <Badge>Expired</Badge> : <Badge tone="accent">Waiting · expires {dateTime(i.expires_at)}</Badge>}
                </div>
              ))}</div>
            )}
          </Card>
        </div>
      )}

      {tab === 'schedule' && <ScheduleTab slots={upcomingSlots} manage={manage} onAdd={() => setDialog('slots')} onChange={refresh} />}
      {tab === 'assignments' && <AssignmentsTab assignments={data.assignments} sessions={data.sessions} manage={manage} onAdd={() => setDialog('assignment')} onChange={refresh} />}
      {tab === 'sessions' && <SessionsTab me={me} data={data} onChange={refresh} />}
      {tab === 'computers' && <ComputersTab devices={data.devices} manage={canManage} onInvite={() => setDialog('invite')} onChange={refresh} />}

      {manage && (
        <div style={{ marginTop: 28, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <ArchiveButton id={c.id} name={c.name} onDone={() => go({ page: 'candidates' })} />
        </div>
      )}

      <MinutesDialog open={dialog === 'minutes'} onClose={() => setDialog(null)} id={c.id} name={c.name} onDone={refresh} />
      <InviteDialog open={dialog === 'invite'} onClose={() => setDialog(null)} id={c.id} name={c.name} onDone={refresh} />
      <SlotsDialog open={dialog === 'slots'} onClose={() => setDialog(null)} id={c.id} onDone={refresh} />
      <AssignmentDialog open={dialog === 'assignment'} onClose={() => setDialog(null)} id={c.id} onDone={refresh} />
    </>
  );
};

// ── Tabs ────────────────────────────────────────────────────

const ScheduleTab: React.FC<{ slots: SlotRow[]; manage: boolean; onAdd: () => void; onChange: () => void }> = ({ slots, manage, onAdd, onChange }) => {
  const action = useAction();
  const toast = useToast();
  const remove = (id: string) => void action.run(async () => {
    const { error } = await supabase.from('slots').delete().eq('id', id);
    if (error) throw error;
    toast('Slot removed');
    onChange();
  });
  const now = Date.now();
  return (
    <Card title="Upcoming slots" description="PrepPilot works for the candidate only inside a slot, while they have minutes left."
      actions={manage && <button className="btn btn-cta sm" onClick={onAdd}><CalendarPlus size={14} /> Book slots</button>} flush>
      {action.error && <div style={{ padding: 12 }}><Alert kind="error">{action.error}</Alert></div>}
      {slots.length === 0 ? (
        <EmptyState icon={<CalendarClock size={18} />} title="No upcoming slots" description="Book the times when this candidate may use PrepPilot."
          action={manage ? <button className="btn btn-cta" onClick={onAdd}><CalendarPlus size={15} /> Book slots</button> : undefined} />
      ) : (
        <div className="rows">{slots.map((s) => {
          const open = new Date(s.starts_at).getTime() <= now;
          const mins = Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60000);
          return (
            <div key={s.id} className="srow">
              <CalendarClock size={16} className="muted" />
              <span style={{ flex: 1 }}>{slotLabel(s)} <span className="faint">· {minutesLabel(mins * 60)}</span></span>
              {open && <Badge tone="good" dot pulse>Open now</Badge>}
              {manage && <button className="btn btn-ghost btn-icon" onClick={() => remove(s.id)} disabled={action.busy} aria-label="Remove slot" title="Remove slot"><Trash2 size={14} /></button>}
            </div>
          );
        })}</div>
      )}
    </Card>
  );
};

const AssignmentsTab: React.FC<{ assignments: Assignment[]; sessions: SessionRow[]; manage: boolean; onAdd: () => void; onChange: () => void }> = ({ assignments, sessions, manage, onAdd, onChange }) => {
  const action = useAction();
  const toast = useToast();
  const remove = (a: Assignment) => {
    if (!window.confirm(`Delete the assignment "${a.title}"?`)) return;
    void action.run(async () => {
      const { error } = await supabase.from('assignments').delete().eq('id', a.id);
      if (error) throw error;
      toast('Assignment deleted');
      onChange();
    });
  };
  return (
    <Card title="Assignments" description="Mock interviews the candidate should complete" actions={manage && <button className="btn btn-cta sm" onClick={onAdd}><Plus size={14} /> New assignment</button>} flush>
      {action.error && <div style={{ padding: 12 }}><Alert kind="error">{action.error}</Alert></div>}
      {assignments.length === 0 ? (
        <EmptyState icon={<ClipboardList size={18} />} title="No assignments" description="Set a mock interview with a role, topics, a due date and limits."
          action={manage ? <button className="btn btn-cta" onClick={onAdd}><Plus size={15} /> New assignment</button> : undefined} />
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Assignment</th><th>Topics</th><th>Due</th><th className="num">Attempts</th><th /></tr></thead>
          <tbody>{assignments.map((a) => {
            const used = sessions.filter((s) => s.assignment_id === a.id).length;
            const overdue = a.due_at && new Date(a.due_at).getTime() < Date.now() && used === 0;
            return (
              <tr key={a.id}>
                <td><div className="person-name">{a.title}</div><div className="person-sub">{[a.role_title, a.company, a.time_limit_minutes ? `${a.time_limit_minutes} min limit` : null].filter(Boolean).join(' · ') || 'Mock interview'}</div></td>
                <td className="muted">{a.topics.length ? a.topics.join(', ') : '—'}</td>
                <td>{a.due_at ? (overdue ? <Badge tone="danger">Overdue</Badge> : <span className="muted">{dateTime(a.due_at)}</span>) : <span className="faint">No due date</span>}</td>
                <td className="num">{used}{a.max_attempts ? <span className="faint"> / {a.max_attempts}</span> : ''}</td>
                <td className="num">{manage && <button className="btn btn-ghost btn-icon" onClick={() => remove(a)} disabled={action.busy} aria-label="Delete assignment"><Trash2 size={14} /></button>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </Card>
  );
};

const SessionsTab: React.FC<{ me: Me; data: Data; onChange: () => void }> = ({ me, data, onChange }) => {
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const action = useAction();
  const toast = useToast();
  const cost = new Map<string, number>();
  for (const u of data.usage) if (u.session_id) cost.set(u.session_id, (cost.get(u.session_id) ?? 0) + Number(u.cost_usd ?? 0));
  const titles = new Map(data.assignments.map((a) => [a.id, a.title]));
  const save = () => void action.run(async () => {
    if (!noteFor || !draft.trim()) return;
    const { error } = await supabase.from('session_comments').insert({ session_id: noteFor, author_id: me.userId, body: draft.trim() });
    if (error) throw error;
    toast('Note added');
    setDraft(''); setNoteFor(null);
    onChange();
  });
  return (
    <Card title="Sessions" description="Each meeting the candidate ran, with time charged and AI cost" flush>
      {data.sessions.length === 0 ? <EmptyState icon={<TrendingUp size={18} />} title="No sessions yet" description="Sessions appear here when the candidate starts PrepPilot inside a slot." /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Started</th><th>Practice</th><th className="num">Time</th><th className="num">AI cost</th><th>Result</th><th>Coach notes</th></tr></thead>
          <tbody>{data.sessions.map((s) => {
            const notes = data.comments.filter((c) => c.session_id === s.id);
            return (
              <tr key={s.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{dateTime(s.started_at)}</td>
                <td className="muted">{s.assignment_id ? titles.get(s.assignment_id) ?? 'Assignment' : 'Free practice'}</td>
                <td className="num">{minutesLabel(s.charged_seconds)}</td>
                <td className="num">{money(cost.get(s.id) ?? 0)}</td>
                <td>{s.ended_at ? <span className="muted">{END_REASON[s.end_reason ?? ''] ?? 'Ended'}</span> : <Badge tone="good" dot pulse>Live</Badge>}</td>
                <td style={{ minWidth: 220 }}>
                  {notes.map((n) => <div key={n.id} className="muted" style={{ fontSize: 13 }}>“{n.body}” <span className="faint">{relative(n.created_at)}</span></div>)}
                  <button className="btn btn-ghost" style={{ paddingLeft: 0 }} onClick={() => { setNoteFor(s.id); setDraft(''); }}><MessageSquare size={13} /> Add note</button>
                </td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      <Dialog open={noteFor !== null} onClose={() => setNoteFor(null)} onSubmit={save} title="Coach note" description="Visible to everyone who can see this candidate."
        footer={<><button type="button" className="btn" onClick={() => setNoteFor(null)}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy || !draft.trim()}>Save note</button></>}>
        <textarea className="input" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={4000} placeholder="Strong STAR structure; tighten the system design answer." autoFocus />
        {action.error && <Alert kind="error">{action.error}</Alert>}
      </Dialog>
    </Card>
  );
};

const ComputersTab: React.FC<{ devices: Device[]; manage: boolean; onInvite: () => void; onChange: () => void }> = ({ devices, manage, onInvite, onChange }) => {
  const action = useAction();
  const toast = useToast();
  const revoke = (d: Device) => {
    if (!window.confirm(`Sign out ${d.name ?? 'this computer'}? The candidate needs a new invite code to sign in on it again.`)) return;
    void action.run(async () => {
      const { error } = await supabase.rpc('pp_revoke_device', { p_device: d.id });
      if (error) throw error;
      toast('Computer signed out');
      onChange();
    });
  };
  return (
    <Card title="Computers" description="Where this candidate is signed in to PrepPilot" flush>
      {action.error && <div style={{ padding: 12 }}><Alert kind="error">{action.error}</Alert></div>}
      {devices.length === 0 ? (
        <EmptyState icon={<Laptop size={18} />} title="Not signed in anywhere" description="The candidate signs in by entering an invite code in PrepPilot › Settings › Account."
          action={manage ? <button className="btn btn-cta" onClick={onInvite}><KeyRound size={15} /> Create invite code</button> : undefined} />
      ) : (
        <div className="rows">{devices.map((d) => (
          <div key={d.id} className="srow">
            <Laptop size={18} className="muted" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="person-name">{d.name ?? 'Computer'}</div>
              <div className="faint">{PLATFORM[d.platform ?? ''] ?? d.platform ?? 'Unknown'}{d.app_version && ` · PrepPilot ${d.app_version}`} · signed in {dateTime(d.created_at)}</div>
            </div>
            {d.revoked_at ? <Badge>Signed out</Badge> : <span className="faint">Seen {relative(d.last_seen_at)}</span>}
            {manage && !d.revoked_at && <button className="btn btn-danger" onClick={() => revoke(d)} disabled={action.busy}>Sign out</button>}
          </div>
        ))}</div>
      )}
    </Card>
  );
};

// ── Dialogs ─────────────────────────────────────────────────

const MinutesDialog: React.FC<{ open: boolean; onClose: () => void; id: string; name: string; onDone: () => void }> = ({ open, onClose, id, name, onDone }) => {
  const [minutes, setMinutes] = useState('30');
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<'give' | 'take'>('give');
  const action = useAction();
  const toast = useToast();
  const save = () => void action.run(async () => {
    const m = Number.parseInt(minutes, 10);
    if (!(m > 0)) throw new Error('Enter a number of minutes.');
    const { error } = await supabase.rpc('pp_grant_minutes', { p_candidate: id, p_minutes: mode === 'give' ? m : -m, p_note: note.trim() || null });
    if (error) throw error;
    toast(mode === 'give' ? `${m} minutes given to ${name}` : `${m} minutes taken back`);
    setNote('');
    onClose();
    onDone();
  });
  return (
    <Dialog open={open} onClose={onClose} onSubmit={save} title={mode === 'give' ? 'Give minutes' : 'Take back minutes'} description={`Practice time for ${name}. It is counted only while a session runs.`}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy}>{mode === 'give' ? 'Give minutes' : 'Take back'}</button></>}>
      <div className="chips">
        {[15, 30, 60, 120].map((v) => <button key={v} type="button" className={`chip ${minutes === String(v) ? 'on' : ''}`} onClick={() => setMinutes(String(v))}>{v} min</button>)}
      </div>
      <div className="form-grid">
        <Field label="Minutes"><input className="input" type="number" min={1} max={100000} value={minutes} onChange={(e) => setMinutes(e.target.value)} autoFocus /></Field>
        <Field label="Action"><select className="input" value={mode} onChange={(e) => setMode(e.target.value as 'give' | 'take')}><option value="give">Give</option><option value="take">Take back</option></select></Field>
        <Field label="Note" hint="Optional, shown in the history." full><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Week 2 practice" /></Field>
      </div>
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Dialog>
  );
};

const InviteDialog: React.FC<{ open: boolean; onClose: () => void; id: string; name: string; onDone: () => void }> = ({ open, onClose, id, name, onDone }) => {
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const create = () => void action.run(async () => {
    const { data, error } = await supabase.rpc('pp_create_invite', { p_candidate: id, p_ttl_days: 7 });
    if (error) throw error;
    setCode(data as string);
    setCopied(false);
    onDone();
  });
  const close = () => { setCode(null); onClose(); };
  return (
    <Dialog open={open} onClose={close} onSubmit={code ? close : create} title="Invite code" description={`${name} enters it in PrepPilot under Settings › Account. It works once, within 7 days.`}
      footer={code
        ? <><button type="button" className="btn" onClick={() => void copyText(code).then(setCopied)}><Copy size={14} /> {copied ? 'Copied' : 'Copy code'}</button><button type="submit" className="btn btn-cta">Done</button></>
        : <><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy}><KeyRound size={14} /> Create code</button></>}>
      {code ? (
        <>
          <div className="code-box">{code}</div>
          <Alert kind="info">This code is shown only now. Send it to {name} privately.</Alert>
        </>
      ) : <p className="muted" style={{ margin: 0 }}>A new code does not cancel earlier ones; unused codes simply expire.</p>}
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Dialog>
  );
};

function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const SlotsDialog: React.FC<{ open: boolean; onClose: () => void; id: string; onDone: () => void }> = ({ open, onClose, id, onDone }) => {
  const [start, setStart] = useState(() => localInputValue(new Date(Math.ceil(Date.now() / 3600_000) * 3600_000)));
  const [duration, setDuration] = useState('60');
  const [days, setDays] = useState('1');
  const [skipWeekends, setSkipWeekends] = useState(true);
  const action = useAction();
  const toast = useToast();
  const count = Math.min(60, Math.max(1, Number.parseInt(days, 10) || 1));
  const save = () => void action.run(async () => {
    const first = new Date(start);
    const mins = Number.parseInt(duration, 10);
    if (Number.isNaN(first.getTime())) throw new Error('Choose a start date and time.');
    if (!(mins >= 5 && mins <= 1440)) throw new Error('A slot lasts between 5 minutes and 24 hours.');
    const rows = repeatedSlots(first, mins, count, skipWeekends).map((s) => ({ ...s, candidate_id: id }));
    const { error } = await supabase.from('slots').insert(rows);
    if (error) throw error;
    toast(rows.length === 1 ? 'Slot booked' : `${rows.length} slots booked`);
    onClose();
    onDone();
  });
  return (
    <Dialog open={open} onClose={onClose} onSubmit={save} title="Book slots" description="The times when this candidate may use PrepPilot."
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy}>{count === 1 ? 'Book slot' : `Book ${count} slots`}</button></>}>
      <div className="form-grid">
        <Field label="First slot starts" full><input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Length"><select className="input" value={duration} onChange={(e) => setDuration(e.target.value)}>
          {[30, 45, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{minutesLabel(m * 60)}</option>)}
        </select></Field>
        <Field label="Repeat for" hint="Consecutive days"><select className="input" value={days} onChange={(e) => setDays(e.target.value)}>
          {[1, 2, 3, 5, 10, 15, 20].map((d) => <option key={d} value={d}>{d === 1 ? 'Just this day' : `${d} days`}</option>)}
        </select></Field>
      </div>
      {count > 1 && <label className="check"><input type="checkbox" checked={skipWeekends} onChange={(e) => setSkipWeekends(e.target.checked)} /> Skip Saturdays and Sundays</label>}
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Dialog>
  );
};

const AssignmentDialog: React.FC<{ open: boolean; onClose: () => void; id: string; onDone: () => void }> = ({ open, onClose, id, onDone }) => {
  const blank = { title: '', role_title: '', company: '', topics: '', due_at: '', max_attempts: '', time_limit_minutes: '', job_description: '' };
  const [form, setForm] = useState(blank);
  const action = useAction();
  const toast = useToast();
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = () => void action.run(async () => {
    if (!form.title.trim()) throw new Error('Give the assignment a title.');
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
    toast('Assignment created');
    setForm(blank);
    onClose();
    onDone();
  });
  return (
    <Dialog open={open} onClose={onClose} onSubmit={save} wide title="New assignment" description="A mock interview for the candidate to complete in PrepPilot."
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy || !form.title.trim()}>Create assignment</button></>}>
      <div className="form-grid">
        <Field label="Title" full><input className="input" value={form.title} onChange={set('title')} placeholder="Mock interview: backend round" maxLength={300} autoFocus /></Field>
        <Field label="Role"><input className="input" value={form.role_title} onChange={set('role_title')} placeholder="Backend developer" /></Field>
        <Field label="Company"><input className="input" value={form.company} onChange={set('company')} placeholder="Optional" /></Field>
        <Field label="Topics" hint="Separate with commas." full><input className="input" value={form.topics} onChange={set('topics')} placeholder="SQL, REST APIs, system design" /></Field>
        <Field label="Due"><input className="input" type="datetime-local" value={form.due_at} onChange={set('due_at')} /></Field>
        <Field label="Attempts allowed"><input className="input" type="number" min={1} value={form.max_attempts} onChange={set('max_attempts')} placeholder="Unlimited" /></Field>
        <Field label="Time limit (minutes)"><input className="input" type="number" min={1} value={form.time_limit_minutes} onChange={set('time_limit_minutes')} placeholder="No limit" /></Field>
        <Field label="Job description" hint="Optional. Answers are tailored to it." full><textarea className="input" value={form.job_description} onChange={set('job_description')} maxLength={20000} /></Field>
      </div>
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Dialog>
  );
};

const ArchiveButton: React.FC<{ id: string; name: string; onDone: () => void }> = ({ id, name, onDone }) => {
  const action = useAction();
  const toast = useToast();
  const archive = () => {
    if (!window.confirm(`Archive ${name}? Their computers are signed out and they can no longer use PrepPilot. Their history is kept.`)) return;
    void action.run(async () => {
      const { error } = await supabase.rpc('pp_archive_candidate', { p_candidate: id });
      if (error) throw error;
      toast(`${name} archived`);
      onDone();
    });
  };
  return (
    <div className="row">
      <div style={{ flex: 1 }}><div className="person-name">Archive candidate</div><div className="faint">Signs out their computers and stops access. History is kept.</div></div>
      <button className="btn btn-danger" onClick={archive} disabled={action.busy}><Archive size={14} /> Archive</button>
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </div>
  );
};
