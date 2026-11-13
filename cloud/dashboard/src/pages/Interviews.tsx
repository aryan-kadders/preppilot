import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarCheck, CalendarPlus, CheckCircle2, Clock, Pencil, RefreshCw, Target, Trash2, Trophy } from 'lucide-react';
import { supabase } from '../supabase';
import { canJudgeReadiness, canRecruit, type InterviewRow, type Me, type Outcome, type Readiness, type Route, type Team } from '../lib/types';
import { dateTime, minutesLabel, relative } from '../lib/format';
import { Alert, Badge, Card, Dialog, EmptyState, Field, Kpi, SkeletonRows, useAction, useToast } from '../components/ui';

export const OUTCOME_LABEL: Record<Outcome, string> = {
  selected: 'Selected', rejected: 'Rejected', on_hold: 'On hold', cancelled: 'Cancelled', no_show: 'No show',
};

/** Recruiters add the client interviews; coaches say who is ready; everyone follows the practice. */
export const Interviews: React.FC<{ me: Me; go: (r: Route) => void }> = ({ me, go }) => {
  const [rows, setRows] = useState<InterviewRow[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [when, setWhen] = useState<'upcoming' | 'past' | 'all'>('upcoming');
  const [teamFilter, setTeamFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const load = useAction();
  const { run } = load;

  const refresh = useCallback(() => run(async () => {
    const [i, t] = await Promise.all([
      supabase.from('interview_overview').select('*').order('interview_at'),
      supabase.from('teams').select('id, name, org_id').order('name'),
    ]);
    if (i.error) throw i.error;
    if (t.error) throw t.error;
    setRows(i.data as InterviewRow[]);
    setTeams(t.data as Team[]);
  }), [run]);
  useEffect(() => { void refresh(); }, [refresh]);

  const now = Date.now();
  const isUpcoming = (r: InterviewRow) => new Date(r.interview_at).getTime() > now && !r.outcome;
  const visible = useMemo(() => (rows ?? []).filter((r) =>
    (when === 'all' || (when === 'upcoming' ? isUpcoming(r) : !isUpcoming(r)))
    && (!teamFilter || r.team_id === teamFilter)), [rows, when, teamFilter, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const ordered = when === 'upcoming' ? visible : [...visible].reverse();

  const all = rows ?? [];
  const upcoming = all.filter(isUpcoming);
  const thisWeek = upcoming.filter((r) => new Date(r.interview_at).getTime() < now + 7 * 86400_000).length;
  const notReady = upcoming.filter((r) => r.readiness !== 'ready').length;
  const decided = all.filter((r) => r.outcome === 'selected' || r.outcome === 'rejected');
  const selected = decided.filter((r) => r.outcome === 'selected').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Interviews</h1>
          <p className="page-desc">Client interviews candidates are preparing for. Each one gets a prep mock interview built from its job description.</p>
        </div>
        {canRecruit(me) && <button className="btn btn-cta" onClick={() => setAdding(true)}><CalendarPlus size={15} /> Add interview</button>}
      </div>

      <div className="stats">
        <Kpi icon={<CalendarCheck size={14} />} label="Upcoming" value={upcoming.length} hint={`${thisWeek} in the next 7 days`} />
        <Kpi icon={<Target size={14} />} label="Not marked ready" value={notReady} hint={notReady ? 'A coach has not cleared them yet' : upcoming.length ? 'Everyone is ready' : undefined} />
        <Kpi icon={<Clock size={14} />} label="Practised for upcoming" value={minutesLabel(upcoming.reduce((s, r) => s + r.practice_seconds, 0))} />
        <Kpi icon={<Trophy size={14} />} label="Selection rate" value={decided.length ? `${Math.round((100 * selected) / decided.length)}%` : '—'} hint={decided.length ? `${selected} of ${decided.length} decided` : 'No results yet'} />
      </div>

      <section className="card">
        <div className="toolbar">
          <div className="chips" role="tablist" aria-label="When">
            {(['upcoming', 'past', 'all'] as const).map((w) => (
              <button key={w} type="button" role="tab" aria-selected={when === w} className={`chip ${when === w ? 'on' : ''}`} onClick={() => setWhen(w)}>
                {w === 'upcoming' ? 'Upcoming' : w === 'past' ? 'Done' : 'All'}
              </button>
            ))}
          </div>
          <select className="input" style={{ width: 180 }} value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} aria-label="Team">
            <option value="">All teams</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <span className="spacer" />
          <button className="btn btn-ghost btn-icon" onClick={() => void refresh()} disabled={load.busy} aria-label="Refresh" title="Refresh"><RefreshCw size={15} /></button>
        </div>
        {load.error && <div style={{ padding: 12 }}><Alert kind="error">{load.error}</Alert></div>}
        {rows === null ? <SkeletonRows /> : ordered.length === 0 ? (
          <EmptyState icon={<CalendarCheck size={20} />} title={when === 'upcoming' ? 'No upcoming interviews' : 'Nothing here'}
            description={canRecruit(me) ? 'Add a client interview: the candidate gets a prep mock interview built from the job description.' : 'Recruiters add the client interviews candidates prepare for.'}
            action={canRecruit(me) ? <button className="btn btn-cta" onClick={() => setAdding(true)}><CalendarPlus size={15} /> Add interview</button> : undefined} />
        ) : <InterviewTable me={me} rows={ordered} onChange={refresh} onOpenCandidate={(id) => go({ page: 'candidate', id })} />}
      </section>

      <InterviewDialog open={adding} onClose={() => setAdding(false)} onDone={refresh} />
    </>
  );
};

/** The interviews table, also used on a candidate's page (without the candidate column). */
export const InterviewTable: React.FC<{ me: Me; rows: InterviewRow[]; onChange: () => void; onOpenCandidate?: (id: string) => void }> = ({ me, rows, onChange, onOpenCandidate }) => {
  const [editing, setEditing] = useState<InterviewRow | null>(null);
  const [judging, setJudging] = useState<InterviewRow | null>(null);
  const [closing, setClosing] = useState<InterviewRow | null>(null);
  const action = useAction();
  const toast = useToast();
  const remove = (r: InterviewRow) => {
    if (!window.confirm(`Delete the ${r.company} interview for ${r.candidate_name}? Its prep assignment is removed too unless it was practised.`)) return;
    void action.run(async () => {
      const { error } = await supabase.rpc('pp_delete_interview', { p_interview: r.id });
      if (error) throw error;
      toast('Interview deleted');
      onChange();
    });
  };
  const now = Date.now();
  return (
    <>
      {action.error && <div style={{ padding: 12 }}><Alert kind="error">{action.error}</Alert></div>}
      <div className="table-wrap"><table className="table">
        <thead><tr>{onOpenCandidate && <th>Candidate</th>}<th>Interview</th><th>When</th><th>Practice</th><th>Ready?</th><th>Result</th><th /></tr></thead>
        <tbody>{rows.map((r) => {
          const ts = new Date(r.interview_at).getTime();
          const soon = ts > now && ts - now < 2 * 86400_000;
          return (
            <tr key={r.id}>
              {onOpenCandidate && (
                <td><button className="link" onClick={() => onOpenCandidate(r.candidate_id)}>{r.candidate_name}</button><div className="person-sub">{r.team_name}</div></td>
              )}
              <td><div className="person-name">{r.role_title}</div><div className="person-sub">{[r.company, r.round].filter(Boolean).join(' · ')}</div></td>
              <td style={{ whiteSpace: 'nowrap' }}>{soon && !r.outcome ? <Badge tone="warn">{dateTime(r.interview_at)}</Badge> : <span className="muted">{dateTime(r.interview_at)}</span>}</td>
              <td className="muted">
                {r.practice_sessions === 0
                  ? <span className="faint">{r.balance_seconds <= 0 ? 'No practice · no minutes left' : 'No practice yet'}</span>
                  : <>{r.practice_sessions} {r.practice_sessions === 1 ? 'session' : 'sessions'} · {minutesLabel(r.practice_seconds)}<div className="person-sub">last {relative(r.last_practice_at)}</div></>}
              </td>
              <td>
                {r.readiness === 'ready' ? <Badge tone="good"><CheckCircle2 size={12} /> Ready</Badge>
                  : r.readiness === 'needs_work' ? <Badge tone="warn">Needs work</Badge> : <span className="faint">Not reviewed</span>}
                {r.readiness_note && <div className="person-sub" title={r.readiness_note}>“{r.readiness_note.length > 60 ? `${r.readiness_note.slice(0, 60)}…` : r.readiness_note}”</div>}
                {canJudgeReadiness(me) && !r.outcome && <button className="btn btn-ghost" style={{ paddingLeft: 0 }} onClick={() => setJudging(r)}>{r.readiness ? 'Change' : 'Review'}</button>}
              </td>
              <td>
                {r.outcome ? <Badge tone={r.outcome === 'selected' ? 'good' : r.outcome === 'rejected' || r.outcome === 'no_show' ? 'danger' : undefined}>{OUTCOME_LABEL[r.outcome]}</Badge> : <span className="faint">Pending</span>}
                {canRecruit(me) && <div><button className="btn btn-ghost" style={{ paddingLeft: 0 }} onClick={() => setClosing(r)}>{r.outcome ? 'Change' : 'Record result'}</button></div>}
              </td>
              <td className="num" style={{ whiteSpace: 'nowrap' }}>
                {canRecruit(me) && <>
                  <button className="btn btn-ghost btn-icon" onClick={() => setEditing(r)} aria-label="Edit interview" title="Edit"><Pencil size={14} /></button>
                  <button className="btn btn-ghost btn-icon" onClick={() => remove(r)} disabled={action.busy} aria-label="Delete interview" title="Delete"><Trash2 size={14} /></button>
                </>}
              </td>
            </tr>
          );
        })}</tbody>
      </table></div>
      <InterviewDialog open={editing !== null} onClose={() => setEditing(null)} onDone={onChange} editing={editing ?? undefined} />
      <ReadinessDialog row={judging} onClose={() => setJudging(null)} onDone={onChange} />
      <OutcomeDialog row={closing} onClose={() => setClosing(null)} onDone={onChange} />
    </>
  );
};

function localInputValue(iso: string | Date): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Add an interview (pick the candidate, or a fixed one), or edit one. */
export const InterviewDialog: React.FC<{ open: boolean; onClose: () => void; onDone: () => void; candidateId?: string; editing?: InterviewRow }> = ({ open, onClose, onDone, candidateId, editing }) => {
  const blank = () => ({
    candidate: candidateId ?? '', company: '', role_title: '', round: '', job_description: '',
    at: localInputValue(new Date(Math.ceil((Date.now() + 2 * 86400_000) / 3600_000) * 3600_000)),
  });
  const [form, setForm] = useState(blank);
  const [candidates, setCandidates] = useState<Array<{ id: string; name: string; team_name: string }>>([]);
  const action = useAction();
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setForm(editing ? {
      candidate: editing.candidate_id, company: editing.company, role_title: editing.role_title, round: editing.round ?? '',
      job_description: editing.job_description ?? '', at: localInputValue(editing.interview_at),
    } : blank());
    if (!candidateId && !editing) {
      void supabase.from('candidate_overview').select('id, name, team_name').neq('status', 'archived').order('name')
        .then(({ data }) => setCandidates((data ?? []) as Array<{ id: string; name: string; team_name: string }>));
    }
  }, [open, editing, candidateId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof ReturnType<typeof blank>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = () => void action.run(async () => {
    if (!form.candidate) throw new Error('Choose the candidate.');
    if (!form.company.trim() || !form.role_title.trim()) throw new Error('Enter the company and the role.');
    const when = new Date(form.at);
    if (Number.isNaN(when.getTime())) throw new Error('Choose the interview date and time.');
    const args = {
      p_company: form.company.trim(), p_role_title: form.role_title.trim(), p_interview_at: when.toISOString(),
      p_round: form.round.trim() || null, p_job_description: form.job_description.trim() || null,
    };
    const { error } = editing
      ? await supabase.rpc('pp_update_interview', { p_interview: editing.id, ...args })
      : await supabase.rpc('pp_create_interview', { p_candidate: form.candidate, ...args });
    if (error) throw error;
    toast(editing ? 'Interview updated' : 'Interview added, with its prep mock interview');
    onClose();
    onDone();
  });

  return (
    <Dialog open={open} onClose={onClose} onSubmit={save} wide title={editing ? 'Edit interview' : 'Add interview'}
      description={editing ? 'The prep mock interview follows these details.' : 'The candidate gets a mock interview built from this job description, due on the interview date.'}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy}>{editing ? 'Save' : 'Add interview'}</button></>}>
      <div className="form-grid">
        {!candidateId && !editing && (
          <Field label="Candidate" full>
            <select className="input" value={form.candidate} onChange={set('candidate')} autoFocus>
              <option value="">Choose…</option>
              {candidates.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.team_name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Company"><input className="input" value={form.company} onChange={set('company')} maxLength={200} placeholder="Infosys" /></Field>
        <Field label="Role"><input className="input" value={form.role_title} onChange={set('role_title')} maxLength={200} placeholder="Java Developer" /></Field>
        <Field label="Date and time"><input className="input" type="datetime-local" value={form.at} onChange={set('at')} /></Field>
        <Field label="Round" hint="Optional."><input className="input" value={form.round} onChange={set('round')} maxLength={100} placeholder="Technical round 1" /></Field>
        <Field label="Job description" hint="Paste it in full: the prep mock interview asks questions from it." full>
          <textarea className="input" value={form.job_description} onChange={set('job_description')} maxLength={20000} rows={6} />
        </Field>
      </div>
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Dialog>
  );
};

const ReadinessDialog: React.FC<{ row: InterviewRow | null; onClose: () => void; onDone: () => void }> = ({ row, onClose, onDone }) => {
  const [value, setValue] = useState<Readiness>('ready');
  const [note, setNote] = useState('');
  const action = useAction();
  const toast = useToast();
  useEffect(() => { if (row) { setValue(row.readiness ?? 'ready'); setNote(row.readiness_note ?? ''); } }, [row]);
  const save = () => void action.run(async () => {
    if (!row) return;
    const { error } = await supabase.rpc('pp_set_interview_readiness', { p_interview: row.id, p_readiness: value, p_note: note.trim() || null });
    if (error) throw error;
    toast(value === 'ready' ? `${row.candidate_name} marked ready` : 'Saved: needs more work');
    onClose();
    onDone();
  });
  return (
    <Dialog open={row !== null} onClose={onClose} onSubmit={save} title="Is the candidate ready?"
      description={row ? `${row.candidate_name} · ${row.role_title} at ${row.company}, ${dateTime(row.interview_at)}` : undefined}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy}>Save</button></>}>
      <div className="chips">
        <button type="button" className={`chip ${value === 'ready' ? 'on' : ''}`} onClick={() => setValue('ready')}>Ready</button>
        <button type="button" className={`chip ${value === 'needs_work' ? 'on' : ''}`} onClick={() => setValue('needs_work')}>Needs more work</button>
      </div>
      <Field label="Note for the team" hint="What to work on, or why they are ready.">
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Strong on Spring Boot; revise Kafka consumer groups." />
      </Field>
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Dialog>
  );
};

const OutcomeDialog: React.FC<{ row: InterviewRow | null; onClose: () => void; onDone: () => void }> = ({ row, onClose, onDone }) => {
  const [value, setValue] = useState<Outcome | ''>('');
  const [note, setNote] = useState('');
  const action = useAction();
  const toast = useToast();
  useEffect(() => { if (row) { setValue(row.outcome ?? ''); setNote(row.outcome_note ?? ''); } }, [row]);
  const save = () => void action.run(async () => {
    if (!row) return;
    const { error } = await supabase.rpc('pp_set_interview_outcome', { p_interview: row.id, p_outcome: value || null, p_note: note.trim() || null });
    if (error) throw error;
    toast(value ? `Result saved: ${OUTCOME_LABEL[value]}` : 'Result cleared');
    onClose();
    onDone();
  });
  return (
    <Dialog open={row !== null} onClose={onClose} onSubmit={save} title="Interview result"
      description={row ? `${row.candidate_name} · ${row.role_title} at ${row.company}` : undefined}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy}>Save</button></>}>
      <div className="chips">
        {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => (
          <button key={o} type="button" className={`chip ${value === o ? 'on' : ''}`} onClick={() => setValue(o)}>{OUTCOME_LABEL[o]}</button>
        ))}
        <button type="button" className={`chip ${value === '' ? 'on' : ''}`} onClick={() => setValue('')}>Pending</button>
      </div>
      <Field label="Note" hint="Optional: feedback from the client, the offer, next round."><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
      {action.error && <Alert kind="error">{action.error}</Alert>}
    </Dialog>
  );
};
