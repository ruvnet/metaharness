// @metaharness/flywheel — F-P2 mutation-effectiveness analysis. Given a ReplayBundle's FULL candidate
// ledger (`all_commits` — every promoted AND rejected candidate across all generations), report which
// policy LEVERS actually earn promotions and how much lift each produces. This is the empirical answer to
// "which `mutationTargets` are worth spending on" — it turns a run's diagnostic ledger into guidance for
// the next run's `--targets`. Pure + read-only: it interprets a bundle, it never re-runs or re-gates.
import type { ReplayBundle, LineageCommit } from './types.js';

/** Per-lever effectiveness over a run. */
export interface TargetStat {
  target: string;
  attempts: number;
  promotions: number;
  rejections: number;
  /** promotions / attempts. */
  promoteRate: number;
  /** mean primaryDelta over this lever's PROMOTED candidates (0 if none promoted). */
  avgDeltaPromoted: number;
  /** mean primaryDelta over ALL of this lever's candidates (promoted + rejected). */
  avgDeltaAll: number;
  /** the single best primaryDelta this lever produced. */
  bestDelta: number;
  /** mean sealed candidateScore.costPerWin over this lever's PROMOTED candidates — the cost-per-accepted-
   *  task for wins this lever bought (lower is better). 0 when none promoted or cost not sealed. */
  avgCostPerWinPromoted: number;
  /** the lowest (cheapest) sealed costPerWin among this lever's PROMOTED candidates. */
  bestCostPerWin: number;
}

export interface BundleAnalysis {
  generations: number;
  candidates: number;
  promotions: number;
  rejections: number;
  /** rejections specifically caused by regressing the frozen anchor (Goodhart guard fired). */
  anchorRegressed: number;
  /** per-lever stats, ranked most-effective first (promotions, then avg promoted lift, then avg lift). */
  byTarget: TargetStat[];
  /** sealed costPerWin along the PROMOTED chain (root→current) — the cost-per-accepted-task trajectory.
   *  A DOWNWARD trend means the flywheel is buying wins more cheaply over generations. Empty if unsealed. */
  costPerWinTrend: number[];
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Compute the mutation-effectiveness report from a bundle's candidate ledger. */
export function analyzeBundle(bundle: ReplayBundle): BundleAnalysis {
  const commits: LineageCommit[] = (bundle.all_commits ?? []).filter((c) => c.verdict !== 'ROOT');
  const groups = new Map<string, LineageCommit[]>();
  for (const c of commits) {
    const t = c.mutation?.target ?? '(none)';
    (groups.get(t) ?? groups.set(t, []).get(t)!).push(c);
  }

  const costOf = (c: LineageCommit): number | undefined => c.candidateScore?.costPerWin;
  const byTarget: TargetStat[] = [...groups.entries()].map(([target, cs]) => {
    const promoted = cs.filter((c) => c.verdict === 'PROMOTED');
    const rejected = cs.filter((c) => c.verdict === 'REJECTED');
    const promotedCosts = promoted.map(costOf).filter((x): x is number => typeof x === 'number');
    return {
      target,
      attempts: cs.length,
      promotions: promoted.length,
      rejections: rejected.length,
      promoteRate: cs.length ? promoted.length / cs.length : 0,
      avgDeltaPromoted: mean(promoted.map((c) => c.primaryDelta)),
      avgDeltaAll: mean(cs.map((c) => c.primaryDelta)),
      bestDelta: cs.length ? Math.max(...cs.map((c) => c.primaryDelta)) : 0,
      avgCostPerWinPromoted: mean(promotedCosts),
      bestCostPerWin: promotedCosts.length ? Math.min(...promotedCosts) : 0,
    };
  });

  // Rank: most promotions first, then biggest average promoted lift, then biggest average lift overall.
  byTarget.sort((a, b) => b.promotions - a.promotions || b.avgDeltaPromoted - a.avgDeltaPromoted || b.avgDeltaAll - a.avgDeltaAll);

  return {
    generations: new Set(commits.map((c) => c.generation)).size,
    candidates: commits.length,
    promotions: commits.filter((c) => c.verdict === 'PROMOTED').length,
    rejections: commits.filter((c) => c.verdict === 'REJECTED').length,
    anchorRegressed: commits.filter((c) => (c.failureReasons ?? []).includes('anchor_regressed')).length,
    byTarget,
    // Promoted chain is stored current→root; reverse to root→current for the trajectory.
    costPerWinTrend: [...(bundle.chain ?? []).filter((c) => c.verdict === 'PROMOTED')].reverse()
      .map(costOf).filter((x): x is number => typeof x === 'number'),
  };
}

/** Human-readable lines for the `analyze` CLI verb. */
export function formatAnalysis(a: BundleAnalysis, label: string): string[] {
  const lines = [
    `Mutation-effectiveness — ${label}`,
    `  generations=${a.generations}  candidates=${a.candidates}  promotions=${a.promotions}  rejections=${a.rejections}  anchor-regressed=${a.anchorRegressed}`,
    '',
    `  ${'lever'.padEnd(22)} ${'att'.padStart(4)} ${'prom'.padStart(5)} ${'rate'.padStart(6)} ${'avgΔ(prom)'.padStart(11)} ${'avgΔ(all)'.padStart(10)} ${'best'.padStart(6)} ${'cpw(prom)'.padStart(10)} ${'cpw(best)'.padStart(10)}`,
  ];
  if (!a.byTarget.length) {
    lines.push('  (no candidates in this bundle — an honest-null / root-only run)');
  } else {
    for (const t of a.byTarget) {
      lines.push(
        `  ${t.target.padEnd(22)} ${String(t.attempts).padStart(4)} ${String(t.promotions).padStart(5)} ${(t.promoteRate * 100).toFixed(0).padStart(5)}% ` +
        `${t.avgDeltaPromoted.toFixed(2).padStart(11)} ${t.avgDeltaAll.toFixed(2).padStart(10)} ${t.bestDelta.toFixed(0).padStart(6)} ` +
        `${(t.promotions ? t.avgCostPerWinPromoted.toFixed(2) : '—').padStart(10)} ${(t.promotions ? t.bestCostPerWin.toFixed(2) : '—').padStart(10)}`,
      );
    }
    lines.push('', `  → most effective lever: ${a.byTarget[0]!.promotions > 0 ? a.byTarget[0]!.target : '(none promoted — widen the proposer or targets)'}`);
  }
  if (a.costPerWinTrend.length > 1) {
    const [first, last] = [a.costPerWinTrend[0]!, a.costPerWinTrend[a.costPerWinTrend.length - 1]!];
    const dir = last < first ? 'cheaper ↓' : last > first ? 'costlier ↑' : 'flat →';
    lines.push(`  → cost-per-win trajectory (root→current): ${a.costPerWinTrend.map((c) => c.toFixed(2)).join(' → ')}  [${dir}]`);
  }
  return lines;
}
