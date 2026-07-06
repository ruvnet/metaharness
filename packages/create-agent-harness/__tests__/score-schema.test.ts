// #15 — the `harness score` badge JSON must carry a schema discriminator that is unambiguously
// distinct from the `metaharness score` scorecard (numeric `schema: 1`), so a downstream consumer can
// detect the shape at the data layer instead of silently mis-parsing one as the other (which defaulted
// every numeric field to 0 and shipped a silent bug in ruflo for 9 iterations).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreCmd, HARNESS_SCORE_SCHEMA } from '../src/score.js';

const dirs: string[] = [];
function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), 'score-schema-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('#15 — harness score schema discriminator', () => {
  it('`harness score --json` output carries schema:"harness-quickcheck-v1" plus the badge fields', async () => {
    const r = await scoreCmd([fixture(), '--json']);
    const out = JSON.parse(r.lines[0]!);
    expect(out.schema).toBe(HARNESS_SCORE_SCHEMA);
    expect(HARNESS_SCORE_SCHEMA).toBe('harness-quickcheck-v1');
    // the badge set is still present alongside the discriminator
    for (const k of ['score', 'mcpRisk', 'releaseReady', 'testsDetected', 'sbom', 'witnessSigned']) {
      expect(out).toHaveProperty(k);
    }
  });

  it('the discriminator is DISTINCT from the metaharness scorecard schema (numeric 1) — detectable at the data layer', async () => {
    const r = await scoreCmd([fixture(), '--json']);
    const out = JSON.parse(r.lines[0]!);
    // metaharness `score` (repo-scorecard) uses numeric `schema: 1`; this must NOT collide.
    expect(typeof out.schema).toBe('string');
    expect(out.schema).not.toBe(1);
  });

  it('`--out` writes the same discriminated badge JSON (not the bare badge blob)', async () => {
    const dir = fixture();
    const outPath = join(dir, 'badges.json');
    await scoreCmd([dir, '--out', outPath]);
    const parsed = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(parsed.schema).toBe(HARNESS_SCORE_SCHEMA);
  });
});
