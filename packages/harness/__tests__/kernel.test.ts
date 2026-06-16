// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { HarnessKernel, topoSort } from '../src/kernel.js';
import { AlgorithmRouter } from '../src/router.js';
import { AgentPool } from '../src/pool.js';
import { VerifierRegistry, predicateVerifier } from '../src/verifier.js';
import { PolicyGate, allowTools } from '../src/safety.js';
import type { AgentSpec, WorkerOutput } from '../src/types.js';

const CODING_KINDS = ['plan', 'scan-repo', 'code', 'test', 'review'];

function out(o: unknown, over: Partial<WorkerOutput> = {}): WorkerOutput {
  return { output: o, quality: 0.9, confidence: 0.8, risk: 0.05, costUsd: 0.01, latencyMs: 100, ...over };
}

/** One agent per coding step kind, each echoing its kind. */
function codingAgents(over: (kind: string) => Partial<WorkerOutput> = () => ({})): AgentSpec[] {
  return CODING_KINDS.map((kind) => ({
    id: kind,
    model: 'haiku',
    handles: [kind],
    run: () => out(`${kind}-ok`, over(kind)),
  }));
}

const nonEmpty = () =>
  new VerifierRegistry().register(
    predicateVerifier('nonempty', 'syntax', (o) => typeof o === 'string' && o.length > 0, 'empty output'),
  );

const router = () => new AlgorithmRouter();

describe('topoSort', () => {
  it('orders deps before dependents and detects cycles', () => {
    const steps = router().compile('coding');
    const order = topoSort(steps).map((s) => s.kind);
    expect(order.indexOf('plan')).toBeLessThan(order.indexOf('code'));
    expect(() =>
      topoSort([
        { id: 'a', kind: 'a', deps: ['b'] },
        { id: 'b', kind: 'b', deps: ['a'] },
      ]),
    ).toThrow(/cycle/);
  });
});

describe('HarnessKernel — end to end (10-step loop)', () => {
  it('runs the full coding plan, gates nothing, and emits a verifiable receipt chain', async () => {
    const k = new HarnessKernel({
      router: router(),
      pool: new AgentPool(codingAgents()),
      verifiers: nonEmpty(),
    });
    const r = await k.run({ text: 'implement and test the parser' }, 'run_e2e');

    expect(r.classification.intent).toBe('coding');
    expect(r.success).toBe(true);
    // Trace coverage: a receipt for EVERY step.
    expect(r.receipts.length).toBe(CODING_KINDS.length);
    expect(r.receiptsValid).toBe(true);
    expect(r.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(r.result).toBe('review-ok'); // terminal step's output
    expect(r.receipts.every((rc) => rc.verdict === 'pass')).toBe(true);
  });

  it('gates an unsafe action (default-deny policy blocks the "code" tool)', async () => {
    const k = new HarnessKernel({
      router: router(),
      pool: new AgentPool(codingAgents()),
      verifiers: nonEmpty(),
      // "code" is NOT allow-listed → default-deny gates it.
      policy: new PolicyGate([allowTools(['plan', 'scan-repo', 'test', 'review'])]),
    });
    const r = await k.run({ text: 'implement and test the parser' });

    const codeStep = r.steps.find((s) => s.step.kind === 'code')!;
    expect(codeStep.status).toBe('gated');
    expect(codeStep.receipt.verdict).toBe('gated');
    expect(r.success).toBe(false);
    // Even a gated run is fully traced + replayable.
    expect(r.receipts.length).toBe(CODING_KINDS.length);
    expect(r.receiptsValid).toBe(true);
  });

  it('retries-then-repairs a step that fails verification on the first attempt', async () => {
    let codeCalls = 0;
    const agents = codingAgents();
    const code = agents.find((a) => a.id === 'code')!;
    code.run = () => out(codeCalls++ === 0 ? '' : 'code-fixed'); // empty first → fails nonEmpty

    const k = new HarnessKernel({
      router: router(),
      pool: new AgentPool(agents),
      verifiers: nonEmpty(),
      budget: { costUsd: 1, risk: 0.5, retries: 3, confidence: 0.6 },
    });
    const r = await k.run({ text: 'implement and test the parser' });

    const codeStep = r.steps.find((s) => s.step.kind === 'code')!;
    expect(codeStep.attempts).toBeGreaterThanOrEqual(1);
    expect(codeStep.status).toBe('ok');
    expect(r.outputs['coding:code']).toBe('code-fixed');
    expect(r.success).toBe(true);
  });

  it('never executes an unbudgeted action — an over-cost step is gated, not run', async () => {
    const agents = codingAgents((kind) => (kind === 'code' ? { costUsd: 5 } : {}));
    const k = new HarnessKernel({
      router: router(),
      pool: new AgentPool(agents),
      verifiers: nonEmpty(),
      budget: { costUsd: 0.5, risk: 0.5, retries: 3, confidence: 0.6 },
    });
    const r = await k.run({ text: 'implement and test the parser' });

    const codeStep = r.steps.find((s) => s.step.kind === 'code')!;
    expect(codeStep.gate.costOk).toBe(false);
    expect(codeStep.status).toBe('gated');
    expect(r.success).toBe(false);
  });

  it('replays deterministically — same goal yields the same receipt hashes', async () => {
    const make = () =>
      new HarnessKernel({ router: router(), pool: new AgentPool(codingAgents()), verifiers: nonEmpty() });
    const a = await make().run({ text: 'implement and test the parser' }, 'run_fixed');
    const b = await make().run({ text: 'implement and test the parser' }, 'run_fixed');
    expect(a.receipts.map((r) => r.thisHash)).toEqual(b.receipts.map((r) => r.thisHash));
  });
});
