// Mock interview sessions: storage and flow.
//
// Sessions live in the app's SQLite database (the same handle every local
// feature uses, under userData on macOS and Windows). The model, the profile
// context and the clock are injected, so the whole flow is tested without
// Electron (electron/services/__tests__/PrepPilotMockInterview.test.mjs).

import { randomUUID } from 'node:crypto';
import {
  buildFeedbackPrompt,
  buildQuestionsPrompt,
  buildReport,
  fallbackQuestions,
  normalizeConfig,
  parseFeedback,
  parseQuestions,
  type AnswerFeedback,
  type PracticeAnswer,
  type PracticeConfig,
  type PracticeQuestion,
  type PracticeReport,
} from './mockInterview';
import type { SqliteLike } from '../profile/ProfileStore';
import { analyzeDelivery } from './delivery';

export const PRACTICE_TABLE = 'preppilot_practice_sessions';
/** A model call that has not answered by then is treated as failed. */
export const PRACTICE_MODEL_TIMEOUT_MS = 60_000;

export interface PracticeSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  config: PracticeConfig;
  questions: PracticeQuestion[];
  answers: PracticeAnswer[];
  /** The questions came from the built-in bank, not the model. */
  usedFallbackQuestions: boolean;
  report: PracticeReport | null;
  status: 'active' | 'finished';
}

export interface PracticeSummary {
  id: string;
  createdAt: string;
  role: string;
  company?: string;
  kind: PracticeConfig['kind'];
  averageScore: number | null;
  answered: number;
  total: number;
  status: PracticeSession['status'];
}

export interface PracticeDeps {
  db: SqliteLike;
  /** One model call; resolves to its text. Null when no AI is connected. */
  generate: (() => ((prompt: string) => Promise<string>) | null);
  /** The résumé + JD context block, or '' when none is uploaded. */
  profileBlock: () => string;
  now?: () => Date;
  timeoutMs?: number;
}

export class PracticeService {
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(private readonly deps: PracticeDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.timeoutMs ?? PRACTICE_MODEL_TIMEOUT_MS;
    deps.db.exec(`CREATE TABLE IF NOT EXISTS ${PRACTICE_TABLE} (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      session_json TEXT NOT NULL
    )`);
  }

  async start(rawConfig: Partial<PracticeConfig>): Promise<PracticeSession> {
    const config = normalizeConfig(rawConfig);
    const profile = config.useProfile ? this.deps.profileBlock() : '';
    let questions: PracticeQuestion[] = [];
    const reply = await this.ask(buildQuestionsPrompt(config, profile));
    if (reply) questions = parseQuestions(reply, config.questionCount);
    const usedFallbackQuestions = questions.length < Math.min(3, config.questionCount);
    if (usedFallbackQuestions) questions = fallbackQuestions(config);
    const at = this.now().toISOString();
    const session: PracticeSession = {
      id: randomUUID(), createdAt: at, updatedAt: at, config, questions, answers: [],
      usedFallbackQuestions, report: null, status: 'active',
    };
    this.save(session);
    return session;
  }

  /** Score one answer. The answer is saved even when no feedback could be produced. */
  /** `meta.spoken`: the answer was recorded, so its delivery is analysed (durationMs = speaking time). */
  async answer(sessionId: string, questionId: string, answerText: string, meta?: { spoken?: boolean; durationMs?: number | null }): Promise<{ session: PracticeSession; answer: PracticeAnswer }> {
    const session = this.require(sessionId);
    if (session.status !== 'active') throw new Error('This practice session has already finished.');
    const question = session.questions.find((q) => q.id === questionId);
    if (!question) throw new Error('Unknown question.');
    const text = String(answerText ?? '').trim();
    if (!text) throw new Error('Say or type an answer first.');

    let feedback: AnswerFeedback | null = null;
    let feedbackError: string | undefined;
    if (!this.deps.generate()) {
      feedbackError = 'Connect an AI to get feedback on your answers.';
    } else {
      const profile = session.config.useProfile ? this.deps.profileBlock() : '';
      const reply = await this.ask(buildFeedbackPrompt(session.config, question, text, profile));
      feedback = reply ? parseFeedback(reply, question) : null;
      if (!feedback) feedbackError = 'The AI could not score this answer. Try again in a moment.';
    }
    const answer: PracticeAnswer = { questionId, answer: text, feedback, feedbackError, answeredAt: this.now().toISOString() };
    if (meta?.spoken) answer.delivery = analyzeDelivery(text, meta.durationMs ?? null);
    session.answers = [...session.answers.filter((a) => a.questionId !== questionId), answer];
    session.updatedAt = answer.answeredAt;
    this.save(session);
    return { session, answer };
  }

