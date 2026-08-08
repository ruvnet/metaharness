import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(here, '..', 'bench', 'k3_kernel_bench.wasm');

// The wasm artifact is built from crates/k3-kernel-bench by scripts/build-wasm.mjs
// and is intentionally not committed; skip when a Rust toolchain hasn't produced it.
describe.skipIf(!existsSync(wasmPath))('k3 kernel bench (wasm)', () => {
  it('every lever combination matches the f64 golden reference', async () => {
    const { loadKernel, measure, relErr } = await import('../scripts/kernel.mjs');
    const k = await loadKernel(wasmPath);
    k.setup(256, 1024, 7);
    const gold = k.golden();
    for (const kernel of ['scalar', 'simd'] as const) {
      for (const unroll of [1, 2, 4]) {
        for (const accs of [1, 2, 4]) {
          const { checksum } = measure(k, { kernel, unroll, accs }, { reps: 1, warmup: 0 });
          expect(relErr(checksum, gold), `${kernel} u${unroll} a${accs}`).toBeLessThan(1e-3);
        }
      }
    }
  });

  it('tuned policy from the flywheel run beats the root policy', async () => {
    const tunedPath = join(here, '..', '.harness', 'flywheel', 'tuned-kernel.json');
    if (!existsSync(tunedPath)) return; // no flywheel run yet
    const { loadKernel, measure } = await import('../scripts/kernel.mjs');
    const { readFile } = await import('node:fs/promises');
    const tuned = JSON.parse(await readFile(tunedPath, 'utf8'));
    const k = await loadKernel(wasmPath);
    k.setup(512, 4096, 42);
    const cfg = (p: Record<string, string>) => ({
      kernel: p.kernel as 'scalar' | 'simd',
      unroll: Number(p.unroll),
      accs: Number(p.accs),
    });
    const root = measure(k, cfg(tuned.root), { reps: 7 });
    const best = measure(k, cfg(tuned.tuned), { reps: 7 });
    expect(best.medianMs).toBeLessThan(root.medianMs);
  });
});
