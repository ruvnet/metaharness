// Build crates/k3-kernel-bench for wasm32-unknown-unknown (+simd128) and place
// the artifact where scripts/kernel.mjs expects it. Requires a Rust toolchain
// with the wasm32-unknown-unknown target installed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const crate = join(here, '..', 'crates', 'k3-kernel-bench');
const out = join(here, '..', 'bench');

execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], {
  cwd: crate,
  stdio: 'inherit',
  env: { ...process.env, RUSTFLAGS: '-C target-feature=+simd128' },
});

mkdirSync(out, { recursive: true });
copyFileSync(
  join(crate, 'target', 'wasm32-unknown-unknown', 'release', 'k3_kernel_bench.wasm'),
  join(out, 'k3_kernel_bench.wasm'),
);
console.log('built bench/k3_kernel_bench.wasm');
