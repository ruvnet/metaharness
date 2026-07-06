// @metaharness/flywheel — independent replay. Given ONLY a ReplayBundle (and, optionally, the pinned
// gate fingerprint), an external reviewer establishes the run with no trust in the producer:
//   (1) every promotion receipt verifies (Ed25519, recompute canon vs the embedded key);
//   (2) the promoted lineage reconstructs current → gen-0 immutable root, contiguously;
//   (3) every commit on the promoted chain is actually PROMOTED (no rejected node smuggled in);
//   (4) the gate fingerprint matches the pinned value ⇒ the promotion rule was UNCHANGED.
import { verifyReceipt } from './receipts.js';
import type { ReplayBundle } from './types.js';

export interface ReplayVerdict {
  pass: boolean;
  checks: {
    receipts: boolean;
    reachesRoot: boolean;
    contiguousParents: boolean;
    allPromoted: boolean;
    gateUnchanged: boolean;
  };
  failures: string[];
  chainSummary: string;
}

export function verifyReplayBundle(bundle: ReplayBundle, opts: { pinnedGateFingerprint?: string } = {}): ReplayVerdict {
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

  return {
    pass: failures.length === 0,
    checks: { receipts, reachesRoot, contiguousParents, allPromoted, gateUnchanged },
    failures,
    chainSummary: chain.map((c) => `gen${c.generation}${c.mutation ? `(${c.mutation.target})` : '(root)'}`).join(' → '),
  };
}
