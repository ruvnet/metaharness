// Side-by-side of the naive root policy vs the flywheel-tuned kernel levers.
// Usage: node scripts/bench-kernel.mjs  (after scripts/build-wasm.mjs)
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadKernel, measure, relErr } from './kernel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tunedPath = join(here, '..', '.harness', 'flywheel', 'tuned-kernel.json');

const SHAPES = [
  { rows: 1024, cols: 4096, seed: 42, label: 'holdout 1024x4096' },
  { rows: 512, cols: 8192, seed: 1337, label: 'anchor  512x8192' },
];

const tuned = JSON.parse(await readFile(tunedPath, 'utf8'));
const k = await loadKernel();

const toCfg = (p) => ({ kernel: p.kernel, unroll: Number(p.unroll), accs: Number(p.accs) });

console.log(`root  : ${JSON.stringify(tuned.root)}`);
console.log(`tuned : ${JSON.stringify(tuned.tuned)} (replayVerified=${tuned.replayVerified})`);
for (const { rows, cols, seed, label } of SHAPES) {
  k.setup(rows, cols, seed);
  const gold = k.golden();
  const a = measure(k, toCfg(tuned.root), { reps: 11 });
  const b = measure(k, toCfg(tuned.tuned), { reps: 11 });
  const gops = (ms) => (2 * rows * cols) / (ms * 1e6);
  console.log(
    `${label}: root ${gops(a.medianMs).toFixed(2)} GOPS -> tuned ${gops(b.medianMs).toFixed(2)} GOPS ` +
      `(${(a.medianMs / b.medianMs).toFixed(2)}x, relErr ${relErr(b.checksum, gold).toExponential(1)})`,
  );
}
