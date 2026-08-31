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
//   (6) for whichever of id/target/verdict/primaryDelta/baselineScore/candidateScore/anchorScore/
//       failureReasons a commit's SIGNED receipt payload carries, the signed copy must match the commit's
//       live (unsigned) fields — including 'id'. Binding 'id' matters as much as the score fields: without
//       it, a bundle editor with no signing key can clone ONE genuine receipt across many fabricated
//       commit ids/parents (copying the real receipt's baseline/candidate/anchor scores onto each
//       fabricated commit too) to manufacture a fake multi-generation promoted lineage from a single real
//       promotion — (5)'s re-gate would happily re-pass every clone since each one re-derives the same
//       genuine (baseline, candidate) pair. Checking whichever keys a payload happens to carry keeps this
//       additive: a receipt whose payload predates this check (carries none of these keys) is left
//       unchecked here, same backward-compat shape as (5)'s own opt-in — it does not retroactively secure
//       old bundles, only binds every bundle produced after this check shipped.
import { verifyReceipt, canon } from './receipts.js';
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
    sealedFieldsAuthentic: boolean;
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

  // (5) RE-EXECUTE the gate. Only when the reviewer supplies the rule (otherwise unchecked → true, so
  // existing fingerprint-only callers are unaffected). The supplied rule must be the SAME one (its
  // fingerprint must match the pinned/bundled value) or re-execution is meaningless. Then every PROMOTED
  // commit that carries its sealed scores must RE-PASS the rule — a logged promotion the frozen gate would
  // NOT grant is a forgery.
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
        if (c.verdict === 'PROMOTED' && c.baselineScore && c.candidateScore) {
          if (!opts.promotionRule({ baseline: c.baselineScore, candidate: c.candidateScore }).promote) {
            gateReExecutes = false;
            break;
          }
        }
      }
    }
  }
  if (!gateReExecutes) failures.push('gateReExecutes');

  // (6) RECEIPT-BOUND-TO-COMMIT (see header). 'id' binds the receipt to a specific commit — without it,
  // whichever score/reason keys a payload carries can canon-match by cloning the whole receipt (sealed
  // fields included) onto a different, fabricated commit that copies the same values live. Only receipts
  // whose payload opts in (carries at least one of these keys) are checked — additive over every
  // pre-existing bundle.
  const BOUND_KEYS: { [k: string]: (c: LineageCommit) => unknown } = {
    id: (c) => c.id,
    target: (c) => c.mutation?.target ?? null,
    verdict: (c) => c.verdict,
    primaryDelta: (c) => c.primaryDelta,
    baselineScore: (c) => c.baselineScore ?? null,
    candidateScore: (c) => c.candidateScore ?? null,
    anchorScore: (c) => c.anchorScore,
    failureReasons: (c) => c.failureReasons,
  };
  let sealedFieldsAuthentic = true;
  {
    const seen = new Set<string>();
    for (const c of [...chain, ...bundle.all_commits] as LineageCommit[]) {
      if (seen.has(c.id) || c.verdict === 'ROOT') continue;
      seen.add(c.id);
      const payload = c.receipt.payload as Record<string, unknown>;
      for (const [k, live] of Object.entries(BOUND_KEYS)) {
        if (!(k in payload)) continue;
        if (canon(payload[k]) !== canon(live(c))) { sealedFieldsAuthentic = false; break; }
      }
      if (!sealedFieldsAuthentic) break;
    }
  }
  if (!sealedFieldsAuthentic) failures.push('sealedFieldsAuthentic');

  return {
    pass: failures.length === 0,
    checks: { receipts, reachesRoot, contiguousParents, allPromoted, gateUnchanged, gateReExecutes, sealedFieldsAuthentic },
    failures,
    chainSummary: chain.map((c) => `gen${c.generation}${c.mutation ? `(${c.mutation.target})` : '(root)'}`).join(' → '),
  };
}
