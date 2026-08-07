# Upstream optimizations for kimi-k3-in-c

Verified, bit-exact performance patches for
[FareedKhan-dev/kimi-k3-in-c](https://github.com/FareedKhan-dev/kimi-k3-in-c)
(v1.0.0, commit `ff11dce`), produced by this harness's agent-swarm workflow:
**4 mappers → 1 ranker → 4 optimizers (isolated copies) → 4 adversarial
verifiers** (13 agents). Every patch kept the full test suite green, preserved
the project's bit-exactness contract (identical FNV1a output hashes across the
scalar path, the AVX2 path, and any thread count), and survived an independent
verifier that rebuilt from scratch and re-measured against a fresh baseline.

## Measured result (merged, quiet 4-core AVX2 box, median of 9 interleaved runs)

| Kernel (real K3 dims) | baseline | merged | speedup |
|---|---|---|---|
| bf16 trunk matmul 12288×7168 | 9.14 ms | 6.64 ms | **1.38×** |
| MXFP4 expert matmul 3072×3584 | 1.76 ms | 1.00 ms | **1.76×** |
| projected trunk s/token | 5.08 | 3.77 | 1.35× |
| projected experts s/token | 7.94 | 5.34 | 1.49× |

End-to-end conformance: the merged engine's logits on the tiny checkpoint are
**bit-identical** to the unpatched build and match the torch reference
elementwise (max |diff| 2.93e-6 against a 6.8e-5 budget, correlation
1.000000000 — `tools/cmp_logits.py`).

## The patches (apply in this order; files are pairwise disjoint)

| Patch | What it does | Verified |
|---|---|---|
| `kernel-conv-bitexact.patch` | Cuts conversion overhead in both hot kernels without touching accumulation order: bf16 x-side precast to a per-call f64 scratch, batched AVX2 bf16 widening (`cvtepu16_epi32` + `slli 16`), MXFP4 double LUT + register-only SIMD nibble decode (kills the `wf[]` store-forwarding stall). | 1.36–1.50× bf16, 1.59–1.83× MXFP4; FNV hashes identical on >20 runs, native + CI-pin + scalar builds |
| `bind-widen-simd-omp.patch` | Vectorizes + threads the bf16→fp32 widen in `k3_bind_layer_mem` (a pure bit shift — elementwise exact). | 3.4× on the widen at 6.4M elements |
| `trunk-bind-memoize.patch` | Memoizes `k3_trunk_bind` for pinned layers / unchanged ring slots — removes ~2.3 GB/token of redundant widen+resolve at the 90/93-pinned server preset. | widen wall on pinned path 0.02 s → below print resolution over 2600 binds |
| `bench-hash-gate.patch` | Turns the bench FNV1a output hashes + thread-count invariance into an enforced `make test` gate — the determinism contract is now machine-checked. | gate passes at 1 and 4 threads with the pre-optimization golden hashes |

```bash
git clone https://github.com/FareedKhan-dev/kimi-k3-in-c && cd kimi-k3-in-c
for p in kernel-conv-bitexact bind-widen-simd-omp trunk-bind-memoize bench-hash-gate; do
  git apply path/to/patches/$p.patch
done
make -j"$(nproc)" && make test && make bench && ./bin/bench_kernels
```

Full per-agent evidence (optimizer reports + adversarial verifier verdicts):
[`swarm-outcomes.json`](./swarm-outcomes.json).

## Notes

- The scalar-vs-AVX2 bf16 bench-hash divergence (`243d…` vs `d65c…`) is
  **pre-existing** upstream behavior, reproduced identically on the unpatched
  baseline; the contract preserved here is "patched output == unpatched output"
  per build flavor, and the AVX2/thread-count invariance the project documents.
- Tokenizer parity does not run in `make test` without `tiktoken.model`
  (offline) — pre-existing, unchanged.
- Rejected-candidate log (AVX-512 variants, accumulation-reordering
  partitions, async MoE I/O) with reasons is preserved in the workflow record.
