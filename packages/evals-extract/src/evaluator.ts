// @metaharness/evals-extract — the EVALUATOR (harness pipeline) + the PROPOSER (schema-constrained mutation).
//
// These are the two seams where the model/benchmark enters the flywheel. Everything extraction-specific lives
// HERE, in the caller — the flywheel core stays benchmark-agnostic. The evaluator runs the full policy
// pipeline per document and projects the result onto the flywheel's `Score`; the proposer mutates ONE lever
// within its typed schema (bounded enum / clamped number / flipped bool) — never free prose (anti-superstition).
import type { Policy, PolicyGenome, Proposer, Evaluator, Suite } from '@metaharness/flywheel';
import {
  policyToGenome, policyFor, clamp01, clampInt,
  SCHEMA_STRICTNESS, VERIFICATION_MODES, CONFIDENCE_RULES, EXTRACTION_STYLES,
  type DocType,
} from './genome.js';
import { heuristicClassifier, type Classifier } from './classifier.js';
import { normalizeExtraction, fieldMatch } from './normalizer.js';
import { makeVerifier } from './verifier.js';
import { confidence } from './calibration.js';
import { shouldEscalate, shouldAbstain, nextTier, type Tier } from './routing.js';
import { detectLeakage, leaks } from './leakage.js';
import { projectScore, type ExtractScore, type PerDocResult } from './score.js';
import type { ExtractItem } from './data.js';

/** The MODEL SEAM: extract one document at a tier under an extraction style + schema strictness. Returns the
 *  raw text (expected to contain a JSON object), an optional self-reported confidence, sampled alternatives
 *  (for self-consistency), and the USD cost. For the live run this calls a real provider; for $0 replay a
 *  deterministic mock is injected. */
export type SolveFn = (input: {
  tier: Tier;
  docType: DocType;
  text: string;
  style: string;
  strictness: string;
  maxCandidates: number;
}) => Promise<{ raw: string; selfReport?: number; samples?: string[]; costUsd: number }>;

/** Judge for OPEN-ENDED gold fields (field-exact-match is only valid for closed-form fields). Never fabricate
 *  a verdict: if an item is open-ended and no judge is injected, it is scored as not-correct (honest). */
export type Judge = (input: { text: string; predicted: Record<string, unknown>; gold: Record<string, unknown> }) => Promise<boolean>;

export interface ExtractEvaluatorOpts {
  solve: SolveFn;
  judge?: Judge;
  classifier?: Classifier;
  verifier?: ReturnType<typeof makeVerifier>;
  /** Public-dev documents the policy must not encode (the leakage corpus). */
  publicExamples?: string[];
}

export function makeExtractEvaluator(opts: ExtractEvaluatorOpts): Evaluator {
  const classify = opts.classifier ?? heuristicClassifier;
  const verify = opts.verifier ?? makeVerifier();
  const publicExamples = opts.publicExamples ?? [];

  return async function evaluate(policy: Policy, suite: Suite): Promise<ExtractScore> {
    const genome = policyToGenome(policy);
    const leaked = leaks(detectLeakage(genome, publicExamples));
    const items = suite.items as ExtractItem[];
    const results: PerDocResult[] = [];

    for (const item of items) {
      const docType = item.docType ?? classify(item.text, item.category);
      const dp = policyFor(genome, docType);
      const gold = safeParseObject(item.gold);

      let tier: Tier = 'cheap';
      let cost = 0;
      let normValue: Record<string, unknown> | null = null;
      let schemaValid = false;
      let conf = 0;

      for (let pass = 0; pass < 3; pass++) {
        const res = await opts.solve({
          tier, docType, text: item.text,
          style: dp.extractionStyle, strictness: dp.schemaStrictness, maxCandidates: dp.maxCandidates,
        });
        cost += res.costUsd;

        const norm = normalizeExtraction(res.raw, item.schema, dp.schemaStrictness, genome.global.normalizeFields);
        normValue = norm.value; schemaValid = norm.schemaValid;
        const normSamples = (res.samples ?? []).map((s) => normalizeExtraction(s, item.schema, dp.schemaStrictness, genome.global.normalizeFields).value);
        const fieldCov = normValue === null ? 0 : requiredCoverageOf(normValue, item.schema.required);
        const vres = verify(dp.verificationMode, { docType, schema: item.schema, value: normValue, samples: normSamples });
        conf = confidence(dp.confidenceRule, { selfReport: res.selfReport, fieldCoverage: fieldCov, verifierAgreement: vres.agreement });

        const escalate = shouldEscalate(
          dp,
          { confidence: conf, verifierDisagrees: vres.disagrees, schemaInvalid: !schemaValid, costSoFarUsd: cost },
          genome.global.maxCostPerDocUsd,
        );
        if (escalate && tier !== 'frontier' && cost < genome.global.maxCostPerDocUsd) { tier = nextTier(tier); continue; }
        break;
      }

      const abstained = shouldAbstain(dp, conf);
      const finalValue = abstained ? null : normValue;
      let correct = false;
      if (finalValue !== null && schemaValid) {
        if (item.openEnded) correct = opts.judge ? await opts.judge({ text: item.text, predicted: finalValue, gold }) : false;
        else correct = fieldMatch(finalValue, gold, item.schema);
      }
      results.push({
        docType, correct, abstained,
        schemaInvalid: !schemaValid && !abstained,
        confidence: conf, costUsd: cost, leaked,
      });
    }

    return projectScore(results);
  };
}

