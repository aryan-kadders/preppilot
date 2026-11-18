import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Clock, Download, GraduationCap, Hourglass, MessageSquare, MessagesSquare, Mic, Search, Sparkles, Target, Trash2 } from 'lucide-react';
import { supabase } from '../supabase';
import type { Me, Route } from '../lib/types';
import { dateTime, minutesLabel, relative } from '../lib/format';
import {
  daysLeft, matches, offsetLabel, recordToText, speakerLabel, timeline,
  type MeetingContent, type PracticeContent, type RecordFull,
} from '../lib/records';
import { Alert, Badge, Card, Dialog, EmptyState, Kpi, SkeletonRows, useAction, useToast } from '../components/ui';
import { KIND_LABEL, scoreTone } from './Sessions';

interface Comment { id: string; body: string; created_at: string }

/** One session: who, when, and everything that happened in it. Opening it is recorded in the audit log. */
export const SessionRecordPage: React.FC<{ me: Me; id: string; go: (r: Route) => void; onTitle: (t: string | null) => void }> = ({ me, id, go, onTitle }) => {
  const [rec, setRec] = useState<RecordFull | null>(null);
  const [notes, setNotes] = useState<Comment[]>([]);
  const load = useAction();
  const { run } = load;
  const del = useAction();
  const toast = useToast();

  const refresh = useCallback(() => run(async () => {
    const { data, error } = await supabase.rpc('pp_open_session_record', { p_id: id });
    if (error) throw error.code === 'P0002' ? new Error('This session no longer exists. It may have been deleted, or its 90 days are over.') : error;
    const r = data as RecordFull;
    setRec(r);
    if (r.session_id) {
      const c = await supabase.from('session_comments').select('id, body, created_at').eq('session_id', r.session_id).order('created_at');
      if (!c.error) setNotes(c.data as Comment[]);
    }
  }), [id, run]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { onTitle(rec?.title ?? null); }, [rec, onTitle]);

  if (!rec) return load.error ? <Alert kind="error">{load.error}</Alert> : <section className="card"><SkeletonRows rows={6} /></section>;

  const download = () => {
    const blob = new Blob([recordToText(rec)], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const day = rec.started_at.slice(0, 10);
    a.download = `${rec.candidate_name} ${KIND_LABEL[rec.kind]} ${day}.txt`.replace(/[\\/:*?"<>|]+/g, '-');
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const remove = () => {
    if (!window.confirm('Delete this session for everyone? Its transcript, answers and notes are removed at once. This cannot be undone.')) return;
    void del.run(async () => {
      const { error } = await supabase.rpc('pp_delete_session_record', { p_id: rec.id });
      if (error) throw error;
      toast('Session deleted');
      go({ page: 'sessions' });
    });
  };

  return (
    <>
      <div className="page-head" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <Badge tone={rec.kind === 'practice' ? 'accent' : undefined}>{rec.kind === 'practice' ? <GraduationCap size={12} /> : <MessagesSquare size={12} />}{KIND_LABEL[rec.kind]}</Badge>
            <span className="faint">Deleted automatically in {daysLeft(rec.expires_at)} days</span>
          </div>
          <h1 className="page-title">{rec.title ?? KIND_LABEL[rec.kind]}</h1>
          <div className="row muted" style={{ fontSize: 13 }}>
            <button className="link" onClick={() => go({ page: 'candidate', id: rec.candidate_id })}>{rec.candidate_name}</button>
            <span className="faint">·</span>{dateTime(rec.started_at)}
            {rec.duration_seconds ? <><span className="faint">·</span>{minutesLabel(rec.duration_seconds)}</> : null}
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={download}><Download size={15} /> Download</button>
          {rec.can_delete && <button className="btn btn-danger" onClick={remove} disabled={del.busy}><Trash2 size={15} /> Delete</button>}
        </div>
      </div>
      {del.error && <div style={{ marginBottom: 16 }}><Alert kind="error">{del.error}</Alert></div>}

      {rec.kind === 'practice'
        ? <PracticeView c={rec.content as PracticeContent} />
        : <MeetingView c={rec.content as MeetingContent} startedAt={rec.started_at} />}

      {rec.session_id && <Notes me={me} sessionId={rec.session_id} notes={notes} onChange={refresh} />}
    </>
  );
};

/** Share of the spoken words, as interview-coaching tools show it ("talk ratio"). */
function talkShare(c: MeetingContent): { candidate: number; interviewer: number } | null {
  let cand = 0, other = 0;
  for (const l of c.transcript) {
    const words = l.text.split(/\s+/).filter(Boolean).length;
    const who = speakerLabel(l.speaker);
    if (who === 'Candidate') cand += words; else if (who === 'Interviewer') other += words;
  }
  const total = cand + other;
  return total ? { candidate: Math.round((cand / total) * 100), interviewer: Math.round((other / total) * 100) } : null;
}

const MeetingView: React.FC<{ c: MeetingContent; startedAt: string }> = ({ c, startedAt }) => {
  const [query, setQuery] = useState('');
  const [showAnswers, setShowAnswers] = useState(true);
  const start = Date.parse(startedAt);
  const all = useMemo(() => timeline(c), [c]);
  const shown = all.filter((it) => (showAnswers || it.kind === 'line') && matches(it, query));
  const share = talkShare(c);
  const s = c.summary;

  return (
    <>
      <div className="stats">
        <Kpi icon={<Mic size={14} />} label="Transcript lines" value={c.transcript.length} />
        <Kpi icon={<Sparkles size={14} />} label="PrepPilot answers" value={c.answers.length} />
        <Kpi icon={<MessagesSquare size={14} />} label="Candidate talk time" value={share ? `${share.candidate}%` : '—'} hint={share ? `Interviewer ${share.interviewer}%` : 'No speech recorded'} />
        <Kpi icon={<Clock size={14} />} label="Started" value={<span style={{ fontSize: 16 }}>{new Date(start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>} hint={relative(startedAt)} />
      </div>

      <div className="record-grid">
        <Card title="Transcript" description="What was said, with PrepPilot’s answers where they appeared" flush>
          <div className="toolbar" style={{ padding: '12px 14px 0' }}>
            <div className="search" style={{ flex: 1, minWidth: 200 }}>
              <Search size={15} />
              <input className="input sm" placeholder="Search the transcript" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the transcript" />
            </div>
            <label className="check"><input type="checkbox" checked={showAnswers} onChange={(e) => setShowAnswers(e.target.checked)} /> PrepPilot answers</label>
          </div>
          {all.length === 0 ? <EmptyState icon={<Mic size={18} />} title="Nothing was recorded" description="The session ended before anything was said." />
            : shown.length === 0 ? <EmptyState icon={<Search size={18} />} title="No matches" description="Try other words." />
            : (
              <ol className="timeline" aria-label="Transcript">
                {shown.map((it, i) => it.kind === 'line' ? (
                  <li key={i} className="tl-line">
                    <span className="tl-time mono">{offsetLabel(it.t, start)}</span>
                    <span className={`tl-who ${speakerLabel(it.speaker) === 'Candidate' ? 'is-candidate' : ''}`}>{speakerLabel(it.speaker)}</span>
                    <span className="tl-text">{it.text}</span>
                  </li>
                ) : (
                  <li key={i} className="tl-answer">
                    <span className="tl-time mono">{offsetLabel(it.t, start)}</span>
                    <div className="tl-answer-body">
                      <div className="tl-answer-head"><Sparkles size={13} /> PrepPilot suggested{it.question ? <span className="faint"> · for “{it.question}”</span> : null}</div>
                      {it.answer ? <div className="tl-text pre">{it.answer}</div> : null}
                      {it.items.length > 0 && <ul className="tl-items">{it.items.map((x, j) => <li key={j}>{x}</li>)}</ul>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
        </Card>

        <div className="record-side">
          <Card title="Summary" description="Written by PrepPilot after the session">
            {!s ? <p className="muted" style={{ margin: 0 }}>No summary for this session.</p> : (
              <div className="summary">
                {s.overview && <p>{s.overview}</p>}
                {s.tldr.length > 0 && <List title="In short" items={s.tldr} />}
                {s.keyPoints.length > 0 && <List title="Key points" items={s.keyPoints} />}
                {s.actionItems.length > 0 && <List title="To do" items={s.actionItems} />}
                {s.sections.map((x, i) => <List key={i} title={x.title} items={x.bullets} />)}
                {s.coaching.length > 0 && (
                  <div>
                    <h4>Coaching</h4>
                    {s.coaching.map((x, i) => (
                      <div key={i} className="coach">
                        <Badge tone={x.severity === 'warning' ? 'warn' : x.severity === 'opportunity' ? 'accent' : undefined}>{x.title}</Badge>
                        <p className="muted">{x.detail}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
};

const List: React.FC<{ title: string; items: string[] }> = ({ title, items }) => (
  <div><h4>{title}</h4><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
);

const PracticeView: React.FC<{ c: PracticeContent }> = ({ c }) => {
  const r = c.report;
  const cfg = c.config;
  return (
    <>
      <div className="stats">
        <Kpi icon={<Target size={14} />} label="Average score" value={r?.averageScore != null ? `${r.averageScore.toFixed(1)}/10` : '—'} />
        <Kpi icon={<MessagesSquare size={14} />} label="Answered" value={`${c.answers.length} of ${c.questions.length}`} />
        <Kpi icon={<Mic size={14} />} label="Speaking pace" value={r?.averageWpm ? `${Math.round(r.averageWpm)} wpm` : '—'} hint={r?.totalFillers != null ? `${r.totalFillers} filler words` : 'Typed answers'} />
        <Kpi icon={<CalendarClock size={14} />} label="Set up" value={<span style={{ fontSize: 15 }}>{[cfg.level, cfg.kind].filter(Boolean).join(' · ') || '—'}</span>} hint={[cfg.role, cfg.company].filter(Boolean).join(' at ') || undefined} />
      </div>
      {r && r.focusAreas.length > 0 && (
        <Card title="Focus on next time"><ul className="plain-list">{r.focusAreas.map((x, i) => <li key={i}>{x}</li>)}</ul></Card>
      )}
      <div className="qlist">
        {c.questions.map((q, i) => {
          const a = c.answers.find((x) => x.questionId === q.id);
          const f = a?.feedback;
          return (
            <section key={q.id} className="card qcard">
              <div className="qcard-head">
                <span className="faint mono">Q{i + 1}</span>
                <h3>{q.text}</h3>
                {f?.score != null && <Badge tone={scoreTone(f.score)}>{f.score}/10</Badge>}
              </div>
              {q.kind && <div className="faint" style={{ marginBottom: 10 }}>{q.kind}{q.focus ? ` · ${q.focus}` : ''}</div>}
              {!a ? <p className="muted">Not answered.</p> : (
                <>
                  <div className="answer-quote pre">{a.answer}</div>
                  {a.delivery && (
                    <div className="row faint" style={{ marginTop: 8 }}>
                      {a.delivery.wpm ? <span>{Math.round(a.delivery.wpm)} wpm{a.delivery.pace ? ` (${a.delivery.pace})` : ''}</span> : null}
                      {a.delivery.fillerCount != null && <span>· {a.delivery.fillerCount} filler words</span>}
                      {a.delivery.length && <span>· length {a.delivery.length}</span>}
                    </div>
                  )}
                  {f && (
                    <div className="feedback">
                      {f.verdict && <p>{f.verdict}</p>}
                      {f.star && (
                        <div className="row" aria-label="STAR coverage">
                          {(['situation', 'task', 'action', 'result'] as const).map((k) => (
                            <Badge key={k} tone={f.star![k] ? 'good' : undefined}>{k[0].toUpperCase() + k.slice(1)}</Badge>
                          ))}
                        </div>
                      )}
                      <div className="grid-2" style={{ marginTop: 12 }}>
                        {f.strengths.length > 0 && <List title="What went well" items={f.strengths} />}
                        {f.improvements.length > 0 && <List title="To improve" items={f.improvements} />}
                      </div>
                      {f.betterAnswer && (
                        <details className="better">
                          <summary>A stronger answer</summary>
                          <div className="pre">{f.betterAnswer}</div>
                        </details>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          );
        })}
        {c.questions.length === 0 && <EmptyState icon={<Hourglass size={18} />} title="No questions" />}
      </div>
    </>
  );
};

const Notes: React.FC<{ me: Me; sessionId: string; notes: Comment[]; onChange: () => void }> = ({ me, sessionId, notes, onChange }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const action = useAction();
  const toast = useToast();
  const save = () => void action.run(async () => {
    if (!draft.trim()) return;
    const { error } = await supabase.from('session_comments').insert({ session_id: sessionId, author_id: me.userId, body: draft.trim() });
    if (error) throw error;
    toast('Note added');
    setDraft(''); setOpen(false);
    onChange();
  });
  return (
    <div style={{ marginTop: 16 }}>
      <Card title="Coach notes" description="Visible to everyone who can see this candidate"
        actions={<button className="btn btn-cta sm" onClick={() => setOpen(true)}><MessageSquare size={14} /> Add note</button>}>
        {notes.length === 0 ? <p className="muted" style={{ margin: 0 }}>No notes yet.</p>
          : notes.map((n) => <p key={n.id} style={{ margin: '0 0 8px' }}>“{n.body}” <span className="faint">{relative(n.created_at)}</span></p>)}
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} onSubmit={save} title="Coach note" description="Visible to everyone who can see this candidate."
        footer={<><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="btn btn-cta" disabled={action.busy || !draft.trim()}>Save note</button></>}>
        <textarea className="input" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={4000} placeholder="Good structure; pause before answering system design." autoFocus />
        {action.error && <Alert kind="error">{action.error}</Alert>}
      </Dialog>
    </div>
  );
};
