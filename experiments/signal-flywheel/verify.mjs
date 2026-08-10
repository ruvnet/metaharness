// signal-flywheel — independent replay verification of the COMMITTED bundle.
//
// An external reviewer runs `node verify.mjs` with no trust in the producer:
//   (1) every Ed25519 receipt verifies against its embedded public key;
//   (2) the promoted chain reconstructs contiguously to the immutable gen-0 root;
//   (3) no rejected commit is smuggled into the chain;
//   (4) the bundle's gate fingerprint matches the LIBRARY DEFAULT frozen gate
//       (meetsPromotionRule) — proving no custom/softened rule decided promotions;
//   (5) every PROMOTED commit is RE-GATED on its sealed baseline+candidate scores
//       through that same default rule and must still promote (ADR-235: trust the
//       gate re-run, not the logged verdict).
// Additionally asserts data_source === 'SYNTHETIC' (honesty stamp: this bundle is
// a mechanism proof, never a benchmark claim — see ADR-248 §6 for the LIVE gate,
// which this experiment does NOT satisfy).
//
// Exit code 0 ⇔ every check passes.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  verifyReplayBundle,
  meetsPromotionRule,
  gateFingerprint,
} from '../../packages/flywheel/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = JSON.parse(await readFile(join(here, 'bundle.json'), 'utf8'));

const verdict = verifyReplayBundle(bundle, {
  promotionRule: meetsPromotionRule,
  pinnedGateFingerprint: gateFingerprint(meetsPromotionRule),
});

const syntheticStamp = bundle.data_source === 'SYNTHETIC';

console.log('--- signal-flywheel verify (committed bundle.json) ---');
console.log('checks                :', JSON.stringify(verdict.checks));
console.log('data_source SYNTHETIC :', syntheticStamp);
console.log('chain                 :', verdict.chainSummary);
console.log('promotions            :', bundle.verified_improvements, '| anchor-surviving:', bundle.anchor_surviving_improvements);
if (verdict.pass && syntheticStamp) {
  console.log('VERDICT: PASS');
} else {
  console.log('VERDICT: FAIL', JSON.stringify([...verdict.failures, ...(syntheticStamp ? [] : ['data_source_not_synthetic'])]));
  process.exit(1);
}
