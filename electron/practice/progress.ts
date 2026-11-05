// Progress across mock interviews (PrepPilot): scores over time, by question
// type, the trend, and what keeps coming up to improve. Pure: computed from the
// saved sessions, no model call, no platform branches.

import { buildReport, type InterviewKind } from './mockInterview';
import type { PracticeSession } from './PracticeService';

export interface ProgressPoint {
  id: string;
  createdAt: string;
  role: string;
  kind: InterviewKind;
  averageScore: number;
}

export interface PracticeProgress {
  /** Sessions with at least one scored answer. */
  sessions: number;
  answers: number;
  averageScore: number | null;
  /** The last 10 scored sessions, oldest first (for the chart). */
  recent: ProgressPoint[];
  byKind: Array<{ kind: InterviewKind; sessions: number; averageScore: number }>;
  /** Average of the last 3 scored sessions minus the 3 before; null with fewer than 4. */
  trend: number | null;
  /** Improvements that recur across sessions, most frequent first. */
  focusAreas: string[];
  averageWpm: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const theme = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();

export function computeProgress(all: PracticeSession[]): PracticeProgress {
  const scored = all
    .map((s) => ({ s, report: s.report ?? buildReport(s.questions, s.answers) }))
    .filter((x) => x.report.averageScore !== null)
    .sort((a, b) => a.s.createdAt.localeCompare(b.s.createdAt));

  const points: ProgressPoint[] = scored.map(({ s, report }) => ({
    id: s.id, createdAt: s.createdAt, role: s.config.role, kind: s.config.kind, averageScore: report.averageScore as number,
  }));

  const allScores = scored.flatMap(({ s }) => s.answers.filter((a) => a.feedback).map((a) => a.feedback!.score));
  const kinds: InterviewKind[] = ['mixed', 'behavioral', 'technical'];
  const byKind = kinds
    .map((kind) => {
      const pts = points.filter((p) => p.kind === kind);
      return { kind, sessions: pts.length, averageScore: round1(mean(pts.map((p) => p.averageScore))) };
    })
    .filter((k) => k.sessions > 0);

  let trend: number | null = null;
  if (points.length >= 4) {
    const last = points.slice(-3).map((p) => p.averageScore);
    const before = points.slice(-6, -3).map((p) => p.averageScore);
    trend = round1(mean(last) - mean(before));
  }

  const counts = new Map<string, { text: string; sessions: Set<string> }>();
  for (const { s } of scored) {
    for (const a of s.answers) {
      for (const imp of a.feedback?.improvements ?? []) {
        const k = theme(imp);
        if (!k) continue;
        const e = counts.get(k) ?? { text: imp, sessions: new Set<string>() };
        e.sessions.add(s.id);
        counts.set(k, e);
      }
    }
  }
  const focusAreas = [...counts.values()]
    .filter((e) => e.sessions.size > 1 || scored.length === 1)
    .sort((a, b) => b.sessions.size - a.sessions.size)
    .slice(0, 3)
    .map((e) => e.text);

  const wpms = scored.flatMap(({ s }) => s.answers.map((a) => a.delivery?.wpm).filter((w): w is number => typeof w === 'number'));

  return {
    sessions: points.length,
    answers: allScores.length,
    averageScore: allScores.length ? round1(mean(allScores)) : null,
    recent: points.slice(-10),
    byKind,
    trend,
    focusAreas,
    averageWpm: wpms.length ? Math.round(mean(wpms)) : null,
  };
}
