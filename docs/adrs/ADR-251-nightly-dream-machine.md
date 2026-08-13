# ADR-251: The MetaHarness Dream Machine — a nightly, cloud-scheduled, evidence-gated evolution routine

- **Status**: Proposed — routine created in the cloud scheduler; first live run pending; ledger is created by the first run
- **Date**: 2026-08-13
- **Deciders**: ruv
- **Tags**: dream-cycle, scheduling, autonomy, flywheel, darwin-mode, redblue, evidence-discipline, promotion-gate, witness
- **Extends**: ADR-250 (SOTA-proof ladder — the honesty discipline every nightly claim must respect), ADR-248 (frozen acceptance gates), ADR-243 (mechanism-testbed-not-benchmark precedent)
- **Prior art**: the Ruflo Nightly Dream Cycle v3 (`ruvnet/ruflo`, routine cron `0 6 * * *` UTC) — this ADR ports that architecture to this repository, with the deltas listed in §2.4
- **Artifacts**: `docs/dream-cycle/PROMPT.md` (version-controlled mirror of the routine prompt), `docs/dream-cycle/LEDGER.md` (created by the first run)

---

## 1. Context

MetaHarness's thesis is "freeze the model, evolve the harness" — yet the
repository's own evolution machinery (`@metaharness/flywheel` gate/receipts/
replay, `@metaharness/darwin` bounded evolution, `@metaharness/redblue`
adversarial evaluation, the `evals-*` flywheel domain adapters, the frozen
`experiments/*` acceptance harnesses) is exercised only when a human session
happens to pick it up. There is no standing process that applies the repo's
own evaluation infrastructure to the repo itself.

The sibling project already solved this. Ruflo's Dream Cycle went through
three versions, and the v1 failure mode is the instructive part: 80 nightly
research-only runs produced genuinely good research with a 5% follow-through
rate, because every run was a stateless fresh checkout with no memory of the
79 nights before it, disconnected from the repo's own evaluation machinery.
v2 added a git-committed ledger as durable memory plus a bridge into real
evaluation; v3 made every stage mandatory:

```text
ledger → research → hypothesis → candidate → baseline → evaluation
  → adversarial critique → bounded Darwin evolution → Flywheel retention
  → witness → human-gated promotion
```

MetaHarness is arguably a *better* host for this loop than Ruflo, because
the pipeline stages map one-to-one onto packages this repo ships as
products: the Dream Cycle is the harness generator running its own genome
through its own flywheel — dogfooding as a nightly invariant.

Two environmental facts shape the design and must be stated up front:

1. **A fresh cloud checkout has no `dist/`** and the ordered build includes
   Rust/wasm/NAPI steps that may fail in a sandbox. The routine must treat a
   JS-only build as a recorded degradation, not a failure.
2. **The scheduler environment may expose no LLM credentials.** Every
   model-calling evaluation stage (darwin, redblue, live evals) then
   reports `blocked`. Early ledgers dominated by `LLM_EVAL=blocked` rows
   are the *expected* behavior of an honest routine in a credential-less
   environment — not a malfunction. Evaluated nights depend on what secrets
   the routine's environment exposes; provisioning a key is a deliberate
   human decision recorded outside this ADR.

## 2. Decision

### 2.1 What it is

A `/schedule` cloud routine — **"MetaHarness Nightly Dream Cycle"**
(`trig_01T9FVWfahfGrkK9E9eCsvyw`), cron
`0 8 * * *` UTC (staggered two hours after Ruflo's `0 6` so the two nightly
runs never contend for the same reviewer attention window) — running in a
fully isolated cloud session with a fresh checkout of `ruvnet/metaharness`,
no access to any local machine, driven by one long structured prompt.

The routine is **not** a workflow file in this repository. It lives in
Anthropic's cloud scheduler and interacts with the repo the way any
contributor does: `git` and `gh`. Grepping the repo for a generator will
come up empty by design.

### 2.2 The pipeline

The full prompt is mirrored at `docs/dream-cycle/PROMPT.md`. The stages, in
order, with their governing invariants:

| Stage | Invariant |
|---|---|
| 0 Build + control-plane discovery | probe what actually built; wasm failure ⇒ recorded degradation; check `OPENROUTER_API_KEY` presence up front |
| 1 Ledger check + learning signals | `docs/dream-cycle/LEDGER.md` is the only durable memory; re-check last 7 nights' issue/PR fates; zero merges in 14 nights biases toward small reviewable candidates |
| 2 Load accumulated evidence | ADR index + `experiments/*` verdicts + prior receipts before any external research |
| 3 Parallel research | 5 concurrent roles; every external claim graded A/B/C; 5 scored candidates, one selected, overrides explained |
| 3.3 Formal hypothesis | frozen falsifiable statement *before* evaluation; never edited after |
| 5 Testability gate | not testable tonight ⇒ research issue with explicit reason; never a fabricated benchmark |
| 6–9 Candidate + baseline + evaluation | real diff (<300 lines target); parent evaluated first on the real evaluator; candidate never touches gold answers; infrastructure failure ⇒ `blocked`, never an invented metric |
| 10–11 Adversarial critique + reward-hack check | independent critic; periodic corpus-fairness check; any unresolved signal blocks ACCEPT |
| 12 Bounded Darwin | ≤3 generations × ≤4 candidates × 1 promoted lineage; frozen fitness function; failed mutations persisted |
| 13 Evidence retention | knowledge classified OBSERVATION/MEASUREMENT/INFERENCE/HYPOTHESIS/DECISION/REJECTION; replay-verification failure demotes to research finding |
| 14 Promotion gate | **evaluation is not promotion** — ACCEPT means "recommend human review", nothing more; the session never merges |
| 16 Witness | `WITNESS = sha256(sha256(gist) + SESSION_COMMIT)`, independently verifiable in five steps |
| 17–25 Publish | public gist + labeled issue + always-**draft** PR + exactly one appended ledger row (the row survives any budget or failure stop) |
| 26 Self-review | closing checklist against every invariant; any "no" corrected or reported |

Every run ends in exactly one of `ACCEPT | REJECT | INCONCLUSIVE`. A
rejected hypothesis with a clean measurement is a successful night. The
routine optimizes for shrinking tomorrow's search space, not for PR count.

### 2.3 Surface rotation

Five slots keyed to `date % 5`, covering this repo's actual product
surfaces:

```text
0 generator-genome     (scaffolding, genome scorers, score/diag)  + router, turn-credit
1 flywheel-promotion   (gate, receipts, replay, lineage)          + evals-verticals, bench
2 darwin-evolution     (darwin-mode, SWE-bench harness, scorers)  + weight-eft, learn
3 security-adversarial (redblue, mcp-scan, threat-model)          + sbom, policy
4 host-adapters        (host-*, kernel, web-ui)                   + kernel, sdk
```

Bonus deep-dives on `% 25` / `% 75` boundaries cover vertical-packs,
meta-proxy, and federation.

### 2.4 Deltas from the Ruflo v3 design

1. **The prompt is mirrored in-repo** (`docs/dream-cycle/PROMPT.md`).
   Ruflo deliberately keeps its prompt only in the scheduler; we diverge
   because this repo's review culture runs on diffable artifacts. The
   scheduler copy is authoritative; both carry a header requiring the two
   to be updated together. A drifted mirror is a defect.
2. **Explicit build-degradation and credential-blocked modes** (§1's two
   environmental facts) are first-class recorded states with their own
   ledger vocabulary (`LLM_EVAL=blocked`, `HALT: budget`), so a reader can
   distinguish "the routine is broken" from "the environment is minimal".
3. **ADR output follows this repo's shape** — including the Test Contract
   section and the INDEX.md row — not Ruflo's 15-section STEP-19 template.
4. **Proof-ladder discipline** (ADR-250) is woven into the gist and issue
   requirements: every quantitative claim carries its rung.

### 2.5 Authority boundaries (what the routine may never do)

Never merge. Never self-promote flywheel state. Never weaken a test,
benchmark, or threshold to obtain a favorable result. Never modify gold
answers. Never force-push. Never publish packages. Darwin explores only
scoped candidate parameters under the frozen fitness function. All output
lands as draft PRs, issues, gists, and ledger rows — promotion is a human
act, every night, with no exceptions.

