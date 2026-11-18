import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, GraduationCap, MessagesSquare, RefreshCw, Search, Sparkles } from 'lucide-react';
import { supabase } from '../supabase';
import type { Me, Route, Team } from '../lib/types';
import { dateTime, minutesLabel } from '../lib/format';
import { RECORD_LIST_COLUMNS, daysLeft, type RecordKind, type RecordRow } from '../lib/records';
import { Alert, Avatar, Badge, EmptyState, Kpi, SkeletonRows, useAction } from '../components/ui';

export const KIND_LABEL: Record<RecordKind, string> = { meeting: 'Interview', practice: 'Mock interview' };

/** One row per uploaded session, newest first. Shared by this page and a candidate's History tab. */
export const RecordsTable: React.FC<{ rows: RecordRow[]; showCandidate: boolean; go: (r: Route) => void }> = ({ rows, showCandidate, go }) => (
  <div className="table-wrap">
    <table className="table">
      <thead><tr>
        {showCandidate && <th>Candidate</th>}
        <th>Session</th><th>Started</th><th className="num">Length</th><th>Contents</th><th className="num">Deleted in</th>
      </tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="clickable" onClick={() => go({ page: 'record', id: r.id })}
            tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') go({ page: 'record', id: r.id }); }}>
            {showCandidate && (
              <td><div className="person"><Avatar name={r.candidates?.name} /><div className="person-name">{r.candidates?.name ?? 'Candidate'}</div></div></td>
            )}
            <td>
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <Badge tone={r.kind === 'practice' ? 'accent' : undefined}>{r.kind === 'practice' ? <GraduationCap size={12} /> : <MessagesSquare size={12} />}{KIND_LABEL[r.kind]}</Badge>
                <span className="ellipsis" style={{ maxWidth: 320 }}>{r.title ?? KIND_LABEL[r.kind]}</span>
              </div>
            </td>
            <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(r.started_at)}</td>
            <td className="num">{r.duration_seconds ? minutesLabel(r.duration_seconds) : '—'}</td>
            <td className="muted" style={{ whiteSpace: 'nowrap' }}>
              {r.kind === 'practice'
                ? <>{r.score !== null ? <Badge tone={scoreTone(Number(r.score))}>{Number(r.score).toFixed(1)}/10</Badge> : null} <span className="faint">{r.answer_count} of {r.line_count} answered</span></>
                : <span>{r.line_count} lines · {r.answer_count} answers</span>}
            </td>
            <td className="num faint">{daysLeft(r.expires_at)} days</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export function scoreTone(score: number): 'good' | 'warn' | 'danger' {
  return score >= 7 ? 'good' : score >= 5 ? 'warn' : 'danger';
}

/** Every session the caller may see: transcripts, answers, notes and mock interviews, kept 90 days. */
export const Sessions: React.FC<{ me: Me; go: (r: Route) => void }> = ({ go }) => {
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'' | RecordKind>('');
  const [teamFilter, setTeamFilter] = useState('');
  const [days, setDays] = useState(30);
  const load = useAction();
  const { run } = load;

  const refresh = useCallback(() => run(async () => {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const [r, t] = await Promise.all([
      supabase.from('session_records').select(`${RECORD_LIST_COLUMNS}, candidates(name, team_id)`)
        .gte('started_at', since).order('started_at', { ascending: false }).limit(1000),
      supabase.from('teams').select('id, name, org_id').order('name'),
    ]);
    if (r.error) throw r.error;
    if (t.error) throw t.error;
    setRows(r.data as unknown as RecordRow[]);
    setTeams(t.data as Team[]);
  }), [run, days]);
  useEffect(() => { void refresh(); }, [refresh]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((r) => (!kind || r.kind === kind)
      && (!teamFilter || r.candidates?.team_id === teamFilter)
      && (!q || `${r.candidates?.name ?? ''} ${r.title ?? ''}`.toLowerCase().includes(q)));
  }, [rows, query, kind, teamFilter]);

  const interviews = visible.filter((r) => r.kind === 'meeting');
  const mocks = visible.filter((r) => r.kind === 'practice' && r.score !== null);
  const avgScore = mocks.length ? mocks.reduce((s, r) => s + Number(r.score), 0) / mocks.length : null;
  const answers = interviews.reduce((s, r) => s + r.answer_count, 0);
  const people = new Set(visible.map((r) => r.candidate_id)).size;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Session history</h1>
          <p className="page-desc">Transcripts, PrepPilot’s answers, notes and mock interview results. Each session is deleted automatically after 90 days.</p>
        </div>
      </div>

      <div className="stats">
        <Kpi icon={<MessagesSquare size={14} />} label="Interview sessions" value={interviews.length} hint={`Last ${days} days`} />
        <Kpi icon={<GraduationCap size={14} />} label="Mock interviews" value={visible.length - interviews.length} hint={avgScore !== null ? `Average score ${avgScore.toFixed(1)}/10` : undefined} />
        <Kpi icon={<Sparkles size={14} />} label="Answers from PrepPilot" value={answers} />
        <Kpi icon={<FileText size={14} />} label="Candidates" value={people} />
      </div>

      <section className="card">
        <div className="toolbar">
          <div className="search" style={{ width: 260 }}>
            <Search size={15} />
            <input className="input" placeholder="Search candidate or session" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search sessions" />
          </div>
          <select className="input" style={{ width: 170 }} value={kind} onChange={(e) => setKind(e.target.value as '' | RecordKind)} aria-label="Type">
            <option value="">All sessions</option>
            <option value="meeting">Interviews</option>
            <option value="practice">Mock interviews</option>
          </select>
          <select className="input" style={{ width: 170 }} value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} aria-label="Team">
            <option value="">All teams</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select className="input" style={{ width: 150 }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <span className="spacer" />
          <button className="btn btn-ghost btn-icon" onClick={() => void refresh()} disabled={load.busy} aria-label="Refresh" title="Refresh"><RefreshCw size={15} /></button>
        </div>
        {load.error && <div style={{ padding: 12 }}><Alert kind="error">{load.error}</Alert></div>}
        {rows === null ? <SkeletonRows /> : visible.length === 0 ? (
          rows.length === 0
            ? <EmptyState icon={<MessagesSquare size={20} />} title="No sessions yet"
                description="When a candidate finishes an interview session or a mock interview in PrepPilot, it appears here a few seconds later." />
            : <EmptyState icon={<Search size={20} />} title="No matches" description="Try another name, type or team." />
        ) : <RecordsTable rows={visible} showCandidate go={go} />}
      </section>
    </>
  );
};
