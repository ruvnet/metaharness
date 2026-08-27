// @metaharness/flywheel — independent replay. Given ONLY a ReplayBundle (and, optionally, the pinned
// gate fingerprint + the gate rule itself), an external reviewer establishes the run with no trust in the
// producer:
//   (1) every promotion receipt verifies (Ed25519, recompute canon vs the embedded key);
//   (2) the promoted lineage reconstructs current → gen-0 immutable root, contiguously;
//   (3) every commit on the promoted chain is actually PROMOTED (no rejected node smuggled in);
//   (4) the gate fingerprint matches the pinned value ⇒ the promotion rule was UNCHANGED;
//   (5) [ADR-235] if the reviewer supplies the (fingerprint-matched) rule, every PROMOTED commit is
//       RE-GATED on its sealed baseline+candidate scores and must STILL promote — trust the gate re-run,
//       not the logged verdict. Catches a signed-but-forged promotion the fingerprint check cannot.
import { verifyReceipt } from './receipts.js';
import { gateFingerprint } from './gate.js';
import type { ReplayBundle, PromotionRule, LineageCommit } from './types.js';

export interface ReplayVerdict {
  pass: boolean;
  checks: {
    receipts: boolean;
    reachesRoot: boolean;
    contiguousParents: boolean;
    allPromoted: boolean;
    gateUnchanged: boolean;
    gateReExecutes: boolean;
  };
  failures: string[];
  chainSummary: string;
}

export function verifyReplayBundle(
  bundle: ReplayBundle,
  opts: { pinnedGateFingerprint?: string; promotionRule?: PromotionRule } = {},
): ReplayVerdict {
  const failures: string[] = [];
  const chain = bundle.chain;

  const receipts = chain.length > 0 && chain.every((c) => verifyReceipt(c.receipt));
  if (!receipts) failures.push('receipts');

  const root = chain[chain.length - 1];
  const reachesRoot = !!root && root.parents.length === 0 && root.id === bundle.root_id;
  if (!reachesRoot) failures.push('reachesRoot');

  let contiguousParents = chain.length > 0;
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i]!.parents.includes(chain[i + 1]!.id)) contiguousParents = false;
  }
  if (!contiguousParents) failures.push('contiguousParents');

  // Every non-root commit on the promoted chain must be PROMOTED (no rejected node smuggled in). An
  // HONEST-NULL run — the flywheel found no improvement, so the chain is just the immutable gen-0 root —
  // is VALID and replayable: an empty set of non-root commits satisfies this VACUOUSLY. (Requiring
  // ≥1 promotion here was a bug: it failed replay on a legitimate 0-promotion result, e.g. a weak model
  // that resolves nothing — the negative is a real, verifiable outcome, not an invalid bundle.)
  const promos = chain.filter((c) => c.verdict !== 'ROOT');
  const allPromoted = promos.every((c) => c.verdict === 'PROMOTED');
  if (!allPromoted) failures.push('allPromoted');

  const gateUnchanged = opts.pinnedGateFingerprint ? bundle.gate_fingerprint === opts.pinnedGateFingerprint : true;
  if (!gateUnchanged) failures.push('gateUnchanged');

  // The run's frozen anti-Goodhart bar is the ROOT commit's sealed `anchorScore` (set once at gen-0,
  // run.ts — the same `rootAnchor` every live winner was compared against). Reading it off `root` here
  // keeps the anchor re-check at the SAME sealed-field trust tier as the pre-existing
  // baselineScore/candidateScore re-execution below — not a new/stronger guarantee. (Hardening sealed
  // fields against bundle-editing, as opposed to signature, forgery is a separate, larger, disclosed
  // future gap — see the PR/issue writeup — not attempted here.)
  const rootAnchorSealed = root && root.anchorScore != null ? root.anchorScore : null;

  // (5) RE-EXECUTE the gate. Only when the reviewer supplies the rule (otherwise unchecked → true, so
  // existing fingerprint-only callers are unaffected). The supplied rule must be the SAME one (its
  // fingerprint must match the pinned/bundled value) or re-execution is meaningless. Then every PROMOTED
  // commit that carries its sealed scores must RE-PASS the rule — a logged promotion the frozen gate would
  // NOT grant is a forgery. This includes the anti-Goodhart anchor clause: previously `evidence.anchor`
  // was NEVER supplied here, so `anchor_regressed` was structurally unreachable during replay even though
  // `run.ts` enforces it live — a promotion that regressed the frozen anchor replayed clean.
  let gateReExecutes = true;
  if (opts.promotionRule) {
    const suppliedFp = gateFingerprint(opts.promotionRule);
    const expectedFp = opts.pinnedGateFingerprint ?? bundle.gate_fingerprint ?? undefined;
    if (expectedFp && suppliedFp !== expectedFp) {
      gateReExecutes = false; // wrong rule supplied — cannot re-execute the run's gate
    } else {
      const seen = new Set<string>();
      for (const c of [...chain, ...bundle.all_commits] as LineageCommit[]) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (c.verdict !== 'PROMOTED') continue;
        // Fail-closed: a PROMOTED commit missing the sealed scores this verification mode claims to
        // re-execute is not "unchecked" — it cannot prove the gate re-run, so replay must not pass it.
        if (c.baselineScore == null || c.candidateScore == null) {
          gateReExecutes = false;
          break;
        }
        // Same fail-closed rule for the anchor axis: once the root pins an anchor bar, a promoted commit
        // missing its own anchorScore must not silently drop out of the anti-Goodhart check (that was the
        // original gap — anchor: undefined made the clause unreachable instead of failing).
        if (rootAnchorSealed != null && c.anchorScore == null) {
          gateReExecutes = false;
          break;
        }
        const anchor = rootAnchorSealed != null
          ? { baseline: rootAnchorSealed, candidate: c.anchorScore! }
          : undefined;
        if (!opts.promotionRule({ baseline: c.baselineScore, candidate: c.candidateScore, anchor }).promote) {
          gateReExecutes = false;
          break;
        }
      }
    }
  }
  if (!gateReExecutes) failures.push('gateReExecutes');

  return {
    pass: failures.length === 0,
    checks: { receipts, reachesRoot, contiguousParents, allPromoted, gateUnchanged, gateReExecutes },
    failures,
    chainSummary: chain.map((c) => `gen${c.generation}${c.mutation ? `(${c.mutation.target})` : '(root)'}`).join(' → '),
  };
}
