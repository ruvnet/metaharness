// SPDX-License-Identifier: MIT
// $0 coverage for the #523 sealed SIM evaluation runner (bench/sim-eval).
// No dist imports, no network: the proposer gets a fake fetch.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error untyped .mjs bench module
import { buildPartitions, partitionHash, sealingLeaks } from '../bench/sim-eval/tasks.mjs';
// @ts-expect-error untyped .mjs bench module
import * as plan from '../bench/sim-eval/plan.mjs';
// @ts-expect-error untyped .mjs bench module
import { SpendCapError, SpendGuard, parseCap, worstCaseUsd } from '../bench/sim-eval/spend-guard.mjs';
// @ts-expect-error untyped .mjs bench module
import { GuardedOpenRouterProposer, diffSummary } from '../bench/sim-eval/proposer.mjs';
// @ts-expect-error untyped .mjs bench module
import { contrast, holm, verdict } from '../bench/sim-eval/stats.mjs';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'sim-eval-test-')); dirs.push(d); return d; };

describe('sim-eval task partitions', () => {
  it('are deterministic, match the frozen tasks.json and the pre-registered hash, and are sealed', async () => {
    const p = buildPartitions();
    expect(partitionHash(buildPartitions())).toBe(partitionHash(p));
    const frozen = JSON.parse(await readFile(new URL('../bench/sim-eval/tasks.json', import.meta.url), 'utf8'));
    expect(partitionHash(frozen.partitions)).toBe(frozen.sha256);
    expect(frozen.sha256).toBe(plan.EXPECTED_TASKS_SHA256);
    expect(partitionHash(p)).toBe(frozen.sha256);
    expect(sealingLeaks(p)).toEqual([]);
    expect(p.loc.heldout.length).toBeGreaterThanOrEqual(40);
    expect(p.per.heldout.length).toBeGreaterThanOrEqual(40);
  });

  it('passes only the train partition to evolve()', () => {
    const p = buildPartitions();
    for (const bench of plan.BENCHES) {
      const spec = { bench, seed: 3, model: plan.MODELS[0].id };
      const cfg = plan.evolveConfig(spec, p, plan.LIVE_DESIGN, { repoRoot: '/r', workRoot: '/w', generator: {}, sim: undefined });
      const text = JSON.stringify(cfg);
      expect(cfg.agentTasks).toEqual(p[bench].train);
      expect(cfg.sandboxMode).toBe('agent');
      expect(cfg.selectionPool).toBe('generation');
      for (const h of p[bench].heldout) expect(text).not.toContain(`"${h.id}"`);
    }
  });
});

describe('sim-eval design', () => {
  it('gives every arm the same seeds, cells and proposal budget, seed-major', () => {
    const specs = plan.targetSpecs(plan.LIVE_DESIGN);
    const perArm = new Map<string, number>();
    for (const s of specs) perArm.set(s.arm, (perArm.get(s.arm) ?? 0) + 1);
    for (const a of plan.ARMS) expect(perArm.get(a.arm)).toBe(plan.LIVE_DESIGN.targetSeeds.length * plan.MODELS.length * plan.BENCHES.length);
    expect(perArm.get('retr-poison')).toBe(plan.LIVE_DESIGN.targetSeeds.length);
    expect(specs.map((s: { seed: number }) => s.seed)).toEqual([...specs.map((s: { seed: number }) => s.seed)].sort((a, b) => a - b));
    expect(plan.LIVE_DESIGN.targetSeeds.length).toBeGreaterThanOrEqual(5);
    expect(plan.expectedProposals(plan.LIVE_DESIGN)).toBe(33);
  });

  it('maps transfer arms to the other model / other benchmark store', () => {
    const [m0, m1] = plan.MODELS.map((m: { id: string }) => m.id);
    expect(plan.sourceStoreFor({ memory: 'none', model: m0, bench: 'loc' })).toBeNull();
    expect(plan.sourceStoreFor({ memory: 'in', model: m0, bench: 'loc' })).toEqual({ model: m0, bench: 'loc' });
    expect(plan.sourceStoreFor({ memory: 'xmodel', model: m0, bench: 'loc' })).toEqual({ model: m1, bench: 'loc' });
    expect(plan.sourceStoreFor({ memory: 'xbench', model: m1, bench: 'per' })).toEqual({ model: m1, bench: 'loc' });
  });

  it('hash embedder is deterministic, unit-norm and finite', () => {
    const a = plan.hashEmbed('surface/retryPolicy/task-failure maxAttempts');
    expect(a).toEqual(plan.hashEmbed('surface/retryPolicy/task-failure maxAttempts'));
    expect(Math.abs(Math.hypot(...a) - 1)).toBeLessThan(1e-9);
    expect(plan.hashEmbed('').every(Number.isFinite)).toBe(true);
  });
});

