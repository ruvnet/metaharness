// Explicit claim-bearing mode. Research callers keep the compatibility contract of issue #319.
import { createHash } from 'node:crypto';
import { canon } from './receipts.js';
import { bindGateManifest, defaultGateImplementation, gateFingerprint, meetsPromotionRule } from './gate.js';
import { pairedOutcomesFromItemWins, sequentialEvidence } from './sequential.js';
import type { PromotionDecision, PromotionEvidence, PromotionRule, Score, Suite } from './types.js';

export interface EvaluationProvenance {
  source: 'LIVE';
  purpose: 'promotion';
  evaluatorDigest: string;
  corpusDigest: string;
  policyDigest: string;
  /** Ordered, unique task/sample identities, shared by the paired arms. */
  sampleIds: string[];
}
export interface PromotionSuite extends Suite {
  /** Stable source-task identities. Renaming the same task does not make it independent. */
  itemIds: string[];
  seed: string;
}
export interface ProductionGateConfig {
  /** A pre-registered comparison family, not a disposable per-invocation run id. */
  familyId: string;
  alpha?: number;
  lambda?: number;
  /** Fixed before any observations; at most one independent comparison per generation. */
  maxComparisons: number;
  evaluator: { id: string; model: string; artifactDigest: string };
  dependenciesDigest: string;
  /** Required for a custom base rule: explicit closed-over parameters and helper artifact identity. */
  baseRule?: { configuration: Record<string, unknown>; dependenciesDigest: string };
  selectionItemIds: string[];
  anchorItemIds?: string[];
  /** One fresh, disjoint, unused suite per generation, inaccessible to the proposer. */
  suites: PromotionSuite[];
}
export interface ProductionGateManifest {
  version: 'production-gate-v1';
  familyId: string;
  alpha: number;
  lambda: number;
  maxComparisons: number;
  implementationDigest: string;
  baseRule: { fingerprint: string; configuration: Record<string, unknown>; dependenciesDigest: string };
  evaluator: { id: string; model: string; artifactDigest: string; sourceDigest: string };
  dependenciesDigest: string;
  selectionCorpusDigest: string;
  anchorCorpusDigest: string | null;
  anchorItemIds: string[];
  mutationTargets: string[];
  selectionItemIds: string[];
  suites: Array<{ id: string; digest: string; itemIds: string[]; seed: string }>;
  budget: { ledgerId: string; total: number; evaluatorUnits: number; proposerUnits: number };
  rootPolicyDigest: string;
}
export interface ProductionEvidence {
  comparison: number;
  baselinePolicyDigest: string;
  candidatePolicyDigest: string;
  baseline: Score;
  candidate: Score;
}

/** Reject values JSON would erase or coerce; canonical identities must not have silent collisions. */
export function evidenceDigest(value: unknown): string {
  const visit = (v: unknown): void => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) throw new Error('non-canonical sparse array');
      for (let i = 0; i < v.length; i++) {
        if (!Object.hasOwn(v, i)) throw new Error('non-canonical sparse array');
        visit(v[i]);
      }
      return;
    }
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      Object.values(v).forEach(visit); return;
    }
    throw new Error('non-canonical evidence');
  };
  visit(value);
  return createHash('sha256').update(canon(value)).digest('hex');
}
const isDigest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const idsValid = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(nonempty) && new Set(v).size === v.length;

