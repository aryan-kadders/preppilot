// PrepPilot company research (electron/profile/companyResearch.ts): grounded
// dossiers from web search, AI-only overviews that never invent numbers, the
// cache, the Tavily provider, and the background run after a JD upload. Search,
// model and fetch are injected; SQLite is real (in memory). No platform branches.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST = path.join(ROOT, 'dist-electron/electron/profile');
const HAVE_BUILD = fs.existsSync(path.join(DIST, 'companyResearch.js'));
let Database = null;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch { Database = null; }
const SKIP = !HAVE_BUILD ? 'run `npm run build:electron` first' : !Database ? 'better-sqlite3 not loadable' : false;
const cr = HAVE_BUILD ? require(path.join(DIST, 'companyResearch.js')) : {};

const SOURCES = [
  { title: 'Acme interviews', url: 'https://example.com/a', content: 'Acme runs four rounds: recruiter, coding, system design, values.' },
  { title: 'Acme reviews', url: 'https://example.com/b', content: 'Rated 4.1 overall; work-life balance 3.8.' },
];
const FULL_REPLY = JSON.stringify({
  summary: 'Acme builds rockets.', hiring_strategy: 'Generalists.', interview_focus: 'System design.', interview_difficulty: 'hard',
  culture_ratings: { overall: 4.1, work_life_balance: 3.8, management: 9 },
  salary_estimates: [{ title: 'Engineer', location: 'Remote', min: 120000, max: 160000, currency: 'USD', confidence: 'medium' }, { title: 'Bad', min: 200, max: 100 }],
  benefits: ['Remote'], core_values: ['Ownership'], critics: [{ category: 'Pace', complaint: 'Long hours', frequency: 'common' }],
  recent_news: 'Raised a round.', used_sources: [1],
});

describe('dossier parsing', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  const at = new Date('2026-11-05T00:00:00Z');

  test('with sources: numbers kept within range, bad salary rows dropped, only used sources cited', () => {
    const d = cr.parseDossier(FULL_REPLY, 'Acme', SOURCES, at);
    assert.equal(d.interview_difficulty, 'hard');
    assert.deepEqual(d.culture_ratings, { overall: 4.1, work_life_balance: 3.8 }, 'an out-of-range rating is dropped');
    assert.equal(d.salary_estimates.length, 1);
    assert.equal(d.recent_news, 'Raised a round.');
    assert.deepEqual(d.sources, [{ title: 'Acme interviews', url: 'https://example.com/a' }]);
  });

  test('without sources: ratings, salaries, news, benefits and criticisms are never kept', () => {
    const d = cr.parseDossier(FULL_REPLY, 'Acme', [], at);
    for (const k of ['culture_ratings', 'salary_estimates', 'recent_news', 'benefits', 'critics']) assert.equal(d[k], undefined, k);
    assert.equal(d.summary, 'Acme builds rockets.');
    assert.deepEqual(d.sources, []);
  });

  test('an empty or unusable reply is no dossier', () => {
    assert.equal(cr.parseDossier('{"core_values":["x"]}', 'Acme', [], at), null);
    assert.equal(cr.parseDossier('nope', 'Acme', [], at), null);
  });

  test('the prompts: grounded one lists numbered sources; AI-only one forbids numbers', () => {
    const g = cr.buildDossierPrompt('Acme', { title: 'Engineer' }, SOURCES);
    assert.match(g, /using ONLY the numbered sources/);
    assert.match(g, /\[1\] Acme interviews — https:\/\/example\.com\/a/);
    const u = cr.buildDossierPrompt('Acme', {}, []);
    assert.match(u, /Do NOT give ratings, salary figures, numbers or news/);
    assert.doesNotMatch(u, /salary_estimates/);
  });
});

