// src/lib/teamSetup.mjs — when a person is asked to join a team, and when Start waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamSetupStep, startBlockMessage } from '../teamSetup.mjs';

const step = (o) => teamSetupStep({ cloudState: 'signed_out', ...o });

test('every computer without an invite code is asked for one, AI key or not', () => {
  assert.equal(step({}), 'join');
  assert.equal(step({ cloudState: null }), 'join');
  // An AI key of its own no longer gets around the code.
  assert.equal(step({ hasOwnAi: true }), 'join');
});

test('only a development build started with PREPPILOT_ALLOW_OWN_AI skips the code', () => {
  assert.equal(step({ devOwnAi: true }), null);
});

test('a computer the manager signed out must join again', () => {
  assert.equal(step({ cloudState: 'revoked' }), 'join');
  assert.equal(step({ cloudState: 'revoked', devOwnAi: true }), 'join');
});

test('once joined there is no team step (the résumé and JD are on the home page)', () => {
  assert.equal(step({ cloudState: 'signed_in' }), null);
});

test('only the join step blocks Start', () => {
  assert.match(startBlockMessage('join', 'signed_out'), /invite code from your manager/);
  assert.match(startBlockMessage('join', 'revoked'), /signed out by your manager/);
  assert.equal(startBlockMessage(null, 'signed_in'), null);
});
