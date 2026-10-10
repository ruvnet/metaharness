import { InMemoryLineageStore, computeLiftCurve } from './lineage.js';
import { gateFingerprint, meetsPromotionRule } from './gate.js';
import { canon, verifyReceipt } from './receipts.js';
import { createProductionManifest, createProductionPromotionRule, evidenceDigest, validProductionScoreDomain } from './production-gate.js';
import type { ProductionEvidence } from './production-gate.js';
import type { FlywheelConfig, FlywheelResult } from './run.js';
import type { BudgetSnapshot } from './budget.js';
import type { CandidateMutation, LineageCommit, Policy, ReplayBundle, ResumeState, Score, Suite } from './types.js';

/** Claim-bearing entry point, reached only by explicit mode (CLI defaults to it). No paid provider
 * integration exists here: every injected operation is admitted before invocation. */
export async function runProductionFlywheel(cfg: FlywheelConfig): Promise<FlywheelResult> {
  cfg = { ...cfg, ...(cfg.resumeFrom ? { resumeFrom: JSON.parse(canon(cfg.resumeFrom)) as ResumeState } : {}) };
  const production = cfg.production ? JSON.parse(canon(cfg.production)) as NonNullable<FlywheelConfig['production']> : undefined;
  const budget = cfg.hardBudget ? { ...cfg.hardBudget } : undefined;
  if (!production || !budget || !budget.limiter.durable) throw new Error('production requires configuration and a durable hard budget limiter');
  if (cfg.dataSource !== 'LIVE') throw new Error('production requires explicit LIVE provenance; use research mode for synthetic/unspecified runs');
  if (cfg.cacheEvaluations) throw new Error('production forbids cached evaluation evidence');
  if (!Number.isSafeInteger(cfg.maxGenerations) || cfg.maxGenerations < 0 || cfg.maxGenerations > production.maxComparisons)
    throw new Error('maxGenerations exceeds the pre-registered comparison family');
  // Snapshot mutable inputs before any await/provider operation.
  const rootPolicy: Policy = JSON.parse(canon(cfg.rootPolicy));
  const holdout: Suite = JSON.parse(canon(cfg.holdout));
  const suites = JSON.parse(canon(production.suites)) as typeof production.suites;
  const anchor = cfg.anchor ? JSON.parse(canon(cfg.anchor)) as Suite : undefined;
  const targets = [...(cfg.mutationTargets ?? Object.keys(rootPolicy))];
  if (!targets.length || new Set(targets).size !== targets.length || targets.some((t) => !Object.hasOwn(rootPolicy, t)))
    throw new Error('production requires distinct valid mutation targets');
  const reserveBudget = budget.limiter.reserve.bind(budget.limiter);
  const snapshotBudget = budget.limiter.snapshot.bind(budget.limiter);
  const initialBudget = await snapshotBudget();
  const baseRule = cfg.promotionRule ?? meetsPromotionRule;
  const manifest = createProductionManifest(production, {
    baseRule, evaluator: cfg.evaluator, holdout, rootPolicy, anchor, targets,
    budget: { ledgerId: initialBudget.ledgerId, total: initialBudget.total, evaluatorUnits: budget.evaluatorUnits, proposerUnits: budget.proposerUnits },
  });
  const rule = createProductionPromotionRule(manifest, baseRule);
  const fingerprint = gateFingerprint(rule);
  const store = cfg.lineageStore ?? new InMemoryLineageStore();
  const rootId = cfg.rootId ?? 'root';
  const now = cfg.now ?? ((g: number) => `gen-${g}`);
  const signer = cfg.signer;
  const family = manifest.familyId;
  // The durable admission record binds the effective gate BEFORE the first observation.
  const evaluatorBudgetId = canon([manifest.evaluator.id, fingerprint]);
  let stopped = false;
  const reserve = async (operation: string, kind: 'proposer' | 'evaluator'): Promise<void> => {
    // IDs deliberately omit caller-controlled root/run IDs. Restarting a family cannot reuse a slot.
    await reserveBudget({ operationId: canon([family, operation]), kind, evaluatorId: evaluatorBudgetId,
      units: kind === 'evaluator' ? budget.evaluatorUnits : budget.proposerUnits });
  };
  const evaluate = async (p: Policy, suite: Suite, operation: string): Promise<Score> => {
    await reserve(operation, 'evaluator');
    // A thrown evaluator is fully charged; no refund or automatic retry after uncertain execution.
    const score = await cfg.evaluator(JSON.parse(canon(p)), JSON.parse(canon(suite)));
    return JSON.parse(canon(score)) as Score;
  };
  const budgetExceeded = (e: unknown): boolean => !!e && typeof e === 'object' && (e as { code?: string }).code === 'BUDGET_EXCEEDED';
  let rootAnchorEvaluation: Score | undefined;
  let rootScore: Score, rootAnchor: number | null, parentId: string, policy: Policy, score: Score;
  let generation = 0;
  const all: LineageCommit[] = [];
  if (cfg.resumeFrom) {
    const r = cfg.resumeFrom;
    const checkpoint = r.production;
    const body = { ...r }; delete body.production;
    if (!checkpoint || checkpoint.gateFingerprint !== fingerprint || checkpoint.ledgerId !== initialBudget.ledgerId || initialBudget.reserved < checkpoint.budgetReserved ||
      !checkpoint.budgetSnapshot || checkpoint.budgetSnapshot.ledgerId !== initialBudget.ledgerId || checkpoint.budgetSnapshot.total !== initialBudget.total ||
      checkpoint.budgetSnapshot.reserved !== checkpoint.budgetReserved ||
      canon(initialBudget.operations.slice(0, checkpoint.budgetSnapshot.operations.length)) !== canon(checkpoint.budgetSnapshot.operations) ||
      !verifyReceipt(checkpoint.checkpointReceipt) || checkpoint.checkpointReceipt.publicKey !== signer.publicKey() ||
      canon(checkpoint.checkpointReceipt.payload) !== canon({ kind: 'production-checkpoint', gateFingerprint: fingerprint, ledgerId: checkpoint.ledgerId, budgetReserved: checkpoint.budgetReserved, budgetSnapshot: checkpoint.budgetSnapshot, state: body }))
      throw new Error('production resume requires an authentic configuration-bound checkpoint and the original budget ledger');
    if (!r.priorCommits.some((c) => c.verdict === 'ROOT' && c.id === rootId && c.policyDigest === manifest.rootPolicyDigest)) throw new Error('production resume root changed');
    if (!Number.isSafeInteger(r.fromGeneration) || r.fromGeneration < 0 || r.fromGeneration > manifest.maxComparisons) throw new Error('invalid production resume generation');
    for (const c of r.priorCommits) {
      if (!verifyReceipt(c.receipt) || c.receipt.publicKey !== signer.publicKey()) throw new Error('invalid production resume lineage');
      await store.append(c);
    }
    all.push(...r.priorCommits.filter((c) => c.verdict !== 'ROOT'));
    rootAnchorEvaluation = r.priorCommits.find((c) => c.verdict === 'ROOT')?.anchorEvaluation;
    rootScore = r.rootScore; rootAnchor = r.rootAnchor; parentId = r.parentId;
    policy = { ...r.policy }; score = r.score; generation = r.fromGeneration;
  } else {
    rootScore = await evaluate(rootPolicy, holdout, 'baseline');
    if (!validProductionScoreDomain(rootScore)) throw new Error('invalid production baseline score');
    rootAnchorEvaluation = anchor ? await evaluate(rootPolicy, anchor, 'root-anchor') : undefined;
    if (anchor && (!validProductionScoreDomain(rootAnchorEvaluation) || rootAnchorEvaluation.regressed)) throw new Error('invalid or unsafe root anchor');
    rootAnchor = rootAnchorEvaluation?.primary ?? null;
    parentId = rootId; policy = { ...rootPolicy }; score = rootScore;
    const root: LineageCommit = {
      id: rootId, generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: rootAnchor,
      verdict: 'ROOT', failureReasons: [], createdAt: now(0), policyDigest: evidenceDigest(rootPolicy),
      ...(rootAnchorEvaluation ? { anchorEvaluation: rootAnchorEvaluation } : {}),
      receipt: signer.sign({ kind: 'root', root: rootId, gateFingerprint: fingerprint, gateManifest: manifest,
        rootScore, anchorScore: rootAnchor, ...(rootAnchorEvaluation ? { anchorEvaluation: rootAnchorEvaluation } : {}), policyDigest: evidenceDigest(rootPolicy) }),
    };
    await store.append(root);
  }
  const bundle = async (): Promise<ReplayBundle> => {
    const chain = await store.walkToRoot(parentId);
    const promoted = chain.filter((c) => c.verdict === 'PROMOTED');
    const count = promoted.filter((c) => c.primaryDelta > 0).length;
    const b: ReplayBundle = {
      promotion_mode: 'production', data_source: 'LIVE', root_id: rootId, chain, all_commits: [...all],
      lift_curve: computeLiftCurve(chain, rootScore.primary), gate_fingerprint: fingerprint,
      gate_manifest: manifest, budget_snapshot: await snapshotBudget(),
      verified_improvements: count, anchor_surviving_improvements: count, milestone_reached: count >= 2,
      created_at: now(generation),
    };
    b.production_receipt = signer.sign({ kind: 'production-bundle', bundle: JSON.parse(canon(b)) });
    return JSON.parse(canon(b)) as ReplayBundle;
  };
  for (let gen = generation + 1; gen <= cfg.maxGenerations && !stopped; gen++) {
    const candidates: Array<{ target: string; policy: Policy; score: Score; reasons: string[]; promote: boolean; summary: string; inverse?: CandidateMutation['inverse'] }> = [];
    for (const target of targets) {
      try {
        await reserve(`gen:${gen}:propose:${target}`, 'proposer');
        const proposed = await cfg.proposer({ id: parentId, generation: gen, parents: [parentId], policy: { ...policy } }, target);
        const norm = typeof proposed === 'string' ? { value: proposed } : JSON.parse(canon(proposed)) as Exclude<typeof proposed, string>;
        if (!norm || typeof norm.value !== 'string' || (norm.summary !== undefined && typeof norm.summary !== 'string')) throw new Error('invalid proposer result');
        const p = { ...policy, [target]: norm.value };
        const s = await evaluate(p, holdout, `gen:${gen}:candidate:${target}`);
        const decision = !validProductionScoreDomain(s) ? { promote: false, reasons: ['invalid_selection_evidence'] } :
          s.regressed ? { promote: false, reasons: ['safety_regressed'] } : baseRule({ baseline: score, candidate: s });
        candidates.push({ target, policy: p, score: s, reasons: decision.reasons, promote: decision.promote, summary: norm.summary ?? `adapt ${target}`, ...(norm.inverse ? { inverse: norm.inverse } : {}) });
      } catch (error) {
        if (!budgetExceeded(error)) throw error;
        stopped = true; break;
      }
    }
    // Candidate selection sees only the selection suite. Independent observations begin after the
    // winner is frozen, and are never passed to the proposer or used to select another candidate.
    const winner = candidates.filter((c) => c.promote).sort((a, b) => b.score.primary - a.score.primary)[0];
    let approved = false, winnerAnchor: number | null = null;
    let independent: ProductionEvidence | undefined;
    let winnerAnchorEvaluation: Score | undefined;
    let reasons = ['independent_evidence_unavailable'];
    if (winner && !stopped) {
      try {
        const suite = suites[gen - 1]!;
        const baseline = await evaluate(policy, suite, `gen:${gen}:independent-baseline`);
        const candidate = await evaluate(winner.policy, suite, `gen:${gen}:independent-candidate`);
        independent = { comparison: gen, baselinePolicyDigest: evidenceDigest(policy), candidatePolicyDigest: evidenceDigest(winner.policy), baseline, candidate };
        winnerAnchorEvaluation = anchor ? await evaluate(winner.policy, anchor, `gen:${gen}:winner-anchor`) : undefined;
        if (anchor && !validProductionScoreDomain(winnerAnchorEvaluation)) throw new Error('invalid candidate anchor');
        winnerAnchor = winnerAnchorEvaluation?.primary ?? null;
        const decision = rule({ baseline: score, candidate: winner.score, production: independent,
          ...(rootAnchor !== null ? { anchor: { baseline: rootAnchor, candidate: winnerAnchor! } } : {}) });
        const anchorSurvives = rootAnchor === null || (winnerAnchor !== null && winnerAnchor >= rootAnchor);
        approved = decision.promote && anchorSurvives && !winnerAnchorEvaluation?.regressed;
        reasons = [...new Set([...decision.reasons, ...(!anchorSurvives ? ['anchor_regressed'] : []), ...(winnerAnchorEvaluation?.regressed ? ['anchor_safety_regressed'] : [])])];
      } catch (error) {
        if (!budgetExceeded(error)) throw error;
        stopped = true; reasons = ['hard_budget_exhausted'];
      }
    }
    for (const c of candidates) {
      const promoted = c === winner && approved;
      const fields: Omit<LineageCommit, 'receipt'> = {
        id: `${parentId}__${c.target}_gen${gen}`, generation: gen, parents: [parentId],
        mutation: { target: c.target, summary: c.summary, ...(c.inverse ? { inverse: c.inverse } : {}) }, primaryDelta: c.score.primary - score.primary,
        anchorScore: c === winner ? winnerAnchor : null, verdict: promoted ? 'PROMOTED' : 'REJECTED',
        failureReasons: promoted ? [] : c === winner ? reasons : c.promote ? ['not_selected'] : c.reasons,
        createdAt: now(gen), baselineScore: score, candidateScore: c.score,
        policyDigest: evidenceDigest(c.policy), baselinePolicyDigest: evidenceDigest(policy),
        ...(c === winner && independent ? { productionEvidence: independent } : {}),
        ...(c === winner && winnerAnchorEvaluation ? { anchorEvaluation: winnerAnchorEvaluation } : {}),
      };
      const commit: LineageCommit = { ...fields, receipt: signer.sign({ kind: 'candidate', gateFingerprint: fingerprint, ...fields, target: c.target }) };
      await store.append(commit); all.push(commit);
    }
    if (winner && approved) { parentId = `${parentId}__${winner.target}_gen${gen}`; policy = winner.policy; score = winner.score; }
    generation = gen;
    if (cfg.onGeneration) {
      const partialBundle = await bundle();
      const snapshot = partialBundle.budget_snapshot as BudgetSnapshot;
      const state: ResumeState = { rootScore, rootAnchor, parentId, policy, score, fromGeneration: gen, priorCommits: await store.list() };
      state.production = { gateFingerprint: fingerprint, ledgerId: snapshot.ledgerId, budgetReserved: snapshot.reserved, budgetSnapshot: snapshot,
        checkpointReceipt: signer.sign({ kind: 'production-checkpoint', gateFingerprint: fingerprint, ledgerId: snapshot.ledgerId, budgetReserved: snapshot.reserved, budgetSnapshot: snapshot, state: JSON.parse(canon(state)) }) };
      // Unlike observational research hooks, a failed production checkpoint stops immediately.
      await cfg.onGeneration(JSON.parse(canon({ generation: gen, generationsRun: gen, partialBundle, spent: snapshot.reserved, resumeState: state })));
    }
  }
  const replayBundle = await bundle();
  return { liftCurve: replayBundle.lift_curve, promotions: replayBundle.chain.filter((c) => c.verdict === 'PROMOTED'),
    lineage: store, replayBundle, generationsRun: generation, milestoneReached: replayBundle.milestone_reached, finalPolicy: policy };
}