function safeParseObject(s: string): Record<string, unknown> {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch { return {}; }
}

function requiredCoverageOf(value: Record<string, unknown>, required: string[]): number {
  if (required.length === 0) return 1;
  let ok = 0;
  for (const r of required) {
    const v = value[r];
    if (v !== undefined && v !== null && v !== '') ok++;
  }
  return ok / required.length;
}

// ── the PROPOSER — one lever, in-schema ─────────────────────────────────────────────────────────────────

export interface ExtractProposerOpts {
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
export function makeExtractProposer(opts: ExtractProposerOpts = {}): Proposer {
  return async function propose(base: PolicyGenome, target: string): Promise<string> {
    const cur = base.policy[target] ?? '';

    // With an LLM: it proposes in-schema and clampLever still forces the result into the lever's type/range.
    if (opts.complete) {
      let suggestion = cur;
      try {
        suggestion = (await opts.complete(
          opts.proposerModel ?? 'proposer',
          `You tune ONE lever of a structured-extraction policy. Lever="${target}", current="${cur}". Reply with ONLY the new value, in-schema. No prose.`,
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
    case 'extractionStyle': return nextEnum(EXTRACTION_STYLES, cur || 'direct-json');
    case 'schemaStrictness': return nextEnum(SCHEMA_STRICTNESS, cur || 'coerce');
    case 'verificationMode': return nextEnum(VERIFICATION_MODES, cur || 'none');
    case 'confidenceRule': return nextEnum(CONFIDENCE_RULES, cur || 'selfReport');
    case 'maxCandidates': return String(clampInt(num(cur, 1) + 1, 1, 8));
    case 'escalationThreshold': return String(clamp01(num(cur, 0.5) + 0.1));
    case 'abstainThreshold': return String(clamp01(num(cur, 0.15) + 0.05));
    case 'maxCostPerDocUsd': return String(Math.max(0, num(cur, 0.05) + 0.02));
    case 'normalizeFields':
    case 'requireAllRequiredFields': return String(!(cur === 'true'));
    default: return cur;
  }
}

/** Force any proposed value into the lever's schema. The load-bearing anti-superstition guarantee. */
export function clampLever(target: string, proposed: string, current: string): string {
  const num = (v: string, d: number) => (Number.isNaN(Number(v)) ? d : Number(v));
  switch (target) {
    case 'extractionStyle': return valid(EXTRACTION_STYLES, proposed) ?? nextEnum(EXTRACTION_STYLES, current || 'direct-json');
    case 'schemaStrictness': return valid(SCHEMA_STRICTNESS, proposed) ?? nextEnum(SCHEMA_STRICTNESS, current || 'coerce');
    case 'verificationMode': return valid(VERIFICATION_MODES, proposed) ?? nextEnum(VERIFICATION_MODES, current || 'none');
    case 'confidenceRule': return valid(CONFIDENCE_RULES, proposed) ?? nextEnum(CONFIDENCE_RULES, current || 'selfReport');
    case 'escalationThreshold': return String(clamp01(num(proposed, num(current, 0.5))));
    case 'abstainThreshold': return String(clamp01(num(proposed, num(current, 0.15))));
    case 'maxCandidates': return String(clampInt(num(proposed, num(current, 1)), 1, 8));
    case 'maxCostPerDocUsd': return String(Math.max(0, num(proposed, num(current, 0.05))));
    case 'normalizeFields':
    case 'requireAllRequiredFields': {
      const b = /^(true|false)$/i.test(proposed) ? proposed.toLowerCase() : String(!(current === 'true'));
      return b;
    }
    default: return current;
  }
}

function valid<T extends readonly string[]>(arr: T, v: string): string | null {
  return (arr as readonly string[]).includes(v) ? v : null;
}
