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
import { augmentedResearch } from './augment.js';
import { selfConsistentResearch } from './self-consistency.js';
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
  /** Called as each question finishes — lets a long live run emit a heartbeat
   * instead of printing nothing until the end. */
  onProgress?: (done: number, total: number, questionId: string) => void;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * How many QUESTIONS run concurrently. The old runner was one-call-at-a-time
 * (slow but rate-limit-safe). Naive `Promise.all(questions.map(...))` flipped to
 * the other extreme: on a 20-Q three-way run it fires ~60 pipelines at once,
 * which hammers OpenRouter into a 429 storm — the fusion transport throws on a
 * non-2xx, that rejects the whole batch, and the run dies with no output
 * (observed iter 160: 0-byte output, no artifact). A small BOUNDED pool is the
 * fix: parallel enough to be ~Nx faster, capped so we never burst past the rate
 * limit. Override with DRACO_CONCURRENCY for fatter accounts.
 */
const DRACO_CONCURRENCY = Math.max(1, parseInt(process.env.DRACO_CONCURRENCY ?? '4', 10) || 4);

/**
 * Map `items` through async `fn` with at most `limit` running at once, preserving
 * INPUT ORDER in the result (so downstream scoring stays deterministic w.r.t. the
 * corpus). A pure helper — no deps. If any task rejects, the whole call rejects
 * (we want a live run to fail loudly, not silently average over dropped questions).
 */
