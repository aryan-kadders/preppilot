// PrepPilot Profile Intelligence — the pure extraction helpers
// (electron/profile/profileExtraction.ts). No Electron, no platform branches.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPILED = path.join(ROOT, 'dist-electron/electron/profile/profileExtraction.js');
const HAVE_BUILD = fs.existsSync(COMPILED);
const x = HAVE_BUILD ? require(COMPILED) : {};

const NOW = new Date('2026-11-05T00:00:00Z');

describe('profile extraction helpers', { skip: HAVE_BUILD ? false : 'run `npm run build:electron` first' }, () => {
  test('model JSON is read through code fences and surrounding prose', () => {
    assert.deepEqual(x.parseModelJson('Sure!\n```json\n{"name":"Ada"}\n```'), { name: 'Ada' });
    assert.equal(x.parseModelJson('not json'), null);
    assert.equal(x.parseModelJson('[1,2]'), null, 'an array is not a fact object');
    assert.equal(x.parseModelJson(undefined), null);
  });

  test('résumé facts land in the field names the answer routes read', () => {
    const facts = x.normalizeResumeFacts({
      name: '  Ada   Lovelace ',
      email: 'ada@example.com',
      skills: { languages: ['Python', 'python', 'Go'], cloud: ['AWS'] },
      experience: [
        { title: 'Senior Engineer', organization: 'Acme', start_date: 'Jan 2022', end_date: 'Present', highlights: ['Led migration'] },
        { role: '', company: '' },
      ],
      projects: [{ title: 'PrepPilot', summary: 'Interview practice app', tech_stack: 'Electron, React' }],
      education: [{ school: 'MIT', major: 'CS', degree: 'BSc' }],
    }, 'llm');
    assert.equal(facts.identity.name, 'Ada Lovelace');
    assert.equal(facts.name, 'Ada Lovelace');
    assert.deepEqual(facts.skills, ['Python', 'Go', 'AWS'], 'flattened, de-duplicated case-insensitively');
    assert.deepEqual(facts.skills_flat, facts.skills);
    assert.equal(facts.experience.length, 1, 'an empty role is dropped');
    assert.equal(facts.experience[0].role, 'Senior Engineer');
    assert.equal(facts.experience[0].company, 'Acme');
    assert.deepEqual(facts.experience[0].bullets, ['Led migration']);
    assert.deepEqual(facts.projects[0], { name: 'PrepPilot', description: 'Interview practice app', technologies: ['Electron', 'React'] });
    assert.equal(facts.education[0].institution, 'MIT');
    assert.equal(facts._extraction_mode, 'llm');
  });

  test('placeholder values the model writes for missing facts are dropped', () => {
    const facts = x.normalizeJobFacts({ title: 'N/A', company: 'unknown', min_years_experience: '5', requirements: ['None', 'Go'] }, 'llm');
    assert.equal(facts.title, undefined);
    assert.equal(facts.company, undefined);
    assert.equal(facts.min_years_experience, 5);
    assert.deepEqual(facts.requirements, ['Go']);
  });

  test('résumé dates in the usual shapes parse to months', () => {
    const m = (s) => x.parseResumeMonth(s, NOW);
    assert.equal(m('Jan 2021'), 2021 * 12);
    assert.equal(m('September 2020'), 2020 * 12 + 8);
    assert.equal(m('Sept 2020'), 2020 * 12 + 8);
    assert.equal(m('2021-03'), 2021 * 12 + 2);
    assert.equal(m('03/2021'), 2021 * 12 + 2);
    assert.equal(m('2019'), 2019 * 12);
    assert.equal(m('Present'), 2026 * 12 + 10);
    assert.equal(m('sometime'), null);
  });

  test('total experience counts overlapping roles once', () => {
    const years = x.totalExperienceYears([
      { role: 'A', company: 'X', start_date: 'Jan 2020', end_date: 'Dec 2021', bullets: [] },
      { role: 'B', company: 'Y', start_date: 'Jan 2021', end_date: 'Dec 2022', bullets: [] },
      { role: 'C', company: 'Z', start_date: 'undated', bullets: [] },
    ], NOW);
    assert.equal(years, 3);
    assert.equal(x.totalExperienceYears([{ role: 'A', company: 'X', bullets: [] }], NOW), undefined);
  });

  test('a skills list one per line is not cut short by a skill that looks like a heading', () => {
    assert.equal(x.isHeadingLine('Python'), false);
    assert.equal(x.isHeadingLine('AWS'), false);
    assert.equal(x.isHeadingLine('EDUCATION'), true);
    assert.equal(x.isHeadingLine('Work Experience'), true);
    assert.equal(x.isHeadingLine('Skills:'), true);
    const text = 'Ada Lovelace\nSKILLS\nPython\nAWS\nSQL\nEDUCATION\nMIT';
    assert.deepEqual(x.section(text, /^skills$/i), ['Python', 'AWS', 'SQL']);
  });

  test('with no model, a résumé still yields name, contact and skills', () => {
    const text = [
      'Ada Lovelace',
      'ada@example.com | +44 20 7946 0958 | github.com/ada',
      '',
      'Technical Skills',
      '• Python, TypeScript',
      '• AWS',
      '',
      'Work Experience',
      'Engineer, Acme 2020 – Present',
    ].join('\n');
    const facts = x.heuristicResumeFacts(text);
    assert.equal(facts.identity.name, 'Ada Lovelace');
    assert.equal(facts.identity.email, 'ada@example.com');
    assert.ok(facts.identity.phone?.includes('7946'));
    assert.deepEqual(facts.skills, ['Python', 'TypeScript', 'AWS']);
    assert.equal(facts._extraction_mode, 'heuristic');
  });

  test('with no model, a JD still yields its title and lists', () => {
    const text = [
      'Senior Backend Engineer',
      'Responsibilities',
      '- Build APIs',
      '- Own on-call',
      'Requirements',
      '- 5+ years of Go',
      'Nice to have',
      '- Kubernetes',
    ].join('\n');
    const facts = x.heuristicJobFacts(text);
    assert.equal(facts.title, 'Senior Backend Engineer');
    assert.deepEqual(facts.responsibilities, ['Build APIs', 'Own on-call']);
    assert.deepEqual(facts.requirements, ['5+ years of Go']);
    assert.deepEqual(facts.nice_to_haves, ['Kubernetes']);
  });

  test('the context block carries only stored facts, and is empty with none', () => {
    const resume = x.normalizeResumeFacts({ name: 'Ada', experience: [{ role: 'Engineer', company: 'Acme', start_date: '2020', end_date: 'Present' }], skills: ['Go'] }, 'llm');
    const jd = x.normalizeJobFacts({ title: 'Staff Engineer', company: 'Globex', requirements: ['Go'] }, 'llm');
    const block = x.buildProfileContextBlock(resume, jd);
    assert.match(block, /<candidate_profile source="resume">/);
    assert.match(block, /Name: Ada/);
    assert.match(block, /- Engineer at Acme \(2020 – Present\)/);
    assert.match(block, /<target_job source="job_description">/);
    assert.match(block, /Role: Staff Engineer at Globex/);
    assert.match(block, /never invent/);
    assert.equal(x.buildProfileContextBlock(null, null), '');
  });

  test('the status summary names the latest role and total years', () => {
    const facts = x.normalizeResumeFacts({ name: 'Ada', headline: 'Builder', experience: [{ role: 'Lead', company: 'Acme', start_date: 'Jan 2024', end_date: 'Dec 2024' }] }, 'llm');
    assert.deepEqual(x.resumeSummary(facts), { name: 'Ada', role: 'Lead', totalExperienceYears: 1 });
    assert.deepEqual(x.resumeSummary(null), { name: '', role: '', totalExperienceYears: null });
  });
});
