// src/lib/teamSetup.mjs — which setup step a person sees, and when Start waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamSetupStep, startBlockMessage } from '../teamSetup.mjs';

const step = (o) => teamSetupStep({ cloudState: 'signed_out', hasOwnAi: false, profileReady: false, ...o });

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

test('after joining, the résumé is asked for until it is ready or skipped', () => {
  assert.equal(step({ cloudState: 'signed_in' }), 'profile');
  assert.equal(step({ cloudState: 'signed_in', profileReady: true }), null);
  assert.equal(step({ cloudState: 'signed_in', profileSkipped: true }), null);
});

test('only the join step blocks Start', () => {
  assert.match(startBlockMessage('join', 'signed_out'), /invite code from your manager/);
  assert.match(startBlockMessage('join', 'revoked'), /signed out by your manager/);
  assert.equal(startBlockMessage('profile', 'signed_in'), null);
  assert.equal(startBlockMessage(null, 'signed_in'), null);
});