async function mapPooled<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const pool = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(pool);
  return results;
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

  // Bounded pool (iter 160): both arms per question run concurrently, questions
  // through a capped pool. Order preserved → deterministic. See DRACO_CONCURRENCY.
  let done = 0;
  const rows = await mapPooled(questions, DRACO_CONCURRENCY, async (q) => {
    const [single, fused] = await Promise.all([
      singleModelResearch({ id: q.id, prompt: q.prompt }, singleModel, opts.transport),
      fuseResearch({ id: q.id, prompt: q.prompt }, fusionModels, opts.transport),
    ]);
    const [s, f] = await Promise.all([scoreOne(single.answer, q), scoreOne(fused.answer, q)]);
    opts.onProgress?.(++done, questions.length, q.id);
    return { single, fused, s, f };
  });
  for (const r of rows) {
    singleTokens += r.single.totalTokens;
    singleDims.push(r.s.dims);
    if (r.s.faith != null) singleFaith.push(r.s.faith);
    fusionTokens += r.fused.totalTokens;
    fusionDims.push(r.f.dims);
    if (r.f.faith != null) fusionFaith.push(r.f.faith);
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

  // Optimisation (iter 159, hardened iter 160): run questions through a BOUNDED
  // pool (DRACO_CONCURRENCY, default 4). Within each question the three arms run
  // concurrently; across questions at most `limit` are in flight. Far faster than
  // the old one-call-at-a-time loop, but capped so a live run never bursts past
  // the OpenRouter rate limit (the unbounded version 429-stormed and died with no
  // output). mapPooled preserves input order → deterministic scoring.
  let done = 0;
  const perQ = await mapPooled(questions, DRACO_CONCURRENCY, async (q) => {
    const [v, h, f] = await Promise.all([
      vanillaResearch({ id: q.id, prompt: q.prompt }, singleModel, opts.transport),
      singleModelHarness({ id: q.id, prompt: q.prompt }, singleModel, opts.transport),
      fuseResearch({ id: q.id, prompt: q.prompt }, fusionModels, opts.transport),
    ]);
    const [vs, hs, fs] = await Promise.all([scoreOne(v.answer, q), scoreOne(h.answer, q), scoreOne(f.answer, q)]);
    opts.onProgress?.(++done, questions.length, q.id);
    return { v, h, f, vs, hs, fs };
  });
  for (const r of perQ) {
    tokens.vanilla += r.v.totalTokens; dims.vanilla.push(r.vs.d); if (r.vs.f != null) faith.vanilla.push(r.vs.f);
    tokens.harness += r.h.totalTokens; dims.harness.push(r.hs.d); if (r.hs.f != null) faith.harness.push(r.hs.f);
    tokens.fusion += r.f.totalTokens; dims.fusion.push(r.fs.d); if (r.fs.f != null) faith.fusion.push(r.fs.f);
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

// ─────────────────────────────────────────────────────────────────────────────
// AUGMENT ABLATION (ADR-038 arm 1) — vanilla vs augment-not-replace.
//
// Measures whether refining the strong direct dossier with an independent
// verify→prune pass (augment.ts) beats the raw vanilla dossier on the SAME
// scorer. The baseline showed the rebuild-everything harness loses to vanilla;
// this tests the opposite design — keep vanilla's grounding, only prune.
// ─────────────────────────────────────────────────────────────────────────────

export interface AugmentReport {
  corpusVersion: number;
  transport: 'mock' | 'live';
  judged: boolean;
  judge?: { model: string; promptVersion: number };
  vanilla: ArmResult;
  augment: ArmResult;
  /** augment.score − vanilla.score. Positive → augment wins. */
  delta: number;
  deltaByDimension: { grounding: number; coverage: number; balance: number; cleanliness: number; faithfulness?: number };
  augmentWins: boolean;
}

export async function runAugmentAblation(corpus: DracoCorpus, opts: AblationOptions): Promise<AugmentReport> {
  const judged = !!opts.judgeTransport;
  const judgeModel = opts.judgeModel ?? DRACO_JUDGE.model;
  const fusionModels = opts.fusionModels ?? DRACO_OPTIMIZED_MODELS;
  if (judged) assertJudgeIndependent(judgeModel, fusionModels);
  const baseModel = opts.singleModel ?? DRACO_SINGLE_MODEL;
  const verifyModel = fusionModels.verify; // independent family, reused from the fusion map

  let questions = corpus.questions;
  if (opts.limit != null) questions = questions.slice(0, opts.limit);

  const scoreOne = async (answer: string, q: typeof questions[number]) => {
    const d = await scoreAnswer(answer, q.rubric, q.prompt, opts.checkUrl);
    let f: number | undefined;
    if (judged && opts.judgeTransport) f = (await judgeFaithfulness(answer, opts.judgeTransport, judgeModel)).faithfulness;
    return { d, f };
  };

  const vDims: DimensionScores[] = [];
  const aDims: DimensionScores[] = [];
  const vFaith: number[] = [];
  const aFaith: number[] = [];
  let vTokens = 0;
  let aTokens = 0;

  let done = 0;
  const rows = await mapPooled(questions, DRACO_CONCURRENCY, async (q) => {
    const [v, a] = await Promise.all([
      vanillaResearch({ id: q.id, prompt: q.prompt }, baseModel, opts.transport),
      augmentedResearch({ id: q.id, prompt: q.prompt }, { baseModel, verifyModel, transport: opts.transport }),
    ]);
    const [vs, as] = await Promise.all([scoreOne(v.answer, q), scoreOne(a.answer, q)]);
    opts.onProgress?.(++done, questions.length, q.id);
    return { v, a, vs, as };
  });
  for (const r of rows) {
    vTokens += r.v.totalTokens; vDims.push(r.vs.d); if (r.vs.f != null) vFaith.push(r.vs.f);
    aTokens += r.a.totalTokens; aDims.push(r.as.d); if (r.as.f != null) aFaith.push(r.as.f);
  }

  const score = (ds: DimensionScores[], ff: number[]) =>
    mean(ds.map((d, i) => {
      const vals = [d.grounding, d.coverage, d.balance, d.cleanliness];
      if (judged) vals.push(ff[i] ?? 0);
      return vals.reduce((x, y) => x + y, 0) / vals.length;
    }));

  const vScore = score(vDims, vFaith);
  const aScore = score(aDims, aFaith);
  const vd = avgDims(vDims, judged ? vFaith : null);
  const ad = avgDims(aDims, judged ? aFaith : null);

  return {
    corpusVersion: corpus.version,
    transport: opts.transportKind,
    judged,
    ...(judged ? { judge: { model: judgeModel, promptVersion: DRACO_JUDGE.promptVersion } } : {}),
    vanilla: { arm: 'single', score: vScore, perDimension: vd, totalTokens: vTokens },
    augment: { arm: 'fusion', score: aScore, perDimension: ad, totalTokens: aTokens },
    delta: aScore - vScore,
    deltaByDimension: {
      grounding: ad.grounding - vd.grounding,
      coverage: ad.coverage - vd.coverage,
      balance: ad.balance - vd.balance,
      cleanliness: ad.cleanliness - vd.cleanliness,
      ...(judged ? { faithfulness: (ad as { faithfulness: number }).faithfulness - (vd as { faithfulness: number }).faithfulness } : {}),
    },
    augmentWins: aScore > vScore,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-CONSISTENCY ABLATION (ADR-038 arm 2) — vanilla vs best-of-N selection.
//
// Generate N intact diverse-angle dossiers, judge-select the best. Never
// transforms a candidate → grounding cannot be lost. Measured vs vanilla on the
// identical scorer. Requires a judge transport (the selector); without one it
// degenerates to vanilla and is meaningless, so judgeTransport is required.
// ─────────────────────────────────────────────────────────────────────────────

export interface SelfConsistencyReport {
  corpusVersion: number;
  transport: 'mock' | 'live';
  judged: boolean;
  judge?: { model: string; promptVersion: number };
  candidates: number;
  vanilla: ArmResult;
  selfConsistency: ArmResult;
  delta: number;
  deltaByDimension: { grounding: number; coverage: number; balance: number; cleanliness: number; faithfulness?: number };
  selfConsistencyWins: boolean;
  /** How often each candidate angle was selected (diagnostic). */
  selectionHistogram: number[];
}

export async function runSelfConsistencyAblation(
  corpus: DracoCorpus,
  opts: AblationOptions & { candidates?: number },
): Promise<SelfConsistencyReport> {
  const judged = !!opts.judgeTransport;
  const judgeModel = opts.judgeModel ?? DRACO_JUDGE.model;
  const baseModel = opts.singleModel ?? DRACO_SINGLE_MODEL;
  const candidates = opts.candidates ?? 3;
  if (!opts.judgeTransport) {
    throw new Error('self-consistency selection requires a judge transport (the selector). Run with the judge enabled.');
  }

  let questions = corpus.questions;
  if (opts.limit != null) questions = questions.slice(0, opts.limit);

  const scoreOne = async (answer: string, q: typeof questions[number]) => {
    const d = await scoreAnswer(answer, q.rubric, q.prompt, opts.checkUrl);
    let f: number | undefined;
    if (judged && opts.judgeTransport) f = (await judgeFaithfulness(answer, opts.judgeTransport, judgeModel)).faithfulness;
    return { d, f };
  };

  const vDims: DimensionScores[] = [];
  const sDims: DimensionScores[] = [];
  const vFaith: number[] = [];
  const sFaith: number[] = [];
  let vTokens = 0;
  let sTokens = 0;
  const hist: number[] = [];

  let done = 0;
  const rows = await mapPooled(questions, DRACO_CONCURRENCY, async (q) => {
    const [v, sc] = await Promise.all([
      vanillaResearch({ id: q.id, prompt: q.prompt }, baseModel, opts.transport),
      selfConsistentResearch({ id: q.id, prompt: q.prompt }, {
        baseModel, judgeModel, transport: opts.transport, judgeTransport: opts.judgeTransport!, candidates,
      }),
    ]);
    const [vs, ss] = await Promise.all([scoreOne(v.answer, q), scoreOne(sc.answer, q)]);
    opts.onProgress?.(++done, questions.length, q.id);
    return { v, sc, vs, ss };
  });
  for (const r of rows) {
    vTokens += r.v.totalTokens; vDims.push(r.vs.d); if (r.vs.f != null) vFaith.push(r.vs.f);
    sTokens += r.sc.totalTokens; sDims.push(r.ss.d); if (r.ss.f != null) sFaith.push(r.ss.f);
    hist[r.sc.selectedIndex] = (hist[r.sc.selectedIndex] ?? 0) + 1;
  }

  const score = (ds: DimensionScores[], ff: number[]) =>
    mean(ds.map((d, i) => {
      const vals = [d.grounding, d.coverage, d.balance, d.cleanliness];
      if (judged) vals.push(ff[i] ?? 0);
      return vals.reduce((x, y) => x + y, 0) / vals.length;
    }));

  const vScore = score(vDims, vFaith);
  const sScore = score(sDims, sFaith);
  const vd = avgDims(vDims, judged ? vFaith : null);
  const sd = avgDims(sDims, judged ? sFaith : null);

  return {
    corpusVersion: corpus.version,
    transport: opts.transportKind,
    judged,
    ...(judged ? { judge: { model: judgeModel, promptVersion: DRACO_JUDGE.promptVersion } } : {}),
    candidates,
    vanilla: { arm: 'single', score: vScore, perDimension: vd, totalTokens: vTokens },
    selfConsistency: { arm: 'fusion', score: sScore, perDimension: sd, totalTokens: sTokens },
    delta: sScore - vScore,
    deltaByDimension: {
      grounding: sd.grounding - vd.grounding,
      coverage: sd.coverage - vd.coverage,
      balance: sd.balance - vd.balance,
      cleanliness: sd.cleanliness - vd.cleanliness,
      ...(judged ? { faithfulness: (sd as { faithfulness: number }).faithfulness - (vd as { faithfulness: number }).faithfulness } : {}),
    },
    selfConsistencyWins: sScore > vScore,
    selectionHistogram: Array.from({ length: candidates }, (_, i) => hist[i] ?? 0),
  };
}
