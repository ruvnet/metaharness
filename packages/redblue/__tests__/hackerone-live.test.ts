// SPDX-License-Identifier: MIT
//
// LIVE, READ-ONLY HackerOne auth smoke. Skipped unless HACKERONE_API_KEY is in
// the environment. Confirms the GraphQL X-Auth-Token auth works against the real
// API (POST https://hackerone.com/graphql).
//
// SECRETS: this test NEVER prints, logs, or asserts on the token or any response
// body. It only checks `authSmoke()`'s {ok,status} (the body is never surfaced
// by the client) and reports PASS/FAIL. The key is read at runtime from env.

import { describe, it, expect } from 'vitest';
import { HackerOneClient, hasHackerOneKey } from '../src/integrations/hackerone.js';

const LIVE = hasHackerOneKey();

describe.skipIf(!LIVE)('LIVE HackerOne read-only auth smoke', () => {
  it('authenticates via GraphQL X-Auth-Token and can read the weakness taxonomy', async () => {
    const client = new HackerOneClient();
    expect(client.isLive()).toBe(true);

    // Read-only auth smoke — only ok/status are observable (no body surfaced).
    const smoke = await client.authSmoke();
    expect(smoke.live).toBe(true);
    // A valid key returns 200; an unauthorized key returns 401. We assert auth
    // succeeded (200). We do NOT print status to avoid leaking account state.
    expect(smoke.ok).toBe(true);
    expect(smoke.status).toBe(200);

    // Read-only taxonomy fetch returns CWE-bearing weaknesses.
    const weaknesses = await client.weaknesses();
    expect(Array.isArray(weaknesses)).toBe(true);
    expect(weaknesses.length).toBeGreaterThan(0);
  }, 60_000);
});
