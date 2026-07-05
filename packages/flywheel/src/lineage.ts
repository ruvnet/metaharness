// @metaharness/flywheel — the lineage graph ("git for operating policies"). Every promotion is a commit
// with parents; the gen-0 root is immutable (parents:[]). Walk any node to the root to reconstruct the
// full, receipt-backed history. InMemory here; a durable backend is a drop-in behind the LineageStore
// interface (the flywheel core only calls append / get / walkToRoot / list).
import type { LineageCommit, LineageStore, LiftCurve, LiftPoint } from './types.js';

export class InMemoryLineageStore implements LineageStore {
  private readonly commits = new Map<string, LineageCommit>();

  async append(commit: LineageCommit): Promise<void> {
    this.commits.set(commit.id, { ...commit });
  }
  async get(id: string): Promise<LineageCommit | null> {
    const c = this.commits.get(id);
    return c ? { ...c } : null;
  }
  async walkToRoot(id: string): Promise<LineageCommit[]> {
    const chain: LineageCommit[] = [];
    const seen = new Set<string>();
    let cur = this.commits.get(id) ?? null;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push({ ...cur });
      cur = cur.parents[0] ? this.commits.get(cur.parents[0]) ?? null : null;
    }
    return chain;
  }
  async list(): Promise<LineageCommit[]> {
    return [...this.commits.values()].map((c) => ({ ...c }));
  }
}

/** The compounding lift curve: root primary, then each promoted generation's primary + delta + anchor.
 *  `chain` is current→root (as returned by walkToRoot); we reverse to read root→current. */
export function computeLiftCurve(chain: LineageCommit[], rootPrimary: number): LiftCurve {
  const rootFirst = [...chain].reverse();
  const curve: LiftCurve = [];
  let running = rootPrimary;
  for (const c of rootFirst) {
    if (c.verdict === 'ROOT') {
      curve.push({ generation: c.generation, primary: rootPrimary, delta: 0, anchor: c.anchorScore });
    } else {
      running += c.primaryDelta;
      curve.push({ generation: c.generation, primary: running, delta: c.primaryDelta, anchor: c.anchorScore });
    }
  }
  return curve;
}

/** Convenience: a single point (used when composing a curve incrementally). */
export function liftPoint(generation: number, primary: number, delta: number, anchor: number | null): LiftPoint {
  return { generation, primary, delta, anchor };
}
