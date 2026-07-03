# ADR-231: Provably-clean SOTA — submission-integrity attestation as a required leaderboard gate

- **Status**: Accepted — implemented (PR #76)
- **Date**: 2026-07-03
- **Deciders**: ruv
- **Tags**: metaharness, swebench, gaia, frames, sota, leaderboard, integrity, attestation, reward-hacking, security, evals
- **Source**: UC Berkeley RDI, *"Illusory Success: All 8 Major Agent Benchmarks Are Gamed"* (Apr 2026) — SWE-bench, GAIA, WebArena, OSWorld, Terminal-Bench et al. driven to ~98–100% **without solving a task** (GAIA via ~98% answer-DB leakage; o3 / Claude-3.7 monkey-patched the grader in 30%+ of runs).
- **Extends**: [[ADR-173]] (leaderboard-conformant path), [[ADR-179]] (cost-Pareto leaderboard), [[ADR-103]] (Ed25519 witness manifest), [[ADR-184]] (nightly SOTA-review pipeline)
- **Generalizes**: ruflo **ADR-167 §4** (GAIA pre-submission exploit audit + Ed25519-signed attestation; `gaia-audit.mjs`), and the metaharness **FRAMES self-audit** (`packages/darwin-mode/bench/gaia/INTEGRITY-AUDIT.md`)
- **Lineage**: the `beyond-sota` thread — [[ADR-038]] / [[ADR-039]] (beyond-SOTA is a durable *property*, not a higher number)
- **Reference implementation**: `scripts/sota-attest.mjs` (+ `scripts/sota-attest.test.mjs`, 25 passing pure-logic tests) — now a **working, enforced, Ed25519-signed** gate: patch-lint off `predictions.jsonl`, real signing/verification, and a fail-closed hook wired into `scripts/nightly-sota-review.mjs` (`--gate-only`, `scripts/nightly-sota-gate.test.mjs`). CI runs both test suites (ADR-231 step in `ci.yml`).

---

## Context

### The finding that invalidates self-declared numbers

UC Berkeley RDI (Apr 2026) demonstrated that **all 8 major agent benchmarks** can be pushed to ~98–100% *without solving any task*. On GAIA specifically: ~98% of the score came from **answer-DB leakage** and normalization collisions; **no-work / no-LLM** records still "passed"; and frontier agents (o3, Claude-3.7) **monkey-patched the grader** in 30%+ of runs. The conclusion is not "those teams cheated" — it is structural: **a self-declared conformant number is no longer evidence of anything.** The reader cannot distinguish a clean 55% from a gamed 55% from the number alone.

This lands directly on our own campaign. `docs/SOTA_HORIZON.md` defines conformance on the **honor system**:

> *"the solver NEVER touches the gold `FAIL_TO_PASS` or `PASS_TO_PASS` test suite during solving … any system that accesses gold tests in-loop is disqualified."*

That is exactly the kind of claim RDI showed is worthless when merely asserted. A grader that isn't bound to an audit is a grader an agent learns to game.

### Our current, honest posture (measured, not asserted)

We are already ahead of the 8 broken benchmarks — but only partially, and only where we can prove it:

- **FRAMES / GAIA** (`packages/darwin-mode/bench/gaia/INTEGRITY-AUDIT.md`, n=50, seed 42): survives the RDI lens on every vector we can *currently check* — strict EM not the relaxed metric, best-of-N view-labeled, no-work absent, seed pinned — but the **answer-leakage** vector is `⚠️ not provable from the artifact` because the trajectory (tool outputs) isn't serialized.
- **SWE-bench** (Darwin harness, `packages/darwin-mode/bench/swebench/`): scored by the **official Docker oracle** `python -m swebench.harness.run_evaluation` (post-hoc, out-of-band), with an in-loop conformance gate (`conformant-tests.mjs`) that *"explicitly NEVER applies the gold `test_patch`."* Published: **Verified 278/500 = 55.6%** (Wilson [51.2, 59.9], committed report `darwin-agentic.verified-500-cascade-local.json`, schema_version 2), Lite ~51.3% (n=300, conformant). The 58.3% figure (`3tier-300-report.json`, 175/300) is **oracle-ON TDR mode — a product metric, not a leaderboard entry.**

The gap: these audits exist as prose per-run. There is no machine-emitted, signed artifact bound to a number, and nothing in the nightly SOTA pipeline (`scripts/nightly-sota-review.mjs`) requires one before it opens a "new SOTA" issue.

---

## Decision

**Redefine a metaharness SOTA/leaderboard claim as a triple:** `(score, cost, integrity-attestation)`. A score without a passing, signed exploit-audit attestation is **not a SOTA claim** — it is an unverified assertion, and the nightly pipeline must refuse to publish it as SOTA.

This is the durable, beyond-SOTA edge (ADR-038/039 restated for the RDI era): **RDI proved numbers are cheap. The moat is being the only harness whose numbers are cryptographically clean** — every milestone number ships a signed per-vector exploit audit anyone can recompute and verify. We compete on *provable integrity*, not on a higher digit.

### The RDI threat model applied to our OWN benchmarks — honestly, per vector

SWE-bench has **structural advantages GAIA lacks**, and pretending otherwise would repeat RDI's error. The table below is justified from harness code, not asserted. `immune` = the vector cannot apply given how the harness scores; `attest` = it can apply and must carry an explicit attestable check.

| RDI vector (how it broke GAIA) | Darwin SWE-bench | Justification (from the harness) |
|---|---|---|
| **Answer-DB leakage** (GAIA #1, ~98%) | **immune** | Success requires a *source diff* that flips held-out gold `FAIL_TO_PASS` under the official Docker harness. `conformant-tests.mjs` never applies the gold `test_patch` in-loop; the verdict is computed post-hoc by `run_evaluation`. Retrieving text cannot substitute for a compiling, test-passing patch — unlike GAIA, where the answer *string* is the deliverable. |
| **Normalization / substring collision** | **immune** | Scoring is binary test execution (`FAIL_TO_PASS` flips fail→pass **and** `PASS_TO_PASS` stays pass). There is no relaxed/substring metric to collide — contrast GAIA's `acc_relaxed`. |
| **Grader monkey-patching** (o3/3.7, 30%+) | **immune (external form)** | The grader is a **separate post-hoc process** on a fresh image, outside the agent tool sandbox, *after the agent has stopped*. The agent emits only a `predictions.jsonl` patch; it cannot write the grader process. |
| **No-work / no-LLM "pass"** | **immune (that direction)** | An empty patch cannot flip a failing test, so no-work structurally scores **0** — the inverse of GAIA's "empty answer scores 100%". |
| **Grader tampering *via the submitted patch*** | **ENFORCED** | The residual of the grader vector: the patch **is** applied inside the grading image, so a diff that edits `conftest.py`/tests or deletes tests could sabotage scoring. → **`patch_touches_tests` — now a real, unit-tested pure check off `predictions.jsonl`**: parse each `model_patch` unified diff, flag any hunk touching a test file (`test_*.py`, `*_test.py`, `conftest.py`, paths under `tests/`/`test/`). A **RESOLVED** instance whose patch edits/deletes a test → **CRITICAL fail** (always fail-closed). Marked `critical: true`. Real number on every committed darwin predictions file: **0** test-touching patches (the conformant harness is clean). No trajectory needed. |
| **Undisclosed best-of-N / k-sample** | **ENFORCED (with solver)** | Darwin genuinely uses best-of-N (temp>0 N trajectories in `solve-agentic.mjs`), MCTS best-of-3, cross-model best-of-N (`xbo`), and ADR-205 cascade escalation. A BoN number is legitimate only if the **winner is selected by a conformant selector** (repro tests), never by gold. → `best_of_n_disclosure` **passes** when the solver report discloses `k`/`kSampleN`/`cascade`/`escalateModel`; `best_of_n_selector_conformant` remains `skip` until the winner-selector is serialized. |
| **No-work rate hidden in denominator** | **ENFORCED** | Empties can't pass, but the *rate* must be disclosed and counted as unresolved (our runs carry real `empty_patch_instances`: 52/500, 14/300, …). → `empty_patch_rate_disclosed` **passes** straight off the gold report. |
| **Cost under-reporting** (Pareto claims) | **ENFORCED (with solver)** | The official gold report structurally carries **no cost**; only the solver report does. → `cost_measured` **passes** when `totalCost_usd` is present (measured); `skip` otherwise (never inferred into a pass). |
| **Cherry-picked seed / non-reproducible** | **ENFORCED (with solver)** | n + split are in the gold report; seed/temperature only in the solver report. → `reproducibility` **passes** when `modelParams.temperature` is present; `skip` otherwise. |
| **Retrieval surfacing gold** (ADR-195 localization) | **attest (open gap)** | `localize.mjs` / `ruvector-localize.mjs` / trace-localize run over repo source, and `conformant-tests.mjs` never stages gold — so gold is out of the corpus *by construction*, but we cannot **prove** the retrieved context excluded gold `FAIL_TO_PASS` without serializing the localization inputs. Same forward-contract gap as FRAMES answer-leakage. → `localization_no_gold` stays `skip`. |
| **No-gold-in-loop conformance** (the SOTA_HORIZON honor claim) | **attested-by-flag** | Enforced by `conformant-tests.mjs`, corroborated by **two** machine-readable flags (`leaderboardConformant=true` **and** `noTestOracle=true`/`--no-test-oracle`), but a full `pass` needs the in-loop trajectory serialized. → `no_gold_in_loop` = `attested-by-flag`, honestly, until the trajectory contract lands. |

**Net:** four vectors are structurally immune with a code-level justification; `patch_touches_tests`, `best_of_n_disclosure`, `empty_patch_rate_disclosed`, `cost_measured`, and `reproducibility` are **enforced** (real pass/fail from the committed artifacts); `no_gold_in_loop` is `attested-by-flag`; `localization_no_gold` + `best_of_n_selector_conformant` remain `skip` pending the trajectory forward-contract. We do **not** claim immunity or a pass we cannot justify.

### The gate — `integrity-attestation.json`

Every SOTA/leaderboard number must carry an `integrity-attestation.json` (produced by `scripts/sota-attest.mjs`) with:

```jsonc
{
  "attestation_version": "1.0",
  "adr": "ADR-231",
  "harness_version": "<git short sha>",
  "generated_at": "<ISO>",
  "run": {
    "split": "verified",                       // inferred from the official denominator (300→lite, 500→verified)
    "n": 500,
    "dataset_name": "princeton-nlp/SWE-bench_Verified",
    "gold_oracle": "official-docker:swebench.harness.run_evaluation",
    "gold_oracle_proven_by": "schema_version:2 report with resolved_ids/empty_patch_ids present",
    "resolved": 278, "resolve_pct": 55.6, "wilson_ci": [51.2, 59.9]
  },
  "empty_patch_rate": 0.104,                    // empty_patch_instances / total — honest denominator
  "k_sample": { "N": 5, "cascade": true, "escalate_model": "…", "winner_selector": null }, // N reads `k` or `kSampleN`
  "patches_linted": 500,                        // count of predictions.jsonl entries linted (null if no --predictions)
  "cost": { "total_usd": 137.4, "per_inst_usd": 0.27, "source": "measured" },
  "vectors": [
    { "vector": "answer_db_leakage", "result": "immune", "evidence": "…" },
    { "vector": "patch_touches_tests", "result": "pass", "critical": true, "evidence": "500 patches linted; 0 resolved-instance test edits" },
    { "vector": "localization_no_gold", "result": "skip", "evidence": "…", "harness_gap": "forward-contract" }
    // … one entry per RDI vector, each pass | fail | skip | immune | attested-by-flag
  ],
  "summary": { "immune": 4, "pass": 4, "skip": 3, "attested-by-flag": 1 },
  "signature": {
    "alg": "ed25519",
    "witness_sha256": "<sha256 of canonical body, sorted keys>",
    "sig": "<128-hex ed25519 over the 32-byte witness digest, or null until signed>",
    "pubkey": "<64-hex raw ed25519 public key, or null until signed>"
  }
}
```

**As-built vs. draft:** `critical: true` marks the fail-closed vector(s) (`patch_touches_tests`); `patches_linted` records the predictions count; `k_sample.N` reads the darwin `k` field (or `kSampleN`); the `signature` block carries a **real** 128-hex Ed25519 signature once signed (never fabricated — `sig`/`pubkey` are `null` until `--sign`).

**Two report schemas, bound by the attestation.** The gate's honesty comes from binding two artifacts that each carry half the truth:
- the **official gold report** (`{total_instances, resolved_instances, empty_patch_instances, resolved_ids, …, schema_version}`) — the post-hoc Docker-oracle verdict; carries **no cost, no k-sample, no conformance flag**;
- the **solver report** (`{model, leaderboardConformant, noTestOracle, cascade, escalateModel, phase2, totalCost_usd, modelParams}`) — carries cost, k-sample config, conformance flags, but **not** the gold verdict.

The attestation is the join. Where a field is absent, the vector returns **`skip` + `harness_gap`, never a false `pass`** — the exact discipline of `gaia-audit.mjs` / the FRAMES INTEGRITY-AUDIT ("*Verdict per check is measured from the committed artifacts, not asserted*").

**Signing (ADR-103) — implemented.** `sota-attest.mjs` computes `witness_sha256` = SHA-256 over the canonical (sorted-key) attestation body, then signs the raw 32-byte digest with a publisher **Ed25519** key using Node's built-in `crypto` (zero-dep; the same raw-hex convention as the harness `witness.json` — 64-hex pubkey, 128-hex signature). Signing is an explicit opt-in: `--sign` with `--seed-hex <64hex>`, `--key <file>`, or `$SOTA_SIGNING_SEED_HEX` (no key material is committed or logged). `--verify <attestation>` recomputes the witness over the body (catching **any** tamper) and Ed25519-verifies the signature. The script **never fabricates a signature** (`sig: null` until `--sign`). Proven: sign→verify round-trips; a one-field body edit fails with a witness mismatch; a flipped signature byte fails the Ed25519 check.

### Nightly-pipeline integration point (`scripts/nightly-sota-review.mjs`)

The nightly pipeline escalates a needle-mover to an n=300 confirm and, on confirmation, renders `renderPRBody()` + `renderIssue()`. ADR-231 is **wired in** (`runIntegrityGate()` + `attestationSection()` in `scripts/nightly-sota-review.mjs`):

1. On the n=300/500 confirm (the run that **measures** OpenRouter spend), `runIntegrityGate({goldPath, solverPath, predictionsPath, maxSkips})` builds the attestation over the `(gold, solver, predictions)` triple.
2. **Fail-closed gate (`integrityGateDecision`):** any vector `fail` (a **critical** fail always blocks) **or** more `skip`s than `--attest-max-skips` (default 4) ⇒ the pipeline logs *why* and does **not** open the SOTA issue/PR. A gold-only report (6 skips — cost/conformance unprovable) is correctly refused.
3. On a clean gate, the attestation (per-vector table + `witness_sha256` + signature) is **embedded** into `renderPRBody()` **and** `renderIssue()`, and `integrity-attestation.json` is committed beside the report.

The gate runs at $0 with no cloud: `node scripts/nightly-sota-review.mjs --gate-only [--gold-report … --solver-report … --predictions …]` exercises the whole path in isolation (CI-safe). The gate decision is unit-tested (`scripts/nightly-sota-gate.test.mjs`): fail-closed on the real gold-only Verified-500, opens on a full conformant triple, fail-closed on a fabricated critical fail. This makes the honor-system conformance claim a machine-emitted, signed, per-vector artifact attached to the pipeline's own output.

---

## Consequences

**Positive**
- A metaharness SOTA number becomes independently verifiable: anyone can recompute `witness_sha256` and re-run the per-vector audit against the committed reports.
- The durable moat is explicit and cheap to hold: `sota-attest.mjs` is $0 and deterministic.
- The two-schema join surfaces exactly which fields a run failed to record, turning silent gaps into tracked `harness_gap`s.

**Negative / honest limitations**
- **An audit reduces but cannot eliminate reward-hacking.** It raises the cost and narrows the surface; it is not a proof of honesty.
- **SWE-bench's structural advantages do not transfer to GAIA/FRAMES.** The immunity claims above are earned by the Docker-oracle + binary-test design; GAIA has neither and must lean harder on the forward contract.
- **`patch_touches_tests` is now enforced** off `predictions.jsonl` (the submitted diffs *are* the serialized artifact for this vector), so only **two** checks still need the trajectory forward-contract: `localization_no_gold` (needs the serialized localization inputs) and the full-strength `no_gold_in_loop` (needs the in-loop tool calls to upgrade from `attested-by-flag` to a machine-proven `pass`). Both need the **trajectory-serialization contract of ADR-167 §4 (ruflo #2550)** applied to the Darwin bench harness (secret-redacted, size-bounded). `best_of_n_selector_conformant` similarly stays `skip` until the winner-selector is serialized. Until then those vectors are honestly `attested-by-flag` or `skip`, never `pass`.
- **The gate audits integrity, not SOTA-worthiness.** `integrityGateDecision` opens on a *clean* attestation regardless of the resolve number — whether a config is Pareto-optimal is the nightly pipeline's separate Wilson/Pareto logic. A low-resolve run with a clean attestation opens the gate; that is by design (the two concerns are orthogonal).

---

## Reference implementation

`scripts/sota-attest.mjs` — pure, dependency-free, $0. Exports `wilson`, `deriveSplit`, `emptyPatchRate`, `isOfficialGoldReport`, `vectorAudit`, `canonicalize`, `witnessHash`, `buildAttestation`, plus the as-built additions: `isTestFile`, `parsePatchPaths`, `lintPatch`, `lintPredictions`, `parsePredictionsJsonl`, `signAttestation`, `verifyAttestation`, `integrityGateDecision`. `scripts/sota-attest.test.mjs` — **25 passing tests**, including the load-bearing discipline test (*gold-only input → cost/k-sample/no-gold-in-loop must `skip`, never `pass`*), the patch-lint suite (*a RESOLVED instance whose patch edits tests is a CRITICAL `fail`*), the Ed25519 sign→verify + tamper suite, and the fail-closed gate decision.

**Case A — the committed Verified gold report, gold-only (honest 6 skips → fail-closed):**

```
$ node scripts/sota-attest.mjs --gold-report packages/darwin-mode/bench/swebench/darwin-agentic.verified-500-cascade-local.json
  claim: verified 278/500 = 55.6% (Wilson 51.2–59.9%), gold-oracle=official-docker
  empty_patch_rate: 10.4%   cost: skip   patches_linted: none   witness: e81e81dd8b1c63ee…
    IMMUNE  answer_db_leakage · normalization_collision · grader_tampering_external · no_work_scores_a_pass
    PASS    empty_patch_rate_disclosed
    SKIP    patch_touches_tests *CRITICAL* · best_of_n_disclosure · cost_measured · reproducibility ·
            localization_no_gold · no_gold_in_loop
  summary: {"immune":4,"skip":6,"pass":1}
  gate: FAIL-CLOSED — 6 skips > threshold 4
```

The Verified-500 run has **no committed solver-side report or predictions** (`verified-500.json` is the task manifest, not a solver report), so cost/k-sample/conformance are genuinely unprovable — the gate honestly refuses it.

**Case B — a full committed conformant triple (gold + solver + predictions), skips drop 6 → 3:**

```
$ node scripts/sota-attest.mjs \
    --gold-report   packages/darwin-mode/bench/swebench/mcts-pilot25-eval-report.json \
    --solver-report packages/darwin-mode/bench/swebench/solve-mcts-pilot25.json \
    --predictions   packages/darwin-mode/bench/swebench/predictions-mcts-pilot25.jsonl
  empty_patch_rate: 4.7%   cost: measured   patches_linted: 25   witness: a6fb052cd5433ee0…
    IMMUNE            answer_db_leakage · normalization_collision · grader_tampering_external · no_work_scores_a_pass
    PASS  *CRITICAL*  patch_touches_tests   (25 patches linted; 0 resolved-instance test edits)
    PASS              best_of_n_disclosure (k=5) · empty_patch_rate_disclosed · cost_measured ($0.587)
    SKIP              best_of_n_selector_conformant · reproducibility · localization_no_gold
    ATTESTED-BY-FLAG  no_gold_in_loop
  summary: {"immune":4,"pass":4,"skip":3,"attested-by-flag":1}
  gate: OPEN
```

`--solver-report` upgrades `cost_measured`/`best_of_n_disclosure`; `--predictions` turns the CRITICAL `patch_touches_tests` skip into a real pass (linting all 25 submitted diffs). Signing + verifying:

```
$ node scripts/sota-attest.mjs --gold-report … --solver-report … --predictions … --sign --seed-hex <64hex> --out att.json
  signature: SIGNED (ed25519, pubkey e4148bd9…)
$ node scripts/sota-attest.mjs --verify att.json
  VERDICT: VALID — attestation is authentic and untampered
# after editing any body field:
  VERDICT: INVALID — witness_sha256 mismatch — body tampered
```

This is the gate working as designed: **it refuses to pass what it cannot prove, and cryptographically binds what it can.** Across every committed darwin `predictions*.jsonl` the real `patch_touches_tests` count is **0** — the conformant harness never edits its own grader.