export function createProductionManifest(
  config: ProductionGateConfig,
  context: { baseRule: PromotionRule; evaluator: Function; holdout: Suite; rootPolicy: unknown; anchor?: Suite; targets?: string[]; budget: ProductionGateManifest['budget'] },
): ProductionGateManifest {
  const alpha = config.alpha ?? 0.05, lambda = config.lambda ?? 0.5;
  sequentialEvidence([], { alpha, lambda });
  if (!nonempty(config.familyId) || !Number.isSafeInteger(config.maxComparisons) || config.maxComparisons <= 0)
    throw new Error('production requires a fixed familyId and positive maxComparisons');
  if (!config.evaluator || !nonempty(config.evaluator.id) || !nonempty(config.evaluator.model) || !isDigest(config.evaluator.artifactDigest) || !isDigest(config.dependenciesDigest))
    throw new Error('production requires evaluator/model and dependency artifact digests');
  if (!idsValid(config.selectionItemIds) || config.selectionItemIds.length !== context.holdout.items.length)
    throw new Error('selection item identities must be unique and suite-aligned');
  if (!Array.isArray(config.suites) || config.suites.length !== config.maxComparisons)
    throw new Error('production requires one fresh suite for every pre-registered comparison');
  const usedIds = new Set(config.selectionItemIds);
  const usedItems = new Set(context.holdout.items.map(evidenceDigest));
  if (context.anchor) {
    if (!idsValid(config.anchorItemIds) || config.anchorItemIds.length !== context.anchor.items.length) throw new Error('anchor item identities must be unique and suite-aligned');
    for (let i = 0; i < context.anchor.items.length; i++) {
      const item = evidenceDigest(context.anchor.items[i]);
      if (usedIds.has(config.anchorItemIds[i]!) || usedItems.has(item)) throw new Error('anchor must be disjoint from selection');
      usedIds.add(config.anchorItemIds[i]!); usedItems.add(item);
    }
  }
  const usedSuites = new Set([context.holdout.id, ...(context.anchor ? [context.anchor.id] : [])]);
  const suites = config.suites.map((s) => {
    if (!s || !nonempty(s.id) || usedSuites.has(s.id) || !nonempty(s.seed) || !idsValid(s.itemIds) || !Array.isArray(s.items) || s.items.length !== s.itemIds.length)
      throw new Error('invalid independent promotion suite');
    usedSuites.add(s.id);
    for (let i = 0; i < s.items.length; i++) {
      const item = evidenceDigest(s.items[i]);
      if (usedIds.has(s.itemIds[i]!) || usedItems.has(item)) throw new Error('promotion suites must be disjoint from selection and prior comparisons');
      usedIds.add(s.itemIds[i]!); usedItems.add(item);
    }
    return { id: s.id, digest: evidenceDigest({ id: s.id, items: s.items, itemIds: s.itemIds, seed: s.seed }), itemIds: [...s.itemIds], seed: s.seed };
  });
  if (context.baseRule !== meetsPromotionRule && (!config.baseRule || !isDigest(config.baseRule.dependenciesDigest)))
    throw new Error('custom production base rule requires explicit configuration and dependency digest');
  sequentialEvidence([], { alpha: alpha / config.maxComparisons, lambda });
  const b = context.budget;
  if (!nonempty(b.ledgerId) || !Number.isSafeInteger(b.total) || b.total < 0 || !Number.isSafeInteger(b.evaluatorUnits) || b.evaluatorUnits <= 0 || !Number.isSafeInteger(b.proposerUnits) || b.proposerUnits <= 0)
    throw new Error('invalid production hard budget');
  const manifest: ProductionGateManifest = {
    version: 'production-gate-v1', familyId: config.familyId, alpha, lambda, maxComparisons: config.maxComparisons,
    implementationDigest: productionImplementationDigest(),
    baseRule: { fingerprint: gateFingerprint(context.baseRule), configuration: config.baseRule?.configuration ?? {}, dependenciesDigest: config.baseRule?.dependenciesDigest ?? defaultGateImplementation() },
    evaluator: { ...config.evaluator, sourceDigest: evidenceDigest(context.evaluator.toString()) },
    dependenciesDigest: config.dependenciesDigest,
    selectionCorpusDigest: evidenceDigest(context.holdout), anchorCorpusDigest: context.anchor ? evidenceDigest(context.anchor) : null, anchorItemIds: context.anchor ? [...config.anchorItemIds!] : [], mutationTargets: [...(context.targets ?? [])], selectionItemIds: [...config.selectionItemIds], suites,
    budget: { ...b }, rootPolicyDigest: evidenceDigest(context.rootPolicy),
  };
  // Snapshot every nested user-owned object before the first observation.
  return JSON.parse(canon(manifest)) as ProductionGateManifest;
}

