// @metaharness/evals-hle — the EVALUATOR (harness pipeline) + the PROPOSER (schema-constrained mutation).
//
// These are the two seams where the model/benchmark enters the flywheel. Everything HLE-specific lives HERE,
// in the caller — the flywheel core stays benchmark-agnostic. The evaluator runs the full policy pipeline
// per question and projects the result onto the flywheel's `Score`; the proposer mutates ONE lever within
// its typed schema (bounded enum / clamped number / flipped bool) — never free prose (anti-superstition).
import type { Policy, PolicyGenome, Proposer, Evaluator, Suite } from '@metaharness/flywheel';
import {
  policyToGenome, policyFor, clamp01, clampInt,
  ANSWER_FORMATS, VERIFICATION_MODES, CONFIDENCE_RULES, SOLVER_STYLES,
  type Subject,
} from './genome.js';
import { heuristicClassifier, type Classifier } from './classifier.js';
import { normalizeAnswer, exactMatch } from './normalizer.js';
import { makeVerifier } from './verifier.js';
import { confidence } from './calibration.js';
import { shouldEscalate, shouldAbstain, nextTier, type Tier } from './routing.js';
import { detectLeakage, leaks } from './leakage.js';
import { projectScore, type HleScore, type PerQuestionResult } from './score.js';
import type { HleItem } from './data.js';

/** The MODEL SEAM: solve one question at a tier under a solver style + answer format. Returns the raw text,
 *  an optional self-reported confidence, sampled alternatives (for self-consistency), and the USD cost. For
 *  the live run this calls a real provider; for $0 replay a deterministic mock is injected. */
export type SolveFn = (input: {
  tier: Tier;
  subject: Subject;
  question: string;
  style: string;
  format: string;
  maxCandidates: number;
}) => Promise<{ raw: string; logprob?: number; samples?: string[]; costUsd: number }>;

/** Judge for OPEN-ENDED gold answers (exact-match is only valid for closed-form). Never fabricate a verdict:
 *  if an item is open-ended and no judge is injected, it is scored as not-answered (counts against, honest). */
export type Judge = (input: { question: string; predicted: string; gold: string }) => Promise<boolean>;

export interface HleEvaluatorOpts {
  solve: SolveFn;
  judge?: Judge;
  classifier?: Classifier;
  verifier?: ReturnType<typeof makeVerifier>;
  /** Public-dev questions the policy must not encode (the leakage corpus). */
  publicExamples?: string[];
}

export function makeHleEvaluator(opts: HleEvaluatorOpts): Evaluator {
  const classify = opts.classifier ?? heuristicClassifier;
  const verify = opts.verifier ?? makeVerifier();
  const publicExamples = opts.publicExamples ?? [];

  return async function evaluate(policy: Policy, suite: Suite): Promise<HleScore> {
    const genome = policyToGenome(policy);
    const leaked = leaks(detectLeakage(genome, publicExamples));
    const items = suite.items as HleItem[];
    const results: PerQuestionResult[] = [];

    for (const item of items) {
      const subject = item.subject ?? classify(item.question, item.category);
      const sp = policyFor(genome, subject);

      let tier: Tier = 'cheap';
      let cost = 0;
      let normValue: string | null = null;
      let formatValid = false;
      let conf = 0;

      for (let pass = 0; pass < 3; pass++) {
        const res = await opts.solve({
          tier, subject, question: item.question,
          style: sp.solverStyle, format: sp.answerFormat, maxCandidates: sp.maxCandidates,
        });
        cost += res.costUsd;

        const norm = normalizeAnswer(res.raw, sp.answerFormat, genome.global.normalizeFinalAnswer);
        normValue = norm.value; formatValid = norm.formatValid;
        const normSamples = (res.samples ?? []).map((s) => normalizeAnswer(s, sp.answerFormat, genome.global.normalizeFinalAnswer).value);
        const selfCons = normValue === null ? 0 : selfConsistencyOf(normValue, normSamples);
        const vres = verify(sp.verificationMode, { subject, question: item.question, answer: normValue, samples: normSamples });
        conf = confidence(sp.confidenceRule, { logprob: res.logprob, selfConsistency: selfCons, verifierAgreement: vres.agreement });

        const escalate = shouldEscalate(
          sp,
          { confidence: conf, verifierDisagrees: vres.disagrees, answerFormatInvalid: !formatValid, costSoFarUsd: cost },
          genome.global.maxCostPerQuestionUsd,
        );
        if (escalate && tier !== 'frontier' && cost < genome.global.maxCostPerQuestionUsd) { tier = nextTier(tier); continue; }
        break;
      }

      const abstained = shouldAbstain(sp, conf);
      const finalAnswer = abstained ? null : normValue;
      let correct = false;
      if (finalAnswer !== null) {
        if (item.openEnded) correct = opts.judge ? await opts.judge({ question: item.question, predicted: finalAnswer, gold: item.answer }) : false;
        else correct = exactMatch(finalAnswer, item.answer, sp.answerFormat);
      }
      results.push({
        subject, correct, abstained,
        formatInvalid: !formatValid && !abstained,
        confidence: conf, costUsd: cost, leaked,
      });
    }

    return projectScore(results);
  };
}

