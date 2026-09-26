// Dream Cycle 2026-09-20/21 (generator-genome): the 2026-09-20 exact-head
// review (PR #337) REJECTed the initial mcpRisk grade-cap fix as a
// state-transition completeness failure:
//
//   1. `.harness/mcp-policy.json` present but malformed JSON, or containing
//      the literal JSON value `null`, was collapsed into the SAME safe
//      state as "no policy file at all" (`safeReadJson` returns `null` for
//      both a missing file and a present-but-unparseable one) — scoring
//      100/Grade A/mcpRisk:'None'/releaseReady:true for evidence that could
//      not actually be verified.
//   2. The `releaseReady` badge and the packed `--json`/`--out` badge blob
//      were never updated by the mcpRisk grade cap, so a High-risk harness
//      could still report `releaseReady: true` (text/`--bundle` modes show
//      the capped grade; the badge JSON did not carry grade/exitCode at all).
//
// Fixed: `readMcpPolicyFile()` distinguishes "absent" (safe) from
// "present-but-invalid" (fail-closed to mcpRisk:'High'); `releaseReady` is
// now false whenever mcpRisk is 'High'; the badge JSON now carries the
// authoritative `grade`/`exitCode` fields alongside the badges.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScorecard, scoreCmd } from '../src/score.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Builds a fixture that scores 100/100 on the 4 non-MCP dimensions and
// writes the given raw text (not JSON-encoded) as `.harness/mcp-policy.json`.
function fixtureWithRawPolicy(rawPolicyContent: string | null): string {
  const d = mkdtempSync(join(tmpdir(), 'score-mcp-fail-closed-'));
  dirs.push(d);

  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: 'demo', version: '1.0.0', bin: { demo: './bin.js' }, scripts: { test: 'vitest run' },
  }));

  mkdirSync(join(d, '.harness'), { recursive: true });
  writeFileSync(join(d, '.harness', 'manifest.json'), JSON.stringify({
    schema: 1, generator: 'metaharness@0.4.16',
    meta: { surface: 'default', kernel_version: '1.0.0' },
    hosts: ['claude-code'],
  }));
  writeFileSync(join(d, '.harness', 'witness.json'), JSON.stringify({ signed: true }));
  writeFileSync(join(d, 'sbom.json'), JSON.stringify({ components: [] }));
  if (rawPolicyContent !== null) {
    writeFileSync(join(d, '.harness', 'mcp-policy.json'), rawPolicyContent);
  }

  mkdirSync(join(d, 'src', 'agents'), { recursive: true });
  for (let i = 0; i < 4; i++) writeFileSync(join(d, 'src', 'agents', `a${i}.ts`), '');
  mkdirSync(join(d, '.claude', 'skills'), { recursive: true });
  for (let i = 0; i < 2; i++) writeFileSync(join(d, '.claude', 'skills', `s${i}.md`), '');
  mkdirSync(join(d, '.claude', 'commands'), { recursive: true });
  for (let i = 0; i < 2; i++) writeFileSync(join(d, '.claude', 'commands', `c${i}.md`), '');

  mkdirSync(join(d, '__tests__'), { recursive: true });
  writeFileSync(join(d, '__tests__', 'a.test.ts'), '');
  mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(d, '.github', 'workflows', 'ci.yml'), '');

  return d;
}

describe('mcp-policy.json fail-closed: present-but-invalid must NOT collapse into "not in use"', () => {
  it('malformed JSON (unparseable) is treated as High risk, not None', () => {
    const d = fixtureWithRawPolicy('{ this is not valid json');
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('High');
    expect(sc.grade).not.toBe('A');
    expect(sc.badges.releaseReady).toBe(false);
  });

  it('JSON literal `null` is treated as High risk, not None', () => {
    const d = fixtureWithRawPolicy('null');
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('High');
    expect(sc.grade).not.toBe('A');
    expect(sc.badges.releaseReady).toBe(false);
  });

  it('JSON array (valid JSON, not an object) is treated as High risk, not None', () => {
    const d = fixtureWithRawPolicy('[]');
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('High');
  });

  it('regression: a genuinely absent policy file (and no .mcp.json) is still safe (mcpRisk None)', () => {
    const d = fixtureWithRawPolicy(null);
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('None');
    expect(sc.grade).toBe('A');
    expect(sc.badges.releaseReady).toBe(true);
  });

  it('regression: a valid, fully-safe policy is unaffected', () => {
    const d = fixtureWithRawPolicy(JSON.stringify({
      defaultDeny: true, auditLog: true, allowShell: false, allowNetwork: false, allowFileWrite: false,
    }));
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('Low');
    expect(sc.grade).toBe('A');
    expect(sc.badges.releaseReady).toBe(true);
  });
});

describe('releaseReady badge must never be true when mcpRisk is High', () => {
  it('valid High-risk policy (shell allowed) forces releaseReady false even with a perfect publish-readiness score', () => {
    const d = fixtureWithRawPolicy(JSON.stringify({
      defaultDeny: true, auditLog: true, allowShell: true, allowNetwork: false, allowFileWrite: false,
    }));
    const sc = buildScorecard(d);
    expect(sc.badges.mcpRisk).toBe('High');
    const publish = sc.dimensions.find((d) => d.name === 'Publish readiness')!;
    expect(publish.score).toBeGreaterThanOrEqual(70); // the dimension itself still scores well
    expect(sc.badges.releaseReady).toBe(false); // but the badge must not claim release-ready
  });
});

describe('packed --json/--out badge output carries authoritative grade/exitCode', () => {
  it('--json output includes grade and exitCode fields matching the capped scorecard', async () => {
    const d = fixtureWithRawPolicy(JSON.stringify({
      defaultDeny: true, auditLog: true, allowShell: true, allowNetwork: false, allowFileWrite: false,
    }));
    const r = await scoreCmd([d, '--json']);
    const out = JSON.parse(r.lines[0]!);
    expect(out.mcpRisk).toBe('High');
    expect(out.grade).toBe('C');
    expect(out.exitCode).toBe(1);
    expect(out.releaseReady).toBe(false);
  });
});