function productionImplementationDigest(): string {
  return evidenceDigest([productionDecision, validProductionScore, validProductionScoreDomain, validateProductionManifest, isDigest, idsValid, nonempty, canon, evidenceDigest, sequentialEvidence, pairedOutcomesFromItemWins, createProductionPromotionRule].map(String));
}

export function validProductionScoreDomain(s: Score | undefined): s is Score {
  return !!s && typeof s.primary === 'number' && Number.isFinite(s.primary) && typeof s.noopRate === 'number' && Number.isFinite(s.noopRate) && s.noopRate >= 0 && s.noopRate <= 1 &&
    typeof s.costPerWin === 'number' && Number.isFinite(s.costPerWin) && s.costPerWin >= 0 && typeof s.regressed === 'boolean';
}

function validProductionScore(s: Score | undefined, suite: ProductionGateManifest['suites'][number], policy: string, manifest: ProductionGateManifest): boolean {
  const p = s?.provenance;
  return validProductionScoreDomain(s) &&
    Array.isArray(s.itemWins) && s.itemWins.length === suite.itemIds.length && s.itemWins.every((v) => typeof v === 'boolean') &&
    Object.keys(s.itemWins).length === s.itemWins.length &&
    !!p && p.source === 'LIVE' && p.purpose === 'promotion' && p.evaluatorDigest === manifest.evaluator.artifactDigest &&
    p.corpusDigest === suite.digest && p.policyDigest === policy && canon(p.sampleIds) === canon(suite.itemIds);
}

function productionDecision(e: PromotionEvidence, manifest: ProductionGateManifest, baseRule: PromotionRule): PromotionDecision {
  const inconclusive = (reason: string): PromotionDecision => ({ promote: false, status: 'INCONCLUSIVE', reasons: [reason] });
  if (!e || !validProductionScoreDomain(e.baseline) || !validProductionScoreDomain(e.candidate)) return inconclusive('invalid_selection_evidence');
  if (manifest.anchorCorpusDigest !== null && (!e.anchor || !Number.isFinite(e.anchor.baseline) || !Number.isFinite(e.anchor.candidate))) return inconclusive('missing_anchor_evidence');
  const p = e.production;
  if (!p || !Number.isSafeInteger(p.comparison) || p.comparison < 1 || p.comparison > manifest.maxComparisons)
    return inconclusive('missing_independent_evidence');
  const suite = manifest.suites[p.comparison - 1];
  if (!suite || !isDigest(p.baselinePolicyDigest) || !isDigest(p.candidatePolicyDigest) || p.baselinePolicyDigest === p.candidatePolicyDigest ||
    !validProductionScore(p.baseline, suite, p.baselinePolicyDigest, manifest) || !validProductionScore(p.candidate, suite, p.candidatePolicyDigest, manifest))
    return inconclusive('invalid_independent_evidence');
  const paired = pairedOutcomesFromItemWins(p.baseline, p.candidate);
  if (!paired || paired.length === 0) return inconclusive('missing_paired_evidence');
  const verdict = sequentialEvidence(paired, { alpha: manifest.alpha / manifest.maxComparisons, lambda: manifest.lambda });
  const base = baseRule(e);
  const independent = meetsPromotionRule({ baseline: p.baseline, candidate: p.candidate });
  if (!verdict.informativePairs) return inconclusive('noninformative_paired_evidence');
  const anchorSurvives = !e.anchor || e.anchor.candidate >= e.anchor.baseline;
  const reasons = [...base.reasons, ...(e.candidate.regressed ? ['safety_regressed'] : []), ...independent.reasons.map((r) => `independent_${r}`), ...(!anchorSurvives ? ['anchor_regressed'] : [])];
  if (!verdict.significant) reasons.push('insufficient_independent_sequential_evidence');
  return { promote: base.promote && !e.candidate.regressed && independent.promote && anchorSurvives && verdict.significant, status: reasons.length ? 'REJECT' : 'PROMOTE', reasons };
}

