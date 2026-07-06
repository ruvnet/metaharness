// @metaharness/flywheel — runFlywheelGenerations(): the promotion LOOP. run → measure → mutate → verify
// → promote, generation after generation, each re-basing on the previous promoted winner so verified
// wins COMPOUND into an auditable lineage. Host- and benchmark-agnostic: everything specific enters via
// the injected `proposer` / `evaluator` / `promotionRule`. The gate selects the winner on the HOLDOUT;
// the FROZEN anchor is a separate survival check (never optimized against — the anti-Goodhart guard).
import { InMemoryLineageStore, computeLiftCurve } from './lineage.js';
import { meetsPromotionRule, gateFingerprint } from './gate.js';
import type {
  Policy, PolicyGenome, Proposer, Evaluator, PromotionRule, Signer,
  HoldoutSuite, AnchorSuite, LineageStore, LineageCommit, LiftCurve, ReplayBundle, Score,
} from './types.js';

export interface FlywheelConfig {
  /** The gen-0 policy — the immutable root every promotion chains back to. */
  rootPolicy: Policy;
  proposer: Proposer;
  evaluator: Evaluator;
  /** The FROZEN gate. Default: {@link meetsPromotionRule}. Inject your own compliance/cost gate here. */
  promotionRule?: PromotionRule;
  holdout: HoldoutSuite;
  /** Optional frozen anchor suite — never optimized against; a winner must not regress it to count. */
  anchor?: AnchorSuite;
  /** Which policy levers to try each generation. Default: every key of `rootPolicy`. */
  mutationTargets?: string[];
  maxGenerations: number;
  signer: Signer;
  /** Stop early once `spent() ≥ total` (e.g. a $ budget). */
  budget?: { total: number; spent: () => number };
  /** Caller-supplied ISO/label per generation (determinism; no clock in the engine). */
  now?: (generation: number) => string;
  /** Stamped on the replay bundle — 'SYNTHETIC' | 'LIVE' | …. NEVER a benchmark name. */
  dataSource?: string;
  lineageStore?: LineageStore;
  rootId?: string;
}

export interface FlywheelResult {
  liftCurve: LiftCurve;
  /** The promoted chain (current → root). */
  promotions: LineageCommit[];
  lineage: LineageStore;
  replayBundle: ReplayBundle;
  generationsRun: number;
  /** ≥2 anchor-surviving verified improvements joined the immutable lineage with no human. */
  milestoneReached: boolean;
  finalPolicy: Policy;
}

export async function runFlywheelGenerations(cfg: FlywheelConfig): Promise<FlywheelResult> {
  const rule = cfg.promotionRule ?? meetsPromotionRule;
  const targets = cfg.mutationTargets ?? Object.keys(cfg.rootPolicy);
  const store = cfg.lineageStore ?? new InMemoryLineageStore();
  const now = cfg.now ?? ((g: number) => `gen-${g}`);
  const rootId = cfg.rootId ?? 'root';
  const anchorOf = async (p: Policy): Promise<number | null> =>
    cfg.anchor ? (await cfg.evaluator(p, cfg.anchor)).primary : null;

  // ── gen-0: the immutable root. Evaluate it once (the baseline) + its anchor (the frozen bar). ──
  const rootScore = await cfg.evaluator(cfg.rootPolicy, cfg.holdout);
  const rootAnchor = await anchorOf(cfg.rootPolicy);
  await store.append({
    id: rootId, generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: rootAnchor,
    verdict: 'ROOT', failureReasons: [], receipt: cfg.signer.sign({ kind: 'root', root: rootId }), createdAt: now(0),
  });

  let parentId = rootId;
  let policy: Policy = { ...cfg.rootPolicy };
  let score: Score = rootScore;
  const allCommits: LineageCommit[] = [];
  let generationsRun = 0;

  for (let gen = 1; gen <= cfg.maxGenerations; gen++) {
    if (cfg.budget && cfg.budget.spent() >= cfg.budget.total) break;
    generationsRun = gen;

    // propose + evaluate one candidate per mutation target, gate each on the HOLDOUT.
    const base: PolicyGenome = { id: parentId, generation: gen, parents: [parentId], policy };
    const cands: Array<{ target: string; policy: Policy; score: Score; reasons: string[]; promote: boolean }> = [];
    for (const target of targets) {
      const proposed = await cfg.proposer(base, target);
      const candPolicy: Policy = { ...policy, [target]: proposed };
      const candScore = await cfg.evaluator(candPolicy, cfg.holdout);
      const decision = rule({ baseline: score, candidate: candScore });
      cands.push({ target, policy: candPolicy, score: candScore, reasons: decision.reasons, promote: decision.promote });
    }

    // winner = highest primary among the promotable; then verify it survives the FROZEN anchor.
    const promotable = cands.filter((c) => c.promote).sort((a, b) => b.score.primary - a.score.primary);
    const winner = promotable[0] ?? null;
    const winnerAnchor = winner ? await anchorOf(winner.policy) : null;
    const anchorSurvives = winner ? (rootAnchor === null || (winnerAnchor ?? -Infinity) >= rootAnchor) : false;
    // A winner that regresses the anchor is NOT promoted (Goodhart guard) — it becomes a rejection.
    const promotedWinner = winner && anchorSurvives ? winner : null;

    for (const c of cands) {
      const isWinner = c === promotedWinner;
      const id = `${parentId}__${c.target}_gen${gen}`;
      const primaryDelta = c.score.primary - score.primary;
      const commit: LineageCommit = {
        id, generation: gen, parents: [parentId],
        mutation: { target: c.target, summary: `adapt ${c.target}` },
        primaryDelta,
        anchorScore: isWinner ? winnerAnchor : c === winner ? winnerAnchor : null,
        verdict: isWinner ? 'PROMOTED' : 'REJECTED',
        failureReasons: isWinner ? [] : c === winner && !anchorSurvives ? ['anchor_regressed'] : c.reasons,
        receipt: cfg.signer.sign({ kind: 'candidate', id, target: c.target, verdict: isWinner ? 'PROMOTED' : 'REJECTED', primaryDelta }),
        createdAt: now(gen),
        baselineScore: score,       // ADR-235 — sealed so the gate can be re-run in replay
        candidateScore: c.score,
      };
      await store.append(commit);
      allCommits.push(commit);
    }

    if (promotedWinner) { parentId = `${parentId}__${promotedWinner.target}_gen${gen}`; policy = promotedWinner.policy; score = promotedWinner.score; }
  }

  const chain = await store.walkToRoot(parentId);
  const liftCurve = computeLiftCurve(chain, rootScore.primary);
  const promotions = chain.filter((c) => c.verdict === 'PROMOTED');
  const verified = promotions.filter((c) => c.primaryDelta > 0).length;
  const anchorSurviving = promotions.filter((c) => c.primaryDelta > 0 && (rootAnchor === null || (c.anchorScore ?? -Infinity) >= rootAnchor)).length;

  const replayBundle: ReplayBundle = {
    data_source: cfg.dataSource ?? 'UNSPECIFIED',
    root_id: rootId,
    chain,
    all_commits: allCommits,
    lift_curve: liftCurve,
    gate_fingerprint: gateFingerprint(rule),
    verified_improvements: verified,
    anchor_surviving_improvements: anchorSurviving,
    milestone_reached: anchorSurviving >= 2,
    created_at: now(cfg.maxGenerations),
  };

  return {
    liftCurve, promotions, lineage: store, replayBundle,
    generationsRun,
    milestoneReached: anchorSurviving >= 2, finalPolicy: policy,
  };
}
