// src/lib/__tests__/partnerLinks.test.mjs
//
// Covers src/lib/partnerLinks.ts — the provider sign-up URLs. They are opened
// through open-external (https only), so each is parsed as a URL. PrepPilot
// carries no referral or promo codes, so neither may have query parameters.
//
// Run: node --experimental-strip-types --test src/lib/__tests__/partnerLinks.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as links from '../partnerLinks.ts';

const cases = [
  ['FLUXION_REFERRAL_URL', 'global.sidrune.ai'],
  ['AGENTROUTER_REFERRAL_URL', 'agentrouter.org'],
];

for (const [name, host] of cases) {
  describe(name, () => {
    const u = new URL(links[name]);

    test('is an https link to the registration page', () => {
      assert.equal(u.protocol, 'https:');
      assert.equal(u.hostname, host);
      assert.equal(u.pathname, '/register');
    });

    test('carries no referral or promo parameters', () => {
      assert.equal(u.search, '');
    });
  });
}

test('only the provider sign-up links are exported', () => {
  assert.deepEqual(Object.keys(links).sort(), ['AGENTROUTER_REFERRAL_URL', 'FLUXION_REFERRAL_URL']);
});
