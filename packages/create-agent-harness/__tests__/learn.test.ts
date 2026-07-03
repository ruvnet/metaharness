// SPDX-License-Identifier: MIT
//
// $0 unit tests for the `metaharness learn` command surface (ADR-235): arg parsing,
// arg assembly ($0-default rule), repo gating, and seed resolution — all pure functions,
// no spawn, no network, no spend.

import { describe, it, expect } from 'vitest';
import { dirname, join, resolve, sep } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
import {
  parseLearnArgs,
  buildLearnArgs,
  findLearnHarness,
  resolveSeed,
  repoRequiredMessage,
  LEARN_MJS_REL,
  GATEWAY_BASE_URL,
  GATEWAY_API_KEY_ENV,
  PACKAGED_SEEDS,
} from '../src/learn.js';

describe('parseLearnArgs', () => {
  it('parses the documented flag set', () => {
    const a = parseLearnArgs([
      '--host', 'claude-p', '--model', 'z-ai/glm-5.2', '--slice', 'advisor-medium-25.json',
      '--seed', 'cand6', '--train-first', '12', '--max-cost', '8', '--via-gateway', '--run',
    ]);
    expect(a).toMatchObject({
      host: 'claude-p',
      model: 'z-ai/glm-5.2',
      slice: 'advisor-medium-25.json',
      seed: 'cand6',
      trainFirst: '12',
      maxCost: '8',
      viaGateway: true,
      run: true,
    });
    expect(a.errors).toEqual([]);
    expect(a.passthrough).toEqual([]);
  });

  it('accepts --manifest as an alias for --slice', () => {
    expect(parseLearnArgs(['--manifest', 'x.json']).slice).toBe('x.json');
  });

  it('forwards unknown value-flags verbatim as passthrough', () => {
    const a = parseLearnArgs(['--concurrency', '4', '--reflection-model', 'anthropic/claude-sonnet-5']);
    expect(a.passthrough).toEqual(['--concurrency', '4', '--reflection-model', 'anthropic/claude-sonnet-5']);
  });

  it('records an error for a value-flag missing its value', () => {
    const a = parseLearnArgs(['--host']);
    expect(a.errors).toHaveLength(1);
  });

  it('absorbs an explicit --dry-run (dry-run is already the default)', () => {
    const a = parseLearnArgs(['--dry-run']);
    expect(a.run).toBe(false);
    expect(a.passthrough).toEqual([]);
  });
});

describe('buildLearnArgs — the $0-default rule', () => {
  it('ALWAYS appends --dry-run when --run is absent', () => {
    const args = parseLearnArgs(['--host', 'h', '--model', 'm', '--slice', 's.json']);
    const out = buildLearnArgs(args, undefined);
    expect(out[out.length - 1]).toBe('--dry-run');
    expect(out).toEqual(['--host', 'h', '--model', 'm', '--slice', 's.json', '--dry-run']);
  });

  it('omits --dry-run only when --run is passed, and never forwards --run itself', () => {
    const args = parseLearnArgs(['--host', 'h', '--run']);
    const out = buildLearnArgs(args, undefined);
    expect(out).not.toContain('--dry-run');
    expect(out).not.toContain('--run');
  });

  it('inserts the resolved seed path', () => {
    const args = parseLearnArgs(['--seed', 'cand6']);
    const out = buildLearnArgs(args, '/pkg/genomes/genome-promoted-cand6-edit-by-midpoint.json');
    expect(out).toContain('--seed');
    expect(out[out.indexOf('--seed') + 1]).toBe('/pkg/genomes/genome-promoted-cand6-edit-by-midpoint.json');
  });

  it('expands --via-gateway to the cognitum base-url + key env', () => {
    const out = buildLearnArgs(parseLearnArgs(['--via-gateway']), undefined);
    expect(out[out.indexOf('--base-url') + 1]).toBe(GATEWAY_BASE_URL);
    expect(out[out.indexOf('--api-key-env') + 1]).toBe(GATEWAY_API_KEY_ENV);
  });

  it('does not duplicate --base-url/--api-key-env when given explicitly alongside --via-gateway', () => {
    const out = buildLearnArgs(
      parseLearnArgs(['--via-gateway', '--base-url', 'http://localhost:1/v1', '--api-key-env', 'X']),
      undefined,
    );
    expect(out.filter((t) => t === '--base-url')).toHaveLength(1);
    expect(out.filter((t) => t === '--api-key-env')).toHaveLength(1);
    expect(out[out.indexOf('--base-url') + 1]).toBe('http://localhost:1/v1');
  });
});

