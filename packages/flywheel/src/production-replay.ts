import { computeLiftCurve } from './lineage.js';
import { canon, verifyReceipt } from './receipts.js';
import { createProductionPromotionRule, validProductionScoreDomain } from './production-gate.js';
import { gateFingerprint } from './gate.js';
import type { ReplayBundle, PromotionRule } from './types.js';

export function isProductionBundle(b: ReplayBundle): boolean {
  return b.promotion_mode === 'production' || b.gate_manifest !== undefined || b.production_receipt !== undefined ||
    [...b.chain, ...b.all_commits].some((c) => 'gateManifest' in c.receipt.payload || 'gateFingerprint' in c.receipt.payload);
}

/** Pins are supplied independently of the bundle. Embedded keys alone prove consistency, not authority. */
export function verifyProductionBindings(b: ReplayBundle, opts: { pinnedGateFingerprint?: string; pinnedPublicKey?: string; promotionRule?: PromotionRule }): boolean {
  try {
    if (b.promotion_mode !== 'production' || b.data_source !== 'LIVE' || !b.gate_manifest || !b.budget_snapshot || !b.production_receipt || !opts.pinnedGateFingerprint || !opts.pinnedPublicKey) return false;
    const { production_receipt: receipt, ...unsigned } = b;
    if (receipt.publicKey !== opts.pinnedPublicKey || !verifyReceipt(receipt) || canon(receipt.payload) !== canon({ kind: 'production-bundle', bundle: unsigned })) return false;
    const manifest = b.gate_manifest;
    const rule = opts.promotionRule ?? createProductionPromotionRule(manifest);
    if (gateFingerprint(rule) !== opts.pinnedGateFingerprint || b.gate_fingerprint !== opts.pinnedGateFingerprint) return false;
    const root = b.chain[b.chain.length - 1];
    if (!root || root.receipt.payload.gateFingerprint !== opts.pinnedGateFingerprint || canon(root.receipt.payload.gateManifest) !== canon(manifest) ||
      root.receipt.payload.anchorScore !== root.anchorScore || root.receipt.payload.policyDigest !== root.policyDigest || root.policyDigest !== manifest.rootPolicyDigest) return false;
    const rootScore = root.receipt.payload.rootScore as import('./types.js').Score;
    if (!validProductionScoreDomain(rootScore)) return false;
    if ((manifest.anchorCorpusDigest === null) !== (root.anchorScore === null)) return false;
    if (manifest.anchorCorpusDigest !== null && (!validProductionScoreDomain(root.anchorEvaluation) || root.anchorEvaluation.regressed || root.anchorEvaluation.primary !== root.anchorScore || canon(root.receipt.payload.anchorEvaluation) !== canon(root.anchorEvaluation))) return false;
    const promoted = b.chain.filter((c) => c.verdict === 'PROMOTED' && c.primaryDelta > 0).length;
    if (b.verified_improvements !== promoted || b.anchor_surviving_improvements !== promoted || b.milestone_reached !== (promoted >= 2) || canon(b.lift_curve) !== canon(computeLiftCurve(b.chain, rootScore.primary))) return false;
    const budget = b.budget_snapshot;
    if (budget.ledgerId !== manifest.budget.ledgerId || budget.total !== manifest.budget.total || !Number.isSafeInteger(budget.reserved) || budget.reserved < 0 || budget.reserved > budget.total || budget.remaining !== budget.total - budget.reserved) return false;
    const ids = new Set<string>(); let sum = 0;
    for (const op of budget.operations) {
      if (ids.has(op.operationId) || !Number.isSafeInteger(op.units) || op.units <= 0 || op.state !== 'reserved') return false;
      ids.add(op.operationId); sum += op.units;
    }
    if (sum !== budget.reserved) return false;
    const hasOperation = (op: string, kind: 'proposer' | 'evaluator'): boolean => budget.operations.some((r) =>
      r.operationId === canon([manifest.familyId, op]) && r.kind === kind && r.evaluatorId === canon([manifest.evaluator.id, opts.pinnedGateFingerprint]) &&
      r.units === (kind === 'evaluator' ? manifest.budget.evaluatorUnits : manifest.budget.proposerUnits));
    if (!hasOperation('baseline', 'evaluator') || (root.anchorScore !== null && !hasOperation('root-anchor', 'evaluator'))) return false;
    const commits = new Map<string, string>();
    const comparisons = new Map<number, string>();
    const ledgerIds = new Set(b.all_commits.map((c) => c.id));
    const promotedChainIds = new Set(b.chain.map((c) => c.id));
    for (const c of [...b.chain, ...b.all_commits]) {
      if (c.receipt.publicKey !== opts.pinnedPublicKey || !verifyReceipt(c.receipt)) return false;
      const encoded = canon(c);
      if (commits.has(c.id)) { if (commits.get(c.id) !== encoded) return false; continue; }
      commits.set(c.id, encoded);
      if (c.verdict === 'ROOT') continue;
      if (!ledgerIds.has(c.id) || c.receipt.payload.gateFingerprint !== opts.pinnedGateFingerprint ||
        !Number.isSafeInteger(c.generation) || c.generation < 1 || c.generation > manifest.maxComparisons ||
        !manifest.mutationTargets.includes(c.mutation?.target ?? '')) return false;
      const { receipt: _receipt, ...fields } = c;
      if (canon(c.receipt.payload) !== canon({ kind: 'candidate', gateFingerprint: opts.pinnedGateFingerprint, ...fields, target: c.mutation?.target })) return false;
      if (!hasOperation(`gen:${c.generation}:propose:${c.mutation?.target}`, 'proposer') || !hasOperation(`gen:${c.generation}:candidate:${c.mutation?.target}`, 'evaluator')) return false;
      if (c.productionEvidence) {
        const p = c.productionEvidence;
        if (p.comparison !== c.generation || p.baselinePolicyDigest !== c.baselinePolicyDigest || p.candidatePolicyDigest !== c.policyDigest || comparisons.has(p.comparison)) return false;
        comparisons.set(p.comparison, c.id);
        if (!hasOperation(`gen:${c.generation}:independent-baseline`, 'evaluator') || !hasOperation(`gen:${c.generation}:independent-candidate`, 'evaluator')) return false;
      }
      if (!validProductionScoreDomain(c.baselineScore) || !validProductionScoreDomain(c.candidateScore) || c.primaryDelta !== c.candidateScore.primary - c.baselineScore.primary) return false;
      if (c.verdict === 'PROMOTED') {
        if (!promotedChainIds.has(c.id)) return false;
        if (manifest.anchorCorpusDigest !== null && (!validProductionScoreDomain(c.anchorEvaluation) || c.anchorEvaluation.regressed || c.anchorEvaluation.primary !== c.anchorScore || c.anchorScore! < root.anchorScore!)) return false;
        if (!c.productionEvidence || !c.baselineScore || !c.candidateScore || !rule({ baseline: c.baselineScore, candidate: c.candidateScore, production: c.productionEvidence,
          ...(root.anchorScore !== null ? { anchor: { baseline: root.anchorScore, candidate: c.anchorScore! } } : {}) }).promote) return false;
        if (root.anchorScore !== null && (c.anchorScore === null || !hasOperation(`gen:${c.generation}:winner-anchor`, 'evaluator'))) return false;
      }
    }
    // A promoted policy must be evaluated against the policy on its actual parent, not a convenient baseline.
    const byId = new Map([...b.chain, ...b.all_commits].map((c) => [c.id, c]));
    for (const c of b.all_commits) {
      const parent = byId.get(c.parents[0]!);
      if (!parent || (parent.verdict !== 'ROOT' && parent.verdict !== 'PROMOTED') || parent.generation >= c.generation) return false;
      if (c.baselinePolicyDigest !== parent?.policyDigest || canon(c.baselineScore) !== canon(parent?.verdict === 'ROOT' ? rootScore : parent?.candidateScore)) return false;
    }
    return true;
  } catch { return false; }
}
