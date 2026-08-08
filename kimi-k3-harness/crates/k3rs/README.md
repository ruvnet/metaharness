# k3rs — Kimi K3 inference in Rust

A faithful Rust port of [kimi-k3-in-c](https://github.com/FareedKhan-dev/kimi-k3-in-c)'s
verified in-memory inference path: config, safetensors, all kernels (RMSNorm,
SiTU-GLU, ShortConv, KDA decay + delta-rule recurrence, gated NoPE MLA,
sigmoid-routed Stable LatentMoE with MXFP4 experts, AttnRes block residuals),
the 93-layer-architecture decoder stack, and full-recompute greedy decode.
Dependency-free: own JSON parser, own safetensors reader, `std` only.

## Conformance — the whole point

Verified with the upstream repo's own tooling on the tiny checkpoint
(`tools/make_tiny_checkpoint.py`):

- **torch reference** (`tools/cmp_logits.py`): max |diff| 2.93e-6 against a
  6.8e-5 budget, correlation 1.000000000 — VERIFIED, argmax agrees.
- **C engine**: first-step logits are **byte-identical** to `./bin/k3
  --dump-logits`, and greedy decode emits the **same token sequence**
  (239, 26, 209, 85 for `--ids 3,7,11,5,9 --gen 4`).

Bit-identity is by construction, not luck: the matmul kernels reproduce the C
engine's exact accumulator partitions and reduction trees (16 f64 fma lanes
reduced `(b0+b1)+(b2+b3)` for the dense kernels; 8 lanes inside each MXFP4
group, group scale applied once per group), and every place the C code holds a
`float` or `double` this port holds an `f32` or `f64`.

```bash
cargo build --release    # AVX2+FMA dispatched at runtime; no special flags needed
./target/release/k3rs <model_dir> --ids 3,7,11,5,9 --gen 4 --dump-logits rs.bin
python3 tools/cmp_logits.py rs.bin <model_dir>/ref_logits.json <hidden>
cargo test          # 9 kernel tests: the C fixtures' invariants + AVX2 bit-identity
./target/release/k3rs --bench   # the two dominant kernels at real K3 dims
```

## Measured (4-core AVX2, default build, threaded rows; interleaved with the
## patched C engine on the same box, min/median of 5)

| Kernel (real K3 dims) | k3rs | C engine (patched) |
|---|---|---|
| bf16 matmul 12288×7168 | 7.4 / 7.9 ms | 6.2 / 7.0 ms |
| MXFP4 matmul 3072×3584 | **1.15 / 1.17 ms** | 1.16 / 1.19 ms |

MXFP4 is at parity with the hand-tuned C engine; bf16 is within ~15% and
memory-bandwidth-bound (the two trade places between measurement rounds).
Journey: bf16 73.2 → 7.4 ms and MXFP4 11.3 → 1.15 ms — ~10× each — with
output bits frozen the whole way.

The AVX2 paths (`src/avx2.rs`) carry the techniques the verified upstream
patches added to the C engine — per-call f64 x-precast, batched bf16 widening,
register-only pshufb nibble decode — plus one k3rs-original: the MXFP4 kernel
keeps TWO groups in flight (their sub-sums are independent; the row total
still adds `sub·scale` in ascending group order), doubling the independent
fma chains at zero bit movement. Every path reproduces the portable kernels'
accumulator partitions and reduction trees exactly, asserted bitwise by
`tests::avx2_paths_match_portable_bitwise`; a non-AVX2 machine falls back to
the portable kernels with identical output. The KDA recurrence threads over
heads (independent state blocks, compact private outputs scattered after the
join) and takes caller-owned scratch instead of allocating per step. Thread
count cannot change a single output bit — rows/heads are partitioned, never
reduced across threads, same as the C engine's OpenMP contract.

## Scope

In: everything the full-model oracle validates (the `k3_model`-equivalent
path). Out (lives in the C engine): trunk streaming from disk, the LRU expert
cache, incremental decode / KV cache, the tokenizer, and the hybrid draft
model. The tests' reproducible channel is `--ids`, same as upstream.
