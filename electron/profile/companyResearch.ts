// Company research for the active job (PrepPilot): a "dossier" on the company
// — how it hires, what its interviews focus on, culture, pay, values, common
// criticisms and recent news — shown in Profile Intelligence and used to
// prepare. Upstream's engine was premium; this is PrepPilot's own.
//
// With a Tavily key (Settings › Connections) it searches the web first and the
// model writes ONLY from those sources, citing them. Without one it is an
// AI-only overview: qualitative guidance from the model's general knowledge,
// and never numbers (ratings, salaries), which would be invented. The panel
// already labels a dossier with no sources as AI-only.
//
// Pure helpers + an engine with injected search, model, clock and SQLite, so
// all of it is unit-tested. No platform branches; network through fetch.

import { parseModelJson } from './profileExtraction';
import type { SqliteLike } from './ProfileStore';

export interface SearchResult { title: string; url: string; content: string }

export interface CompanySearchProvider {
  search(query: string): Promise<SearchResult[]>;
  quotaExhausted?: boolean;
}

export interface JdContext {
  title?: string;
  location?: string;
  level?: string;
  technologies?: string[];
  requirements?: string[];
}

export interface CompanyDossier {
  company: string;
  summary?: string;
  hiring_strategy?: string;
  interview_focus?: string;
  interview_difficulty?: 'easy' | 'medium' | 'hard' | 'very_hard';
  culture_ratings?: { overall: number; work_life_balance?: number; career_growth?: number; compensation?: number; management?: number };
  salary_estimates?: Array<{ title: string; location?: string; min: number; max: number; currency: string; confidence: 'low' | 'medium' | 'high' }>;
  benefits?: string[];
  core_values?: string[];
  critics?: Array<{ category: string; complaint: string; frequency: 'rare' | 'some' | 'common' }>;
  recent_news?: string;
  /** Empty for an AI-only dossier. */
  sources: Array<{ title: string; url: string }>;
  generated_at: string;
}

export const DOSSIER_TABLE = 'preppilot_company_dossiers';
export const DOSSIER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SOURCE_CHARS = 900;
const MAX_SOURCES = 12;

