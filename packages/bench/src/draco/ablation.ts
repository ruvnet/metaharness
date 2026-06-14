// SPDX-License-Identifier: MIT
//
// DRACO M6 — the fusion-vs-single ablation (ADR-037 §M6, "the proof").
//
// Runs the SAME corpus through two arms with the SAME injected transports:
//   - single: one strong model, end to end (DRACO_SINGLE_MODEL) — the baseline.
//   - fusion: the DRACO-optimised harness (DRACO_OPTIMIZED_MODELS) — independent
//             verifier (different family) + optional independent judge.
// Both are scored by the identical DRACO scorer, so the delta is attributable to
// the ARCHITECTURE, not the score function. The claim "beyond SOTA" is then a
// MEASURED delta — `fusionWins` is true only if fusion's mean score strictly
// exceeds single's. Fully offline: pass mock transports.

import type { OpenRouterTransport } from './fusion.js';
import { fuseResearch } from './fusion.js';
import type { UrlChecker } from './scorer.js';
import { scoreAnswer, type DimensionScores } from './scorer.js';
import { judgeFaithfulness, assertJudgeIndependent, DRACO_JUDGE } from './judge.js';
import {
  DRACO_OPTIMIZED_MODELS,
  DRACO_SINGLE_MODEL,
  singleModelResearch,
  vanillaResearch,
  singleModelHarness,
} from './optimized.js';
import type { DracoCorpus } from './runner.js';

export interface ArmResult {
  arm: 'single' | 'fusion';
  score: number; // mean quality across questions
  perDimension: { grounding: number; coverage: number; balance: number; cleanliness: number; faithfulness?: number };
  totalTokens: number;
}

export interface AblationReport {
  corpusVersion: number;
  transport: 'mock' | 'live';
  judged: boolean;
  judge?: { model: string; promptVersion: number };
  single: ArmResult;
  fusion: ArmResult;
  /** fusion.score − single.score. Positive → fusion wins. */
  delta: number;
  /** The dimensions that drove the delta (fusion − single per dimension). */
  deltaByDimension: { grounding: number; coverage: number; balance: number; cleanliness: number; faithfulness?: number };
  fusionWins: boolean;
}

