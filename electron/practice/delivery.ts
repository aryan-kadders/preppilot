// Delivery coaching for spoken mock-interview answers (PrepPilot): pace,
// filler words and length — "how you say it", next to the AI's feedback on
// "what you say". Pure, no model call, no platform branches.
//
// Caveat shown to the user: some speech engines (Apple Speech among them) tidy
// away "um" and "uh", so filler counts are a floor, not an exact tally.

export interface DeliveryStats {
  wordCount: number;
  durationMs: number | null;
  /** Words per minute; null for typed answers or very short recordings. */
  wpm: number | null;
  pace: 'slow' | 'good' | 'fast' | null;
  fillerCount: number;
  /** Fillers per 100 words. */
  fillerRate: number;
  fillers: Array<{ word: string; count: number }>;
  length: 'short' | 'good' | 'long';
  tips: string[];
}

export const PACE_SLOW_WPM = 110;
export const PACE_FAST_WPM = 170;
export const SHORT_WORDS = 40;
/** About two minutes of speech at a comfortable pace. */
export const LONG_WORDS = 300;

// Multi-word fillers first, so "you know" is not also counted as "know".
const FILLER_PATTERNS: Array<[string, RegExp]> = [
  ['you know', /\byou know\b(?!\s+(?:what|how|why|where|when|that|the|a|an|it|this)\b)/g],
  ['i mean', /\bi mean\b(?=[,.]|\s+(?:like|you|i|it|the|we)\b)/g],
  ['kind of', /\bkind of\b(?=\s+(?:like|just|really|um|uh)\b|[,.])/g],
  ['sort of', /\bsort of\b(?=\s+(?:like|just|really|um|uh)\b|[,.])/g],
  ['um', /\b(?:um+|umm+)\b/g],
  ['uh', /\b(?:uh+|uhh+)\b/g],
  ['erm', /\b(?:erm+|er)\b(?=[,.\s])/g],
  ['like', /(?:^|[,.?!]\s*|\b(?:was|is|and|it's|its)\s+)like,/g],
  ['basically', /\bbasically\b/g],
  ['actually', /\bactually\b/g],
  ['literally', /\bliterally\b/g],
  ['honestly', /\bhonestly\b/g],
];

const countWords = (text: string) => (text.match(/[A-Za-z0-9']+/g) ?? []).length;

export function analyzeDelivery(text: string, durationMs: number | null | undefined): DeliveryStats {
  const clean = String(text ?? '');
  const lower = clean.toLowerCase();
  const wordCount = countWords(clean);

  const fillers: Array<{ word: string; count: number }> = [];
  for (const [word, re] of FILLER_PATTERNS) {
    const n = (lower.match(re) ?? []).length;
    if (n) fillers.push({ word, count: n });
  }
  fillers.sort((a, b) => b.count - a.count);
  const fillerCount = fillers.reduce((s, f) => s + f.count, 0);
  const fillerRate = wordCount ? Math.round((fillerCount / wordCount) * 1000) / 10 : 0;

  const dur = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
  // Under ~8 s or ~15 words a pace figure is noise.
  const wpm = dur && dur >= 8_000 && wordCount >= 15 ? Math.round(wordCount / (dur / 60_000)) : null;
  const pace = wpm === null ? null : wpm < PACE_SLOW_WPM ? 'slow' : wpm > PACE_FAST_WPM ? 'fast' : 'good';
  const length = wordCount < SHORT_WORDS ? 'short' : wordCount > LONG_WORDS ? 'long' : 'good';

  const tips: string[] = [];
  if (pace === 'fast') tips.push(`You spoke at about ${wpm} words a minute. Slow down a little (around 130 to 160) and pause between points.`);
  if (pace === 'slow') tips.push(`You spoke at about ${wpm} words a minute. Aim for around 130 to 160 so the answer keeps its energy.`);
  if (fillerRate >= 5) {
    const top = fillers.slice(0, 2).map((f) => `"${f.word}"`).join(' and ');
    tips.push(`Filler words came up often (${top}). Replace them with a short pause; silence sounds more confident.`);
  }
  if (length === 'short') tips.push('This answer was short. Add one concrete example and the result it led to.');
  if (length === 'long') tips.push('This answer ran long. Lead with the point, give one example, and stop at around two minutes.');

  return { wordCount, durationMs: dur, wpm, pace, fillerCount, fillerRate, fillers, length, tips };
}

export interface DeliverySummary {
  spokenAnswers: number;
  averageWpm: number | null;
  totalFillers: number;
  topFillers: Array<{ word: string; count: number }>;
  longAnswers: number;
  shortAnswers: number;
}

export function summarizeDelivery(stats: DeliveryStats[]): DeliverySummary | null {
  if (!stats.length) return null;
  const paced = stats.filter((s) => s.wpm !== null);
  const counts = new Map<string, number>();
  for (const s of stats) for (const f of s.fillers) counts.set(f.word, (counts.get(f.word) ?? 0) + f.count);
  return {
    spokenAnswers: stats.length,
    averageWpm: paced.length ? Math.round(paced.reduce((a, s) => a + (s.wpm as number), 0) / paced.length) : null,
    totalFillers: stats.reduce((a, s) => a + s.fillerCount, 0),
    topFillers: [...counts.entries()].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count).slice(0, 3),
    longAnswers: stats.filter((s) => s.length === 'long').length,
    shortAnswers: stats.filter((s) => s.length === 'short').length,
  };
}
