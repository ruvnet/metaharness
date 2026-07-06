// @metaharness/evals-sql — the EVALUATOR (harness pipeline) + the PROPOSER (schema-constrained mutation).
//
// These are the two seams where the model/benchmark enters the flywheel. Everything SQL-specific lives HERE,
// in the caller — the flywheel core stays benchmark-agnostic. The evaluator runs the full policy pipeline
// per question and projects the result onto the flywheel's `Score`; the proposer mutates ONE lever within
// its typed schema (bounded enum / clamped number / flipped bool) — never free prose (anti-superstition).
import type { Policy, PolicyGenome, Proposer, Evaluator, Suite } from '@metaharness/flywheel';
import {
  policyToGenome, policyFor, clamp01, clampInt,
  SQL_DIALECTS, SCHEMA_LINKING_STYLES, VERIFICATION_MODES, CONFIDENCE_RULES, DECODING_STYLES,
  type QueryType,
} from './genome.js';
import { heuristicClassifier, type Classifier } from './classifier.js';
import { normalizeSql, executionMatch } from './normalizer.js';
import { makeVerifier } from './verifier.js';
import { confidence } from './calibration.js';
import { shouldEscalate, shouldAbstain, nextTier, type Tier } from './routing.js';
import { detectLeakage, leaks } from './leakage.js';
import { projectScore, type SqlScore, type PerQuestionResult } from './score.js';
import type { SqlItem } from './data.js';

/** The MODEL SEAM: emit one SQL query at a tier under a decoding style + schema-linking + dialect. Returns
 *  the raw text, an optional self-reported confidence, sampled alternatives (for self-consistency), and the
 *  USD cost. For the live run this calls a real provider; for $0 replay a deterministic mock is injected. */
export type SolveFn = (input: {
  tier: Tier;
  queryType: QueryType;
  question: string;
  style: string;
  dialect: string;
  schemaLinking: string;
  maxCandidates: number;
}) => Promise<{ raw: string; logprob?: number; samples?: string[]; costUsd: number }>;

/** Judge for OPEN-ENDED gold (execution-match is the real check; exact-match only works for closed-form gold
 *  on the synthetic). Never fabricate a verdict: if an item is open-ended and no judge is injected, it is
 *  scored as not-answered (counts against, honest). */
export type Judge = (input: { question: string; predicted: string; gold: string }) => Promise<boolean>;

export interface SqlEvaluatorOpts {
  solve: SolveFn;
  judge?: Judge;
  classifier?: Classifier;
  verifier?: ReturnType<typeof makeVerifier>;
  /** Public-dev questions the policy must not encode (the leakage corpus). */
  publicExamples?: string[];
}

export function makeSqlEvaluator(opts: SqlEvaluatorOpts): Evaluator {
  const classify = opts.classifier ?? heuristicClassifier;
  const verify = opts.verifier ?? makeVerifier();
  const publicExamples = opts.publicExamples ?? [];

  return async function evaluate(policy: Policy, suite: Suite): Promise<SqlScore> {
    const genome = policyToGenome(policy);
    const leaked = leaks(detectLeakage(genome, publicExamples));
    const items = suite.items as SqlItem[];
    const results: PerQuestionResult[] = [];

    for (const item of items) {
      const queryType = item.queryType ?? classify(item.question, item.category);
      const sp = policyFor(genome, queryType);
      const dialect = item.dialect ?? sp.sqlDialect;

      let tier: Tier = 'cheap';
      let cost = 0;
      let normValue: string | null = null;
      let formatValid = false;
      let conf = 0;

      for (let pass = 0; pass < 3; pass++) {
        const res = await opts.solve({
          tier, queryType, question: item.question,
          style: sp.decodingStyle, dialect: sp.sqlDialect, schemaLinking: sp.schemaLinking, maxCandidates: sp.maxCandidates,
        });
        cost += res.costUsd;

        const norm = normalizeSql(res.raw, dialect, genome.global.normalizeSql);
        normValue = norm.value; formatValid = norm.formatValid;
        const normSamples = (res.samples ?? []).map((s) => normalizeSql(s, dialect, genome.global.normalizeSql).value);
        const selfCons = normValue === null ? 0 : selfConsistencyOf(normValue, normSamples);
        const vres = verify(sp.verificationMode, { queryType, question: item.question, sql: normValue, samples: normSamples });
        conf = confidence(sp.confidenceRule, { logprob: res.logprob, selfConsistency: selfCons, executionAgreement: vres.agreement });

        const escalate = shouldEscalate(
          sp,
          { confidence: conf, verifierDisagrees: vres.disagrees, sqlInvalid: !formatValid, costSoFarUsd: cost },
          genome.global.maxCostPerQueryUsd,
        );
        if (escalate && tier !== 'frontier' && cost < genome.global.maxCostPerQueryUsd) { tier = nextTier(tier); continue; }
        break;
      }

      const abstained = shouldAbstain(sp, conf);
      const finalSql = abstained ? null : normValue;
      let correct = false;
      if (finalSql !== null) {
        if (item.openEnded) correct = opts.judge ? await opts.judge({ question: item.question, predicted: finalSql, gold: item.gold }) : false;
        else correct = executionMatch(finalSql, item.gold, dialect);
      }
      results.push({
        queryType, correct, abstained,
        sqlInvalid: !formatValid && !abstained,
        confidence: conf, costUsd: cost, leaked,
      });
    }

    return projectScore(results);
  };
}