function selfConsistencyOf(answer: string, samples: (string | null)[]): number {
  const all = [answer, ...samples.filter((s): s is string => s !== null)];
  if (all.length <= 1) return 0.5;
  return all.filter((s) => s === answer).length / all.length;
}

// ── the PROPOSER — one lever, in-schema ─────────────────────────────────────────────────────────────────

export interface HleProposerOpts {
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
export function makeHleProposer(opts: HleProposerOpts = {}): Proposer {
  return async function propose(base: PolicyGenome, target: string): Promise<string> {
    const cur = base.policy[target] ?? '';

    // With an LLM: it proposes in-schema and clampLever still forces the result into the lever's type/range.
    if (opts.complete) {
      let suggestion = cur;
      try {
        suggestion = (await opts.complete(
          opts.proposerModel ?? 'proposer',
          `You tune ONE lever of an HLE answering policy. Lever="${target}", current="${cur}". Reply with ONLY the new value, in-schema. No prose.`,
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
    case 'solverStyle': return nextEnum(SOLVER_STYLES, cur || 'concise');
    case 'answerFormat': return nextEnum(ANSWER_FORMATS, cur || 'short');
    case 'verificationMode': return nextEnum(VERIFICATION_MODES, cur || 'none');
    case 'confidenceRule': return nextEnum(CONFIDENCE_RULES, cur || 'logprob');
    case 'maxCandidates': return String(clampInt(num(cur, 1) + 1, 1, 8));
    case 'escalationThreshold': return String(clamp01(num(cur, 0.5) + 0.1));
    case 'abstainThreshold': return String(clamp01(num(cur, 0.15) + 0.05));
    case 'maxCostPerQuestionUsd': return String(Math.max(0, num(cur, 0.05) + 0.02));
    case 'normalizeFinalAnswer':
    case 'requireAnswerOnly': return String(!(cur === 'true'));
    default: return cur;
  }
}

/** Force any proposed value into the lever's schema. The load-bearing anti-superstition guarantee. */
export function clampLever(target: string, proposed: string, current: string): string {
  const num = (v: string, d: number) => (Number.isNaN(Number(v)) ? d : Number(v));
  switch (target) {
    case 'solverStyle': return valid(SOLVER_STYLES, proposed) ?? nextEnum(SOLVER_STYLES, current || 'concise');
    case 'answerFormat': return valid(ANSWER_FORMATS, proposed) ?? nextEnum(ANSWER_FORMATS, current || 'short');
    case 'verificationMode': return valid(VERIFICATION_MODES, proposed) ?? nextEnum(VERIFICATION_MODES, current || 'none');
    case 'confidenceRule': return valid(CONFIDENCE_RULES, proposed) ?? nextEnum(CONFIDENCE_RULES, current || 'logprob');
    case 'escalationThreshold': return String(clamp01(num(proposed, num(current, 0.5))));
    case 'abstainThreshold': return String(clamp01(num(proposed, num(current, 0.15))));
    case 'maxCandidates': return String(clampInt(num(proposed, num(current, 1)), 1, 8));
    case 'maxCostPerQuestionUsd': return String(Math.max(0, num(proposed, num(current, 0.05))));
    case 'normalizeFinalAnswer':
    case 'requireAnswerOnly': {
      const b = /^(true|false)$/i.test(proposed) ? proposed.toLowerCase() : String(!(current === 'true'));
      return b;
    }
    default: return current;
  }
}

function valid<T extends readonly string[]>(arr: T, v: string): string | null {
  return (arr as readonly string[]).includes(v) ? v : null;
}
