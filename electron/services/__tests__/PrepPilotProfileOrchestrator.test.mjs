// PrepPilot Profile Intelligence — résumé and JD upload end to end through the
// orchestrator (electron/profile/ProfileOrchestrator.ts) over a real in-memory
// SQLite store. Text extraction and the model are injected, so the case runs
// the same on macOS and Windows; paths go through node:path only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST = path.join(ROOT, 'dist-electron/electron/profile');
const HAVE_BUILD = fs.existsSync(path.join(DIST, 'ProfileOrchestrator.js'));

let Database = null;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch { Database = null; }
const SKIP = !HAVE_BUILD ? 'run `npm run build:electron` first' : !Database ? 'better-sqlite3 not loadable in this runtime' : false;

const RESUME_TEXT = 'Ada Lovelace\nada@example.com\n\nSkills\nPython, Go\n\nExperience\nEngineer at Acme, Jan 2020 – Present\n';
const JD_TEXT = 'Staff Engineer\nGlobex\nRequirements\n- 5+ years of Go\nResponsibilities\n- Lead the platform team\n';

function setup({ reply, files = {}, timeoutMs } = {}) {
  const { ProfileOrchestrator } = require(path.join(DIST, 'ProfileOrchestrator.js'));
  const { ProfileStore } = require(path.join(DIST, 'ProfileStore.js'));
  const { DocType } = require(path.join(DIST, 'types.js'));
  const db = new Database(':memory:');
  const store = new ProfileStore(db);
  const calls = [];
  const extractText = async (p) => {
    const name = path.basename(p);
    if (!(name in files)) throw new Error('ENOENT');
    return { content: files[name], fileName: name };
  };
  const orch = new ProfileOrchestrator(store, { extractText, timeoutMs });
  if (reply !== undefined) orch.setGenerateContentFn(async (contents) => { calls.push(contents); return typeof reply === 'function' ? reply(contents) : reply; });
  return { orch, store, db, DocType, calls, ProfileOrchestrator };
}

const filePath = (name) => path.join(ROOT, 'test-fixtures', name);

