// Loader + measurement helpers for the k3-kernel-bench WASM module.
// The wasm artifact is built from crates/k3-kernel-bench (see build-wasm.mjs);
// it is not committed — rebuild it deterministically from source.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const WASM_PATH = join(here, '..', 'bench', 'k3_kernel_bench.wasm');

export const KERNELS = { scalar: 0, simd: 1 };

export async function loadKernel(wasmPath = WASM_PATH) {
  const bytes = await readFile(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const { setup, matvec, golden } = instance.exports;
  return { setup, matvec, golden };
}

/** Median-of-N wall time for one full matvec pass with the given levers. */
export function measure(k, { kernel, unroll, accs }, { reps = 9, warmup = 2 } = {}) {
  const kid = KERNELS[kernel];
  if (kid === undefined) throw new Error(`unknown kernel lever: ${kernel}`);
  for (let i = 0; i < warmup; i++) k.matvec(kid, unroll, accs);
  const times = [];
  let checksum = 0;
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    checksum = k.matvec(kid, unroll, accs);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { medianMs: times[(times.length - 1) >> 1], checksum };
}

/** Relative error of a variant checksum vs the f64 golden reference. */
export function relErr(checksum, gold) {
  return Math.abs((checksum - gold) / gold);
}