function selfConsistencyOf(sql: string, samples: (string | null)[]): number {
  const all = [sql, ...samples.filter((s): s is string => s !== null)];
  if (all.length <= 1) return 0.5;
  return all.filter((s) => s === sql).length / all.length;
}

// ── the PROPOSER — one lever, in-schema ─────────────────────────────────────────────────────────────────

export interface SqlProposerOpts {
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
export function makeSqlProposer(opts: SqlProposerOpts = {}): Proposer {
  return async function propose(base: PolicyGenome, target: string): Promise<string> {
    const cur = base.policy[target] ?? '';

    // With an LLM: it proposes in-schema and clampLever still forces the result into the lever's type/range.
    if (opts.complete) {
      let suggestion = cur;
      try {
        suggestion = (await opts.complete(
          opts.proposerModel ?? 'proposer',
          `You tune ONE lever of a text-to-SQL answering policy. Lever="${target}", current="${cur}". Reply with ONLY the new value, in-schema. No prose.`,
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
    case 'decodingStyle': return nextEnum(DECODING_STYLES, cur || 'direct');
    case 'sqlDialect': return nextEnum(SQL_DIALECTS, cur || 'sqlite');
    case 'schemaLinking': return nextEnum(SCHEMA_LINKING_STYLES, cur || 'exactMatch');
    case 'verificationMode': return nextEnum(VERIFICATION_MODES, cur || 'none');
    case 'confidenceRule': return nextEnum(CONFIDENCE_RULES, cur || 'logprob');
    case 'maxCandidates': return String(clampInt(num(cur, 1) + 1, 1, 8));
    case 'escalationThreshold': return String(clamp01(num(cur, 0.5) + 0.1));
    case 'abstainThreshold': return String(clamp01(num(cur, 0.15) + 0.05));
    case 'maxCostPerQueryUsd': return String(Math.max(0, num(cur, 0.05) + 0.02));
    case 'normalizeSql':
    case 'requireSingleStatement': return String(!(cur === 'true'));
    default: return cur;
  }
}

/** Force any proposed value into the lever's schema. The load-bearing anti-superstition guarantee. */
export function clampLever(target: string, proposed: string, current: string): string {
  const num = (v: string, d: number) => (Number.isNaN(Number(v)) ? d : Number(v));
  switch (target) {
    case 'decodingStyle': return valid(DECODING_STYLES, proposed) ?? nextEnum(DECODING_STYLES, current || 'direct');
    case 'sqlDialect': return valid(SQL_DIALECTS, proposed) ?? nextEnum(SQL_DIALECTS, current || 'sqlite');
    case 'schemaLinking': return valid(SCHEMA_LINKING_STYLES, proposed) ?? nextEnum(SCHEMA_LINKING_STYLES, current || 'exactMatch');
    case 'verificationMode': return valid(VERIFICATION_MODES, proposed) ?? nextEnum(VERIFICATION_MODES, current || 'none');
    case 'confidenceRule': return valid(CONFIDENCE_RULES, proposed) ?? nextEnum(CONFIDENCE_RULES, current || 'logprob');
    case 'escalationThreshold': return String(clamp01(num(proposed, num(current, 0.5))));
    case 'abstainThreshold': return String(clamp01(num(proposed, num(current, 0.15))));
    case 'maxCandidates': return String(clampInt(num(proposed, num(current, 1)), 1, 8));
    case 'maxCostPerQueryUsd': return String(Math.max(0, num(proposed, num(current, 0.05))));
    case 'normalizeSql':
    case 'requireSingleStatement': {
      const b = /^(true|false)$/i.test(proposed) ? proposed.toLowerCase() : String(!(current === 'true'));
      return b;
    }
    default: return current;
  }
}

function valid<T extends readonly string[]>(arr: T, v: string): string | null {
  return (arr as readonly string[]).includes(v) ? v : null;
}
