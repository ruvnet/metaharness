// @metaharness/flywheel — independent replay. Given ONLY a ReplayBundle (and, optionally, the pinned
// gate fingerprint + the gate rule itself), an external reviewer establishes the run with no trust in the
// producer:
//   (1) every promotion receipt verifies (Ed25519, recompute canon vs the embedded key);
//   (2) the promoted lineage reconstructs current → gen-0 immutable root, contiguously;
//   (3) every commit on the promoted chain is actually PROMOTED (no rejected node smuggled in);
//   (4) the gate fingerprint matches the pinned value ⇒ the promotion rule was UNCHANGED;
//   (5) [ADR-235] if the reviewer supplies the (fingerprint-matched) rule, every PROMOTED commit is
//       RE-GATED on its sealed baseline+candidate scores and must STILL promote — trust the gate re-run,
//       not the logged verdict. Catches a signed-but-forged promotion the fingerprint check cannot. A
//       PROMOTED commit with no sealed scores to re-gate FAILS this check, not passes by omission.
//   (6) every entry in `all_commits` — the full diagnostic ledger of promoted AND rejected candidates —
//       also carries a receipt that verifies AND actually attests to that commit's own id + verdict, not
//       just the promoted `chain`. A signature is only as trustworthy as the fields it covers: `run.ts`
//       signs {kind, id, target, verdict, primaryDelta} (root: {kind, root}), so `verifyReceipt` alone
//       proves the PAYLOAD is internally consistent, not that it's attached to the RIGHT commit — without
//       cross-checking id/verdict, a REJECTED commit's outer `verdict` field could be flipped to
//       `PROMOTED` (or a receipt spliced onto a different id) and still "verify." `failureReasons` and
//       the Score fields are NOT part of the signed payload — tampering with those alone is a disclosed,
//       still-open gap (see the gist's Recommended Next Steps), not something this check catches.
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
    /** Every entry in `all_commits` — the full diagnostic ledger, PROMOTED *and* REJECTED — carries a
     *  receipt that both verifies AND attests to that commit's own id + verdict (see the file header's
     *  point (6)). `run.ts` signs every commit it mints, promoted or not, so this is always satisfiable
     *  by an honest producer; it exists to catch a receipt-splicing / verdict-flip forgery that
     *  `receipts` alone (chain-only) would miss. */
    allCommitsReceipts: boolean;
  };
  failures: string[];
  chainSummary: string;
}

/** A verified signature proves the PAYLOAD is internally consistent; it does not by itself prove the
 *  payload is attached to the RIGHT commit. `run.ts` signs `{kind:'candidate', id, target, verdict,
 *  primaryDelta}` for every candidate (root: `{kind:'root', root}`) — cross-check `id`/`verdict` against
 *  the embedded payload so a receipt cannot be spliced onto a different id, and a REJECTED commit's
 *  outer `verdict` field cannot be flipped to `PROMOTED` (or vice versa) without invalidating the check. */
function receiptMatchesCommit(c: LineageCommit): boolean {
  const p = c.receipt.payload as { kind?: unknown; id?: unknown; verdict?: unknown; root?: unknown };
  if (c.verdict === 'ROOT') return p.kind === 'root' && p.root === c.id;
  return p.kind === 'candidate' && p.id === c.id && p.verdict === c.verdict;
}

export function verifyReplayBundle(
  bundle: ReplayBundle,
  opts: { pinnedGateFingerprint?: string; promotionRule?: PromotionRule } = {},
): ReplayVerdict {
  const failures: string[] = [];
  const chain = bundle.chain;

  const receipts = chain.length > 0 && chain.every((c) => verifyReceipt(c.receipt) && receiptMatchesCommit(c));
  if (!receipts) failures.push('receipts');

  // `chain` proves the WINNING lineage; `all_commits` is the "full diagnostic ledger" (every candidate
  // across every generation, promoted + rejected — see ReplayBundle) that analyzeBundle's
  // rejection-reason / cost-per-win / mutation-effectiveness reporting reads. The producer already signs
  // every commit it mints (run.ts: `receipt: cfg.signer.sign(...)` on both PROMOTED and REJECTED verdicts)
  // — verifying only `chain`'s receipts left that ledger's signatures (and the id/verdict they attest to)
  // unchecked, so a receipt-splicing or verdict-flip forgery on a REJECTED entry would not fail replay.
  const allCommitsReceipts = bundle.all_commits.every((c) => verifyReceipt(c.receipt) && receiptMatchesCommit(c));
  if (!allCommitsReceipts) failures.push('allCommitsReceipts');

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
        if (c.verdict === 'PROMOTED') {
          // A PROMOTED commit with no sealed scores cannot be re-gated at all — previously this was
          // silently SKIPPED (neither pass nor fail), so a forged/incomplete promotion missing its
          // baseline/candidate Score evaded gate re-execution entirely. Per ADR-235 ("trust the gate
          // re-run, not the logged verdict"), an unauditable promotion must FAIL, not pass by omission.
          if (!c.baselineScore || !c.candidateScore) {
            gateReExecutes = false;
            break;
          }
          if (!opts.promotionRule({ baseline: c.baselineScore, candidate: c.candidateScore }).promote) {
            gateReExecutes = false;
            break;
          }
        }
      }
    }
  }
  if (!gateReExecutes) failures.push('gateReExecutes');

  return {
    pass: failures.length === 0,
    checks: { receipts, reachesRoot, contiguousParents, allPromoted, gateUnchanged, gateReExecutes, allCommitsReceipts },
    failures,
    chainSummary: chain.map((c) => `gen${c.generation}${c.mutation ? `(${c.mutation.target})` : '(root)'}`).join(' → '),
  };
}
