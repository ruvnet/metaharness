import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { dispatch } from '../src/cli/index.js';
import { cmdDefense } from '../src/cli/defense.js';

const pkgDir = join(createRequire(import.meta.url).resolve('@metaharness/artex-defense'), '..');
const fixture = (name: string) => join(pkgDir, 'fixtures', name);

describe('redblue defense (artex-defense)', () => {
  it('prints its own help without loading the package', async () => {
    const r = await cmdDefense(['help'], () => { throw new Error('must not load'); });
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/redblue defense/);
  });

  it('is listed in the top-level usage', async () => {
    const r = await dispatch('help', []);
    expect(r.lines.join('\n')).toMatch(/redblue defense <replay\|verify\|benchmark>/);
  });

  it('replays the identity fixture and verifies it against the printed tail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'redblue-defense-'));
    try {
      const report = join(dir, 'report.json');
      const m = fixture('identity.manifest.json'), input = fixture('identity.json');
      const replay = await dispatch('defense', ['replay', m, input, report, 'simulate']);
      expect(replay.code).toBe(0);
      const summary = JSON.parse(replay.lines[0]);
      expect(summary.candidate.simulatedQuarantines).toBe(1);
      expect(summary.baseline.simulatedQuarantines).toBe(0);
      const ok = await dispatch('defense', ['verify', m, input, report, summary.tailSha256]);
      expect(ok).toEqual({ code: 0, lines: ['{"verified":true}'] });
      const bad = await dispatch('defense', ['verify', m, input, report, '0'.repeat(64)]);
      expect(bad.code).toBe(1);
      const before = readFileSync(report, 'utf8');
      const again = await dispatch('defense', ['replay', m, input, report]);
      expect(again.code).toBe(1);
      expect(again.lines).toEqual(['redblue defense: Output already exists. Choose a new report path.']);
      expect(readFileSync(report, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('explains how to install the package when it is missing', async () => {
    const r = await cmdDefense(['benchmark'], async () => { throw new Error('MODULE_NOT_FOUND'); });
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/npm install @metaharness\/artex-defense/);
  });
});
