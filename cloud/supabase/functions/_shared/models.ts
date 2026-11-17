// The AI models behind /v1/chat, and the order they are tried in.
//
// Each answer is either "fast" (a live answer: first words matter most) or
// "long" (a whole-project build: completeness matters most). Each tier is an
// ordered list of models from different providers; the router (router.ts)
// tries them in turn, so one provider's outage, rate limit or spending cap
// never leaves a candidate without an answer. A provider without a key on the
// server is skipped, so Claude switches on by itself once ANTHROPIC_API_KEY
// is set. MODEL_ROUTES (a secret) overrides the order, e.g.
//   {"fast":["claude:claude-haiku-5-5","gemini:gemini-3.8-flash"],"long":["claude:claude-sonnet-5-5"]}

export type Provider = 'gemini' | 'claude';
export type Tier = 'fast' | 'long';

export interface ModelRef { provider: Provider; model: string }

export interface ChatBody {
  messages: Array<{ role?: string; content?: unknown }>;
  system?: string;
  stream?: boolean;
  images?: Array<{ mime_type?: string; data?: string }>;
  /** "long" for a whole-project build; anything else is a live answer. */
  model_tier?: string;
}

export interface ModelEvent { text?: string; usage?: { input: number; output: number } }

export class ProviderError extends Error {
  provider: string;
  model: string;
  status: number;
  detail: string;
  // Fields assigned by hand: Node's type stripping (the tests) has no parameter properties.
  constructor(provider: string, model: string, status: number, detail: string) {
    super(`${provider}/${model} refused (HTTP ${status})`);
    this.provider = provider;
    this.model = model;
    this.status = status;
    this.detail = detail;
  }
}

export const DEFAULT_ROUTES: Record<Tier, string[]> = {
  fast: ['claude:claude-haiku-5-5', 'gemini:gemini-3.1-flash-lite', 'gemini:gemini-3.8-flash'],
  long: ['claude:claude-sonnet-5-5', 'gemini:gemini-3.8-flash'],
};

// An organization's AI plan (organizations.ai_quality, set by its admin on the
// dashboard). 'standard' uses DEFAULT_ROUTES (or MODEL_ROUTES); 'premium' puts
// the stronger, pricier Claude models first. Chosen from a blind test of 9
// models on 12 interview questions (Nov 2026): Sonnet 5.5 scored best and starts
// answering in ~0.85s; Gemini 3.8 Flash is the best Gemini that starts within
// ~2s; Opus 5.5 is the strongest for long builds.
export type Quality = 'standard' | 'premium';
export const PREMIUM_ROUTES: Record<Tier, string[]> = {
  fast: ['claude:claude-sonnet-5-5', 'gemini:gemini-3.8-flash', 'claude:claude-haiku-5-5'],
  long: ['claude:claude-opus-5-5', 'claude:claude-sonnet-5-5', 'gemini:gemini-4-argon'],
};
export function qualityOf(v: unknown): Quality {
  return v === 'premium' ? 'premium' : 'standard';
}

// How long a model may take to its first words before the next one is tried.
// A long build plans before it writes, so it gets more time.
export const FIRST_TOKEN_TIMEOUT_MS: Record<Tier, number> = { fast: 6_000, long: 20_000 };

// USD per 1M tokens [input, output]. Claude: Anthropic list prices. Gemini:
// estimates; set MODEL_PRICES (same shape) to your bill's rates.
export const DEFAULT_PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2.00, 10.00],
  'claude-opus-5-5': [4.00, 20.00],
  'gemini-3.1-flash-lite': [0.25, 1.50],
  'gemini-3.5-flash-lite': [0.30, 2.50],
  'gemini-3.8-flash': [0.75, 3.75],
  'gemini-4-argon': [2.00, 10.00],
};

export function parseRef(s: string): ModelRef | null {
  const m = /^(gemini|claude):([a-z0-9.\-]+)$/.exec(String(s).trim());
  return m ? { provider: m[1] as Provider, model: m[2] } : null;
}

/** The models to try for a tier, in order, keeping only providers this server has keys for. */
export function routeFor(tier: Tier, available: Record<Provider, boolean>, override?: Partial<Record<Tier, string[]>>, quality: Quality = 'standard'): ModelRef[] {
  // MODEL_ROUTES overrides the standard plan only; premium keeps its own list.
  const list = quality === 'premium' ? PREMIUM_ROUTES[tier] : override?.[tier]?.length ? override[tier]! : DEFAULT_ROUTES[tier];
  const seen = new Set<string>();
  return list.map(parseRef).filter((r): r is ModelRef => {
    if (!r || !available[r.provider]) return false;
    const key = `${r.provider}:${r.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function tierOf(body: { model_tier?: unknown }): Tier {
  return body.model_tier === 'long' ? 'long' : 'fast';
}

export function costUsd(model: string, input: number, output: number, prices: Record<string, [number, number]>): number {
  const [pin, pout] = prices[model] ?? DEFAULT_PRICES[model] ?? [0, 0];
  return Math.round(((input * pin + output * pout) / 1_000_000) * 1e6) / 1e6;
}
