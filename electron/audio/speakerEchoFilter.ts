// Drops the microphone's copy of what the call just said (PrepPilot).
//
// On laptop speakers the microphone hears the other side, so every interviewer
// sentence came back a second time as the user's ("Can you tell me about a
// time…" from both channels, measured in a scripted call). Headphones avoid it;
// this makes speakers usable too. A user segment is an echo when most of its
// words were said on the call audio in the last few seconds. Interviewer
// partials count as well, since both channels transcribe the same sound at
// about the same time and the user's copy can land first.
//
// Pure (the clock is injected), no platform branches: the echo is acoustic and
// the same on macOS and Windows.

export interface EchoFilterOptions {
  /** How long interviewer text stays comparable, in ms. */
  windowMs?: number;
  /** Share of the user's words that must appear in recent interviewer text. */
  threshold?: number;
  /** Shorter user segments are never treated as echo ("yes", "okay, sure"). */
  minWords?: number;
  now?: () => number;
}

const words = (text: string): string[] =>
  String(text ?? '').toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) ?? [];

export class SpeakerEchoFilter {
  private recent: Array<{ at: number; words: Set<string> }> = [];
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly minWords: number;
  private readonly now: () => number;
  /** How many user segments were dropped (for one log line per meeting). */
  dropped = 0;

  constructor(opts: EchoFilterOptions = {}) {
    this.windowMs = opts.windowMs ?? 8_000;
    this.threshold = opts.threshold ?? 0.7;
    this.minWords = opts.minWords ?? 4;
    this.now = opts.now ?? Date.now;
  }

  /** Record what the call audio said (partials and finals). */
  noteInterviewer(text: string): void {
    const w = words(text);
    if (!w.length) return;
    const at = this.now();
    this.prune(at);
    this.recent.push({ at, words: new Set(w) });
  }

  /** True when this user segment repeats recent call audio. */
  isEcho(userText: string): boolean {
    const w = words(userText);
    if (w.length < this.minWords) return false;
    this.prune(this.now());
    if (!this.recent.length) return false;
    const heard = new Set<string>();
    for (const r of this.recent) for (const x of r.words) heard.add(x);
    const matched = w.filter((x) => heard.has(x)).length;
    const echo = matched / w.length >= this.threshold;
    if (echo) this.dropped++;
    return echo;
  }

  reset(): void {
    this.recent = [];
    this.dropped = 0;
  }

  private prune(at: number): void {
    const cutoff = at - this.windowMs;
    if (this.recent.length && this.recent[0].at < cutoff) this.recent = this.recent.filter((r) => r.at >= cutoff);
  }
}
