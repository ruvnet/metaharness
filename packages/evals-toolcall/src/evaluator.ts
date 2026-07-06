// @metaharness/evals-toolcall — the EVALUATOR (harness pipeline) + the PROPOSER (schema-constrained mutation).
//
// These are the two seams where the model/benchmark enters the flywheel. Everything toolcall-specific lives
// HERE, in the caller — the flywheel core stays benchmark-agnostic. The evaluator runs the full policy
// pipeline per query (select → format → retry → verify → escalate → abstain) and projects the result onto the
// flywheel's `Score`; the proposer mutates ONE lever within its typed schema (bounded enum / clamped number /
// flipped bool) — never free prose (anti-superstition).
import type { Policy, PolicyGenome, Proposer, Evaluator, Suite } from '@metaharness/flywheel';
import {
  policyToGenome, policyFor, clamp01, clampInt,
  ARG_FORMATS, VERIFICATION_MODES, CONFIDENCE_RULES, SELECTION_STYLES,
  type Category,
} from './genome.js';
import { heuristicClassifier, type Classifier } from './classifier.js';
import { normalizeCall, callMatch, type ToolCall } from './normalizer.js';
import { makeVerifier, type ToolSchema } from './verifier.js';
import { confidence } from './calibration.js';
import { shouldEscalate, shouldRetry, shouldAbstain, nextTier, type Tier } from './routing.js';
import { detectLeakage, leaks } from './leakage.js';
import { projectScore, type ToolcallScore, type PerCallResult } from './score.js';
import type { ToolItem } from './data.js';

/** The MODEL SEAM: emit one function call at a tier under a selection style + arg format. Returns the raw
 *  text (JSON call / functional form / prose), an optional self-reported confidence, sampled alternatives
 *  (for self-consistency), and the USD cost. For the live run this calls a real provider; for $0 replay a
 *  deterministic mock is injected. */
export type SolveFn = (input: {
  tier: Tier;
  category: Category;
  query: string;
  tools: ToolSchema[];
  style: string;
  format: string;
  maxCandidates: number;
  attempt: number;
}) => Promise<{ raw: string; logprob?: number; samples?: string[]; costUsd: number }>;

export interface ToolcallEvaluatorOpts {
  solve: SolveFn;
  classifier?: Classifier;
  verifier?: ReturnType<typeof makeVerifier>;
  /** Public-dev queries the policy must not encode (the leakage corpus). */
  publicExamples?: string[];
}

export function makeToolcallEvaluator(opts: ToolcallEvaluatorOpts): Evaluator {
  const classify = opts.classifier ?? heuristicClassifier;
  const verify = opts.verifier ?? makeVerifier();
  const publicExamples = opts.publicExamples ?? [];

  return async function evaluate(policy: Policy, suite: Suite): Promise<ToolcallScore> {
    const genome = policyToGenome(policy);
    const leaked = leaks(detectLeakage(genome, publicExamples));
    const items = suite.items as ToolItem[];
    const results: PerCallResult[] = [];

    for (const item of items) {
      const category = item.category ?? classify(item.query, item.categoryHint, { toolCount: item.tools.length });
      const cp = policyFor(genome, category);

      let tier: Tier = 'cheap';
      let cost = 0;
      let call: ToolCall | null = null;
      let formatValid = false;
      let conf = 0;

      for (let pass = 0; pass < 3; pass++) {
        let verifierDisagrees = false;
        // in-tier retry loop on a malformed call (the retry-policy lever) before spending on escalation.
        for (let retriesUsed = 0; ; retriesUsed++) {
          const res = await opts.solve({
            tier, category, query: item.query, tools: item.tools,
            style: cp.selectionStyle, format: cp.argFormat, maxCandidates: cp.maxCandidates, attempt: retriesUsed,
          });
          cost += res.costUsd;

          const norm = normalizeCall(res.raw, cp.argFormat, genome.global.normalizeArgs);
          call = norm.value; formatValid = norm.formatValid;
          const normSamples = (res.samples ?? []).map((s) => normalizeCall(s, cp.argFormat, genome.global.normalizeArgs).value);
          const selfCons = call === null ? 0 : selfConsistencyOf(call, normSamples);
          const schema = call ? (item.tools.find((t) => t.name === call!.name) ?? item.tools[0]) : item.tools[0];
          const vres = verify(cp.verificationMode, { category, query: item.query, call, schema, samples: normSamples });
          verifierDisagrees = vres.disagrees;
          conf = confidence(cp.confidenceRule, { logprob: res.logprob, selfConsistency: selfCons, verifierAgreement: vres.agreement });

          if (shouldRetry(cp, retriesUsed, !formatValid, cost, genome.global.maxCostPerCallUsd)) continue;
          break;
        }

        const escalate = shouldEscalate(
          cp,
          { confidence: conf, verifierDisagrees, callFormatInvalid: !formatValid, costSoFarUsd: cost },
          genome.global.maxCostPerCallUsd,
        );
        if (escalate && tier !== 'frontier' && cost < genome.global.maxCostPerCallUsd) { tier = nextTier(tier); continue; }
        break;
      }

      // IRRELEVANCE items: the correct action is to emit NO call. Abstaining (or emitting nothing) is right;
      // emitting a call is wrong.
      const abstained = item.irrelevant ? call === null || shouldAbstain(cp, conf) : shouldAbstain(cp, conf);
      const finalCall = abstained ? null : call;

      let correct = false;
      if (item.irrelevant) {
        correct = finalCall === null; // correctly refrained from calling
      } else if (finalCall !== null) {
        correct = callMatch(finalCall, item.goldCall, cp.argFormat, genome.global.strictSchema);
      }

      results.push({
        category, correct,
        // an irrelevance abstain is a CORRECT no-call, not a no-op failure; only count no-ops on relevant items
        abstained: item.irrelevant ? false : abstained,
        callInvalid: item.irrelevant ? false : (!formatValid && !abstained),
        confidence: conf, costUsd: cost, leaked,
      });
    }

    return projectScore(results);
  };
}

