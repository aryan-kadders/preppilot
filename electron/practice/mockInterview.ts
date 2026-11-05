// Mock interview — the prompts, the parsing of what the model returns, and the
// session report. Pure: no Electron, no I/O, no platform branches, so all of it
// is unit-tested (electron/practice/__tests__ is not a glob; the tests live in
// electron/services/__tests__/PrepPilotMockInterview.test.mjs).
//
// Flow: start(config) asks the model for N questions (a built-in bank is the
// fallback), each answer is scored with concrete feedback and a stronger
// example answer, and finish() summarises the session without another call.

import { parseModelJson } from '../profile/profileExtraction';
import { summarizeDelivery, type DeliveryStats, type DeliverySummary } from './delivery';

export type InterviewKind = 'behavioral' | 'technical' | 'mixed';
export type InterviewLevel = 'entry' | 'mid' | 'senior';

export interface PracticeConfig {
  role: string;
  company?: string;
  level: InterviewLevel;
  kind: InterviewKind;
  questionCount: number;
  /** Ground questions and feedback in the uploaded résumé / JD. */
  useProfile: boolean;
}

export interface PracticeQuestion {
  id: string;
  text: string;
  kind: 'behavioral' | 'technical' | 'situational' | 'intro';
  /** What a good answer shows (shown after the answer, never before). */
  focus: string;
}

export interface StarCheck {
  situation: boolean;
  task: boolean;
  action: boolean;
  result: boolean;
}

export interface AnswerFeedback {
  /** 1..10. */
  score: number;
  verdict: string;
  strengths: string[];
  improvements: string[];
  betterAnswer: string;
  /** Behavioural answers only. */
  star?: StarCheck;
}

export interface PracticeAnswer {
  questionId: string;
  answer: string;
  feedback: AnswerFeedback | null;
  /** Why there is no feedback (no AI, the model failed). */
  feedbackError?: string;
  answeredAt: string;
  /** Spoken answers only: pace, fillers, length (delivery.ts). */
  delivery?: DeliveryStats;
}

export interface PracticeReport {
  averageScore: number | null;
  answered: number;
  total: number;
  strongest: { questionId: string; score: number } | null;
  weakest: { questionId: string; score: number } | null;
  /** The improvements that came up most, most frequent first. */
  focusAreas: string[];
  starCoverage: { behavioral: number; complete: number } | null;
  /** Spoken answers only. */
  delivery: DeliverySummary | null;
}

export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 10;
const MAX_ANSWER_CHARS = 6_000;

export function normalizeConfig(raw: Partial<PracticeConfig> | null | undefined): PracticeConfig {
  const r = raw ?? {};
  const role = String(r.role ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Software Engineer';
  const company = String(r.company ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined;
  const level: InterviewLevel = r.level === 'entry' || r.level === 'senior' ? r.level : 'mid';
  const kind: InterviewKind = r.kind === 'behavioral' || r.kind === 'technical' ? r.kind : 'mixed';
  const n = Math.round(Number(r.questionCount));
  const questionCount = Number.isFinite(n) ? Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, n)) : 5;
  return { role, company, level, kind, questionCount, useProfile: r.useProfile !== false };
}

const LEVEL_TEXT: Record<InterviewLevel, string> = {
  entry: 'an entry-level / new-graduate',
  mid: 'a mid-level',
  senior: 'a senior',
};

const KIND_TEXT: Record<InterviewKind, string> = {
  behavioral: 'behavioural questions only (past experience, teamwork, conflict, ownership, failure)',
  technical: 'technical questions only (concepts, design and problem-solving for this role; no long coding exercises)',
  mixed: 'a realistic mix: start with an introduction question, then behavioural and technical questions',
};

export function buildQuestionsPrompt(config: PracticeConfig, profileBlock: string): string {
  return `You are an experienced interviewer for ${LEVEL_TEXT[config.level]} ${config.role} role${config.company ? ` at ${config.company}` : ''}.
Write ${config.questionCount} interview questions: ${KIND_TEXT[config.kind]}.
Make them specific to the role${profileBlock ? ' and, where natural, to the candidate background and target job below' : ''}. One question each, no multi-part questions, in the order an interviewer would ask them.
${profileBlock ? `\n${profileBlock}\n` : ''}
Return ONLY a JSON object:
{"questions":[{"text": string, "kind": "intro" | "behavioral" | "technical" | "situational", "focus": string}]}
"focus" is one short sentence on what a strong answer demonstrates.`;
}

