// scripts/run-electron-tests.mjs: which test files need upstream's private
// premium/ sources, and how the rest are batched under the Windows
// command-line limit. Pure helpers, so the Windows cases run from any host.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { needsPremium, batchByLength, expandGlobs, MAX_ARGS_CHARS } from '../run-electron-tests.mjs';

describe('needsPremium', () => {
  test('a compiled premium module path is a dependency', () => {
    assert.equal(needsPremium("const m = await import('../../../dist-electron/premium/electron/knowledge/IntentClassifier.js');"), true);
  });

  test('a premium source path read from disk is a dependency', () => {
    assert.equal(needsPremium("const src = fs.readFileSync(path.join(root, 'premium/src/ModesSettings.tsx'), 'utf8');"), true);
  });

  test('path.join segments naming premium count too', () => {
    assert.equal(needsPremium("const p = path.join(ROOT, 'premium', 'electron', 'knowledge', 'X.ts');"), true);
  });

  test('a mention in a comment is not a dependency', () => {
    assert.equal(needsPremium("// mirrors premium/electron/knowledge/KnowledgeOrchestrator.ts\n/* see premium/src/X.tsx */\nconst a = 1;"), false);
  });

  test('a file that skips itself when premium is missing is kept', () => {
    const src = [
      "const classifierPath = path.join(dist, 'premium/electron/knowledge/IntentClassifier.js');",
      'const premium = fs.existsSync(classifierPath) ? require(classifierPath) : null;',
      "test('drift guard', { skip: !premium && 'premium not built' }, () => {});",
    ].join('\n');
    assert.equal(needsPremium(src), false);
  });

  test('ordinary tests are kept', () => {
    assert.equal(needsPremium("import { x } from '../../services/proAccess.js';"), false);
  });
});

describe('batchByLength', () => {
  test('every file lands in exactly one batch, in order', () => {
    const files = Array.from({ length: 50 }, (_, i) => `electron/services/__tests__/File${i}.test.mjs`);
    const batches = batchByLength(files, 400);
    assert.deepEqual(batches.flat(), files);
    assert.ok(batches.length > 1);
  });

  test('each batch stays under the limit, quoted as Windows would', () => {
    const files = Array.from({ length: 2000 }, (_, i) => `electron\\services\\__tests__\\Some Long Name ${i}.test.mjs`);
    for (const batch of batchByLength(files)) {
      const quoted = batch.map((f) => `"${f}"`).join(' ');
      assert.ok(quoted.length <= MAX_ARGS_CHARS, `batch of ${quoted.length} chars`);
    }
  });

  test('the default limit leaves room under the 32,767-char CreateProcess cap', () => {
    assert.ok(MAX_ARGS_CHARS < 32_767 - 2_000);
  });

  test('a single over-long path still runs, alone', () => {
    const long = 'x'.repeat(50);
    assert.deepEqual(batchByLength(['a', long, 'b'], 10), [['a'], [long], ['b']]);
  });

  test('no files, no batches', () => {
    assert.deepEqual(batchByLength([]), []);
  });
});

describe('expandGlobs', () => {
  test('Windows separators come back as forward slashes, de-duplicated and sorted', () => {
    const fake = (pattern) => (pattern === 'a' ? ['b\\y.test.mjs', 'b\\x.test.mjs'] : ['b\\x.test.mjs']);
    const out = expandGlobs(['a', 'c'], { cwd: '.', globSync: (p) => fake(p).map((f) => f.split('\\').join(path.sep)) });
    assert.deepEqual(out, ['b/x.test.mjs', 'b/y.test.mjs']);
  });
});
