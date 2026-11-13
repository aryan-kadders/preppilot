// src/lib/teamSetup.mjs — when a person is asked to join a team, and when Start waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamSetupStep, startBlockMessage } from '../teamSetup.mjs';

const step = (o) => teamSetupStep({ cloudState: 'signed_out', hasOwnAi: false, ...o });

test('a new candidate (no code, no AI of their own) is asked for the invite code', () => {
  assert.equal(step({}), 'join');
  assert.equal(step({ cloudState: null }), 'join');
});

test('the owner or a solo user with their own AI sees no team step', () => {
  assert.equal(step({ hasOwnAi: true }), null);
});

test('a computer the manager signed out must join again, even with its own AI', () => {
  assert.equal(step({ cloudState: 'revoked' }), 'join');
  assert.equal(step({ cloudState: 'revoked', hasOwnAi: true }), 'join');
});

test('once joined there is no team step (the résumé and JD are on the home page)', () => {
  assert.equal(step({ cloudState: 'signed_in' }), null);
});

test('only the join step blocks Start', () => {
  assert.match(startBlockMessage('join', 'signed_out'), /invite code from your manager/);
  assert.match(startBlockMessage('join', 'revoked'), /signed out by your manager/);
  assert.equal(startBlockMessage(null, 'signed_in'), null);
});
