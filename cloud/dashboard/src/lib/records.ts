// Session records: what the dashboard shows of a finished meeting or mock
// interview (uploaded by the app; see cloud/supabase/functions/_shared/records.ts).

export type RecordKind = 'meeting' | 'practice';

export interface RecordRow {
  id: string;
  candidate_id: string;
  session_id: string | null;
  kind: RecordKind;
  title: string | null;
  started_at: string;
  duration_seconds: number | null;
  line_count: number;
  answer_count: number;
  score: number | null;
  expires_at: string;
  candidates?: { name: string; team_id: string } | null;
}

export const RECORD_LIST_COLUMNS = 'id, candidate_id, session_id, kind, title, started_at, duration_seconds, line_count, answer_count, score, expires_at';

export interface TranscriptLine { speaker: string; text: string; t: number | null }
export interface AnswerItem { type: string | null; t: number | null; question: string | null; answer: string | null; items: string[] }
export interface MeetingSummary {
  overview: string | null; tldr: string[]; keyPoints: string[]; actionItems: string[];
  sections: Array<{ title: string; bullets: string[] }>;
  coaching: Array<{ title: string; detail: string; severity: string | null }>;
}
export interface PracticeFeedback {
  score: number | null; verdict: string | null; strengths: string[]; improvements: string[]; betterAnswer: string | null;
  star: { situation: boolean; task: boolean; action: boolean; result: boolean } | null;
}
export interface PracticeContent {
  config: { role: string | null; company: string | null; level: string | null; kind: string | null };
  questions: Array<{ id: string; text: string; kind: string | null; focus: string | null }>;
  answers: Array<{ questionId: string; answer: string; feedback: PracticeFeedback | null; delivery: { wpm: number | null; pace: string | null; fillerCount: number | null; length: string | null } | null }>;
  report: { averageScore: number | null; answered: number | null; total: number | null; focusAreas: string[]; averageWpm: number | null; totalFillers: number | null } | null;
}
export interface MeetingContent { transcript: TranscriptLine[]; answers: AnswerItem[]; summary: MeetingSummary | null }

export interface RecordFull extends Omit<RecordRow, 'candidates'> {
  candidate_name: string;
  content: MeetingContent | PracticeContent;
  created_at: string;
  updated_at: string;
  can_delete: boolean;
}

/** Who said a transcript line, as a person reads it. */
export function speakerLabel(speaker: string): string {
  const s = speaker.toLowerCase();
  if (s === 'user' || s === 'me' || s === 'candidate' || s === 'mic') return 'Candidate';
  if (s === 'interviewer' || s === 'system' || s === 'them' || s.startsWith('speaker')) return 'Interviewer';
  if (s === 'assistant') return 'PrepPilot';
  return speaker ? speaker[0].toUpperCase() + speaker.slice(1) : 'Unknown';
}

/** "m:ss" (or "h:mm:ss") into the session, or '' when the time is unknown. */
export function offsetLabel(t: number | null, startMs: number): string {
  if (t === null || !Number.isFinite(t)) return '';
  // Lines carry the wall-clock time; older ones may carry an offset already.
  const ms = t > 1e11 ? t - startMs : t;
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export type TimelineItem =
  | { kind: 'line'; t: number | null; speaker: string; text: string }
  | { kind: 'answer'; t: number | null; question: string | null; answer: string | null; items: string[]; type: string | null };

/** Transcript lines and PrepPilot's answers in one timeline, by time (unknown times keep their place). */
export function timeline(c: MeetingContent): TimelineItem[] {
  const items: Array<TimelineItem & { order: number }> = [
    ...c.transcript.map((l, i) => ({ kind: 'line' as const, t: l.t, speaker: l.speaker, text: l.text, order: i })),
    ...c.answers.map((a, i) => ({ kind: 'answer' as const, t: a.t, question: a.question, answer: a.answer, items: a.items ?? [], type: a.type, order: 1e6 + i })),
  ];
  return items
    .sort((a, b) => (a.t !== null && b.t !== null && a.t !== b.t ? a.t - b.t : a.order - b.order))
    .map(({ order: _o, ...rest }) => rest as TimelineItem);
}

/** Does a timeline item mention the search words (case-insensitive)? */
export function matches(item: TimelineItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = item.kind === 'line' ? item.text : [item.question, item.answer, ...item.items].filter(Boolean).join(' ');
  return hay.toLowerCase().includes(q);
}

export const isPractice = (r: { kind: RecordKind }) => r.kind === 'practice';

/** A plain-text copy for download: header, summary, transcript with answers, or the mock interview. */
export function recordToText(r: RecordFull): string {
  const start = Date.parse(r.started_at);
  const out: string[] = [
    r.title ?? (r.kind === 'practice' ? 'Mock interview' : 'Interview session'),
    `Candidate: ${r.candidate_name}`,
    `Started: ${new Date(start).toLocaleString()}`,
    ...(r.duration_seconds ? [`Length: ${Math.round(r.duration_seconds / 60)} min`] : []),
    '',
  ];
  if (r.kind === 'practice') {
    const p = r.content as PracticeContent;
    if (p.report?.averageScore != null) out.push(`Average score: ${p.report.averageScore}/10`, '');
    for (const q of p.questions) {
      const a = p.answers.find((x) => x.questionId === q.id);
      out.push(`Q: ${q.text}`, `A: ${a?.answer ?? '(not answered)'}`);
      if (a?.feedback?.score != null) out.push(`Score: ${a.feedback.score}/10${a.feedback.verdict ? ` - ${a.feedback.verdict}` : ''}`);
      if (a?.feedback?.betterAnswer) out.push(`Better answer: ${a.feedback.betterAnswer}`);
      out.push('');
    }
    return out.join('\n');
  }
  const m = r.content as MeetingContent;
  if (m.summary?.overview) out.push('SUMMARY', m.summary.overview, '');
  if (m.summary?.keyPoints.length) out.push('KEY POINTS', ...m.summary.keyPoints.map((k) => `- ${k}`), '');
  out.push('TRANSCRIPT');
  for (const it of timeline(m)) {
    const at = offsetLabel(it.t, start);
    if (it.kind === 'line') out.push(`[${at}] ${speakerLabel(it.speaker)}: ${it.text}`);
    else out.push(`[${at}] PrepPilot answer${it.question ? ` to "${it.question}"` : ''}: ${it.answer ?? it.items.join('; ')}`);
  }
  return out.join('\n');
}

/** Days until the record is deleted (0 = today). */
export function daysLeft(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 86_400_000));
}
