// SPDX-License-Identifier: MIT
//
// LIVE, READ-ONLY HackerOne smoke. Skipped unless HACKERONE_API_KEY is in the
// environment. Confirms the GraphQL X-Auth-Token auth works against the real API
// (POST https://hackerone.com/graphql), the FULL taxonomy paginates, every CWE
// redblue maps exists in the live set, and the cache is written.
//
// SECRETS: this test NEVER prints, logs, or asserts on the token or any response
// body. It only checks {ok,status}, counts, and CWE membership. The key is read
// at runtime from env. The cache is written to an OS-temp path (not the user's
// real ~/.claude/redblue) so a test run never mutates their cache.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HackerOneClient, hasHackerOneKey } from '../src/integrations/hackerone.js';
import { readCache } from '../src/integrations/h1-cache.js';
import { FAMILY_TAXONOMY } from '../src/integrations/cwe-cvss.js';
import { ALL_FAMILIES } from '../src/config/loader.js';
import type { AttackFamily } from '../src/types.js';

const LIVE = hasHackerOneKey();

describe.skipIf(!LIVE)('LIVE HackerOne read-only smoke', () => {
  it('authenticates, paginates the full taxonomy, validates mappings, writes cache', async () => {
    // Isolated temp cache path — never touches the user's real cache.
    const cachePath = join(mkdtempSync(join(tmpdir(), 'h1-live-')), 'h1-weaknesses.json');
    const client = new HackerOneClient({ cachePath });
    expect(client.isLive()).toBe(true);

    // Read-only auth smoke — only ok/status are observable (no body surfaced).
    const smoke = await client.authSmoke();
    expect(smoke.live).toBe(true);
    expect(smoke.ok).toBe(true);
    expect(smoke.status).toBe(200);

    // Full paginated taxonomy fetch (force live; ignore any cache).
    const result = await client.weaknessesFull({ force: true });
    expect(result.source).toBe('live');
    // The real taxonomy is ~1631 entries; assert it is clearly the full set.
    expect(result.weaknesses.length).toBeGreaterThan(1000);
    expect(result.totalCount).toBeGreaterThan(1000);
    expect(result.requests).toBeGreaterThan(1); // genuinely paginated

    // Mapping validity: every CWE redblue maps MUST exist in the live taxonomy.
    const liveIds = new Set(result.weaknesses.map((w) => w.externalId));
    for (const fam of ALL_FAMILIES as AttackFamily[]) {
      for (const c of FAMILY_TAXONOMY[fam].cwe) {
        expect(liveIds.has(c.id), `mapped ${c.id} must exist live`).toBe(true);
      }
    }

    // Cache was written and is now readable (next run is 0-request).
    const cached = readCache({ path: cachePath });
    expect(cached).not.toBeNull();
    expect(cached!.weaknesses.length).toBe(result.weaknesses.length);

    // A second fetch (no force) serves from cache — 0 requests (compliance).
    const cachedResult = await new HackerOneClient({ cachePath }).weaknessesFull();
    expect(cachedResult.source).toBe('cache');
    expect(cachedResult.requests).toBe(0);
  }, 60_000);

  it('capability probe reports the real read surface (no secrets)', async () => {
    const probes = await new HackerOneClient().probeCapabilities();
    const byField = new Map(probes.map((p) => [p.field, p.status]));
    // weaknesses is the confirmed read path.
    expect(byField.get('weaknesses')).toBe('data');
    // me is null for this limited-scope token (confirmed 2026-06-27).
    expect(byField.get('me')).toBe('null');
  }, 60_000);

  // READ-ONLY scope gate verification against real public programs. NEVER
  // submits anything: programScope() and probeWriteScope() are read-only (the
  // write probe sends a deliberately-invalid empty createReport that H1 MUST
  // reject, so no report is ever created). Only counts/booleans are asserted.
  it('reads live program scope via team(handle) and fails closed on a bad handle', async () => {
    const client = new HackerOneClient();
    // A real, public program exposes in-scope assets (read-only).
    const sec = await client.programScope('security', { pageSize: 100 });
    expect(sec.readable).toBe(true);
    expect(sec.assets.length).toBeGreaterThan(0);
    expect(sec.assets.some((a) => a.eligibleForSubmission)).toBe(true);
    // A non-existent team → fail closed (never assume in-scope).
    const bad = await client.programScope('this-team-should-not-exist-xyz-987');
    expect(bad.readable).toBe(false);
    expect(bad.assets.length).toBe(0);
  }, 60_000);

  it('probes write scope WITHOUT creating a report (read-only effect)', async () => {
    // Empty-input createReport is rejected by H1 → no report created. We only
    // read the rejection class. Never asserts on a token or account data.
    const ws = await new HackerOneClient().probeWriteScope();
    expect(['present', 'absent', 'unverified']).toContain(ws.status);
  }, 60_000);
});