describe('findLearnHarness — repo gating', () => {
  const FAKE_ROOT = resolve(sep, 'repos', 'metaharness');
  const FAKE_LEARN = join(FAKE_ROOT, LEARN_MJS_REL);
  const existsOnlyFake = (p: string) => p === FAKE_LEARN;

  it('walks up from a nested cwd to the repo root', () => {
    const deep = join(FAKE_ROOT, 'packages', 'create-agent-harness', 'src');
    expect(findLearnHarness(deep, {}, existsOnlyFake)).toBe(FAKE_LEARN);
  });

  it('returns null when no checkout is found (drives the clean repo-required message)', () => {
    expect(findLearnHarness(resolve(sep, 'tmp', 'elsewhere'), {}, existsOnlyFake)).toBeNull();
  });

  it('honors METAHARNESS_REPO over cwd walking', () => {
    expect(
      findLearnHarness(resolve(sep, 'tmp'), { METAHARNESS_REPO: FAKE_ROOT }, existsOnlyFake),
    ).toBe(FAKE_LEARN);
  });

  it('returns null when METAHARNESS_REPO points at a non-checkout', () => {
    expect(
      findLearnHarness(FAKE_ROOT, { METAHARNESS_REPO: resolve(sep, 'not', 'a', 'repo') }, existsOnlyFake),
    ).toBeNull();
  });

  it('the real repo layout matches LEARN_MJS_REL (guards against harness moves)', () => {
    // This test file lives at packages/create-agent-harness/__tests__/ inside the repo.
    const repoRoot = resolve(here, '..', '..', '..');
    expect(existsSync(join(repoRoot, LEARN_MJS_REL))).toBe(true);
  });
});

describe('resolveSeed', () => {
  it('resolves cand6 (case-insensitive) to the packaged genome', () => {
    const p = resolveSeed('cand6', '/pkg/genomes');
    expect(p).toBe(join('/pkg/genomes', PACKAGED_SEEDS.cand6!));
    expect(resolveSeed('CAND6', '/pkg/genomes')).toBe(p);
  });

  it('passes any other value through unchanged', () => {
    expect(resolveSeed('gepa/seed-genome.json', '/pkg/genomes')).toBe('gepa/seed-genome.json');
  });

  it('returns undefined for an absent --seed (learn.mjs default seed)', () => {
    expect(resolveSeed(undefined, '/pkg/genomes')).toBeUndefined();
  });

  it('the packaged cand-6 genome ships in the package and is the promoted policy', () => {
    const p = resolveSeed('cand6', resolve(here, '..', 'genomes'))!;
    expect(existsSync(p)).toBe(true);
    const g = JSON.parse(readFileSync(p, 'utf-8'));
    expect(g.meta.id).toBe('cand-6');
    expect(g.meta.mutated).toBe('test_policy');
    expect(g.components.test_policy).toContain('midpoint');
  });
});

describe('repoRequiredMessage', () => {
  it('is actionable: names the clone URL, METAHARNESS_REPO, and the ADR-235 follow-up', () => {
    const msg = repoRequiredMessage().join('\n');
    expect(msg).toContain('git clone https://github.com/ruvnet/metaharness.git');
    expect(msg).toContain('METAHARNESS_REPO');
    expect(msg).toContain('ADR-235');
  });
});