describe('ProfileOrchestrator', { skip: SKIP }, () => {
  test('a résumé upload stores model-structured facts and reports them', async () => {
    const reply = JSON.stringify({
      name: 'Ada Lovelace', skills: ['Python', 'Go'],
      experience: [{ role: 'Engineer', company: 'Acme', start_date: 'Jan 2020', end_date: 'Present', bullets: ['Built things'] }],
    });
    const { orch, DocType, calls } = setup({ reply, files: { 'ada.pdf': RESUME_TEXT } });
    const res = await orch.ingestDocument(filePath('ada.pdf'), DocType.RESUME);
    assert.equal(res.success, true);
    assert.equal(res.extractionMode, 'llm');
    assert.equal(res.degraded, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0].text, /Extract the facts from this résumé as JSON/);
    assert.match(calls[0][0].text, /Ada Lovelace/, 'the résumé text is in the prompt');

    const r = orch.activeResume;
    assert.equal(r.structured_data.identity.name, 'Ada Lovelace');
    assert.equal(r.raw_text, RESUME_TEXT.trim());
    assert.equal(r.file_name, 'ada.pdf');
    assert.equal(r.source_uri, path.resolve(filePath('ada.pdf')));

    const status = orch.getStatus();
    assert.equal(status.hasResume, true);
    assert.equal(status.hasActiveJD, false);
    assert.equal(status.resumeSummary.name, 'Ada Lovelace');
    assert.equal(status.resumeSummary.role, 'Engineer');

    const data = orch.getProfileData();
    assert.equal(data.identity.name, 'Ada Lovelace');
    assert.deepEqual(data.skillsFlat, ['Python', 'Go']);
    assert.equal(data.experienceCount, 1);
    assert.equal(data.aotStatus.companyResearch, 'idle');
  });

  test('when the model fails, the upload still succeeds on the heuristic pass', async () => {
    const { orch, DocType } = setup({ reply: () => { throw new Error('no provider configured'); }, files: { 'ada.docx': RESUME_TEXT } });
    const res = await orch.ingestDocument(filePath('ada.docx'), DocType.RESUME);
    assert.equal(res.success, true);
    assert.equal(res.extractionMode, 'heuristic');
    assert.equal(res.degraded, true);
    assert.equal(orch.activeResume.structured_data.identity.name, 'Ada Lovelace');
    assert.deepEqual(orch.activeResume.structured_data.skills, ['Python', 'Go']);
  });

  test('a model that never answers times out into the heuristic pass', async () => {
    const { orch, DocType } = setup({ reply: () => new Promise(() => {}), files: { 'jd.txt': JD_TEXT }, timeoutMs: 30 });
    const res = await orch.ingestDocument(filePath('jd.txt'), DocType.JD);
    assert.equal(res.success, true);
    assert.equal(res.extractionMode, 'heuristic');
    assert.equal(orch.activeJD.structured_data.title, 'Staff Engineer');
    assert.deepEqual(orch.activeJD.structured_data.requirements, ['5+ years of Go']);
  });

  test('an unreadable or empty file is refused with a reason, and nothing is stored', async () => {
    const { orch, DocType } = setup({ reply: '{}', files: { 'scan.pdf': '   \n  ' } });
    const empty = await orch.ingestDocument(filePath('scan.pdf'), DocType.RESUME);
    assert.equal(empty.success, false);
    assert.match(empty.error, /No readable text/);
    const missing = await orch.ingestDocument(filePath('gone.pdf'), DocType.RESUME);
    assert.equal(missing.success, false);
    assert.match(missing.error, /Could not read the file/);
    assert.equal(orch.activeResume, null);
    assert.equal(orch.getProfileData(), null);
  });

  test('documents survive a restart: a new orchestrator over the same database reads them back', async () => {
    const { orch, store, DocType, ProfileOrchestrator } = setup({ reply: JSON.stringify({ title: 'Staff Engineer', company: 'Globex' }), files: { 'jd.md': JD_TEXT } });
    await orch.ingestDocument(filePath('jd.md'), DocType.JD);
    const again = new ProfileOrchestrator(store);
    assert.equal(again.activeJD.structured_data.company, 'Globex');
    assert.equal(again.activeJD.id, orch.activeJD.id);
    assert.equal(again.getStatus().hasActiveJD, true);
  });

  test('a new résumé replaces the old one with a new id; delete clears only its type', async () => {
    const { orch, DocType } = setup({ reply: (c) => JSON.stringify({ name: /Grace/.test(c[0].text) ? 'Grace Hopper' : 'Ada Lovelace', title: 'Staff Engineer' }), files: { 'a.txt': RESUME_TEXT, 'b.txt': RESUME_TEXT.replace('Ada Lovelace', 'Grace Hopper'), 'jd.txt': JD_TEXT } });
    await orch.ingestDocument(filePath('a.txt'), DocType.RESUME);
    const firstId = orch.activeResume.id;
    await orch.ingestDocument(filePath('b.txt'), DocType.RESUME);
    assert.notEqual(orch.activeResume.id, firstId);
    assert.equal(orch.activeResume.structured_data.identity.name, 'Grace Hopper');
    await orch.ingestDocument(filePath('jd.txt'), DocType.JD);

    orch.deleteDocumentsByType(DocType.RESUME);
    assert.equal(orch.activeResume, null);
    assert.ok(orch.activeJD, 'the JD stays');
    assert.equal(orch.getStatus().hasResume, false);
  });

  test('profile mode gates the answer context, which carries résumé and JD', async () => {
    const { orch, DocType } = setup({ reply: (c) => (/résumé/.test(c[0].text) ? JSON.stringify({ name: 'Ada', skills: ['Go'] }) : JSON.stringify({ title: 'Staff Engineer', company: 'Globex' })), files: { 'r.txt': RESUME_TEXT, 'j.txt': JD_TEXT } });
    await orch.ingestDocument(filePath('r.txt'), DocType.RESUME);
    await orch.ingestDocument(filePath('j.txt'), DocType.JD);
    assert.equal(await orch.processQuestion('Tell me about yourself'), null, 'off until profile mode is on');
    orch.setKnowledgeMode(true);
    const res = await orch.processQuestion('Tell me about yourself');
    assert.match(res.contextBlock, /Name: Ada/);
    assert.match(res.contextBlock, /Role: Staff Engineer at Globex/);
    orch.feedForDepthScoring('anything'); // called unguarded by LLMHelper
  });

  test('a second upload of the same type while one is running is refused', async () => {
    let release;
    const { orch, DocType } = setup({ reply: () => new Promise((r) => { release = () => r('{"name":"Ada"}'); }), files: { 'r.txt': RESUME_TEXT } });
    const first = orch.ingestDocument(filePath('r.txt'), DocType.RESUME);
    while (!release) await new Promise((r) => setTimeout(r, 2));
    assert.equal(orch.isIngesting(DocType.RESUME), true);
    const second = await orch.ingestDocument(filePath('r.txt'), DocType.RESUME);
    assert.equal(second.success, false);
    release();
    assert.equal((await first).success, true);
    assert.equal(orch.isIngesting(DocType.RESUME), false);
  });

  test('premium-only extras answer "nothing yet" instead of throwing', () => {
    const { orch } = setup();
    assert.equal(orch.getCompanyResearchEngine().getCachedDossier('Globex'), null);
    assert.equal(orch.getNegotiationScript(), null);
    assert.equal(orch.getNegotiationTracker().isActive(), false);
  });
});

describe('wiring', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('main.ts falls back to the PrepPilot engine when premium is absent', () => {
    const main = read('electron/main.ts');
    assert.match(main, /KnowledgeOrchestratorClass = require\('\.\/profile\/ProfileOrchestrator'\)\.ProfileOrchestrator;/);
    assert.match(main, /KnowledgeDatabaseManagerClass = require\('\.\/profile\/ProfileStore'\)\.ProfileStore;/);
  });

  test('the IPC handlers take DocType from the PrepPilot types, never from premium', () => {
    const ipc = read('electron/ipcHandlers.ts');
    assert.ok(!ipc.includes("require('../premium/electron/knowledge/types')"));
    assert.ok(ipc.includes("require('./profile/types')"));
  });
});
