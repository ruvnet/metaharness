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
