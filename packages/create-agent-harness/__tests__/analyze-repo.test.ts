// SPDX-License-Identifier: MIT
//
// Tests the Node-side repo analyzer. Pure analysis + scoring is always
// exercised; the ruvllm embedding path is exercised opportunistically (it is
// an optional dependency — the test still passes via lexical fallback if the
// native build is absent).

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeFiles, inventory, recommendPlan, scoreArchetypes, ruvllmSemantic, analyzeRepoCmd } from '../src/analyze-repo.js';

async function rustRepoDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'analyze-rust-'));
  await writeFile(join(dir, 'README.md'), 'ruvector — a Rust + WASM vector and agentic database. cargo build, clippy, HNSW.', 'utf-8');
  await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "ruvector"\nedition = "2021"\n[dependencies]\nserde = "1"', 'utf-8');
  await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci', 'utf-8');
  return dir;
}

describe('inventory + analyzeFiles', () => {
  it('reads high-signal files and detects rust + CI', async () => {
    const dir = await rustRepoDir();
    const files = inventory(dir);
    expect(files['Cargo.toml']).toContain('ruvector');
    const p = analyzeFiles('ruvector', files);
    expect(p.languages).toContain('rust');
    expect(p.buildCommands).toContain('cargo build');
    expect(p.hasCi).toBe(true);
  });

  it('never reads node_modules / build dirs (analysis-only)', async () => {
    const dir = await rustRepoDir();
    await mkdir(join(dir, 'node_modules', 'evil'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'evil', 'package.json'), '{"name":"evil"}', 'utf-8');
    const files = inventory(dir);
    expect(Object.keys(files).some((k) => k.includes('node_modules'))).toBe(false);
  });

  // Dream Cycle 2026-08-25: the real fs scan behind hasVerifiedTestFiles
  // (inventory()'s dirExists probe for tests/__tests__/test) was previously
  // only exercised via a hand-built files map in the genome-scorers suite,
  // never against a real filesystem — closing that gap per the independent
  // critic's finding.
  it('sets hasVerifiedTestFiles=true only when a real tests/__tests__/test dir exists on disk', async () => {
    const dir = await rustRepoDir();
    expect(analyzeFiles('ruvector', inventory(dir)).hasVerifiedTestFiles).toBe(false);
    await mkdir(join(dir, 'tests'), { recursive: true });
    await writeFile(join(dir, 'tests', 'smoke.rs'), '// smoke test', 'utf-8');
    expect(analyzeFiles('ruvector', inventory(dir)).hasVerifiedTestFiles).toBe(true);
  });

  // Dream Cycle 2026-10-25: 2026-08-25's #229 fix stopped `hasVerifiedTestFiles`
  // from being credited off manifest/language detection alone — but the real
  // fs scan behind it (`dirExists`) only checked the directory was present,
  // not that it had anything in it. `mkdir tests` with zero files reopened
  // the exact false-positive #229 was meant to close, one level deeper.
  it('an empty tests/ directory (mkdir only, no files inside) does NOT count as verified', async () => {
    const dir = await rustRepoDir();
    await mkdir(join(dir, 'tests'), { recursive: true });
    expect(analyzeFiles('ruvector', inventory(dir)).hasVerifiedTestFiles).toBe(false);
    // adding a real file flips it, proving the probe still works for the real case
    await writeFile(join(dir, 'tests', 'smoke.rs'), '// smoke test', 'utf-8');
    expect(analyzeFiles('ruvector', inventory(dir)).hasVerifiedTestFiles).toBe(true);
  });

  // Caught by an independent critic the same night: a first version of this
  // fix only scanned the top level of `tests/`, so `mkdir -p tests/unit` with
  // zero files anywhere still passed (the top-level entry `unit` is itself a
  // non-dot entry). Closed before ship by walking the subtree.
  it('a nested-but-still-empty tests/unit/ directory does NOT count as verified either', async () => {
    const dir = await rustRepoDir();
    await mkdir(join(dir, 'tests', 'unit'), { recursive: true });
    expect(analyzeFiles('ruvector', inventory(dir)).hasVerifiedTestFiles).toBe(false);
    // a real file nested two levels down correctly flips it
    await writeFile(join(dir, 'tests', 'unit', 'smoke.rs'), '// smoke test', 'utf-8');
    expect(analyzeFiles('ruvector', inventory(dir)).hasVerifiedTestFiles).toBe(true);
  });

  it('a manifest-only repo (test script declared, no real test dir) reads as unverified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analyze-manifest-only-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'echo no tests' } }), 'utf-8');
    await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
    await writeFile(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci', 'utf-8');
    const p = analyzeFiles('x', inventory(dir));
    expect(p.testCommands.length).toBeGreaterThan(0); // the old, insufficient signal is still present
    expect(p.hasVerifiedTestFiles).toBe(false); // but no real test dir exists
  });
});

describe('recommendPlan (lexical default)', () => {
  it('routes a Rust crate to rust-crate-harness + vertical:coding', async () => {
    const dir = await rustRepoDir();
    const plan = recommendPlan(analyzeFiles('ruvector', inventory(dir)));
    expect(plan.archetypeId).toBe('rust-crate-harness');
    expect(plan.template).toBe('vertical:coding');
    expect(plan.engine).toBe('lexical');
    expect(plan.suggestedCommands.every((c) => c.execution === 'disabled')).toBe(true);
  });
});

describe('ruvllm embeddings (opt-in, deterministic, fallback-safe)', () => {
  it('returns a per-archetype map (or undefined → lexical fallback)', async () => {
    const dir = await rustRepoDir();
    const profile = analyzeFiles('ruvector', inventory(dir));
    const sem = ruvllmSemantic(profile);
    if (!sem) {
      // optional dep / native build absent in this env — fallback is the contract
      expect(sem).toBeUndefined();
      return;
    }
    // Present: deterministic + a score for every archetype, rounded to <=3dp.
    expect(Object.keys(sem).length).toBe(scoreArchetypes(profile).length);
    expect(ruvllmSemantic(profile)).toEqual(sem);
    for (const v of Object.values(sem)) expect(v).toBe(Math.round(v * 1000) / 1000);
    // Injecting it still yields a deterministic ranking.
    expect(scoreArchetypes(profile, sem)).toEqual(scoreArchetypes(profile, sem));
  });
});

describe('analyzeRepoCmd', () => {
  it('writes repo-profile.json + harness-plan.json and prints the plan', async () => {
    const dir = await rustRepoDir();
    const r = await analyzeRepoCmd([dir]);
    expect(r.code).toBe(0);
    const profile = JSON.parse(await readFile(join(dir, 'repo-profile.json'), 'utf-8'));
    const plan = JSON.parse(await readFile(join(dir, 'harness-plan.json'), 'utf-8'));
    expect(profile.languages).toContain('rust');
    expect(plan.archetypeId).toBe('rust-crate-harness');
    expect(r.lines.join('\n')).toContain('Best archetype: rust-crate-harness');
  });

  it('--scaffold materialises the recommended harness', async () => {
    const dir = await rustRepoDir();
    const r = await analyzeRepoCmd([dir, '--scaffold', 'ruvector-bot', '--out', dir]);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/Scaffolded ruvector-bot/);
  });
});
