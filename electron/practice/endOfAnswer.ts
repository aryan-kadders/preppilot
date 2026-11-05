// Ends a spoken mock-interview answer when the speaker stops talking (PrepPilot).
//
// Fed 16-bit mono PCM chunks from the microphone. Speech is a chunk whose RMS
// stands clearly above the room's noise floor. The floor is calibrated from the
// quietest chunk of the first `calibrationMs` (the gaps between syllables are
// quiet even if the speaker starts at once), then tracks the minimum: it falls
// at once and rises slowly, so steady fan or AC noise is never taken for speech;
// the answer is over once speech has been heard and then `silenceMs` passes
// without any. If nothing is said at all for `noSpeechMs`, it gives up so the
// recording never runs on forever. Pure: the clock is injected and nothing here
// depends on the platform or the capture backend (native or Chromium fallback).

export interface EndOfAnswerOptions {
  /** Quiet after speech that ends the answer. */
  silenceMs?: number;
  /** Give up if no speech is heard at all. */
  noSpeechMs?: number;
  /** Speech must be at least this loud (int16 RMS), whatever the noise floor. */
  minSpeechRms?: number;
  /** The opening stretch used only to learn the noise floor. */
  calibrationMs?: number;
  now?: () => number;
}

export type EndOfAnswerVerdict = 'continue' | 'answer-ended' | 'no-speech';

export function pcmRms(chunk: Buffer): number {
  const n = Math.floor(chunk.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = chunk.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

export class EndOfAnswerDetector {
  private readonly silenceMs: number;
  private readonly noSpeechMs: number;
  private readonly minSpeechRms: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly calibrationMs: number;
  private noiseFloor = Infinity;
  private heardSpeech = false;
  private lastSpeechAt = 0;
  private done = false;

  constructor(opts: EndOfAnswerOptions = {}) {
    this.silenceMs = opts.silenceMs ?? 2_200;
    this.noSpeechMs = opts.noSpeechMs ?? 12_000;
    this.minSpeechRms = opts.minSpeechRms ?? 350;
    this.calibrationMs = opts.calibrationMs ?? 400;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Feed one chunk; returns what to do. Only the first ending verdict is returned. */
  push(chunk: Buffer): EndOfAnswerVerdict {
    if (this.done) return 'continue';
    const at = this.now();
    const rms = pcmRms(chunk);
    // The floor falls at once to any quieter chunk. It rises only from chunks
    // that are not speech (slowly: 0.1% of the gap per 20 ms chunk), so however
    // long someone talks without a pause, their voice never becomes the floor.
    if (rms < this.noiseFloor) this.noiseFloor = rms;
    if (at - this.startedAt < this.calibrationMs) return 'continue';
    const threshold = Math.max(this.minSpeechRms, this.noiseFloor * 3);
    if (rms >= threshold) {
      this.heardSpeech = true;
      this.lastSpeechAt = at;
    } else {
      this.noiseFloor += (rms - this.noiseFloor) * 0.001;
    }
    if (this.heardSpeech && at - this.lastSpeechAt >= this.silenceMs) {
      this.done = true;
      return 'answer-ended';
    }
    if (!this.heardSpeech && at - this.startedAt >= this.noSpeechMs) {
      this.done = true;
      return 'no-speech';
    }
    return 'continue';
  }
}
