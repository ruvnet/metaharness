import type { Evaluator, Policy, PolicyGenome, Proposer, Suite } from '@metaharness/flywheel';
import {
  AUTOGENOUS_MUTATION_TARGETS,
  clampLever,
  policyToGenome,
  policyViolations,
  type AutogenousMeshGenome,
} from './genome.js';
import { projectAutogenousScore, type AutogenousBenchResult } from './score.js';
import { admitAutogenousPolicy, type AutogenousAdmissionOptions } from './admission.js';

/**
 * The real-system seam. The adapter never reimplements radio-moe's evaluator; callers inject
 * radio-moe's own deterministic bench (or a subprocess wrapper around BENCH_JSON=1 bench:fusion).
 */
export type AutogenousBenchRunner = (
  genome: AutogenousMeshGenome,
  suite: Suite,
) => Promise<AutogenousBenchResult>;

export interface AutogenousEvaluatorOptions {
  /** AGL admission settings (parent genome, clock). Admission always runs. */
  admission?: AutogenousAdmissionOptions;
}

/**
 * Every candidate is first admitted by Autogenous' AGL (`autogenous` package, Rust
 * agl-types compiled to WebAssembly). A refused candidate is scored as not authorized,
 * so the promotion gate can never promote it, whatever its benchmark says.
 */
export function makeAutogenousEvaluator(
  runBench: AutogenousBenchRunner,
  options: AutogenousEvaluatorOptions = {},
): Evaluator {
  return async function evaluate(policy: Policy, suite: Suite) {
    const violations = policyViolations(policy);
    const result = await runBench(policyToGenome(policy), suite);
    // Admission runs after the bench so AGL, not a caller boolean alone, decides reversibility.
    const admission = admitAutogenousPolicy(policy, violations, {
      ...options.admission,
      reversible: result.reversible,
    });
    return projectAutogenousScore(result, violations, admission);
  };
}

export interface AutogenousProposerOptions {
  /** Optional model seam. Output is always clamped to the authorized numeric schema. */
  complete?: (prompt: string) => Promise<string>;
  /** Deterministic step size used by the model-free proposer. Default 0.05. */
  step?: number;
}

export function makeAutogenousProposer(options: AutogenousProposerOptions = {}): Proposer {
  const step = Math.max(0.001, Math.abs(options.step ?? 0.05));
  return async function propose(base: PolicyGenome, target: string): Promise<string> {
    const current = base.policy[target] ?? '';
    if (!(AUTOGENOUS_MUTATION_TARGETS as readonly string[]).includes(target)) return current;
    if (options.complete) {
      let proposed = current;
      try {
        proposed = (await options.complete(
          `Tune only Autogenous radio-moe lever "${target}". Current=${current}. ` +
          'Return one numeric value only; constitutional bounds are enforced by the caller.',
        )).trim();
      } catch {
        proposed = current;
      }
      return clampLever(target, proposed, current);
    }
    const value = Number(current);
    return clampLever(target, String((Number.isFinite(value) ? value : 0) + step), current);
  };
}
