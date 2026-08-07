// Flywheel evolution of the k3 kernel levers — run → measure → mutate → verify → promote.
//
// The policy being evolved is the operating configuration of the block-quantized
// int8 matvec kernel (the kimi-k3-in-c trunk inner loop, compiled from Rust to
// wasm32+simd128). The model is frozen — there is no model. Every promotion is
// a MEASURED throughput win that clears a frozen gate, survives a never-
// optimized-against anchor shape, and is Ed25519-signed into a replayable
// lineage. Zero API keys, zero network.
//
// Usage: node scripts/flywheel-evolve.mjs  (after scripts/build-wasm.mjs)
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  runFlywheelGenerations,
  makeSigner,
  verifyReplayBundle,
} from '@metaharness/flywheel';
import { loadKernel, measure, relErr } from './kernel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', '.harness', 'flywheel');

// ---------------------------------------------------------------------------
// Lever domains. kernel=scalar/u1/a1 is the gen-0 root — the naive portable
// loop a straight C99 transliteration would ship.
const DOMAINS = {
  kernel: ['scalar', 'simd'],
  unroll: ['1', '2', '4'],
  accs: ['1', '2', '4'],
};
const ROOT_POLICY = { kernel: 'scalar', unroll: '1', accs: '1' };

// Holdout: the shape the wheel optimizes against. Anchor: a different frozen
// shape it NEVER optimizes against (anti-Goodhart) — a win must transfer.
const HOLDOUT = { id: 'holdout-1024x4096', items: [{ rows: 1024, cols: 4096, seed: 42 }] };
const ANCHOR = { id: 'anchor-512x8192', items: [{ rows: 512, cols: 8192, seed: 1337 }] };
const REPS = 15;
const RELTOL = 1e-3;

// ---------------------------------------------------------------------------
// Deterministic proposer — walks each lever's domain, never re-proposing the
// base value. No model, no network: the search space is small and the WHEEL
// (measure + frozen gate + anchor + receipts) is the thing under test.
const cursors = Object.fromEntries(Object.keys(DOMAINS).map((k) => [k, 0]));
async function proposer(base, target) {
  const domain = DOMAINS[target];
  for (let i = 0; i < domain.length; i++) {
    const candidate = domain[(cursors[target] + i) % domain.length];
    if (candidate !== base.policy[target]) {
      cursors[target] = (cursors[target] + i + 1) % domain.length;
      return candidate;
    }
  }
  return base.policy[target];
}

// ---------------------------------------------------------------------------
// Evaluator — the ONLY place benchmark meaning lives. primary = GOPS (2 ops
// per weight), costPerWin = median ms per pass, regressed = correctness break
// vs the f64 golden reference.
const kernel = await loadKernel();
const goldCache = new Map();
async function evaluator(policy, suite) {
  const { rows, cols, seed } = suite.items[0];
  const key = `${rows}x${cols}s${seed}`;
  kernel.setup(rows, cols, seed);
  if (!goldCache.has(key)) goldCache.set(key, kernel.golden());
  const gold = goldCache.get(key);
  const cfg = { kernel: policy.kernel, unroll: Number(policy.unroll), accs: Number(policy.accs) };
  const { medianMs, checksum } = measure(kernel, cfg, { reps: REPS, warmup: 3 });
  const gops = (2 * rows * cols) / (medianMs * 1e6);
  return {
    primary: gops,
    noopRate: 0,
    costPerWin: medianMs,
    regressed: relErr(checksum, gold) > RELTOL,
  };
}

// ---------------------------------------------------------------------------
// The FROZEN gate. Conjunctive: ≥2% measured lift (above timing noise), cost
// must not worsen, correctness is a hard stop, and the anchor shape must not
// regress more than 2% (noise band). Fingerprinted into the replay bundle.
function k3KernelPromotionRule(e) {
  const reasons = [];
  if (e.candidate.regressed) reasons.push('correctness regressed vs golden reference');
  if (!(e.candidate.primary >= e.baseline.primary * 1.02))
    reasons.push(`lift below 2% noise floor (${e.baseline.primary.toFixed(2)} -> ${e.candidate.primary.toFixed(2)} GOPS)`);
  if (!(e.candidate.costPerWin <= e.baseline.costPerWin * 1.0))
    reasons.push('cost per pass worsened');
  if (e.anchor && !(e.anchor.candidate >= e.anchor.baseline * 0.98))
    reasons.push(`anchor shape regressed (${e.anchor.baseline.toFixed(2)} -> ${e.anchor.candidate.toFixed(2)} GOPS)`);
  return { promote: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
const startedAt = new Date().toISOString();
const result = await runFlywheelGenerations({
  rootPolicy: ROOT_POLICY,
  proposer,
  evaluator,
  promotionRule: k3KernelPromotionRule,
  holdout: HOLDOUT,
  anchor: ANCHOR,
  maxGenerations: 8,
  signer: makeSigner(),
  dataSource: 'LIVE',
  now: (g) => `${startedAt}#gen${g}`,
});

const verdict = verifyReplayBundle(result.replayBundle);

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'replay-bundle.json'), JSON.stringify(result.replayBundle, null, 2) + '\n');
await writeFile(
  join(outDir, 'tuned-kernel.json'),
  JSON.stringify(
    {
      schema: 'k3-kernel-tuning-v1',
      root: ROOT_POLICY,
      tuned: result.finalPolicy,
      liftCurve: result.liftCurve,
      milestoneReached: result.milestoneReached,
      replayVerified: verdict.pass,
      startedAt,
    },
    null,
    2,
  ) + '\n',
);

console.log('--- flywheel: k3 kernel levers ---');
console.log('generations run :', result.generationsRun);
console.log('lift curve      :');
for (const p of result.liftCurve)
  console.log(`  gen ${p.generation}: ${p.primary.toFixed(2)} GOPS (Δ ${p.delta >= 0 ? '+' : ''}${p.delta.toFixed(2)})` + (p.anchor != null ? ` anchor ${p.anchor.toFixed(2)}` : ''));
console.log('promoted chain  :', result.promotions.map((c) => `gen${c.generation}${c.mutation ? `(${c.mutation.target}=${c.mutation.summary})` : '(root)'}`).join(' -> '));
console.log('final policy    :', JSON.stringify(result.finalPolicy));
console.log('milestone (≥2 anchor-surviving wins):', result.milestoneReached);
console.log('replay verified :', verdict.pass, verdict.pass ? '' : JSON.stringify(verdict));
if (!verdict.pass) process.exitCode = 1;