  finish(sessionId: string): PracticeSession {
    const session = this.require(sessionId);
    const order = new Map(session.questions.map((q, i) => [q.id, i]));
    session.answers.sort((a, b) => (order.get(a.questionId) ?? 0) - (order.get(b.questionId) ?? 0));
    session.report = buildReport(session.questions, session.answers);
    session.status = 'finished';
    session.updatedAt = this.now().toISOString();
    this.save(session);
    return session;
  }

  get(sessionId: string): PracticeSession | null {
    const row = this.deps.db.prepare(`SELECT session_json FROM ${PRACTICE_TABLE} WHERE id = ?`).get(sessionId) as { session_json?: string } | undefined;
    if (!row?.session_json) return null;
    try { return JSON.parse(row.session_json) as PracticeSession; } catch { return null; }
  }

  history(limit = 20): PracticeSummary[] {
    const rows = this.deps.db.prepare(`SELECT session_json FROM ${PRACTICE_TABLE} ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(100, limit))) as Array<{ session_json: string }>;
    const out: PracticeSummary[] = [];
    for (const r of rows) {
      try {
        const s = JSON.parse(r.session_json) as PracticeSession;
        const report = s.report ?? buildReport(s.questions, s.answers);
        out.push({
          id: s.id, createdAt: s.createdAt, role: s.config.role, company: s.config.company, kind: s.config.kind,
          averageScore: report.averageScore, answered: s.answers.length, total: s.questions.length, status: s.status,
        });
      } catch { /* a damaged row is skipped */ }
    }
    return out;
  }

  /** Every saved session, for progress (electron/practice/progress.ts). */
  all(): PracticeSession[] {
    const rows = this.deps.db.prepare(`SELECT session_json FROM ${PRACTICE_TABLE} ORDER BY created_at ASC`).all() as Array<{ session_json: string }>;
    const out: PracticeSession[] = [];
    for (const r of rows) { try { out.push(JSON.parse(r.session_json) as PracticeSession); } catch { /* skip a damaged row */ } }
    return out;
  }

  delete(sessionId: string): boolean {
    const res = this.deps.db.prepare(`DELETE FROM ${PRACTICE_TABLE} WHERE id = ?`).run(sessionId) as { changes?: number };
    return (res?.changes ?? 0) > 0;
  }

  private require(sessionId: string): PracticeSession {
    const s = this.get(sessionId);
    if (!s) throw new Error('This practice session no longer exists.');
    return s;
  }

  private save(s: PracticeSession): void {
    this.deps.db.prepare(`INSERT INTO ${PRACTICE_TABLE} (id, created_at, updated_at, session_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, session_json = excluded.session_json`)
      .run(s.id, s.createdAt, s.updatedAt, JSON.stringify(s));
  }

  /** One model call with a timeout. Null on no model, timeout or error. */
  private async ask(prompt: string): Promise<string | null> {
    const generate = this.deps.generate();
    if (!generate) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        generate(prompt),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs); }),
      ]);
    } catch (e: any) {
      console.warn('[Practice] model call failed:', e?.message || e);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
