// PrepPilot transcription accuracy: a Deepgram key (saved, or DEEPGRAM_API_KEY
// in a dev .env) makes Deepgram the default on macOS and Windows, and tech
// interview words (the JD's and résumé's first) reach Deepgram as keyterms,
// never Whisper prompts. Pure functions on both platform branches, plus pins.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST = path.join(ROOT, 'dist-electron/electron/audio');
const HAVE_BUILD = ['defaultSttProvider.js', 'techInterviewTerms.js', 'sttContextTerms.js'].every((f) => fs.existsSync(path.join(DIST, f)));
const SKIP = HAVE_BUILD ? false : 'run `npm run build:electron` first';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const mod = (f) => (HAVE_BUILD ? require(path.join(DIST, f)) : {});

describe('Deepgram as the default with a key', { skip: SKIP }, () => {
  const { defaultSttProviderFor } = mod('defaultSttProvider.js');
  test('macOS and Windows: Deepgram with a key, the on-device default without', () => {
    assert.equal(defaultSttProviderFor('darwin', { appleSpeechAvailable: true, deepgramKey: true }), 'deepgram');
    assert.equal(defaultSttProviderFor('win32', { appleSpeechAvailable: false, deepgramKey: true }), 'deepgram');
    assert.equal(defaultSttProviderFor('darwin', { appleSpeechAvailable: true, deepgramKey: false }), 'apple-speech');
    assert.equal(defaultSttProviderFor('win32', { appleSpeechAvailable: false }), 'local-whisper');
    assert.equal(defaultSttProviderFor('linux', { appleSpeechAvailable: true, deepgramKey: true }), 'none');
  });
  test('the key may come from a dev .env, through the gated fallback', () => {
    const cm = read('electron/services/CredentialsManager.ts');
    assert.match(cm, /getDeepgramApiKey\(\): string \| undefined \{\s*return this\.storedOrEnv\(this\.credentials\.deepgramApiKey, 'DEEPGRAM_API_KEY'\);/);
    assert.match(cm, /defaultSttProviderFor\(process\.platform, \{ appleSpeechAvailable: appleSpeechHelperPresent\(\), deepgramKey: !!this\.getDeepgramApiKey\(\) \}\)/);
  });
});

describe('tech interview words as transcription hints', { skip: SKIP }, () => {
  const { techInterviewTerms, TECH_INTERVIEW_TERMS } = mod('techInterviewTerms.js');
  const t = mod('sttContextTerms.js');
  test('the JD and résumé words come first, then the general list', () => {
    const terms = techInterviewTerms({ jd: { technologies: ['Snowflake', 7] }, resume: { skills_flat: ['Airflow'], skills: null } });
    assert.deepEqual(terms.slice(0, 2), ['Snowflake', 'Airflow']);
    for (const w of ['React', 'Python', 'Kubernetes', 'PostgreSQL']) assert.ok(TECH_INTERVIEW_TERMS.includes(w), w);
    assert.equal(techInterviewTerms().length, TECH_INTERVIEW_TERMS.length);
  });
  test('they reach Deepgram keyterms after the name and dictionary, and stay out of Whisper prompts', () => {
    t.setSttContextTerms(['Aryan']);
    t.setSttDictionaryTerms(['Kadders']);
    t.setSttDomainTerms(techInterviewTerms());
    const all = t.getSttContextTerms();
    assert.deepEqual(all.slice(0, 3), ['Aryan', 'Kadders', 'React']);
    assert.ok(all.length <= 100);
    assert.deepEqual(t.deepgramHintParams('nova-3', all).keyterm.slice(0, 3), ['Aryan', 'Kadders', 'React']);
    assert.deepEqual(t.getSttDictionaryTerms(), ['Kadders'], 'the Whisper glossary reads only the dictionary');
    t.setSttContextTerms([]); t.setSttDictionaryTerms([]); t.setSttDomainTerms([]);
    assert.deepEqual(t.getSttContextTerms(), []);
  });
  test('main sets them at meeting start, beside the name and dictionary', () => {
    assert.match(read('electron/main.ts'), /setSttDictionaryTerms\(getUserDictionary\(\)\);[\s\S]{0,300}setSttDomainTerms\(techInterviewTerms\(\{ resume: ko\?\.activeResume\?\.structured_data \?\? null, jd: ko\?\.activeJD\?\.structured_data \?\? null \}\)\);/);
  });
});

describe('Deepgram hint budget (400 "Keyterm limit exceeded" refuses the whole socket)', { skip: SKIP }, () => {
  const t = mod('sttContextTerms.js');
  const { techInterviewTerms } = mod('techInterviewTerms.js');
  test('multilingual gets a smaller budget than English; order is kept, so name and dictionary survive', () => {
    const all = ['Aryan Kadders', 'Aryan', ...techInterviewTerms()];
    const multi = t.capDeepgramTerms(all, 'multi');
    const en = t.capDeepgramTerms(all, 'en');
    assert.ok(multi.join(' ').length <= 450 && en.join(' ').length <= 600);
    assert.ok(multi.length < en.length && en.length < all.length);
    assert.deepEqual(multi.slice(0, 2), ['Aryan Kadders', 'Aryan']);
    // Measured against Deepgram 2026-11-05: 71 terms / ~626 chars was the most multi accepted.
    assert.ok(multi.length < 71);
    assert.deepEqual(t.deepgramHintParams('nova-3', all, 'multi').keyterm, multi);
    assert.deepEqual(t.deepgramHintParams('nova-3', [], 'en'), {});
  });
  test('the stream passes its connect language', () => {
    assert.match(read('electron/audio/DeepgramStreamingSTT.ts'), /deepgramHintParams\(this\.model, getSttContextTerms\(\), this\.connectLanguage\(\)\)/);
  });
});

test('answers default to English (Auto answered English questions in Hindi on an India-region Mac)', () => {
  assert.match(read('electron/services/CredentialsManager.ts'), /getAiResponseLanguage\(\): string \{[\s\S]{0,300}return this\.credentials\.aiResponseLanguage \|\| 'English';/);
});