export interface AblationOptions {
  /** Transport used for BOTH arms (fair comparison). */
  transport: OpenRouterTransport;
  transportKind: 'mock' | 'live';
  checkUrl: UrlChecker;
  /** Optional independent judge (folds faithfulness into both arms' scores). */
  judgeTransport?: OpenRouterTransport;
  judgeModel?: string;
  singleModel?: string;
  /** Override the fusion-arm model map (e.g. the cheap preset). Defaults to DRACO_OPTIMIZED_MODELS. */
  fusionModels?: import('./fusion.js').FusionModelMap;
  limit?: number;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function avgDims(rows: DimensionScores[], faith: number[] | null) {
  const base = {
    grounding: mean(rows.map((r) => r.grounding)),
    coverage: mean(rows.map((r) => r.coverage)),
    balance: mean(rows.map((r) => r.balance)),
    cleanliness: mean(rows.map((r) => r.cleanliness)),
  };
  return faith ? { ...base, faithfulness: mean(faith) } : base;
}

/**
 * Run the ablation. Returns a report whose `fusionWins` is a MEASURED claim:
 * true iff the optimised fusion harness scores strictly higher than the
 * single-model baseline on the same corpus + scorer.
 */
export async function runAblation(corpus: DracoCorpus, opts: AblationOptions): Promise<AblationReport> {
  const judged = !!opts.judgeTransport;
  const judgeModel = opts.judgeModel ?? DRACO_JUDGE.model;
  const singleModel = opts.singleModel ?? DRACO_SINGLE_MODEL;
  const fusionModels = opts.fusionModels ?? DRACO_OPTIMIZED_MODELS;
  if (judged) assertJudgeIndependent(judgeModel, fusionModels);

  let questions = corpus.questions;
  if (opts.limit != null) questions = questions.slice(0, opts.limit);

  const singleDims: DimensionScores[] = [];
  const fusionDims: DimensionScores[] = [];
  const singleFaith: number[] = [];
  const fusionFaith: number[] = [];
  let singleTokens = 0;
  let fusionTokens = 0;

  const scoreOne = async (answer: string, q: typeof questions[number]) => {
    const dims = await scoreAnswer(answer, q.rubric, q.prompt, opts.checkUrl);
    let faith: number | undefined;
    if (judged && opts.judgeTransport) {
      const j = await judgeFaithfulness(answer, opts.judgeTransport, judgeModel);
      faith = j.faithfulness;
    }
    return { dims, faith };
  };

  for (const q of questions) {
    // single arm
    const single = await singleModelResearch({ id: q.id, prompt: q.prompt }, singleModel, opts.transport);
    singleTokens += single.totalTokens;
    const s = await scoreOne(single.answer, q);
    singleDims.push(s.dims);
    if (s.faith != null) singleFaith.push(s.faith);

    // fusion arm
    const fused = await fuseResearch({ id: q.id, prompt: q.prompt }, fusionModels, opts.transport);
    fusionTokens += fused.totalTokens;
    const f = await scoreOne(fused.answer, q);
    fusionDims.push(f.dims);
    if (f.faith != null) fusionFaith.push(f.faith);
  }

  const meanOf = (dims: DimensionScores[], faith: number[]) => {
    const perQ = dims.map((d, i) => {
      const vals = [d.grounding, d.coverage, d.balance, d.cleanliness];
      if (judged) vals.push(faith[i] ?? 0);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    });
    return mean(perQ);
  };

  const singleScore = meanOf(singleDims, singleFaith);
  const fusionScore = meanOf(fusionDims, fusionFaith);
  const sd = avgDims(singleDims, judged ? singleFaith : null);
  const fd = avgDims(fusionDims, judged ? fusionFaith : null);

  const deltaByDimension = {
    grounding: fd.grounding - sd.grounding,
    coverage: fd.coverage - sd.coverage,
    balance: fd.balance - sd.balance,
    cleanliness: fd.cleanliness - sd.cleanliness,
    ...(judged ? { faithfulness: (fd as { faithfulness: number }).faithfulness - (sd as { faithfulness: number }).faithfulness } : {}),
  };

  return {
    corpusVersion: corpus.version,
    transport: opts.transportKind,
    judged,
    ...(judged ? { judge: { model: judgeModel, promptVersion: DRACO_JUDGE.promptVersion } } : {}),
    single: { arm: 'single', score: singleScore, perDimension: sd, totalTokens: singleTokens },
    fusion: { arm: 'fusion', score: fusionScore, perDimension: fd, totalTokens: fusionTokens },
    delta: fusionScore - singleScore,
    deltaByDimension,
    fusionWins: fusionScore > singleScore,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THREE-WAY ABLATION — the full thesis (ADR-037 §M6, refined).
//
//   vanilla   < harness   < fusion+harness
//   (raw chat)  (structure)  (structure + independent fusion)
//
// The claim the benchmark proves: a HARNESS beats vanilla (structure adds
// coverage/balance/citations), and FUSION beats the harness (an independent
// verifier of a different family catches the hallucinations a single model
// rubber-stamps). Each "<" is a MEASURED delta over the same corpus + scorer.
// ─────────────────────────────────────────────────────────────────────────────

export interface ThreeWayReport {
  corpusVersion: number;
  transport: 'mock' | 'live';
  judged: boolean;
  judge?: { model: string; promptVersion: number };
  arms: { vanilla: ArmResult; harness: ArmResult; fusion: ArmResult };
  /** vanilla→harness and harness→fusion deltas. */
  deltas: { harnessOverVanilla: number; fusionOverHarness: number; fusionOverVanilla: number };
  /** True iff vanilla <= harness <= fusion AND fusion strictly beats vanilla. */
  thesisHolds: boolean;
  /** The measured ordering, best last. */
  ordering: Array<'vanilla' | 'harness' | 'fusion'>;
}

export async function runThreeWayAblation(corpus: DracoCorpus, opts: AblationOptions): Promise<ThreeWayReport> {
  const judged = !!opts.judgeTransport;
  const judgeModel = opts.judgeModel ?? DRACO_JUDGE.model;
  const fusionModels = opts.fusionModels ?? DRACO_OPTIMIZED_MODELS;
  if (judged) assertJudgeIndependent(judgeModel, fusionModels);
  const singleModel = opts.singleModel ?? DRACO_SINGLE_MODEL;

  let questions = corpus.questions;
  if (opts.limit != null) questions = questions.slice(0, opts.limit);

  const dims = { vanilla: [] as DimensionScores[], harness: [] as DimensionScores[], fusion: [] as DimensionScores[] };
  const faith = { vanilla: [] as number[], harness: [] as number[], fusion: [] as number[] };
  const tokens = { vanilla: 0, harness: 0, fusion: 0 };

  const scoreOne = async (answer: string, q: typeof questions[number]) => {
    const d = await scoreAnswer(answer, q.rubric, q.prompt, opts.checkUrl);
    let f: number | undefined;
    if (judged && opts.judgeTransport) f = (await judgeFaithfulness(answer, opts.judgeTransport, judgeModel)).faithfulness;
    return { d, f };
  };

  for (const q of questions) {
    const v = await vanillaResearch({ id: q.id, prompt: q.prompt }, singleModel, opts.transport);
    tokens.vanilla += v.totalTokens;
    const vs = await scoreOne(v.answer, q); dims.vanilla.push(vs.d); if (vs.f != null) faith.vanilla.push(vs.f);

    const h = await singleModelHarness({ id: q.id, prompt: q.prompt }, singleModel, opts.transport);
    tokens.harness += h.totalTokens;
    const hs = await scoreOne(h.answer, q); dims.harness.push(hs.d); if (hs.f != null) faith.harness.push(hs.f);

    const f = await fuseResearch({ id: q.id, prompt: q.prompt }, fusionModels, opts.transport);
    tokens.fusion += f.totalTokens;
    const fs = await scoreOne(f.answer, q); dims.fusion.push(fs.d); if (fs.f != null) faith.fusion.push(fs.f);
  }

  const score = (ds: DimensionScores[], ff: number[]) => {
    const perQ = ds.map((d, i) => {
      const vals = [d.grounding, d.coverage, d.balance, d.cleanliness];
      if (judged) vals.push(ff[i] ?? 0);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    });
    return mean(perQ);
  };
  const arm = (name: ArmResult['arm'], ds: DimensionScores[], ff: number[], tk: number): ArmResult => ({
    arm: name, score: score(ds, ff), perDimension: avgDims(ds, judged ? ff : null), totalTokens: tk,
  });

  const vanilla = arm('single', dims.vanilla, faith.vanilla, tokens.vanilla);
  const harness = { ...arm('single', dims.harness, faith.harness, tokens.harness), arm: 'single' as const };
  const fusion = arm('fusion', dims.fusion, faith.fusion, tokens.fusion);

  const ordering = ([
    ['vanilla', vanilla.score] as const,
    ['harness', harness.score] as const,
    ['fusion', fusion.score] as const,
  ]).sort((a, b) => a[1] - b[1]).map(([n]) => n);

  return {
    corpusVersion: corpus.version,
    transport: opts.transportKind,
    judged,
    ...(judged ? { judge: { model: judgeModel, promptVersion: DRACO_JUDGE.promptVersion } } : {}),
    arms: { vanilla, harness, fusion },
    deltas: {
      harnessOverVanilla: harness.score - vanilla.score,
      fusionOverHarness: fusion.score - harness.score,
      fusionOverVanilla: fusion.score - vanilla.score,
    },
    thesisHolds: vanilla.score <= harness.score && harness.score <= fusion.score && fusion.score > vanilla.score,
    ordering,
  };
}