export function buildFeedbackPrompt(config: PracticeConfig, question: PracticeQuestion, answer: string, profileBlock: string): string {
  const behavioural = question.kind === 'behavioral' || question.kind === 'situational';
  return `You are an experienced, fair interviewer for ${LEVEL_TEXT[config.level]} ${config.role} role${config.company ? ` at ${config.company}` : ''}. Coach the candidate on one answer.
${profileBlock ? `\n${profileBlock}\n` : ''}
QUESTION: ${question.text}
WHAT A STRONG ANSWER SHOWS: ${question.focus}
CANDIDATE'S ANSWER (spoken, may contain transcription slips; judge the content, not typos):
"""
${answer.slice(0, MAX_ANSWER_CHARS)}
"""

Score it 1-10 for this level (5 = acceptable, 8 = strong hire signal). Be specific and kind; refer to what they actually said.
"betterAnswer": a stronger answer in the candidate's own voice, first person, under 170 words${profileBlock ? ', using only facts from their background above (never invent employers, numbers or projects)' : ' (keep any example generic rather than inventing specifics)'}.${behavioural ? '\n"star": whether the answer covered each STAR part (Situation, Task, Action, Result).' : ''}
Return ONLY a JSON object:
{"score": number, "verdict": string, "strengths": string[], "improvements": string[], "betterAnswer": string${behavioural ? ', "star": {"situation": boolean, "task": boolean, "action": boolean, "result": boolean}' : ''}}
"verdict" is one sentence. 1-3 strengths, 1-3 improvements, each one short sentence.`;
}

const cleanText = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanList = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : []).map((x) => cleanText(x, 240)).filter(Boolean).slice(0, max);

const QUESTION_KINDS = new Set(['intro', 'behavioral', 'technical', 'situational']);