describe('sim-eval spend guard', () => {
  it('refuses malformed caps and refuses a call that would exceed the cap', () => {
    expect(() => parseCap('abc')).toThrow();
    expect(() => parseCap(-1)).toThrow();
    const g = new SpendGuard({ capUsd: 0.01 });
    const r = g.reserve(0.006);
    expect(() => g.reserve(0.006)).toThrow(SpendCapError);
    g.settle(r, 0.001);
    expect(g.snapshot().spentUsd).toBeCloseTo(0.001);
    expect(() => g.reserve(0.009)).not.toThrow();
  });

  it('charges the reservation when the provider cost is missing, and persists across restarts', async () => {
    const ledger = join(await tmp(), 'ledger.jsonl');
    const g = new SpendGuard({ capUsd: 1, ledgerPath: ledger });
    g.settle(g.reserve(0.2), undefined);
    g.settle(g.reserve(0.1), 0.05);
    expect(g.snapshot()).toMatchObject({ spentUsd: 0.25, unpricedCalls: 1, calls: 2 });
    const again = new SpendGuard({ capUsd: 1, ledgerPath: ledger });
    expect(again.snapshot().spentUsd).toBeCloseTo(0.25);
    expect(() => again.reserve(0.8)).toThrow(SpendCapError);
    expect(worstCaseUsd({ promptChars: 1e6, maxTokens: 1e6, inPerM: 0.1, outPerM: 0.4 })).toBeCloseTo(0.5);
  });
});

describe('sim-eval proposer (fake fetch)', () => {
  const parentCode = 'export const maxAttempts = 3;\n';
  const input = { parentCode, surface: 'retryPolicy', repoSummary: '', parentScore: 0.5, failedTraces: [], simContext: 'SIM: x' };
  const pricing = { inPerM: 0.1, outPerM: 0.4 };

  it('settles the provider cost and returns a diff-derived summary', async () => {
    const g = new SpendGuard({ capUsd: 1 });
    const fetchImpl = async () => ({ json: async () => ({ choices: [{ message: { content: '```ts\nexport const maxAttempts = 5;\n```' }, finish_reason: 'stop' }], usage: { cost: 0.0004, prompt_tokens: 100, completion_tokens: 20 } }) });
    const p = new GuardedOpenRouterProposer({ model: 'm', pricing, guard: g, apiKey: 'k', fetchImpl });
    const out = await p.generateMutation(input);
    expect(out.code).toBe('export const maxAttempts = 5;\n');
    expect(out.summary).toBe('retryPolicy: -[export const maxAttempts = 3;] +[export const maxAttempts = 5;]');
    expect(g.snapshot().spentUsd).toBeCloseTo(0.0004);
    expect(p.telemetry.withSimContext).toBe(1);
  });

  it('charges the reservation on a network error and refuses before fetching when capped', async () => {
    const g = new SpendGuard({ capUsd: 1 });
    const p = new GuardedOpenRouterProposer({ model: 'm', pricing, guard: g, apiKey: 'k', fetchImpl: async () => { throw new Error('boom'); } });
    const out = await p.generateMutation(input);
    expect(out.code).toBe(parentCode);
    expect(g.snapshot().spentUsd).toBeGreaterThan(0);
    let fetched = 0;
    const capped = new GuardedOpenRouterProposer({ model: 'm', pricing, guard: new SpendGuard({ capUsd: 1e-6 }), apiKey: 'k', fetchImpl: async () => { fetched++; return { json: async () => ({}) }; } });
    await expect(capped.generateMutation(input)).rejects.toBeInstanceOf(SpendCapError);
    expect(fetched).toBe(0);
    expect(() => new GuardedOpenRouterProposer({ model: 'm', pricing, guard: g, apiKey: '' })).toThrow();
    expect(diffSummary('planner', 'a\n', 'a\n')).toBe('planner: no change');
  });
});

describe('sim-eval statistics', () => {
  const rows = (deltas: number[]) => deltas.flatMap((d, i) => [
    { model: 'm', bench: 'b', seed: i, arm: 'off', value: 0.5 },
    { model: 'm', bench: 'b', seed: i, arm: 'sim', value: 0.5 + d },
  ]);
  it('detects a clear gain, a clear loss and practical equivalence', () => {
    expect(contrast(rows([0.1, 0.12, 0.08, 0.11, 0.09, 0.1]), 'sim', 'off').verdict).toBe('gain');
    expect(contrast(rows([-0.1, -0.12, -0.08, -0.11, -0.09, -0.1]), 'sim', 'off').verdict).toBe('negative');
    expect(contrast(rows([0.001, -0.001, 0, 0.002, -0.002, 0]), 'sim', 'off').verdict).toBe('null');
    expect(contrast(rows([0.2, -0.2, 0.15, -0.1, 0.05, -0.12]), 'sim', 'off').verdict).toBe('inconclusive');
  });
  it('applies Holm and refuses to judge missing data', () => {
    expect(holm([0.01, 0.04])).toEqual([0.02, 0.04]);
    expect(verdict({ estimate: NaN, lo: NaN, hi: NaN })).toBe('insufficient-data');
  });
});
