// @metaharness/flywheel — CLI dispatch tests. `graph` had ZERO coverage before tonight: it renders a
// caller-supplied ReplayBundle's lift curve as ASCII bars, and `Score.primary`/`LiftPoint.primary` are
// only documented as "higher is better" (types.ts) — nothing constrains them to be non-negative (a
// PnL-style benchmark, or a root-only honest-null run below zero). Reproduced pre-fix: `'█'.repeat(n)`
// throws `RangeError: Invalid count value` for any negative `n`, which a negative-primary lift point
// produces via `Math.round((p.primary / max) * 32)`. This is the one human-facing verb for inspecting an
// otherwise fully receipt-verified, replay-checked bundle — it should degrade gracefully, not crash.
import { describe, it, expect } from 'vitest';
import { dispatch } from '../src/cli.js';
import type { ReplayBundle } from '../src/index.js';

const bundle = (over: Partial<ReplayBundle> = {}): ReplayBundle => ({
  data_source: 'SYNTHETIC',
  root_id: 'root',
  chain: [
    { id: 'root', generation: 0, parents: [], mutation: null, primaryDelta: 0, anchorScore: null, verdict: 'ROOT', failureReasons: [], receipt: { payload: {}, signature: '', publicKey: '', alg: 'ed25519' }, createdAt: 'g0' },
  ],
  all_commits: [],
  lift_curve: [],
  gate_fingerprint: null,
  verified_improvements: 0,
  anchor_surviving_improvements: 0,
  milestone_reached: false,
  created_at: 'g0',
  ...over,
});

describe('flywheel graph — negative-primary lift points', () => {
  it('pre-fix repro (documentation): a raw negative repeat count throws RangeError', () => {
    expect(() => '█'.repeat(-16)).toThrow(RangeError);
  });

  it('renders an empty (not crashing) bar for a lift point with negative primary', async () => {
    const b = bundle({
      lift_curve: [
        { generation: 0, primary: -16, delta: 0, anchor: null },
        { generation: 1, primary: -8, delta: 8, anchor: null },
      ],
    });
    const path = `/tmp/dream-cli-test-negative-${process.pid}.json`;
    await import('node:fs').then((fs) => fs.writeFileSync(path, JSON.stringify(b)));
    const r = await dispatch('graph', [path]);
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.includes('-16'))).toBe(true);
    // Every rendered bar is empty (0-width) since every point is negative relative to the floor.
    expect(r.lines.some((l) => l.includes('█'))).toBe(false);
    await import('node:fs').then((fs) => fs.unlinkSync(path));
  });

  it('a bundle mixing negative and positive primaries clamps each bar to [0, 32] without crashing', async () => {
    const b = bundle({
      lift_curve: [
        { generation: 0, primary: -4, delta: 0, anchor: null },
        { generation: 1, primary: 20, delta: 24, anchor: null },
      ],
    });
    const path = `/tmp/dream-cli-test-mixed-${process.pid}.json`;
    await import('node:fs').then((fs) => fs.writeFileSync(path, JSON.stringify(b)));
    const r = await dispatch('graph', [path]);
    expect(r.code).toBe(0);
    // The negative point renders with no bar; the positive point (== max) renders a full 32-wide bar.
    const negLine = r.lines.find((l) => l.includes('-4'))!;
    const posLine = r.lines.find((l) => / 20 /.test(l))!;
    expect(negLine.includes('█')).toBe(false);
    expect((posLine.match(/█/g) ?? []).length).toBe(32);
    await import('node:fs').then((fs) => fs.unlinkSync(path));
  });

  it('unchanged behavior for an all-non-negative bundle (no regression)', async () => {
    const b = bundle({
      lift_curve: [
        { generation: 0, primary: 5, delta: 0, anchor: null },
        { generation: 1, primary: 10, delta: 5, anchor: null },
      ],
    });
    const path = `/tmp/dream-cli-test-positive-${process.pid}.json`;
    await import('node:fs').then((fs) => fs.writeFileSync(path, JSON.stringify(b)));
    const r = await dispatch('graph', [path]);
    expect(r.code).toBe(0);
    const fullLine = r.lines.find((l) => / 10 /.test(l))!;
    expect((fullLine.match(/█/g) ?? []).length).toBe(32);
    await import('node:fs').then((fs) => fs.unlinkSync(path));
  });
});
