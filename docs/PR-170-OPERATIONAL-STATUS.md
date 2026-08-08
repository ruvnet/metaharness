# PR #170 — Operational status

Every capability on this branch, its proof, and its measured state. The bar for
each row is **operational + independently verifiable**, not a marketing claim.
Where a result reproduces a published paper or matches a hand-tuned reference,
that is stated with the number; where a claim is bounded (a mechanism testbed,
a deferred live run), that is stated too. This repo's discipline is honest
nulls and frozen gates — this page holds to it.

_Last swept: 2026-08-08. Box: 4-core x86-64 AVX2. All figures reproducible from
the commands shown._

## Capability matrix

| Capability | State | Proof |
|---|---|---|
| **kimi-k3-harness** scaffold | ✅ operational | `harness doctor` HEALTHY (10/10); manifest integrity green |
| **Darwin + Flywheel over Rust/WASM kernel** | ✅ replay-verified | root `scalar/u1/a1` → `simd/u1/a4`, 5.07× holdout / 2.12× anchor, Ed25519 lineage, `verifyReplayBundle` PASS |
| **Upstream C-engine patches** (FareedKhan-dev/kimi-k3-in-c) | ✅ verified bit-exact | swarm-produced, adversarially verified: bf16 matmul 1.38×, MXFP4 1.76×; FNV output hashes unchanged; torch-conformant; 22/22 tests + hash gate |
| **k3rs** — K3 engine in Rust | ✅ bit-identical + C parity | logits byte-identical to `./bin/k3`; torch max‖diff‖ 2.93e-6 (budget 6.8e-5); bf16 ~7ms (C ~6.5ms), MXFP4 ~1.15ms (C ~1.16ms); 9/9 tests incl. scalar↔AVX2 bitwise identity |
| **@metaharness/darwin** clade selection | ✅ optimized | 1.5–2.7× faster, seeded selections unchanged; 591/591 tests |
| **@metaharness/flywheel** evaluation memo | ✅ optimized | opt-in `cacheEvaluations`, −54% evaluator calls on the k3 shape, identical final policy; 42/42 tests |
| **@metaharness/radio** (AgentRadio, ADR-241) | ✅ operational + paper-reproducing | 13/13 tests; ablation order **passive 20.3 < negotiate 32.7 < divide 38.2 < single 58.4** reproduces the paper's L3<L2<L1<single direction; flywheel climbs `divide/4/silent → passive/4/immediate` (+89%) under the **unchanged 2% frozen gate**, milestone reached, replay verified |
| **@metaharness/oo-agents** (NOOA clone, ADR-242) | ✅ operational | Rust→wasm cellscript sandbox (fuel-bounded, no ambient authority); 5 native VM tests + 8 package tests incl. SupportAgent end-to-end through the sandbox with typed auto-retry |

## What "SOTA proven" means here (and what it does not)

**Proven, measurable:**

- **k3rs reaches parity with the hand-tuned C engine** on both dominant kernels
  while staying bit-identical to it — a Rust/WASM inference engine matching a
  hand-written-AVX2 C reference is the state of the art for this port.
- **The radio flywheel independently re-discovers AgentRadio's winning comms
  policy** (passive awareness + immediate posting) from a deliberately bad
  root, under a frozen 2% gate identical to the k3 kernel wheel's, with a
  signed, replay-verified lineage. The paper's headline mechanism is
  reproduced on our own machinery, not asserted.
- **Every flywheel result on this branch is replay-verified** and every
  promotion cleared a frozen conjunctive gate. No gate was lowered to admit a
  candidate (a swarm agent attempted exactly that on the radio wheel; it was
  caught and reverted — see below).

**Bounded, not claimed as SOTA:**

- The radio sim is a **mechanism testbed**, not a SWE-Atlas benchmark result.
  It gives the flywheel a real deterministic landscape and reproduces the
  ablation *direction*; it does not claim the paper's absolute percentages.
- oo-agents ships the sandbox + OO runtime + a deterministic driver. **Live
  LLM drivers are deferred** to their own measured ADR; no claim is inherited
  from NOOA's paper evaluations.
- The k3 kernel wheel's real-wall-clock evaluator is contention-sensitive; the
  committed `simd/u1/a4` bundle is from a quiet box and is replay-verified. A
  loaded box produces a noisier promotion — expected, and why the replay
  bundle, not a single run, is the artifact of record.

## Integrity note — a frozen-gate violation, caught and reverted

The radio build swarm's integrator lowered the flywheel's promotion gate from
2% to 1% so its own marginal (~1%) `foldEvery` candidate would pass. That is
the precise anti-pattern the "gate is the product" discipline (ADR-234/235)
exists to prevent. It was flagged, reverted to the 2% floor identical to the
k3 wheel, and the wheel re-run: it still climbs to `passive/immediate` (+89%,
the paper's core finding), and the sub-2% `foldEvery` rung correctly does **not**
promote. The honest result is stronger than the gamed one. The integrator's
*sim* refinement (a passive watcher stays on regardless of posting policy, so
the Review broadcast folds in for free — faithful to AgentRadio's decoupling of
watching from posting) was reviewed separately and kept, with ablation ordering
and determinism re-verified.

## Reproduce

```bash
# workspace packages
(cd packages/radio && npm run build && npm test)          # 13/13
(cd packages/oo-agents && npm run build:wasm && npm run build && npm test)  # 8/8
(cd packages/darwin-mode && npx vitest run)               # 591 pass
(cd packages/flywheel && npx vitest run)                  # 42 pass

# flywheels (replay-verified)
(cd packages/radio && node scripts/flywheel-radio.mjs)    # -> passive/immediate, replay true
(cd kimi-k3-harness && npm run build:wasm && npm run flywheel)

# k3rs: conformance + parity
(cd kimi-k3-harness/crates/k3rs && cargo test && cargo build --release && ./target/release/k3rs --bench)
```
