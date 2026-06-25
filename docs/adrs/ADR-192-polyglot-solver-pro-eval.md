# ADR-192 — Polyglot solver + SWE-bench Pro eval hardening

**Status:** Proposed (parallel workflow in flight)
**Date:** 2026-06-24
**Related:** ADR-185 (localization findings), §38 (ReAct self-localizes on Python), the Pro integration (gcp-cluster `pro` board, pro-25.json)

---

## Context

We wired SWE-bench **Pro** into the GCP harness (board + `pro-25.json` + a Scale-eval branch in the runner), but the
Pro n=25 first run is a **plumbing smoke test, not a real cost-Pareto number**, for two honest reasons:

1. **The solver is Python-tuned.** `solve.mjs`/`agentic-loop.mjs` localization lists `git ls-files '*.py'` and searches
   `def`/`class` signatures; the patcher assumes Python. But 4 of the first-25 Pro repos are **Go/JS/TS** (NodeBB,
   qutebrowser, teleport, element-web…). It will emit valid-format predictions but resolve poorly on non-Python — so
   the number is not comparable to Lite/Verified.
2. **The Pro eval wiring is unverified end-to-end.** The runner's Pro branch infers the upstream
   `scaleapi/SWE-bench_Pro-os` script names/flags (`gather_patches.py`, `swe_bench_pro_eval.py`) and pulls
   `jefzda/sweap-images` — none verified against a live run; Docker Hub egress + disk for ~8 large enterprise images
   are open risks.

A genuine Pro result needs a **language-agnostic solver** + a **verified eval pipeline**.

## Decision

Make the agentic solver **polyglot** and harden the Pro eval, in a parallel workflow:

### A. Polyglot solver (language-agnostic localization + patching)
- File listing: replace `git ls-files '*.py'` with a multi-extension set (`*.py,*.go,*.js,*.ts,*.tsx,*.rs,*.java,*.rb,*.c,*.cpp,*.h`)
  or all tracked source files, so the model sees the right files regardless of language.
- Symbol search: replace Python-only `def`/`class` heuristics with a language-agnostic symbol grep (ripgrep over
  `func|function|class|def|impl|type|const` etc.), or tree-sitter if cheap. The ReAct loop already drives its own
  grep/read — the fix is the *seed* file/symbol surface, not the model.
- Patcher: the `line_edit`/search-replace tools are already language-agnostic (operate on text/line ranges) — verify no
  Python assumption leaks. Keep conformant (no gold tests in-loop).

### B. Pro eval hardening
- Verify the real `scaleapi/SWE-bench_Pro-os` eval entrypoint + flags against the live repo (not inferred). Fix the
  runner's Pro branch to the actual CLI.
- Confirm `jefzda/sweap-images:{dockerhub_tag}` pulls (anonymous rate limits, disk) — add a Docker Hub login path +
  bump boot disk if needed; cache images at `env` level.
- A graceful "score offline / partial" fallback if an image is missing, so one bad image doesn't wedge the run.

## Consequences
- Pro becomes a **real** benchmark for the cost-Pareto story (polyglot resolve, verified eval) rather than a smoke test.
- The polyglot localization also benefits **SWE-bench Multilingual** (already a board) at no extra cost.
- Honest gate: even polyglot, the cascade's cheap base may resolve lower on enterprise Pro repos than on Lite — that's a
  real measurement to make, not assume. Numbers only after a verified eval run; never fabricate.