function validateProductionManifest(m: ProductionGateManifest): void {
  if (m.version !== 'production-gate-v1' || !nonempty(m.familyId) || !Number.isSafeInteger(m.maxComparisons) || m.maxComparisons < 1 ||
    !Array.isArray(m.suites) || m.suites.length !== m.maxComparisons || !idsValid(m.selectionItemIds) || !Array.isArray(m.anchorItemIds) ||
    !isDigest(m.selectionCorpusDigest) || !isDigest(m.rootPolicyDigest) || !isDigest(m.dependenciesDigest) ||
    !isDigest(m.baseRule?.fingerprint) || !isDigest(m.baseRule?.dependenciesDigest) || !m.baseRule.configuration ||
    !isDigest(m.evaluator?.artifactDigest) || !isDigest(m.evaluator?.sourceDigest) || !nonempty(m.evaluator?.id) || !nonempty(m.evaluator?.model)) throw new Error('invalid production manifest');
  sequentialEvidence([], { alpha: m.alpha / m.maxComparisons, lambda: m.lambda });
  if (!(m.alpha > 0 && m.alpha < 1) || typeof m.alpha !== 'number') throw new Error('invalid production family alpha');
  if (m.anchorCorpusDigest !== null && (!isDigest(m.anchorCorpusDigest) || !idsValid(m.anchorItemIds))) throw new Error('invalid production anchor identity');
  if (m.anchorCorpusDigest === null && m.anchorItemIds.length !== 0) throw new Error('unexpected production anchor identities');
  const ids = new Set(m.selectionItemIds), suiteIds = new Set<string>();
  for (const id of m.anchorItemIds) { if (ids.has(id)) throw new Error('overlapping anchor identities'); ids.add(id); }
  for (const suite of m.suites) {
    if (!nonempty(suite.id) || suiteIds.has(suite.id) || !nonempty(suite.seed) || !isDigest(suite.digest) || !idsValid(suite.itemIds)) throw new Error('invalid promotion suite identity');
    suiteIds.add(suite.id);
    for (const id of suite.itemIds) { if (ids.has(id)) throw new Error('overlapping promotion identities'); ids.add(id); }
  }
  const b = m.budget;
  if (!b || !nonempty(b.ledgerId) || !Number.isSafeInteger(b.total) || b.total < 0 || !Number.isSafeInteger(b.evaluatorUnits) || b.evaluatorUnits <= 0 || !Number.isSafeInteger(b.proposerUnits) || b.proposerUnits <= 0) throw new Error('invalid production budget manifest');
}

export function createProductionPromotionRule(manifest: ProductionGateManifest, baseRule: PromotionRule = meetsPromotionRule): PromotionRule {
  const frozen = JSON.parse(canon(manifest)) as ProductionGateManifest;
  evidenceDigest(frozen);
  validateProductionManifest(frozen);
  if (frozen.version !== 'production-gate-v1' || frozen.baseRule.fingerprint !== gateFingerprint(baseRule)) throw new Error('production base rule does not match manifest');
  if (frozen.implementationDigest !== productionImplementationDigest()) throw new Error('production gate implementation changed');
  if (baseRule === meetsPromotionRule && frozen.baseRule.dependenciesDigest !== defaultGateImplementation()) throw new Error('production default gate helpers changed');
  const rule: PromotionRule = (e) => {
    try { return productionDecision(e, frozen, baseRule); }
    catch { return { promote: false, status: 'INCONCLUSIVE', reasons: ['malformed_production_evidence'] }; }
  };
  return bindGateManifest(rule, frozen);
}
