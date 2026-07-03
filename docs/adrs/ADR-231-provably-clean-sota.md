# ADR-231: Provably-clean SOTA — submission-integrity attestation as a required leaderboard gate

- **Status**: Proposed
- **Date**: 2026-07-03
- **Deciders**: ruv
- **Tags**: metaharness, swebench, gaia, frames, sota, leaderboard, integrity, attestation, reward-hacking, security, evals
- **Source**: UC Berkeley RDI, *"Illusory Success: All 8 Major Agent Benchmarks Are Gamed"* (Apr 2026) — SWE-bench, GAIA, WebArena, OSWorld, Terminal-Bench et al. driven to ~98–100% **without solving a task** (GAIA via ~98% answer-DB leakage; o3 / Claude-3.7 monkey-patched the grader in 30%+ of runs).
- **Extends**: [[ADR-173]] (leaderboard-conformant path), [[ADR-179]] (cost-Pareto leaderboard), [[ADR-103]] (Ed25519 witness manifest), [[ADR-184]] (nightly SOTA-review pipeline)
- **Generalizes**: ruflo **ADR-167 §4** (GAIA pre-submission exploit audit + Ed25519-signed attestation; `gaia-audit.mjs`), and the metaharness **FRAMES self-audit** (`packages/darwin-mode/bench/gaia/INTEGRITY-AUDIT.md`)
- **Lineage**: the `beyond-sota` thread — [[ADR-038]] / [[ADR-039]] (beyond-SOTA is a durable *property*, not a higher number)
- **Reference implementation**: `scripts/sota-attest.mjs` (+ `scripts/sota-attest.test.mjs`, 11 passing pure-logic tests)

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
| **Grader tampering *via the submitted patch*** | **attest** | The residual of the grader vector: the patch **is** applied inside the grading image, so a diff that edits `conftest.py`/tests or deletes tests could sabotage scoring. → `patch_touches_tests` check. Not provable today without serialized diffs (forward-contract gap). |
| **Undisclosed best-of-N / k-sample** | **attest** | Darwin genuinely uses best-of-N (temp>0 N trajectories in `solve-agentic.mjs`), MCTS best-of-3, cross-model best-of-N (`xbo`), and ADR-205 cascade escalation. A BoN number is legitimate only if the **winner is selected by a conformant selector** (repro tests), never by gold. → `best_of_n_disclosure` + `best_of_n_selector_conformant`. |
| **No-work rate hidden in denominator** | **attest** | Empties can't pass, but the *rate* must be disclosed and counted as unresolved (our runs carry real `empty_patch_instances`: 52/500, 109/300, …). → `empty_patch_rate_disclosed`. |
| **Cost under-reporting** (Pareto claims) | **attest** | The official gold report structurally carries **no cost**; only the solver report does. Absent it, $/resolve is *inferred* (see `inferCost` in `nightly-sota-review.mjs`) — not attestable. → `cost_measured`. |
| **Cherry-picked seed / non-reproducible** | **attest** | n + split are in the gold report; seed/temperature only in the solver report. → `reproducibility`. |
| **Retrieval surfacing gold** (ADR-195 localization) | **attest (open gap)** | `localize.mjs` / `ruvector-localize.mjs` / trace-localize run over repo source, and `conformant-tests.mjs` never stages gold — so gold is out of the corpus *by construction*, but we cannot **prove** the retrieved context excluded gold `FAIL_TO_PASS` without serializing the localization inputs. Same forward-contract gap as FRAMES answer-leakage. → `localization_no_gold`. |
| **No-gold-in-loop conformance** (the SOTA_HORIZON honor claim) | **attest** | Enforced by `conformant-tests.mjs`, flagged by `leaderboardConformant`, but not machine-checkable until the in-loop trajectory is serialized. → downgraded to `attested-by-flag`, honestly, until the trajectory contract lands. |