describe('CompanyResearchEngine', { skip: SKIP }, () => {
  const make = (reply = FULL_REPLY) => {
    const calls = { search: [], generate: 0 };
    let t = new Date('2026-11-05T00:00:00Z');
    const engine = new cr.CompanyResearchEngine({
      db: new Database(':memory:'),
      generate: () => async () => { calls.generate++; return reply; },
      now: () => t,
    });
    engine.setSearchProvider({ search: async (q) => { calls.search.push(q); return SOURCES; } });
    return { engine, calls, advance: (ms) => { t = new Date(t.getTime() + ms); } };
  };

  test('researches with search, caches, reuses the cache, and refreshes when forced or a week old', async () => {
    const { engine, calls, advance } = make();
    const d = await engine.researchCompany('Acme', { title: 'Engineer' });
    assert.equal(d.company, 'Acme');
    assert.equal(calls.generate, 1);
    assert.ok(calls.search.length >= 1 && calls.search[0].includes('Acme Engineer'));
    assert.deepEqual(engine.getCachedDossier('ACME'), d, 'cached, case-insensitive');
    await engine.researchCompany('Acme');
    assert.equal(calls.generate, 1, 'cache hit');
    await engine.researchCompany('Acme', {}, true);
    assert.equal(calls.generate, 2, 'forced');
    advance(8 * 24 * 3600 * 1000);
    await engine.researchCompany('Acme');
    assert.equal(calls.generate, 3, 'stale after a week');
  });

  test('a failing search still yields an AI-only overview; a spent quota stops searching', async () => {
    const { engine } = make();
    engine.setSearchProvider({ search: async () => { throw new Error('down'); } });
    const d = await engine.researchCompany('Globex');
    assert.deepEqual(d.sources, []);
    assert.equal(d.culture_ratings, undefined);
    const spent = { quotaExhausted: false, n: 0, async search() { this.n++; this.quotaExhausted = true; return []; } };
    engine.setSearchProvider(spent);
    await engine.researchCompany('Initech', {}, true);
    assert.equal(spent.n, 1);
  });

  test('no AI connected: nothing new, the cache is returned', async () => {
    const engine = new cr.CompanyResearchEngine({ db: new Database(':memory:'), generate: () => null });
    assert.equal(await engine.researchCompany('Acme'), null);
  });
});

describe('TavilySearchProvider', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  test('sends the key, maps results, keeps https only, and marks a spent quota', async () => {
    const sent = [];
    const ok = new cr.TavilySearchProvider('tvly-KEY', async (url, init) => {
      sent.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ results: [{ title: 'A', url: 'https://a.example', content: 'x' }, { title: 'B', url: 'http://b.example', content: 'y' }] }) };
    });
    const r = await ok.search('Acme interview');
    assert.deepEqual(r, [{ title: 'A', url: 'https://a.example', content: 'x' }]);
    assert.equal(sent[0].url, 'https://api.tavily.com/search');
    assert.equal(sent[0].init.headers.Authorization, 'Bearer tvly-KEY');
    assert.equal(JSON.parse(sent[0].init.body).query, 'Acme interview');
    const spent = new cr.TavilySearchProvider('k', async () => ({ ok: false, status: 432, json: async () => ({}) }));
    assert.deepEqual(await spent.search('q'), []);
    assert.equal(spent.quotaExhausted, true);
  });
});

describe('background research after a JD upload', { skip: SKIP }, () => {
  test('a JD naming its company is researched, and the result reaches the answer context', async () => {
    const { ProfileOrchestrator } = require(path.join(DIST, 'ProfileOrchestrator.js'));
    const { ProfileStore } = require(path.join(DIST, 'ProfileStore.js'));
    const { DocType } = require(path.join(DIST, 'types.js'));
    const orch = new ProfileOrchestrator(new ProfileStore(new Database(':memory:')), {
      extractText: async () => ({ content: 'Staff Engineer at Acme. Requirements: Go, Kubernetes, distributed systems.', fileName: 'jd.txt' }),
      resolveSearchProvider: () => ({ search: async () => SOURCES }),
    });
    orch.setGenerateContentFn(async (c) => (/job description as JSON/.test(c[0].text)
      ? JSON.stringify({ title: 'Staff Engineer', company: 'Acme', requirements: ['Go'] })
      : FULL_REPLY));
    await orch.ingestDocument(path.join(ROOT, 'jd.txt'), DocType.JD);
    assert.equal(orch.getProfileData().aotStatus.companyResearch, 'running');
    for (let i = 0; i < 50 && orch.getProfileData().aotStatus.companyResearch === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(orch.getProfileData().aotStatus.companyResearch, 'idle');
    assert.equal(orch.getCompanyResearchEngine().getCachedDossier('Acme').interview_focus, 'System design.');
    orch.setKnowledgeMode(true);
    const ctx = await orch.processQuestion('Why Acme?');
    assert.match(ctx.contextBlock, /<company_research company="Acme" source="web research">/);
    assert.match(ctx.contextBlock, /Interview focus: System design\./);
  });
});

test('wiring: a Tavily key uses PrepPilot\'s provider; practice feedback sees the research', () => {
  const r = fs.readFileSync(path.join(ROOT, 'electron/services/resolveCompanySearchProvider.ts'), 'utf8');
  assert.match(r, /require\('\.\.\/profile\/companyResearch'\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'electron/practice/practiceIpc.ts'), 'utf8'), /o\.companyContextBlock\(\)/);
});
