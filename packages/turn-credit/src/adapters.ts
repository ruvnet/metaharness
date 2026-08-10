// @metaharness/turn-credit — downstream adapters (ADR-248 §5). Credits are
// ADVISORY: they feed routing quality labels, retry/tool policy analysis,
// retrieval feedback, and Darwin mutation attribution. Nothing here updates
// model weights. All adapters are pure and structurally typed — no imports from
// sibling packages, so this package stays dependency-free and phase-1.

import { round6 } from './belief.js';
import type { TrajectoryCredit, TurnCredit } from './types.js';

/** Aggregate credit per label (tool name, route, 'retry', mutation surface, …).
 *  Answers "which decisions/tools/routes/retries mattered" for a trajectory. */
export interface LabelCredit {
  label: string;
  turns: number;
  totalCredit: number;
  meanMultiplier: number;
  pivotalTurns: number;
}

export function creditByLabel(credit: TrajectoryCredit): LabelCredit[] {
  const byLabel = new Map<string, TurnCredit[]>();
  for (const c of credit.credits) {
    const key = c.label ?? '(unlabelled)';
    const list = byLabel.get(key) ?? [];
    list.push(c);
    byLabel.set(key, list);
  }
  return [...byLabel.entries()]
    .map(([label, cs]) => ({
      label,
      turns: cs.length,
      totalCredit: round6(cs.reduce((a, c) => a + c.credit, 0)),
      meanMultiplier: round6(cs.reduce((a, c) => a + c.multiplier, 0) / cs.length),
      pivotalTurns: cs.filter((c) => c.pivotal).length,
    }))
    .sort((a, b) => b.totalCredit - a.totalCredit || a.label.localeCompare(b.label));
}

/** Darwin seam: given credit-processed parent and child trajectories for the same
 *  task, report where the child's credit moved — which labels gained or lost, and
 *  whether the child's pivotal turns shifted onto the mutated surface. Advisory
 *  evidence for a promotion decision, never a gate by itself. */
export interface MutationAttribution {
  /** child totalCredit − parent totalCredit, per label (union of both). */
  labelDeltas: Array<{ label: string; parent: number; child: number; delta: number }>;
  /** True iff the mutated surface's label carries a strictly positive credit delta. */
  surfaceImproved: boolean;
  parentPivotal: number[];
  childPivotal: number[];
}

export function attributeMutation(
  parent: TrajectoryCredit,
  child: TrajectoryCredit,
  mutatedSurface: string,
): MutationAttribution {
  const p = new Map(creditByLabel(parent).map((l) => [l.label, l.totalCredit]));
  const c = new Map(creditByLabel(child).map((l) => [l.label, l.totalCredit]));
  const labels = [...new Set([...p.keys(), ...c.keys()])].sort();
  const labelDeltas = labels.map((label) => {
    const pv = p.get(label) ?? 0;
    const cv = c.get(label) ?? 0;
    return { label, parent: round6(pv), child: round6(cv), delta: round6(cv - pv) };
  });
  const surface = labelDeltas.find((l) => l.label === mutatedSurface);
  return {
    labelDeltas,
    surfaceImproved: surface !== undefined && surface.delta > 0,
    parentPivotal: parent.pivotalTurns,
    childPivotal: child.pivotalTurns,
  };
}

/** Router seam: per-turn quality labels in [0,1], suitable as
 *  `RouterExample.quality` once the caller attaches embeddings. Quality is the
 *  turn's multiplier mapped from [1−λ·b, 1+λ·b] onto [0,1]. */
export function toQualityLabels(credit: TrajectoryCredit): Array<{ turn: number; label?: string; quality: number }> {
  const lo = 1 - credit.boundPct;
  const span = 2 * credit.boundPct;
  return credit.credits.map((c) => ({
    turn: c.turn,
    ...(c.label !== undefined ? { label: c.label } : {}),
    quality: round6(span === 0 ? 0.5 : (c.multiplier - lo) / span),
  }));
}

/** Retrieval seam: one feedback record per turn that used retrieved context,
 *  matching the existing MemoryLayer.feedback({retrievedIds, resolved, weight})
 *  shape — credit-weighted instead of uniform. */
export function toMemoryFeedback(
  credit: TrajectoryCredit,
  retrievedIdsByTurn: Map<number, string[]>,
): Array<{ retrievedIds: string[]; resolved: boolean; weight: number }> {
  const resolved = credit.outcomeSign > 0;
  const out: Array<{ retrievedIds: string[]; resolved: boolean; weight: number }> = [];
  for (const c of credit.credits) {
    const ids = retrievedIdsByTurn.get(c.turn);
    if (ids === undefined || ids.length === 0) continue;
    out.push({ retrievedIds: ids, resolved, weight: c.multiplier });
  }
  return out;
}