export const companyKey = (company: string) => company.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function researchQueries(company: string, jd: JdContext): string[] {
  const role = jd.title ? ` ${jd.title}` : '';
  return [
    `${company}${role} interview process questions`,
    `${company} company culture values employee reviews`,
    `${company}${role} salary range`,
    `${company} news this year`,
  ];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildDossierPrompt(company: string, jd: JdContext, sources: SearchResult[]): string {
  const role = [jd.level, jd.title].filter(Boolean).join(' ');
  const jdLine = role || jd.technologies?.length
    ? `The candidate is applying for: ${role || 'a role'}${jd.location ? ` (${jd.location})` : ''}${jd.technologies?.length ? `; stack: ${jd.technologies.slice(0, 10).join(', ')}` : ''}.`
    : '';
  if (sources.length) {
    const list = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${clip(s.content.replace(/\s+/g, ' ').trim(), MAX_SOURCE_CHARS)}`).join('\n\n');
    return `Write a company research brief on ${company} for a job candidate, using ONLY the numbered sources below. If the sources do not state something, leave that field out. Never invent ratings, salaries, numbers or news.
${jdLine}

SOURCES:
${list}

Return ONLY a JSON object (omit any field the sources do not support):
{"summary": string, "hiring_strategy": string, "interview_focus": string, "interview_difficulty": "easy"|"medium"|"hard"|"very_hard",
 "culture_ratings": {"overall": number, "work_life_balance": number, "career_growth": number, "compensation": number, "management": number},
 "salary_estimates": [{"title": string, "location": string, "min": number, "max": number, "currency": string, "confidence": "low"|"medium"|"high"}],
 "benefits": string[], "core_values": string[], "critics": [{"category": string, "complaint": string, "frequency": "rare"|"some"|"common"}],
 "recent_news": string, "used_sources": number[]}
Ratings are 0-5 as the sources give them. "used_sources" lists the source numbers you relied on. Each text field at most 3 sentences.`;
  }
  return `Write a short preparation brief on ${company} for a job candidate, from your general knowledge. It may be out of date, so stay general and say nothing you are unsure of.
${jdLine}
Do NOT give ratings, salary figures, numbers or news: there are no sources to support them.

Return ONLY a JSON object (omit any field you cannot say with confidence):
{"summary": string, "hiring_strategy": string, "interview_focus": string, "interview_difficulty": "easy"|"medium"|"hard"|"very_hard", "core_values": string[]}
Each text field at most 3 sentences.`;
}

const text = (v: unknown, max = 900) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s && !/^(n\/?a|none|unknown|not stated)$/i.test(s) ? s.slice(0, max) : undefined;
};
const list = (v: unknown, max = 8) => (Array.isArray(v) ? v : []).map((x) => text(x, 200)).filter((x): x is string => !!x).slice(0, max);
const rating = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n * 10) / 10 : undefined; };
const DIFFICULTY = new Set(['easy', 'medium', 'hard', 'very_hard']);

/**
 * Normalise the model's dossier. Without sources the numeric and news fields
 * are dropped whatever the model returned: they could only be invented.
 */
export function parseDossier(reply: unknown, company: string, sources: SearchResult[], at: Date): CompanyDossier | null {
  const p = parseModelJson(reply) as any;
  if (!p) return null;
  const grounded = sources.length > 0;
  const d: CompanyDossier = { company, sources: [], generated_at: at.toISOString() };
  const set = <K extends keyof CompanyDossier>(k: K, v: CompanyDossier[K] | undefined) => { if (v !== undefined && !(Array.isArray(v) && !v.length)) d[k] = v; };
  set('summary', text(p.summary));
  set('hiring_strategy', text(p.hiring_strategy));
  set('interview_focus', text(p.interview_focus));
  if (DIFFICULTY.has(p.interview_difficulty)) d.interview_difficulty = p.interview_difficulty;
  set('core_values', list(p.core_values));
  if (grounded) {
    set('benefits', list(p.benefits));
    set('recent_news', text(p.recent_news));
    const r = p.culture_ratings;
    const overall = rating(r?.overall);
    if (overall !== undefined) {
      d.culture_ratings = { overall };
      for (const k of ['work_life_balance', 'career_growth', 'compensation', 'management'] as const) {
        const v = rating(r?.[k]);
        if (v !== undefined) d.culture_ratings[k] = v;
      }
    }
    const salaries = (Array.isArray(p.salary_estimates) ? p.salary_estimates : [])
      .map((s: any) => ({ title: text(s?.title, 80) ?? '', location: text(s?.location, 80), min: Number(s?.min), max: Number(s?.max), currency: text(s?.currency, 8) ?? 'USD', confidence: (['low', 'medium', 'high'].includes(s?.confidence) ? s.confidence : 'low') as 'low' | 'medium' | 'high' }))
      .filter((s: any) => s.title && Number.isFinite(s.min) && Number.isFinite(s.max) && s.min > 0 && s.max >= s.min)
      .slice(0, 4);
    set('salary_estimates', salaries);
    const critics = (Array.isArray(p.critics) ? p.critics : [])
      .map((c: any) => ({ category: text(c?.category, 60) ?? '', complaint: text(c?.complaint, 240) ?? '', frequency: (['rare', 'some', 'common'].includes(c?.frequency) ? c.frequency : 'some') as 'rare' | 'some' | 'common' }))
      .filter((c: any) => c.category && c.complaint)
      .slice(0, 4);
    set('critics', critics);
    const used = new Set((Array.isArray(p.used_sources) ? p.used_sources : []).map(Number).filter((n: number) => n >= 1 && n <= sources.length));
    const cited = used.size ? sources.filter((_, i) => used.has(i + 1)) : sources;
    d.sources = cited.map((s) => ({ title: s.title, url: s.url }));
  }
  return d.summary || d.hiring_strategy || d.interview_focus ? d : null;
}

/** Tavily web search (free tier). The key is the user's, from Settings › Connections. */
export class TavilySearchProvider implements CompanySearchProvider {
  quotaExhausted = false;
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async search(query: string): Promise<SearchResult[]> {
    const res = await this.fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      // The key as a Bearer header (current API) and in the body (older API).
      body: JSON.stringify({ api_key: this.apiKey, query, max_results: 4, search_depth: 'basic', include_answer: false }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 || res.status === 432 || res.status === 433) { this.quotaExhausted = true; return []; }
    if (!res.ok) throw new Error(`Tavily search failed (${res.status})`);
    const data: any = await res.json();
    return (Array.isArray(data?.results) ? data.results : [])
      .map((r: any) => ({ title: String(r?.title ?? '').slice(0, 200), url: String(r?.url ?? ''), content: String(r?.content ?? '') }))
      .filter((r: SearchResult) => /^https:\/\//.test(r.url) && r.content);
  }
}

export interface CompanyResearchDeps {
  db: SqliteLike;
  generate: () => ((prompt: string) => Promise<string>) | null;
  now?: () => Date;
}

export class CompanyResearchEngine {
  searchProvider: CompanySearchProvider | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: CompanyResearchDeps) {
    this.now = deps.now ?? (() => new Date());
    deps.db.exec(`CREATE TABLE IF NOT EXISTS ${DOSSIER_TABLE} (company_key TEXT PRIMARY KEY, dossier_json TEXT NOT NULL, created_at TEXT NOT NULL)`);
  }

  setSearchProvider(provider: CompanySearchProvider | null): void { this.searchProvider = provider; }

  getCachedDossier(company: string): CompanyDossier | null {
    if (!company?.trim()) return null;
    const row = this.deps.db.prepare(`SELECT dossier_json FROM ${DOSSIER_TABLE} WHERE company_key = ?`).get(companyKey(company)) as { dossier_json?: string } | undefined;
    if (!row?.dossier_json) return null;
    try { return JSON.parse(row.dossier_json) as CompanyDossier; } catch { return null; }
  }

  /** Research (or return the cached dossier unless `force` or older than a week). Null when no AI is connected or nothing usable came back. */
  async researchCompany(company: string, jd: JdContext = {}, force = false): Promise<CompanyDossier | null> {
    const name = String(company ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) return null;
    const cached = this.getCachedDossier(name);
    if (cached && !force && this.now().getTime() - Date.parse(cached.generated_at) < DOSSIER_TTL_MS) return cached;
    const generate = this.deps.generate();
    if (!generate) return cached;

    let sources: SearchResult[] = [];
    if (this.searchProvider) {
      const seen = new Set<string>();
      for (const q of researchQueries(name, jd)) {
        try {
          for (const r of await this.searchProvider.search(q)) {
            if (seen.has(r.url)) continue;
            seen.add(r.url);
            sources.push(r);
          }
        } catch (e: any) {
          console.warn('[CompanyResearch] search failed:', e?.message || e);
        }
        if (this.searchProvider.quotaExhausted || sources.length >= MAX_SOURCES) break;
      }
      sources = sources.slice(0, MAX_SOURCES);
    }

    let reply: string | null = null;
    try { reply = await generate(buildDossierPrompt(name, jd, sources)); } catch (e: any) { console.warn('[CompanyResearch] model failed:', e?.message || e); }
    const dossier = reply ? parseDossier(reply, name, sources, this.now()) : null;
    if (!dossier) return cached;
    this.deps.db.prepare(`INSERT INTO ${DOSSIER_TABLE} (company_key, dossier_json, created_at) VALUES (?, ?, ?)
      ON CONFLICT(company_key) DO UPDATE SET dossier_json = excluded.dossier_json, created_at = excluded.created_at`)
      .run(companyKey(name), JSON.stringify(dossier), dossier.generated_at);
    return dossier;
  }
}