function selfConsistencyOf(call: ToolCall, samples: (ToolCall | null)[]): number {
  const key = (c: ToolCall) => `${c.name}(${JSON.stringify(sortedArgs(c.args))})`;
  const target = key(call);
  const all = [call, ...samples.filter((s): s is ToolCall => s !== null)];
  if (all.length <= 1) return 0.5;
  return all.filter((s) => key(s) === target).length / all.length;
}

function sortedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) out[k] = args[k];
  return out;
}

// ── the PROPOSER — one lever, in-schema ─────────────────────────────────────────────────────────────────

export interface ToolcallProposerOpts {
  /** Optional LLM seam — asked to pick an in-schema value; its output is CLAMPED to the schema regardless. */
  complete?: (model: string, prompt: string) => Promise<string>;
  proposerModel?: string;
}

const nextEnum = <T extends readonly string[]>(arr: T, cur: string): string => {
  const i = (arr as readonly string[]).indexOf(cur);
  return arr[(i + 1) % arr.length];
};

/** A deterministic, schema-respecting mutation for one lever. This is the $0 default; with `complete` the
 *  LLM proposes and this function still CLAMPS the result to the lever's type/range. */
export function makeToolcallProposer(opts: ToolcallProposerOpts = {}): Proposer {
  return async function propose(base: PolicyGenome, target: string): Promise<string> {
    const cur = base.policy[target] ?? '';

    if (opts.complete) {
      let suggestion = cur;
      try {
        suggestion = (await opts.complete(
          opts.proposerModel ?? 'proposer',
          `You tune ONE lever of a tool-calling policy. Lever="${target}", current="${cur}". Reply with ONLY the new value, in-schema. No prose.`,
        )).trim();
      } catch { suggestion = cur; }
      return clampLever(target, suggestion, cur);
    }

    // $0 deterministic proposer: take one in-schema STEP so the flywheel can search without a model.
    return deterministicStep(target, cur);
  };
}

/** One deterministic, in-schema step for a lever — the model-free mutation used for $0 dry-runs/replay. */
export function deterministicStep(target: string, cur: string): string {
  const num = (v: string, d: number) => (Number.isNaN(Number(v)) ? d : Number(v));
  switch (target) {
    case 'selectionStyle': return nextEnum(SELECTION_STYLES, cur || 'direct');
    case 'argFormat': return nextEnum(ARG_FORMATS, cur || 'loose');
    case 'verificationMode': return nextEnum(VERIFICATION_MODES, cur || 'none');
    case 'confidenceRule': return nextEnum(CONFIDENCE_RULES, cur || 'logprob');
    case 'maxCandidates': return String(clampInt(num(cur, 1) + 1, 1, 8));
    case 'maxRetries': return String(clampInt(num(cur, 0) + 1, 0, 4));
    case 'escalationThreshold': return String(clamp01(num(cur, 0.5) + 0.1));
    case 'abstainThreshold': return String(clamp01(num(cur, 0.15) + 0.05));
    case 'maxCostPerCallUsd': return String(Math.max(0, num(cur, 0.05) + 0.02));
    case 'normalizeArgs':
    case 'strictSchema': return String(!(cur === 'true'));
    default: return cur;
  }
}

/** Force any proposed value into the lever's schema. The load-bearing anti-superstition guarantee. */
export function clampLever(target: string, proposed: string, current: string): string {
  const num = (v: string, d: number) => (Number.isNaN(Number(v)) ? d : Number(v));
  switch (target) {
    case 'selectionStyle': return valid(SELECTION_STYLES, proposed) ?? nextEnum(SELECTION_STYLES, current || 'direct');
    case 'argFormat': return valid(ARG_FORMATS, proposed) ?? nextEnum(ARG_FORMATS, current || 'loose');
    case 'verificationMode': return valid(VERIFICATION_MODES, proposed) ?? nextEnum(VERIFICATION_MODES, current || 'none');
    case 'confidenceRule': return valid(CONFIDENCE_RULES, proposed) ?? nextEnum(CONFIDENCE_RULES, current || 'logprob');
    case 'escalationThreshold': return String(clamp01(num(proposed, num(current, 0.5))));
    case 'abstainThreshold': return String(clamp01(num(proposed, num(current, 0.15))));
    case 'maxCandidates': return String(clampInt(num(proposed, num(current, 1)), 1, 8));
    case 'maxRetries': return String(clampInt(num(proposed, num(current, 0)), 0, 4));
    case 'maxCostPerCallUsd': return String(Math.max(0, num(proposed, num(current, 0.05))));
    case 'normalizeArgs':
    case 'strictSchema': {
      const b = /^(true|false)$/i.test(proposed) ? proposed.toLowerCase() : String(!(current === 'true'));
      return b;
    }
    default: return current;
  }
}

function valid<T extends readonly string[]>(arr: T, v: string): string | null {
  return (arr as readonly string[]).includes(v) ? v : null;
}
