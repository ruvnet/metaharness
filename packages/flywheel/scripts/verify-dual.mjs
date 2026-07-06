// Verifies the dual CJS+ESM build: the package loads under BOTH module systems and the FROZEN gate is
// byte-identical from each (same gateFingerprint) — a CJS consumer (e.g. a CommonJS server) gets exactly
// the same meetsPromotionRule as an ESM consumer. Run after build; exits non-zero on any mismatch.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cjs = require('@metaharness/flywheel');
const esm = await import('@metaharness/flywheel');
const fns = ['meetsPromotionRule', 'runFlywheelGenerations', 'gateFingerprint', 'verifyReplayBundle', 'analyzeBundle'];
for (const f of fns) {
  if (typeof cjs[f] !== 'function') { console.error(`FAIL: CJS require missing ${f}`); process.exit(1); }
  if (typeof esm[f] !== 'function') { console.error(`FAIL: ESM import missing ${f}`); process.exit(1); }
}
const cjsFp = cjs.gateFingerprint(cjs.meetsPromotionRule);
const esmFp = esm.gateFingerprint(esm.meetsPromotionRule);
if (cjsFp !== esmFp) { console.error(`FAIL: frozen gate fingerprint differs CJS(${cjsFp}) vs ESM(${esmFp})`); process.exit(1); }
console.log(`dual-load OK — CJS+ESM both resolve; frozen gate identical (fp ${cjsFp.slice(0, 12)})`);
