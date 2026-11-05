// PrepPilot: a Gemini project that hit its monthly spending cap was shown as
// "No AI provider is set up yet" after 16-32 s of retries. The cap is now a
// permanent key error (the cascade stops at once) and the user is told what
// Google said and where to fix it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { isPermanentKeyError, accountOrSetupUserMessage, providerFailureUserMessage } = await import(
  pathToFileURL(path.resolve(__dirname, '../../../dist-electron/electron/llm/providerErrorClassifier.js')).href
);
const { chatFailureFromError, isProviderFailureSentence } = await import(
  pathToFileURL(path.resolve(__dirname, '../../../src/lib/chatFailure.mjs')).href
);

const SPEND_CAP = '{"error":{"code":429,"message":"Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap.","status":"RESOURCE_EXHAUSTED"}}';

test('a spending-cap 429 is permanent; a per-minute 429 is not', () => {
  assert.equal(isPermanentKeyError(new Error(SPEND_CAP)), true);
  assert.equal(isPermanentKeyError(new Error('429 RESOURCE_EXHAUSTED: Quota exceeded for requests per minute')), false);
});

test('the spending cap gets a plain sentence the overlay recognises', () => {
  const line = accountOrSetupUserMessage(new Error(`Gemini: ${SPEND_CAP}`));
  assert.match(line, /^Google stopped your Gemini key: .*ai\.studio\/spend/);
  assert.equal(providerFailureUserMessage(new Error(`Gemini: ${SPEND_CAP}`)), line);
  assert.equal(isProviderFailureSentence(line), true);
});

test('the overlay files a spending cap under credits, not a rate limit', () => {
  assert.equal(chatFailureFromError(SPEND_CAP, { provider: 'Google' }).code, 'QUOTA_EXHAUSTED');
});

test('LLMHelper keeps the Gemini account error and reports it instead of "no provider"', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../LLMHelper.ts'), 'utf8');
  assert.match(src, /if \(isPermanentKeyError\(e\)\) \{\s*this\.geminiAccountError = /);
  assert.match(src, /return new Error\(`Gemini: \$\{gemini\.message\}`\)/);
  // A new key clears it.
  assert.match(src, /this\.textHealth\.delete\('gemini_flash'\);[^\n]*\n\s*this\.geminiAccountError = null;/);
});