export function parseQuestions(reply: unknown, count: number): PracticeQuestion[] {
  const parsed = parseModelJson(reply);
  const raw = Array.isArray(parsed?.questions) ? (parsed!.questions as any[]) : [];
  const out: PracticeQuestion[] = [];
  const seen = new Set<string>();
  for (const q of raw) {
    const text = cleanText(q?.text ?? q?.question, 400);
    if (text.length < 8 || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const kind = QUESTION_KINDS.has(q?.kind) ? q.kind : 'behavioral';
    out.push({ id: `q${out.length + 1}`, text, kind, focus: cleanText(q?.focus, 240) || 'A clear, specific answer with a concrete example.' });
    if (out.length >= count) break;
  }
  return out;
}

export function parseFeedback(reply: unknown, question: PracticeQuestion): AnswerFeedback | null {
  const p = parseModelJson(reply) as any;
  if (!p) return null;
  const score = Math.round(Number(p.score));
  if (!Number.isFinite(score)) return null;
  const feedback: AnswerFeedback = {
    score: Math.min(10, Math.max(1, score)),
    verdict: cleanText(p.verdict, 300),
    strengths: cleanList(p.strengths, 3),
    improvements: cleanList(p.improvements, 3),
    betterAnswer: String(p.betterAnswer ?? '').trim().slice(0, 1_500),
  };
  if ((question.kind === 'behavioral' || question.kind === 'situational') && p.star && typeof p.star === 'object') {
    feedback.star = { situation: !!p.star.situation, task: !!p.star.task, action: !!p.star.action, result: !!p.star.result };
  }
  return feedback;
}

// ── Built-in question bank (the model failed or no AI is connected) ─────────

const BANK: Record<'intro' | 'behavioral' | 'technical', Array<[string, string]>> = {
  intro: [
    ['Tell me about yourself and why you are interested in this role.', 'A concise story: current role, relevant strengths, and why this role is the next step.'],
  ],
  behavioral: [
    ['Tell me about a time you disagreed with a teammate. How did you handle it?', 'Listening, a constructive resolution and what changed as a result.'],
    ['Describe a project you are proud of. What was your specific contribution?', 'Clear ownership, concrete actions and a measurable result.'],
    ['Tell me about a time you made a mistake at work. What did you learn?', 'Accountability, how it was fixed, and what you do differently now.'],
    ['Give an example of when you had to deliver under a tight deadline.', 'Prioritisation, communication and the outcome.'],
    ['Tell me about a time you had to learn something new quickly.', 'How you learned, how fast, and how you applied it.'],
  ],
  technical: [
    ['Walk me through how you would design a system you know well. What trade-offs did you make?', 'Structure, the key trade-offs and why they were right for the constraints.'],
    ['How do you approach debugging a problem you have never seen before?', 'A systematic method: reproduce, isolate, hypothesise, verify.'],
    ['How do you make sure the code you ship is reliable?', 'Testing, reviews, monitoring and handling failure.'],
    ['Explain a technical concept from your field to someone non-technical.', 'Clarity, a good analogy and checking understanding.'],
  ],
};

export function fallbackQuestions(config: PracticeConfig): PracticeQuestion[] {
  const pools: Array<['intro' | 'behavioral' | 'technical', Array<[string, string]>]> =
    config.kind === 'behavioral' ? [['behavioral', BANK.behavioral]]
      : config.kind === 'technical' ? [['technical', BANK.technical]]
        : [['intro', BANK.intro], ['behavioral', BANK.behavioral], ['technical', BANK.technical]];
  const ordered: Array<{ kind: PracticeQuestion['kind']; text: string; focus: string }> = [];
  if (config.kind === 'mixed') {
    ordered.push({ kind: 'intro', text: BANK.intro[0][0], focus: BANK.intro[0][1] });
    const b = BANK.behavioral, t = BANK.technical;
    for (let i = 0; i < Math.max(b.length, t.length); i++) {
      if (b[i]) ordered.push({ kind: 'behavioral', text: b[i][0], focus: b[i][1] });
      if (t[i]) ordered.push({ kind: 'technical', text: t[i][0], focus: t[i][1] });
    }
  } else {
    for (const [kind, pool] of pools) for (const [text, focus] of pool) ordered.push({ kind, text, focus });
  }
  return ordered.slice(0, config.questionCount).map((q, i) => ({ id: `q${i + 1}`, ...q }));
}

// ── Report (no model call) ──────────────────────────────────────────────────

/** Feedback text normalised for counting: lower case, no punctuation. */
const theme = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();

export function buildReport(questions: PracticeQuestion[], answers: PracticeAnswer[]): PracticeReport {
  const scored = answers.filter((a) => a.feedback);
  const scores = scored.map((a) => a.feedback!.score);
  const averageScore = scores.length ? Math.round((scores.reduce((s, x) => s + x, 0) / scores.length) * 10) / 10 : null;
  let strongest: PracticeReport['strongest'] = null;
  let weakest: PracticeReport['weakest'] = null;
  for (const a of scored) {
    const s = a.feedback!.score;
    if (!strongest || s > strongest.score) strongest = { questionId: a.questionId, score: s };
    if (!weakest || s < weakest.score) weakest = { questionId: a.questionId, score: s };
  }
  const counts = new Map<string, { text: string; n: number }>();
  for (const a of scored) {
    for (const imp of a.feedback!.improvements) {
      const k = theme(imp);
      if (!k) continue;
      const e = counts.get(k);
      if (e) e.n++; else counts.set(k, { text: imp, n: 1 });
    }
  }
  const focusAreas = [...counts.values()].sort((x, y) => y.n - x.n).slice(0, 4).map((e) => e.text);
  const behavioural = scored.filter((a) => a.feedback!.star);
  const starCoverage = behavioural.length
    ? {
      behavioral: behavioural.length,
      complete: behavioural.filter((a) => { const s = a.feedback!.star!; return s.situation && s.task && s.action && s.result; }).length,
    }
    : null;
  const delivery = summarizeDelivery(answers.map((a) => a.delivery).filter((d): d is DeliveryStats => !!d));
  return { averageScore, answered: answers.length, total: questions.length, strongest, weakest, focusAreas, starCoverage, delivery };
}
