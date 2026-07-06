// @metaharness/evals-servedmodel — the EVALUATOR (micro-loop pipeline) + the PROPOSER (schema-constrained
// mutation). Same seam discipline as evals-hle: everything served-model-specific lives HERE, in the
// caller; the flywheel core never learns what "ruvllm" or "SONA" is. The `ServedModelSolveFn` is the ONLY
// place a real served model enters — a $0 deterministic mock drives it for the synthetic proof, and
// `ruvllmClient.ts` supplies a REAL (gated, opt-in) implementation for a genuine live run.
import type { Policy, PolicyGenome, Proposer, Evaluator, Suite } from '@metaharness/flywheel';
import {
  policyToGenome, clamp01, clampInt, clampRank,
  ADAPTATION_MODES, MEMORY_ROUTING_MODES, DISTILLATION_TRIGGERS,
  type ServedModelPolicyGenome,
} from './genome.js';
import { detectDriftRisk } from './driftguard.js';
import { projectScore, type ServedModelScore, type PerTaskResult } from './score.js';
import type { AdaptationTask } from './data.js';

/** The MODEL SEAM: run one interaction through the served model UNDER a serving policy genome. Returns the
 *  post-adaptation quality signal, whether the micro-loop actually committed an adaptation (vs. gating it
 *  out via `qualityThreshold`), latency, and USD cost. For a live run this hits a real `ruvllm serve`
 *  endpoint; for the $0 proof a deterministic mock is injected — never fabricates a real number. */
export type ServedModelSolveFn = (input: {
  genome: ServedModelPolicyGenome;
  task: AdaptationTask;
}) => Promise<{ afterQuality: number; costUsd: number; latencyMs: number; committed: boolean }>;

export interface ServedModelEvaluatorOpts {
  solve: ServedModelSolveFn;
}

export function makeServedModelEvaluator(opts: ServedModelEvaluatorOpts): Evaluator {
  return async function evaluate(policy: Policy, suite: Suite): Promise<ServedModelScore> {
    const genome = policyToGenome(policy);
    const risk = detectDriftRisk(genome);
    const tasks = suite.items as AdaptationTask[];
    const results: PerTaskResult[] = [];

    for (const task of tasks) {
      const r = await opts.solve({ genome, task });
      results.push({
        capabilityClass: task.capabilityClass,
        afterQuality: r.afterQuality,
        costUsd: r.costUsd,
        latencyMs: r.latencyMs,
        committed: r.committed,
      });
    }

    return projectScore(results, risk);
  };
}

// ── the PROPOSER — one lever, in-schema ─────────────────────────────────────────────────────────────────

export interface ServedModelProposerOpts {
  /** Optional LLM seam — asked to pick an in-schema value; its output is CLAMPED to the schema regardless. */
  complete?: (model: string, prompt: string) => Promise<string>;
  proposerModel?: string;
}

const nextEnum = <T extends readonly string[]>(arr: T, cur: string): string => {
  const i = (arr as readonly string[]).indexOf(cur);
  return arr[(i + 1) % arr.length];
};

/** A deterministic, schema-respecting mutation for one lever — the $0 default. With `complete`, an LLM
 *  proposes and `clampLever` still forces the result into the lever's type/range (anti-superstition). */
export function makeServedModelProposer(opts: ServedModelProposerOpts = {}): Proposer {
  return async function propose(base: PolicyGenome, target: string): Promise<string> {
    const cur = base.policy[target] ?? '';

    if (opts.complete) {
      let suggestion = cur;
      try {
        suggestion = (await opts.complete(
          opts.proposerModel ?? 'proposer',
          `You tune ONE lever of a ruvllm served-model serving policy. Lever="${target}", current="${cur}". ` +
            'Reply with ONLY the new value, in-schema. No prose.',
        )).trim();
      } catch { suggestion = cur; }
      return clampLever(target, suggestion, cur);
    }

    return deterministicStep(target, cur);
  };
}

/** One deterministic, in-schema step for a lever — the model-free mutation used for $0 dry-runs/replay. */
export function deterministicStep(target: string, cur: string): string {
  const num = (v: string, d: number) => (Number.isNaN(Number(v)) ? d : Number(v));
  switch (target) {
    case 'microloraRank': return String(clampRank(num(cur, 2) + 1));
    case 'ewcLambda': return String(clamp01(num(cur, 0.1) + 0.05));
    case 'emaDecay': return String(clamp01(num(cur, 0.95) + 0.01));
    case 'qualityThreshold': return String(clamp01(num(cur, 0.5) + 0.05));
    case 'routingDepth': return String(clampInt(num(cur, 2) + 1, 1, 8));
    case 'adaptationMode': return nextEnum(ADAPTATION_MODES, cur || 'conservative');
    case 'memoryRoutingMode': return nextEnum(MEMORY_ROUTING_MODES, cur || 'hnsw');
    case 'distillationTrigger': return nextEnum(DISTILLATION_TRIGGERS, cur || 'sampleCount');
    case 'minSamplesForDistillation': return String(Math.max(1, Math.round(num(cur, 50) - 5)));
    default: return cur;
  }
}

/** Force any proposed value into the lever's schema. The load-bearing anti-superstition guarantee. */
export function clampLever(target: string, proposed: string, current: string): string {
  const num = (v: string, d: number) => (Number.isNaN(Number(v)) ? d : Number(v));
  switch (target) {
    case 'microloraRank': return String(clampRank(num(proposed, num(current, 2))));
    case 'ewcLambda': return String(clamp01(num(proposed, num(current, 0.1))));
    case 'emaDecay': return String(clamp01(num(proposed, num(current, 0.95))));
    case 'qualityThreshold': return String(clamp01(num(proposed, num(current, 0.5))));
    case 'routingDepth': return String(clampInt(num(proposed, num(current, 2)), 1, 8));
    case 'adaptationMode': return valid(ADAPTATION_MODES, proposed) ?? nextEnum(ADAPTATION_MODES, current || 'conservative');
    case 'memoryRoutingMode': return valid(MEMORY_ROUTING_MODES, proposed) ?? nextEnum(MEMORY_ROUTING_MODES, current || 'hnsw');
    case 'distillationTrigger': return valid(DISTILLATION_TRIGGERS, proposed) ?? nextEnum(DISTILLATION_TRIGGERS, current || 'sampleCount');
    case 'minSamplesForDistillation': return String(Math.max(1, Math.round(num(proposed, num(current, 50)))));
    default: return current;
  }
}

function valid<T extends readonly string[]>(arr: T, v: string): string | null {
  return (arr as readonly string[]).includes(v) ? v : null;
}
