// Every computer joins its team with an invite code before it can start a
// meeting; an AI key of its own does not get around it. Also: a refused code
// says why, so a screenshot from a candidate is enough to find the cause.
// Pure functions from electron/services/cloud/cloudAccount.ts; no platform branches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { devOwnAiAllowed, teamSignInBlock, redeemErrorMessage } = require(path.join(repo, 'dist-electron/electron/services/cloud/cloudAccount.js'));

test('a packaged app always needs the invite code, whatever the environment says', () => {
  assert.equal(devOwnAiAllowed({ PREPPILOT_ALLOW_OWN_AI: '1' }, true), false);
  assert.equal(devOwnAiAllowed({}, false), false);
  assert.equal(devOwnAiAllowed({ PREPPILOT_ALLOW_OWN_AI: '1' }, false), true);
});

test('Start is refused until this computer has joined', () => {
  assert.match(teamSignInBlock(false, false), /invite code from your manager/);
  assert.equal(teamSignInBlock(true, false), null);
  assert.equal(teamSignInBlock(false, true), null);
});

test('a refused code says why', () => {
  assert.match(redeemErrorMessage({ code: 'invalid_code', status: 400 }), /not valid/);
  assert.match(redeemErrorMessage({ code: 'code_used', status: 400 }), /already used/);
  // fetch failed before any answer: a network problem, with its cause.
  const net = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  assert.equal(redeemErrorMessage(net), 'Could not reach PrepPilot Cloud. Check your internet connection (ENOTFOUND).');
  // The server answered with something unexpected: name it.
  assert.match(redeemErrorMessage({ code: 'internal_error', status: 500 }), /Sign-in failed \(internal_error\)/);
  assert.match(redeemErrorMessage({ code: '', status: 502 }), /HTTP 502/);
});
