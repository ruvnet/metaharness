// SPDX-License-Identifier: MIT
//
// ADVERSARIAL SECURITY REGRESSION — Tier-2 `agent` sandbox (ADR-106) must run
// the ADR-071 `inspectVariant` gate BEFORE importing/executing a variant's
// surface files, exactly like the 'real' sandbox (`sandbox.ts`) and the
// 'llm-agent' sandbox (`llm-agent-sandbox.ts`) already do.
//
// This gap was disclosed but explicitly left open in ADR-273 ("Out of scope
// to fix here since it is pre-existing and unrelated to this ADR's own new
// code"): `tier2-sandbox.ts`'s own module doc claimed the gate "has already
// cleared the variant before any execution", but `inspectVariant` was never
// actually called anywhere on the Tier-2 code path. `tier2-driver.ts`
// `import()`s a variant's real `.ts` surface files in a child process with
// full Node capabilities — so an ungated variant's module-level code runs for
// real, not just in a metadata check.
//
// Proof here is non-vacuous: the malicious surface writes a marker file as a
// module-level side effect the instant it is imported. If the gate is
// bypassed, the marker exists after the run; if the gate holds, it does not.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileRepo } from '../../src/repo_profiler.js';
import { generateBaselineHarness } from '../../src/generator.js';
import { runVariantTaskAgent, runVariantTasksAgent, DEFAULT_AGENT_TASKS } from '../../src/tier2-sandbox.js';
import { inspectVariant } from '../../src/safety.js';

const nodeMajor = Number(process.versions.node.split('.')[0]);

describe.skipIf(nodeMajor < 22 || process.platform === 'win32')('Tier-2 agent sandbox — ADR-071 gate must run first', () => {
  let repo: string;
  let wr: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'darwin-t2-gate-repo-'));
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'package.json'), '{"name":"t2gate","version":"1.0.0","private":true}');
    await writeFile(join(repo, 'src', 'i.js'), 'export const x = 1;\n');
    wr = await mkdtemp(join(tmpdir(), 'darwin-t2-gate-wr-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(wr, { recursive: true, force: true });
  });

  it('a variant with blocked content in an approved surface file never runs (marker never created)', async () => {
    const profile = await profileRepo(repo);
    const base = await generateBaselineHarness(profile, wr);

    // Poison an approved surface file with a module-level side effect that
    // fires the instant it is imported, via a top-level `node:fs` import —
    // a "restricted node builtin" the ADR-071 content denylist blocks. If
    // Tier-2 imports this module for real, the marker file exists; if the
    // gate holds, it does not.
    const markerPath = join(wr, 'PROOF_TIER2_EXECUTED');
    const evilDir = join(wr, 'variants', 'evil');
    await mkdir(evilDir, { recursive: true });
    await mkdir(join(evilDir, 'src'), { recursive: true });
    await writeFile(join(evilDir, 'context_builder.ts'), [
      '// SPDX-License-Identifier: MIT',
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(markerPath)}, 'executed');`,
      'export function buildContext(files: string[]): string[] { return files; }',
      '',
    ].join('\n'));
    // Copy the rest of the baseline's approved surfaces unmodified so the ONLY
    // finding is the poisoned file (isolates the gate check, not the allowlist).
    for (const name of ['planner.ts', 'reviewer.ts', 'retry_policy.ts', 'tool_policy.ts', 'memory_policy.ts', 'score_policy.ts']) {
      await writeFile(join(evilDir, name), await import('node:fs/promises').then((m) => m.readFile(join(base.dir, name), 'utf8')));
    }
    const evil = { ...base, id: 'evil', dir: evilDir };

    // Control: the gate itself, run directly, must flag this variant.
    const findings = await inspectVariant(evilDir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join(' ')).toContain('context_builder.ts');
    expect(existsSync(markerPath)).toBe(false);

    // The actual regression: Tier-2 must refuse to run it, not just agree it's bad.
    const trace = await runVariantTaskAgent(evil, DEFAULT_AGENT_TASKS[0]);
    // Check containment BEFORE the exitCode assertion so a bypass shows the
    // real side effect (marker created) rather than just a wrong exit code.
    expect(existsSync(markerPath)).toBe(false);
    expect(trace.exitCode).toBe(99);
    expect(trace.blockedActions.length).toBeGreaterThan(0);

    // And the multi-task entry point disqualifies every task, not just the first.
    const traces = await runVariantTasksAgent(evil);
    expect(traces.length).toBe(DEFAULT_AGENT_TASKS.length);
    for (const t of traces) expect(t.exitCode).toBe(99);
    expect(existsSync(markerPath)).toBe(false);
  }, 60_000);

  it('a clean variant is unaffected by the gate (same behavior as before this fix)', async () => {
    const profile = await profileRepo(repo);
    const base = await generateBaselineHarness(profile, wr);

    const findings = await inspectVariant(base.dir);
    expect(findings).toEqual([]);

    const traces = await runVariantTasksAgent(base);
    expect(traces.length).toBe(DEFAULT_AGENT_TASKS.length);
    // None of these should be gate-disqualified (99); they may solve or not.
    for (const t of traces) expect(t.exitCode).not.toBe(99);
  }, 60_000);
});
