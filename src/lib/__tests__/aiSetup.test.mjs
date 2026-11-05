// src/lib/aiSetup.mjs — the Launcher's "Connect an AI" card: when it shows,
// what it offers, and how it explains a key that does not work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_SETUP_PROVIDERS, OLLAMA_DOWNLOAD_URL, needsAiSetup, cleanPastedKey, precheckKey, friendlyKeyError } from '../aiSetup.mjs';

test('the card shows only while there is no way to get an answer', () => {
  assert.equal(needsAiSetup({ hasOwnAiKey: false, isOllama: false }), true);
  assert.equal(needsAiSetup({ hasOwnAiKey: true, isOllama: false }), false);
  assert.equal(needsAiSetup({ hasOwnAiKey: false, isOllama: true }), false);
});

test('it offers free-to-start providers with https key pages, and Ollama as the local option', () => {
  assert.deepEqual(AI_SETUP_PROVIDERS.map((p) => p.id), ['groq', 'gemini']);
  for (const p of AI_SETUP_PROVIDERS) {
    const u = new URL(p.keyUrl);
    assert.equal(u.protocol, 'https:', p.id);
    assert.equal(u.search, '', `${p.id}: no referral parameters`);
  }
  assert.equal(new URL(OLLAMA_DOWNLOAD_URL).protocol, 'https:');
});

test('a pasted key is cleaned of whitespace, line breaks and quotes', () => {
  assert.equal(cleanPastedKey('  "gsk_abc\n123"  '), 'gsk_abc123');
  assert.equal(cleanPastedKey(undefined), '');
});

test('an empty field or the other provider\'s key is caught before any request', () => {
  assert.match(precheckKey('groq', ''), /Paste your key/);
  assert.match(precheckKey('groq', 'AIzaSyExample'), /Google Gemini key/);
  assert.match(precheckKey('gemini', 'gsk_example'), /Groq key/);
  assert.equal(precheckKey('groq', 'gsk_example'), null);
  assert.equal(precheckKey('gemini', 'AIzaSyExample'), null);
});

test('provider errors become plain instructions, never the raw error', () => {
  const cases = [
    ['401 Unauthorized: invalid_api_key', /didn't accept that key/],
    ['API key not valid. Please pass a valid API key.', /didn't accept that key/],
    ['429 Too Many Requests: rate limit', /hit its limit/],
    ['fetch failed: getaddrinfo ENOTFOUND api.groq.com', /internet connection/],
    ['something odd', /couldn't be reached with that key/],
  ];
  for (const [raw, expected] of cases) {
    const msg = friendlyKeyError('Groq', raw);
    assert.match(msg, expected, raw);
    assert.doesNotMatch(msg, /401|429|ENOTFOUND|invalid_api_key/, 'no raw error text');
  }
});
