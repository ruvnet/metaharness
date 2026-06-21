# Darwin Mode — autonomous loop worker directive

The standing directive for the cron-fired autonomous loop (`/loop` / ruflo loop-worker). This file is
the **versioned source of truth** for what each tick should do; paste it (or its current "active
phase") as the loop prompt. Updated 2026-06-21 for the **ADR-169 phase**.

## Phase status

- **Phase A — SWE-bench arc: COMPLETE + shipped.** Verified ladder 7.7% → 15.3% → 29.3% → 40.3% →
  **58.3%** (3-tier, ADR-154, reproduced); agentic loop 31.3% (ADR-153); $0 local 6.7% (ADR-150).
  All on main, npm `@metaharness/darwin@0.3.x` + `@metaharness/projects@0.1.x`, PR cycle merged, CI green.
- **Phase B — ADR-169 self-learning / WASM memory: cores IMPLEMENTED ($0), paid eval GATED on budget.**
  Patch memory (E3), difficulty router (E2), agentic anti-thrash (E4) are shipped + unit-tested.

## Each tick

1. **HEALTH** — prune exited docker + `/tmp/sbrepo-*` >30min; `docker kill` any `sweb.eval` container
   >12min (psf__requests-2317 hangs, see KNOWN_FLAKY.md); restart ollama if `unshare`/api wedged; warn
   if disk<50G or RAM<10G.
2. **BENCHMARK** — if a solve/eval is running, check it; on completion → official batch eval →
   resolve-rate + Wilson CI → commit. **Only batch-eval numbers are authoritative** (in-loop drifts
   1.5–5×). Never fabricate.
3. **REPO UPKEEP** — keep branch + main in sync (push both); keep the open PR green + mergeable (fix CI
   reds — common classes: `path-guard` /tmp in shipped code, `cargo-deny` wildcard path deps, version-
   coherence allowlist for independently-versioned packages, CI-only flaky timing/sandbox e2e →
   `skipIf(process.env.CI)`); triage new GitHub issues; keep RESULTS/LEARNINGS/#39/gist current.
4. **PUBLISH** — when a result materially changes the package story, bump + publish to npm (CHANGELOG +
   description + README), verify live. **Any independently-versioned package bump must be added to the
   `scripts/healthcheck.mjs` INDEPENDENT allowlist in the SAME commit** (lesson: bit darwin + projects).
5. **ADRs** — advance the highest-value ADR; prefer FREE ($0 local / offline) work.

## Active levers (ADR-169) — run paid ones when OpenRouter budget is available

| id | what | $ | status |
|----|------|---|--------|
| E1 | full-300 agentic on deepseek-v4-pro (untruncated) | ~$50 | **gated on budget** — biggest lever; also yields the trajectory dataset |
| E3 | patch-memory RAG eval (`solve-repair.mjs --patch-memory patch-memory-corpus.json`) | ~$120 | core SHIPPED ($0, BM25 + gated hybrid); eval gated on budget |
| E5 | agentic + Scholar hybrid on E1's tail | ~$150 | gated on budget; projects 42–50% |
| E2 | difficulty-router-gated escalation (`difficulty-router.mjs`) | ~$80 | core SHIPPED ($0, scalar+L2); train+eval gated on budget |
| E4 | extended agentic step budget (max-30) with anti-thrash | included | anti-thrash SHIPPED ($0) |

**Stop condition:** when the OpenRouter budget is exhausted AND no $0 lever remains, idle on health +
PR/issue watch (this is the current state — paid budget exhausted at ~$497.55/$500; E2/E3/E4 cores done
at $0). Resume paid levers (E1 first — it unblocks the rest) on a budget top-up.

See `docs/research/2026-06-21-self-learning-wasm-memory-escalator.md` (full plan) and
`docs/adrs/ADR-169-self-learning-wasm-memory-escalator.md` (implementation).
