// Session records the app uploads (POST /v1/session/record): a meeting's
// transcript, answers and summary, or a mock interview's results.
// Only known fields are kept, every text is capped, and the whole is capped,
// so a record is always small enough to show on the dashboard.

export const MAX_RECORD_BYTES = 2_000_000;
const MAX_LINES = 20_000;
const MAX_ANSWERS = 2_000;
const MAX_TEXT = 20_000;

export interface CleanRecord {
  kind: 'meeting' | 'practice';
  localId: string;
  title: string | null;
  startedAt: string;
  durationSeconds: number | null;
  lineCount: number;
  answerCount: number;
  score: number | null;
  content: Record<string, unknown>;
}

const text = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === 'string' && v.trim() ? v.slice(0, max) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown, max = 100): string[] =>
  Array.isArray(v) ? v.map((s) => text(s, 2000)).filter((s): s is string => s !== null).slice(0, max) : [];
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null);

/** A meeting's summary: the readable parts only. */
function cleanSummary(v: unknown): Record<string, unknown> | null {
  const s = obj(v);
  if (!s) return null;
  const sections = Array.isArray(s.sections)
    ? s.sections.map((x: any) => ({ title: text(x?.title, 300) ?? '', bullets: strings(x?.bullets, 50) }))
        .filter((x: any) => x.title || x.bullets.length).slice(0, 30)
    : [];
  const out = {
    overview: text(s.overview, 5000),
    tldr: strings(s.tldr, 20),
    keyPoints: strings(s.keyPoints, 50),
    actionItems: strings(s.actionItems, 50),
    sections,
    coaching: Array.isArray(s.coachingInsights)
      ? s.coachingInsights.map((c: any) => ({ title: text(c?.title, 300) ?? '', detail: text(c?.detail, 2000) ?? '', severity: text(c?.severity, 20) }))
          .filter((c: any) => c.title).slice(0, 20)
      : [],
  };
  const empty = !out.overview && !out.tldr.length && !out.keyPoints.length && !out.actionItems.length && !out.sections.length && !out.coaching.length;
  return empty ? null : out;
}

function cleanMeeting(c: Record<string, any>) {
  const transcript = (Array.isArray(c.transcript) ? c.transcript : []).slice(0, MAX_LINES)
    .map((l: any) => ({ speaker: text(l?.speaker, 40) ?? 'unknown', text: text(l?.text) ?? '', t: num(l?.t) }))
    .filter((l: any) => l.text);
  const answers = (Array.isArray(c.answers) ? c.answers : []).slice(0, MAX_ANSWERS)
    .map((a: any) => ({ type: text(a?.type, 40), t: num(a?.t), question: text(a?.question), answer: text(a?.answer), items: strings(a?.items, 20) }))
    .filter((a: any) => a.answer || a.question || a.items.length);
  return { content: { transcript, answers, summary: cleanSummary(c.summary) }, lineCount: transcript.length, answerCount: answers.length };
}

function cleanPractice(c: Record<string, any>) {
  const cfg = obj(c.config) ?? {};
  const questions = (Array.isArray(c.questions) ? c.questions : []).slice(0, 100)
    .map((q: any) => ({ id: text(q?.id, 100) ?? '', text: text(q?.text, 2000) ?? '', kind: text(q?.kind, 40), focus: text(q?.focus, 300) }))
    .filter((q: any) => q.id && q.text);
  const answers = (Array.isArray(c.answers) ? c.answers : []).slice(0, 100).map((a: any) => {
    const f = obj(a?.feedback);
    const d = obj(a?.delivery);
    return {
      questionId: text(a?.questionId, 100) ?? '',
      answer: text(a?.answer) ?? '',
      feedback: f ? {
        score: num(f.score), verdict: text(f.verdict, 2000), strengths: strings(f.strengths, 20),
        improvements: strings(f.improvements, 20), betterAnswer: text(f.betterAnswer, 8000),
        star: obj(f.star) ? { situation: !!f.star.situation, task: !!f.star.task, action: !!f.star.action, result: !!f.star.result } : null,
      } : null,
      delivery: d ? { wpm: num(d.wpm), pace: text(d.pace, 10), fillerCount: num(d.fillerCount), length: text(d.length, 10) } : null,
    };
  }).filter((a: any) => a.questionId && a.answer);
  const r = obj(c.report);
  const report = r ? {
    averageScore: num(r.averageScore), answered: num(r.answered), total: num(r.total),
    focusAreas: strings(r.focusAreas, 20),
    averageWpm: num(obj(r.delivery)?.averageWpm), totalFillers: num(obj(r.delivery)?.totalFillers),
  } : null;
  return {
    content: {
      config: { role: text(cfg.role, 200), company: text(cfg.company, 200), level: text(cfg.level, 20), kind: text(cfg.kind, 20) },
      questions, answers, report,
    },
    lineCount: questions.length,
    answerCount: answers.length,
    score: report?.averageScore ?? null,
  };
}

/** The record to store, or the error code to answer with. */
export function cleanRecord(body: Record<string, any> | null): CleanRecord | { error: string } {
  if (!body) return { error: 'bad_request' };
  const kind = body.kind;
  if (kind !== 'meeting' && kind !== 'practice') return { error: 'bad_kind' };
  const localId = text(body.local_id, 200);
  if (!localId) return { error: 'bad_local_id' };
  const startedAt = typeof body.started_at === 'string' ? new Date(body.started_at) : null;
  if (!startedAt || Number.isNaN(startedAt.getTime())) return { error: 'bad_started_at' };
  const content = obj(body.content);
  if (!content) return { error: 'bad_content' };
  const dur = num(body.duration_seconds);
  const cleaned = kind === 'meeting' ? { ...cleanMeeting(content), score: null } : cleanPractice(content);
  if (JSON.stringify(cleaned.content).length > MAX_RECORD_BYTES) return { error: 'record_too_large' };
  return {
    kind, localId, title: text(body.title, 300), startedAt: startedAt.toISOString(),
    durationSeconds: dur === null ? null : Math.max(0, Math.min(86400, Math.round(dur))),
    lineCount: cleaned.lineCount, answerCount: cleaned.answerCount,
    score: cleaned.score === null ? null : Math.max(0, Math.min(999, cleaned.score)),
    content: cleaned.content,
  };
}
