// PrepPilot (2026-11-05): an interview assistant starts in Technical
// Interview, once, without overriding a mode the user picked; and a request
// for a long, whole-project build is answered on Gemini Flash (Flash-Lite
// stops at ~750 tokens whatever the prompt asks).
//
// Run under Electron, as `npm test` does.
import assert from 'node:assert/strict';
import { test, describe, after } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const dist = (p) => path.join(repoRoot, 'dist-electron/electron', p);
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// A fresh profile, set before any bundle opens a database.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'preppilot-interview-defaults-'));
process.env.NATIVELY_TEST_USERDATA = userData;
{
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      app: { getPath: () => userData, getName: () => 'natively-test', getVersion: () => '0.0.0-test', isPackaged: false, isReady: () => true, on() {}, once() {}, whenReady: () => Promise.resolve(), getAppPath: () => repoRoot },
      safeStorage: { isEncryptionAvailable: () => false, encryptString: (x) => Buffer.from(String(x)), decryptString: (b) => b.toString() },
      ipcMain: { handle() {}, on() {}, removeHandler() {} }, BrowserWindow: { getAllWindows: () => [] },
      shell: {}, dialog: {}, screen: {}, nativeTheme: { on() {} }, powerMonitor: { on() {} }, systemPreferences: {},
    },
  };
}
after(() => { try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('the default mode', () => {
  const { ModesManager } = require(dist('services/ModesManager.js'));
  const { DatabaseManager } = require(dist('db/DatabaseManager.js'));
  const modes = ModesManager.getInstance();
  const active = () => modes.getModes().find((m) => m.isActive) ?? DatabaseManager.getInstance().getActiveMode();
  const templateOf = (m) => m?.templateType ?? m?.template_type;

  test('a fresh install starts in Technical Interview', () => {
    assert.equal(templateOf(active()), 'technical-interview');
  });

  test('it happens once: General chosen afterwards stays General', () => {
    const general = modes.getModes().find((m) => m.templateType === 'general');
    modes.setActiveMode(general.id);
    modes.adoptInterviewDefault();
    assert.equal(templateOf(active()), 'general');
  });

  test('a mode the user already picked is never replaced', () => {
    const db = DatabaseManager.getInstance().getDb();
    db.prepare('DELETE FROM app_state WHERE key = ?').run('preppilot.interviewDefaultApplied');
    const sales = modes.getModes().find((m) => m.templateType === 'sales');
    modes.setActiveMode(sales.id);
    modes.adoptInterviewDefault();
    assert.equal(templateOf(active()), 'sales');
  });
});

describe('a long build is answered on Gemini Flash', () => {
  test('What to Answer marks a long coding build, by the same pattern the prompt uses', () => {
    const src = read('electron/llm/WhatToAnswerLLM.ts');
    assert.match(src, /const wtaLargeBuild = Boolean\(answerPlan && isCodingAnswerType\(answerPlan\.answerType\)\s*&& LARGE_BUILD_RE\.test\(/);
    assert.equal(src.match(/largeBuild: wtaLargeBuild,/g)?.length, 2, 'both route-option branches carry it');
  });
  test('LLMHelper skips the fast pick and starts the Gemini cascade at Flash, with a 15 s first-token budget', () => {
    const src = read('electron/LLMHelper.ts');
    assert.match(src, /const largeBuild = routeOptions\?\.largeBuild === true && Boolean\(this\.client\) && !isMultimodal;/);
    assert.match(src, /const fastPick = !isMultimodal && !this\.useOllama && !largeBuild/);
    assert.match(src, /this\.streamGeminiTextCascade\(userContent, imagePaths, finalSystemPrompt, abortSignal, thinkingBudget, largeBuild \? 1 : 0\)/);
    assert.match(src, /const startIndex = Math\.max\(minStartIndex,/);
    assert.match(src, /ttftTimeoutMs: minStartIndex >= 1 \? 15_000 : GEMINI_TEXT_TTFT_MS\.flash/);
  });
});
