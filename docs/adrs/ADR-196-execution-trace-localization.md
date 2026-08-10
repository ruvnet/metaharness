# ADR-196 — Execution-trace localization: the dynamic localizer (repro → run → trace → fix-site)

**Status**: Implemented (build), validation pending budget — shipped as a modular, unit-tested module (`bench/swebench/trace-localize.mjs`, 13 unit tests) + a Phase-2 genome gene `traceLocalize` (default OFF) + a `--trace-localize` flag in `solve-agentic`. ZERO paid runs. See LEARNINGS §53/§54.
**Date:** 2026-06-26
**Related:** ADR-195 (Phase-2 capability stack — this REUSES §195's repro-WRITE half), ADR-175 (Test-Driven Repair), ADR-190 (AST-fused mincut localization), ADR-153 (agentic-loop). LEARNINGS §52 (naive HNSW localization FAILED — symptom-anchoring) and §53 (field SOTA research: execution-trace localization is the #1 untried hard-tail lever). Research: CoSIL (arXiv 2503.22424), ORACLE-SWE (2604.07789), AutoCodeRecover.

---

## Context

Two prior facts frame this decision:

**§52 — naive semantic localization FAILED, plausibly hurt.** The RuVector-HNSW localizer (ADR-195 #1) chunks repo source, embeds it, retrieves the top-k chunks most similar to the issue text, and seeds the agent with a ranked "likely-relevant files" hint. On an n=5 hard-tail probe its recall@12 was 2/5, it resolved 0/5 either arm, and it **reduced patches-generated 2/5 → 0/5**. The misses cluster on a structural pattern: the issue text describes a **symptom**, and pure semantic similarity retrieves the **symptom's definitions** (e.g. urllib3 `exceptions.py`), *not* the **fix-site** that uses/wraps them (`adapters.py`). Worse, a confident wrong/buried hint **anchors** the agent, so it burns its step budget on distractors instead of finding the fix via its own grep/import-following. A wrong authoritative hint is worse than no hint.

**§53 — the field names the exact fix.** Deep SOTA research (CoSIL, ORACLE-SWE, AutoCodeRecover) converges on the same conclusion: single-pass semantic localization anchors on "symptom distractors" (CoSIL names this failure precisely — it matches §52). Their fix is **dynamic localization**: generate a reproduction test, **RUN it**, and use the **execution trace** of the failing run as the localization signal. The fix-site is *in the trace* — the symptom sits on top of it. This is the field's clearest hard-tail mechanism, and it is the **#1 untried lever** in our harness. ADR-195's repro-gate already has the repro-**WRITE** half, but not the **trace-as-localization** half (§53: "our repro-gate has the repro-WRITE half but NOT the trace-as-localization half").

This is **not** the naive localizer with a new index. It is a categorically different signal: *observed execution* (what the failing run actually touched) versus *text similarity* (what looks like the issue). The former cannot anchor on a symptom distractor, because a symptom distractor by definition is not on the execution path that raised.

## Decision

Build **execution-trace localization** as new solver code (`trace-localize.mjs`), then expose it as a Phase-2 genome gene `traceLocalize` (default off) and a `--trace-localize` flag, so per-instance evolution can measure its hard-tail coverage lift.

### Pipeline (conformant — issue text only, base-env run, gold tests NEVER seen)
1. **REPRO** — reuse `test-critic.buildReproTest` (the same repro-WRITE the ADR-195 repro-gate uses): generate a `reproduce_bug.py` that FAILS on the unmodified buggy repo (it captures the bug). Conformant: issue text only, deps present in the base Docker image, no gold `test_patch`.
2. **TRACE** — run that repro under a **stdlib `sys.settrace` line tracer** (`buildPyTracer`, staged as `trace_repro.py`) in the conformant base env. Capture the ordered `(file, function, line)` frames the failing run executed (filtered to repo source under `/testbed` — not stdlib/site-packages/the repro itself), per-file execution frequency, and the **failure traceback** frames. The tracer re-raises so the exit code is unchanged; it emits a JSON block between sentinels (`@@DARWIN_TRACE_BEGIN/END@@`) for robust extraction from a noisy log tail.
3. **RANK** — "from symptom outward" (CoSIL): the **traceback frames rank first** (the *innermost* frame = the raise site = the most probable fix-site leads), then the remaining trace-touched source files by **execution centrality** (frequency). A high-frequency file that is *not* on the failure path (a symptom distractor) ranks **below** any file on the failure path — exactly the §52 failure that semantic ranking could not avoid.
4. **SEED** — inject as the agent's starting surface, framed as **OBSERVED-EXECUTION EVIDENCE** ("a failing reproduction was run under a tracer; it executed through these files; it raised here"), explicitly **NOT** an authoritative directive (the §52 anti-anchoring lesson — the block says "you may still explore elsewhere" and carries no "MUST edit"/"the fix is in" language).

### Composition with the existing Phase-2 stack
- `--trace-localize` composes with `--localize` (semantic): when both are on, the **trace evidence leads** (it is the stronger, observed signal) and the semantic seed follows.
- It composes with `--repro-gate`: trace-localize seeds *where to look*; the repro-gate then *verifies* the fix. Both reuse the same repro-WRITE, so a combined run writes the repro once per phase.
- The combined hint flows into `solveTier` via the existing `localizeHint` channel — no change to the agentic loop.

### Honesty guards (no fabricated localization)
Mirroring the repro-gate's gate-arming discipline: if the repro is invalid, or the trace can't be captured/parsed, or the run touched **no** repo-source frame, `traceLocalize` returns `seed: null` + `traced: false` and the caller injects **NO hint** — never a guessed one. A wrong confident hint is worse than none (§52). Trace-localization never blocks the solve.

## Conformance

- The repro is written from the **issue text only** (`buildReproTest`), never from the gold test.
- The trace is captured from a **base-env run** (deps present, repo at `/testbed`, conda env `testbed`) with the agent's patch absent and the gold `test_patch` **never applied** — the same conformant container path as `runConformantTests`.
- The frame filter keeps only repo source under the repo root, so the localizer points at **project code**, never the gold test path (the issue text never references it anyway).
- The gold FAIL_TO_PASS is reserved for final scoring only and is never seen during solving (the `--no-test-oracle` leakage guard in `solve-agentic` is unchanged).

## Relationship to ADR-195's repro-gate

ADR-195 #2 (repro-gate) **WRITES** a repro and **ITERATES** the solve against it (verification — "make the self-written repro pass"). ADR-196 **REUSES** that same repro WRITE, then adds the **trace-CAPTURE + trace-as-LOCALIZER** half it was missing. The two are orthogonal and composable: #196 answers *where is the fix* (seed), #195 answers *is the fix correct* (gate).

## Honest ceiling caveat

§53's research is explicit: even with **ALL** oracle signals (repro test + edit location + execution context + API + regression), ~3% of instances remain unsolved, and oracle *localization alone* leaves ~57% of the localization-headroom non-recoverable — the hard tail is a **shared model-reasoning ceiling**, not a missing file-finder. Execution-trace localization is the field's best localization mechanism, but it **will not crack everything**: it helps the subset whose fix-site is reachable by the repro's execution but not by the agent's native exploration within budget. Instances whose bug requires multi-file reasoning the model cannot do, or whose repro can't be written from the issue text, are out of its reach. This is a *targeted* hard-tail lever, not a silver bullet — and like every localization lever before it (§35/§38/§44/§52), it must be **validated on held-out conformant n≥25** before any claim; an n=5 probe cannot distinguish a real lift from agentic variance.

## Consequences

- **+** A localization signal that *structurally cannot* anchor on symptom distractors (the §52 failure mode), because it ranks by observed execution, not text similarity.
- **+** Zero new dependency: the tracer is stdlib `sys.settrace`/`runpy`/`traceback` — no pip install, no native addon (unlike the RuVector path). Trivially conformant and reproducible.
- **+** Reuses the audited repro-WRITE (ADR-195) and conformant runner (ADR-173) — small new surface, all of it pure + dependency-injected + unit-tested offline.
- **+** Default OFF gene → byte-identical genome keys for pre-Phase-2 genomes (backward-compatible Firestore readback).
- **−** Adds one repro-write + one traced base-env run per instance when on (cost ≈ the repro-gate's write + one Docker exec). Bounded; gated behind the flag.
- **−** Bounded by repro-writability: instances whose bug can't be reproduced from the issue text get no trace seed (honest null, no fabrication).
- **−** Validation is pending budget — this ADR records the build, not a measured result.

## Validation command (later, paid — the HARD-25)

Run, once budget allows, on the held-out conformant HARD-25 (Opus give-ups), trace-localize as the single delta against a plain full-Opus baseline:

```bash
# trace-localize arm (the ADR-196 delta)
OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
  bench/swebench/solve-agentic.mjs \
  --manifest hard-25.json --model anthropic/claude-opus-4.8 --max-steps 15 \
  --no-test-oracle --trace-localize --concurrency 2 --max-cost 20 \
  --out predictions-trace-hard25.jsonl --report report-trace-hard25.json

# baseline arm (identical except the flag) for the A/B
OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
  bench/swebench/solve-agentic.mjs \
  --manifest hard-25.json --model anthropic/claude-opus-4.8 --max-steps 15 \
  --no-test-oracle --concurrency 2 --max-cost 20 \
  --out predictions-base-hard25.jsonl --report report-base-hard25.json
```

Compare `resolved` counts and (for diagnosis) `traceLocalized` per-instance + the per-instance trace-seed quality (does the gold-fix file appear on the ranked failure path?). The per-instance evolution path measures coverage lift via the `traceLocalize` gene (`evolve-config.mjs` seeds a `single|claude-opus-4.8|s15+trace` probe).
