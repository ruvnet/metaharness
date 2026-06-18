// SPDX-License-Identifier: MIT
//
// `mapLimit` invariants: (1) never more than `concurrency` tasks in flight at
// once, and (2) results preserve input order.
//
// `mapLimit` is NOT exported from src/evolve.ts, and src/ must not be modified.
// So we verify the two properties as follows:
//
//   - ORDER + WIDTH (unit): a faithful copy of the SAME bounded-pool algorithm
//     from src/evolve.ts is exercised with an in-flight counter test double.
//     This proves the algorithm caps concurrency at `limit` and writes
//     `results[i] = fn(items[i])` (order-preserving) by construction.
//   - WIDTH (end-to-end): drive the REAL `evolve` with a testCommand that writes
//     a begin/end marker around a short sleep; replaying the markers reconstructs
//     the max number of simultaneously-running variant evaluations and asserts it
//     overlaps (>1) yet never exceeds the configured `concurrency`.
//
// Recorded in PERF.md: exporting `mapLimit` (or a test-only re-export) would let
// us assert the width bound on the primitive directly rather than inferring it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evolve } from '../../src/evolve.js';
import type { EvolutionConfig } from '../../src/types.js';

// ── A verbatim copy of src/evolve.ts `mapLimit` (kept in sync intentionally). ──
async function mapLimitRef<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

describe('mapLimit algorithm — width bound + order (unit)', () => {
  it('never exceeds the concurrency width and preserves input order', async () => {
    const items = Array.from({ length: 13 }, (_, i) => i);
    const limit = 4;
    let inFlight = 0;
    let maxInFlight = 0;

    const out = await mapLimitRef(items, limit, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // let overlap develop
      inFlight--;
      return n * 10;
    });

    expect(maxInFlight).toBeLessThanOrEqual(limit);
    expect(maxInFlight).toBe(limit); // saturates because items > limit
    expect(out).toEqual(items.map((n) => n * 10)); // order preserved
  });

  it('clamps width to item count when limit > items', async () => {
    const items = [0, 1];
    let inFlight = 0;
    let maxInFlight = 0;
    await mapLimitRef(items, 8, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(items.length);
  });
});

// ── End-to-end width bound through evolve's real mapLimit + sandbox path. ──

// marker.cjs appends "B <hrtime>\n" on start and "E <hrtime>\n" on exit to
// markers.log (next to itself in repoRoot), around an ~80ms sleep.
const MARKER_SCRIPT = `
const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, 'markers.log');
fs.appendFileSync(f, 'B ' + process.hrtime.bigint() + '\\n');
setTimeout(() => {
  fs.appendFileSync(f, 'E ' + process.hrtime.bigint() + '\\n');
}, 80);
`;

async function makeMarkerRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'darwin-ml-repo-'));
  await writeFile(join(repo, 'marker.cjs'), MARKER_SCRIPT, 'utf8');
  await writeFile(
    join(repo, 'package.json'),
    // Profiler resolves `npm test`, which runs this script with cwd=repoRoot.
    JSON.stringify({ name: 'ml-fixture', version: '0.0.0', scripts: { test: 'node marker.cjs' } }),
    'utf8',
  );
  await writeFile(join(repo, 'index.ts'), 'export const x = 1;\n', 'utf8');
  return repo;
}

/** Reconstruct the max number of simultaneously-open [B,E] intervals. */
function maxOverlap(log: string): number {
  const events: Array<{ t: bigint; d: number }> = [];
  for (const line of log.split('\n')) {
    const [tag, ts] = line.split(' ');
    if (!ts) continue;
    events.push({ t: BigInt(ts), d: tag === 'B' ? 1 : -1 });
  }
  // Ties: process ends (-1) before begins (+1) so we never over-count overlap.
  events.sort((a, b) => (a.t === b.t ? a.d - b.d : a.t < b.t ? -1 : 1));
  let cur = 0;
  let max = 0;
  for (const e of events) {
    cur += e.d;
    if (cur > max) max = cur;
  }
  return max;
}

describe('evolve mapLimit — width bound through the real sandbox path', () => {
  const dirs: string[] = [];
  beforeEach(() => {
    dirs.length = 0;
  });
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it(
    'runs at most `concurrency` variant evaluations simultaneously, with real overlap',
    async () => {
      const concurrency = 3;
      const repo = await makeMarkerRepo();
      const work = await mkdtemp(join(tmpdir(), 'darwin-ml-work-'));
      dirs.push(repo, work);

      const cfg: EvolutionConfig = {
        repoRoot: repo,
        workRoot: work,
        generations: 1,
        childrenPerGeneration: 6, // 6 children evaluated via mapLimit at width 3
        tasks: ['t0'],
        promotionDelta: 0.01,
        seed: 1,
        concurrency,
        taskTimeoutMs: 30_000,
      };

      await evolve(cfg);

      const log = await readFile(join(repo, 'markers.log'), 'utf8');
      const overlap = maxOverlap(log);
      // eslint-disable-next-line no-console
      console.log(`[mapLimit] concurrency=${concurrency} observed maxOverlap=${overlap}`);

      expect(overlap).toBeGreaterThan(1); // proves work actually overlapped
      expect(overlap).toBeLessThanOrEqual(concurrency); // never exceeds width
    },
    60_000,
  );
});
