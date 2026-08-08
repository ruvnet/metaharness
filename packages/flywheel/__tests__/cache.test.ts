// FlywheelConfig.cacheEvaluations — the opt-in evaluation memo. An evaluation is
// typically a full benchmark run, so re-proposed policies must not re-spend one
// when the caller opts in — and the default must keep the old call-for-call
// behavior exactly.
import { describe, expect, it } from 'vitest';
import { runFlywheelGenerations, makeSigner } from '../src/index.js';
import type { Policy, Score, Suite } from '../src/types.js';

// A proposer that cycles a single lever through a 2-value domain: gen 1 proposes
// 'b', gen 2 proposes 'a' (already evaluated as the root), gen 3 'b' again if it
// lost, … — guaranteed re-proposals for the memo to catch.
function cyclingProposer() {
  const domain = ['a', 'b'];
  let i = 0;
  return async (base: { policy: Policy }, target: string) => {
    for (let k = 0; k < domain.length; k++) {
      const v = domain[(i + k) % domain.length];
      if (v !== base.policy[target]) {
        i = (i + k + 1) % domain.length;
        return v;
      }
    }
    return base.policy[target];
  };
}

function countingEvaluator() {
  const calls: string[] = [];
  const evaluator = async (p: Policy, suite: Suite): Promise<Score> => {
    calls.push(`${suite.id}:${p.lever}`);
    // 'a' scores 1, 'b' scores 0.5 — the root always wins, so every generation
    // re-proposes and re-evaluates the same losing 'b' policy.
    return { primary: p.lever === 'a' ? 1 : 0.5, noopRate: 0, costPerWin: 1, regressed: false };
  };
  return { evaluator, calls };
}

const base = (evaluator: (p: Policy, s: Suite) => Promise<Score>) => ({
  rootPolicy: { lever: 'a' } as Policy,
  proposer: cyclingProposer(),
  evaluator,
  holdout: { id: 'holdout', items: [1] },
  maxGenerations: 4,
  signer: makeSigner(),
});

describe('cacheEvaluations', () => {
  it('is off by default — identical policies are re-evaluated (old behavior)', async () => {
    const { evaluator, calls } = countingEvaluator();
    await runFlywheelGenerations(base(evaluator));
    // root + one candidate per generation, all live calls.
    expect(calls.length).toBe(1 + 4);
  });

  it('when enabled, re-proposed policies reuse the earlier score', async () => {
    const { evaluator, calls } = countingEvaluator();
    const result = await runFlywheelGenerations({ ...base(evaluator), cacheEvaluations: true });
    // root 'a' + first candidate 'b' — every later re-proposal of 'b' is a hit.
    expect(calls).toEqual(['holdout:a', 'holdout:b']);
    // Same outcome as the uncached run: nothing promotable, root policy stands.
    expect(result.finalPolicy).toEqual({ lever: 'a' });
    expect(result.promotions.length).toBe(0);
  });

  it('cache keys ignore policy key order', async () => {
    const seen: string[] = [];
    const evaluator = async (p: Policy, suite: Suite): Promise<Score> => {
      seen.push(suite.id);
      return { primary: 1, noopRate: 0, costPerWin: 1, regressed: false };
    };
    await runFlywheelGenerations({
      rootPolicy: { x: '1', y: '2' },
      // Proposer returns the existing value but with the policy object rebuilt in
      // reverse key order upstream — the candidate policy spread reorders keys;
      // an order-sensitive key would miss.
      proposer: async (b, t) => b.policy[t],
      evaluator,
      holdout: { id: 'h', items: [1] },
      maxGenerations: 2,
      signer: makeSigner(),
      cacheEvaluations: true,
    });
    // root eval + 2 targets x 2 generations, but every candidate equals the root
    // policy — with the memo only the root call is live.
    expect(seen.length).toBe(1);
  });
});