**Net:** four vectors are structurally immune with a code-level justification; the rest are real and each maps to a concrete attestable check. We do **not** claim immunity we cannot justify.

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
  "k_sample": { "N": null, "cascade": true, "escalate_model": "…", "winner_selector": "conformant-repro" },
  "cost": { "total_usd": 137.4, "per_inst_usd": 0.27, "source": "measured" },
  "vectors": [ { "vector": "answer_db_leakage", "result": "immune", "evidence": "…" }, … ],
  "summary": { "immune": 4, "pass": 5, "skip": 2 },
  "signature": { "alg": "ed25519", "witness_sha256": "<sha256 of canonical body>", "sig": null, "pubkey": null }
}
```

**Two report schemas, bound by the attestation.** The gate's honesty comes from binding two artifacts that each carry half the truth:
- the **official gold report** (`{total_instances, resolved_instances, empty_patch_instances, resolved_ids, …, schema_version}`) — the post-hoc Docker-oracle verdict; carries **no cost, no k-sample, no conformance flag**;
- the **solver report** (`{model, leaderboardConformant, noTestOracle, cascade, escalateModel, phase2, totalCost_usd, modelParams}`) — carries cost, k-sample config, conformance flags, but **not** the gold verdict.

The attestation is the join. Where a field is absent, the vector returns **`skip` + `harness_gap`, never a false `pass`** — the exact discipline of `gaia-audit.mjs` / the FRAMES INTEGRITY-AUDIT ("*Verdict per check is measured from the committed artifacts, not asserted*").

**Signing (ADR-103).** `sota-attest.mjs` computes `witness_sha256` = SHA-256 over the canonical (sorted-key) attestation body. At publish it is signed with the publisher **Ed25519** key — the same `.harness/witness.json` mechanism the `verify-witness` skill checks and that ruflo's ADR-167 uses for its GAIA attestation. The script **never fabricates a signature** (`sig: null` until signed).

### Nightly-pipeline integration point (`scripts/nightly-sota-review.mjs`)

The nightly pipeline already escalates a needle-mover to an n=300 confirm and, on confirmation, renders `renderPRBody()` + `renderIssue()` and opens them ("*opened only in a real run*"). ADR-231 slots in there:

1. After the n=300/500 confirm row lands (the run that **measures** OpenRouter spend), run `sota-attest.mjs --gold-report <confirm-report> --solver-report <solver-report>`.
2. **Fail-closed gate:** if any vector is `fail`, do **not** open the SOTA issue/PR — a failing exploit audit means the number is not a SOTA claim.
3. On pass, **embed the attestation** (per-vector table + `witness_sha256`) into `renderPRBody()` **and** `renderIssue()`, and commit `integrity-attestation.json` beside the report. A confirmed-SOTA issue that lacks a signed attestation is, by this ADR, not a SOTA announcement.

This makes the honor-system conformance claim into a machine-emitted, signed, per-vector artifact attached to the pipeline's own output.

---

## Consequences

**Positive**
- A metaharness SOTA number becomes independently verifiable: anyone can recompute `witness_sha256` and re-run the per-vector audit against the committed reports.
- The durable moat is explicit and cheap to hold: `sota-attest.mjs` is $0 and deterministic.
- The two-schema join surfaces exactly which fields a run failed to record, turning silent gaps into tracked `harness_gap`s.

**Negative / honest limitations**
- **An audit reduces but cannot eliminate reward-hacking.** It raises the cost and narrows the surface; it is not a proof of honesty.
- **SWE-bench's structural advantages do not transfer to GAIA/FRAMES.** The immunity claims above are earned by the Docker-oracle + binary-test design; GAIA has neither and must lean harder on the forward contract.
- **Three checks remain `skip` until a forward contract lands:** `patch_touches_tests`, `localization_no_gold`, and the full-strength `no_gold_in_loop` all need the **trajectory-serialization contract of ADR-167 §4 (ruflo #2550)** applied to the Darwin bench harness — serialize the submitted diffs, the localization inputs, and the in-loop tool calls (secret-redacted, size-bounded). Until then those vectors are honestly `attested-by-flag` or `skip`, never `pass`.

---

## Reference implementation

`scripts/sota-attest.mjs` — pure, dependency-free, $0. Exports `wilson`, `deriveSplit`, `emptyPatchRate`, `isOfficialGoldReport`, `vectorAudit`, `canonicalize`, `witnessHash`, `buildAttestation`. `scripts/sota-attest.test.mjs` — 11 passing tests, including the load-bearing discipline test (*gold-only input → cost/k-sample/no-gold-in-loop must `skip`, never `pass`*) and *a patch that edits tests is a `fail`, not a `skip`*.

Real run against the committed Verified gold report:

```
$ node scripts/sota-attest.mjs --gold-report packages/darwin-mode/bench/swebench/darwin-agentic.verified-500-cascade-local.json
  claim: verified 278/500 = 55.6% (Wilson 51.2–59.9%), gold-oracle=official-docker
  empty_patch_rate: 10.4%   cost: skip   witness: 9aa0f0f00cd0e4dd…
    IMMUNE  answer_db_leakage · normalization_collision · grader_tampering_external · no_work_scores_a_pass
    PASS    empty_patch_rate_disclosed
    SKIP    patch_touches_tests[gap] · best_of_n_disclosure[gap] · cost_measured[gap] ·
            reproducibility[gap] · localization_no_gold[gap] · no_gold_in_loop[gap]
  summary: {"immune":4,"skip":6,"pass":1}
  VERDICT: attestation emitted (skips are honest gaps, not passes). Sign witness_sha256 to make it SOTA-eligible.
```

The six `skip`s are the honest truth for a gold report submitted *without* its paired solver report: cost/k-sample/conformance are unprovable from the Docker-oracle output alone. Attaching the solver report (`--solver-report`) upgrades `cost_measured`, `best_of_n_disclosure`, `reproducibility`, and `no_gold_in_loop` — as the unit tests demonstrate. This is the gate working as designed: **it refuses to pass what it cannot prove.**