## 3. Consequences

- The repo's evaluation machinery gets exercised nightly instead of
  episodically, and its rough edges (unbuildable-in-sandbox packages,
  evaluators that only run credentialed) get surfaced as recorded blockers
  rather than staying invisible.
- `docs/dream-cycle/LEDGER.md` becomes an append-only public record of what
  was tried, what won, what lost, and what stalled — including the
  follow-through rate that killed Ruflo v1. If merges stay at zero for two
  weeks, the routine itself down-shifts to smaller candidates; if that
  persists, the ledger is the evidence for a human either committing review
  time or turning the routine off.
- One more standing consumer of scheduler/cloud budget, nightly. The prompt
  carries an internal budget step with a hard ceiling and a
  ledger-row-always guarantee.
- Two copies of the prompt exist (scheduler + mirror) and can drift; the
  header rule makes drift a reviewable defect but cannot mechanically
  prevent it.
- `dream-cycle`-labeled issues and draft PRs accrue and require triage;
  STALE classification (>14 days, no follow-up) is computed by the routine
  itself each night, so neglect is at least measured.

## 4. Alternatives Considered

- **GitHub Actions cron workflow in-repo.** Rejected: the routine needs an
  agentic session (parallel research subagents, gh/gist publication,
  judgment calls), not a CI step; and keeping evolution authority out of
  the repo's own CI credentials is a security feature, not a limitation.
- **Extending the Ruflo routine to also cover this repo.** Rejected: one
  routine per repository keeps the ledger, rotation, and failure signals
  per-repo legible (the one-agent-per-repo lesson), and the two repos'
  surfaces barely overlap.
- **Research-only nightly (Ruflo v1 shape).** Rejected on Ruflo's own
  measured evidence: 5% follow-through, 94% untouched output. The
  evaluation spine is the point.
- **Local nightly on a workstation (cron/systemd).** Rejected: ties the
  loop to one machine's uptime and credentials, and gives an autonomous
  routine access to a non-isolated environment. The cloud session's
  isolation *is* the containment model.
- **No mirror of the prompt in-repo (Ruflo's choice).** Rejected here;
  see §2.4 delta 1.

## 5. Test Contract

No runtime code ships in this repository for this decision; the contract is
operational and doc-level:

1. **Routine exists**: a cloud scheduler routine named "MetaHarness Nightly
   Dream Cycle" with cron `0 8 * * *` UTC, whose prompt matches
   `docs/dream-cycle/PROMPT.md` (mirror-parity is checked by eyeball at
   review time and re-checked whenever either copy changes).
2. **First-run acceptance**: the first live run must (a) create
   `docs/dream-cycle/LEDGER.md` with the schema header, (b) append exactly
   one row, (c) end with the mandated final-line format, and (d) reach a
   verdict in `{ACCEPT, REJECT, INCONCLUSIVE}` — `INCONCLUSIVE` with
   `LLM_EVAL=blocked` counts as passing.
3. **Ledger schema stability**: every subsequent run appends exactly one
   row to the same 10-column schema; a schema change requires updating this
   ADR and the prompt together.
4. **Standing invariant check**: no commit authored by the routine may ever
   appear on `main` directly (draft-PR-only is auditable from the ledger's
   PR column and branch protection).

If, after 14 live runs, the ledger shows the v1 pathology (″>90% untouched
output″), this ADR's Status moves to `Needs-revision` and the routine is
paused pending a redesign — the ledger is the tripwire.

## 6. References

- Ruflo Dream Cycle v3 tutorial + prompt: gist `ruvnet/889ffa92dab49d508e70b123c940e1b9`
  (`dream-machine-tutorial.md`, `x-claude-prompt.md`)
- Ruflo ledger: `ruvnet/ruflo` → `docs/dream-cycle/LEDGER.md`; issues
  labeled `dream-cycle`
- ADR-250 (SOTA-proof ladder), ADR-248 (turn-credit acceptance gate),
  ADR-243 (mechanism testbed precedent) — the local honesty discipline the
  routine inherits
- `experiments/turn-credit-acceptance`, `experiments/signal-flywheel`,
  `experiments/router-calibration-loop` — the frozen evaluators available
  to credential-less nights
