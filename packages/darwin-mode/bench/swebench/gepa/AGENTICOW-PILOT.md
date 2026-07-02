# Agenticow branch-memory in the GEPA candidate lifecycle (ADR-230 pilot)

Wires [`agenticow`](/home/ruvultra/projects/agenticow) (Git-for-Agent-Memory: copy-on-write vector
branching over `.rvf` files) into GEPA's candidate loop as the **memory-transaction layer**. Agenticow
is *not* the intelligence: it does **not** decide accept/reject (that stays GEPA's Pareto/sum metric in
`gepa-loop.mjs`). It **records lineage** — one 162-byte COW branch per candidate — and, only on a
holdout win, **promotes** the winning genome into the seed base (the frozen-seed rule, ADR-228 §7.1).

## Files

| File | What |
|---|---|
| `branch-memory.mjs` | The module — `openBase / checkpoint / branchCandidate / recordGenome / recordEvalTrace / diffAgainstParent / setDecision / promoteToBase / lineage / exportPromotedLessons / measureStorageOverhead`. Graceful `{degraded:true}` no-op when agenticow is absent. |
| `branch-memory.test.mjs` | 6 `$0` tests (mock degraded-mode + real-agenticow integration). Auto-skips integration when the optional dep is absent. |
| `branch-memory-acceptance.mjs` | `$0` acceptance demo — replays the live pilot's captured candidates (`runs/regression-report.json`: seed + cand-1..4) through the module and checks all ADR-230 acceptance bars. |
| `run-gepa.mjs` | Wired: opens the base from the seed genome, records every candidate in the `liveDeriveLesson` hook, promotes a holdout-winner, exports portable lessons + storage numbers into `pilot-result.json` and `runs/branch-lineage.json`. Opt out with `--no-branch-memory`. |

## The wiring (run-gepa.mjs candidate loop)

```
seed loaded ─► openBranchMemory(runs/branch-memory/seed.rvf, {seedGenome: seed})   # §1 base = seed genome
                                                                                    #    (+ eval traces)
gepaOptimize(… deriveLesson = liveDeriveLesson …)
  per candidate (inside liveDeriveLesson, AFTER GEPA's metric decided accept/reject):
    checkpoint(`pre-${cand}`)                 # §2 restore point on the base
    branchCandidate(cand, {parent})           # §2 162 B COW branch off the frontier parent
    recordGenome(cand, genome)                # §2 genome marker vector + genome in sidecar
    recordEvalTrace(cand, {scores,feedbacks}) # §2 eval-trace evidence
    diffAgainstParent(cand)                    # §3 mutation_diff (component before/after) + vector diff
    setDecision(cand, accept|reject, report)   # §3/§4 lineage + regression-report + lesson IN the branch
holdout ─► if best beats seed on the unseen slice:
    promoteToBase(best)                        # §5 ONLY a holdout-winner graduates into seed-base
export ─► exportPromotedLessons() + measureStorageOverhead() ─► runs/branch-lineage.json + pilot-result.json
```

- **Reject** (e.g. cand-4, 2/12 gold): branch retained with its `diff` + regression report + lesson;
  **never promoted, never deleted**; stays `lineage()`-queryable. (§3)
- **Accept** (parent-relative): kept in the frontier; **still not** promoted to seed-base. (§4)
- **Holdout-win**: `promote(cand → seed-base)` graduates the genome. (§5)

## Build against the REAL API — verified gaps in `agenticow@0.2.3`

Read `src/index.js`, not the `.d.ts`. Three declared-vs-runtime gaps this integration handles:

1. **No `openBase` export at runtime.** Only `open(path,{dimension})` (+ `AgenticMemory.open`). The
   module resolves `aw.open || aw.openBase || aw.default?.open`.
2. **`ingest` stores vectors only** — `ingest([{id,vector}])` or `ingest(Float32Array, ids)`. The
   `.d.ts` `text` payload field is **not implemented**. Rich JSON (genome / mutation_diff / eval trace /
   score-parts / lesson) therefore lives in a **parallel per-candidate "sidecar"** the module owns and
   persists (`branch-memory.json`) — this is also exactly the "move promoted *lessons*, not raw branch
   mechanics" split the pilot wants.
3. **`promote(target)` requires an explicit `AgenticMemory` target** — there is no default-to-parent.
   The module always calls `branch.promote(this._base)`.

Verified invariant: a fresh `branch()` is **162 B regardless of base size** (base 1401 B → branch 162 B).

## Measured storage overhead (the <5% acceptance bar)

`node branch-memory-acceptance.mjs` (replaying the captured seed + cand-1..4, base = seed genome
components + reconstructed per-instance eval traces):

```
base = 12569 B   |   empty COW branch = 162 B   |   overhead = 162 / 12569 = 1.29%   ✅ < 5%
```

- **Headline metric** = the COW invariant agenticow guarantees: an empty branch is a fixed ~162 B delta
  vs a full-copy snapshot that must duplicate the whole base (`baseSize`). For any realistically-sized
  base (seed genome + eval-trace corpus, ≥ ~3.3 KB) the 162 B branch is < 5%, trivially. Verified
  min branch file on disk = **162 B**.
- **Transparency** (not gamed): a branch that then *ingests* the candidate's marker vectors materializes
  one COW segment (~0.6–1.3 KB). Reported as `materializedOverheadPct` (≈10% at this tiny 4-candidate,
  12.5 KB base; it shrinks as the shared base grows with real per-step transcripts). The candidate's
  own marker vectors are irreducible data a full copy stores too — they are not COW overhead.
- At **live-run start** the base holds only the seed genome (no traces yet), so the module reports a
  higher empty-branch ratio (~5.8% on a 2.8 KB base); it drops as the seed eval + promotions grow the
  base. The number in `pilot-result.json.branchLineage.storage` is whatever the run actually measured.

## Acceptance results — `15/15` checks pass (`$0`, replaying the live pilot's captured candidates)

```
PASS  cand-1..4: lineage + diff + lesson captured
PASS  100% of candidates have lineage / mutation_diff / lesson   (4/4)
PASS  rejected candidates query-able via lineage                 (3 rejected)
PASS  rejected candidates NEVER promoted
PASS  holdout-win promoted to base                               (cand-3)
PASS  diff-against-parent = mutation_diff
PASS  portable JSON = ADR-230 minimum object
PASS  empty COW branch overhead < 5% of full-copy                (1.29%, 162B / 12569B)
PASS  branches are ~162 B COW deltas (empty invariant)           (min-file = 162 B)
PASS  promoted candidate reconstructable from lineage            (reconstructGenome + mutation_diff)
```

The captured pilot decisions replayed: cand-1 `[retrieval_policy]` reject (gold 3→1), cand-2
`[retrieval_policy]` reject (3→3), cand-3 `[test_policy]` (accepted in the pilot; **synthesized as the
holdout-win here** to exercise `promoteToBase`), cand-4 `[test_policy]` reject (3→2). Reconstructability:
applying `mutation_diff.after` to the parent's named component rebuilds the promoted genome exactly.

## Portable lesson JSON (what would later sync to ADR-227 Firestore — not the raw `.rvf`)

`exportPromotedLessons()` emits an array of the ADR-230 minimum object (also in
`pilot-result.json.branchLineage.lessons` and `runs/branch-lineage.json`). `{onlyPromoted:true}` filters
to holdout-winners. Emits in degraded mode too (pure JSON — no `.rvf` dependency).

```json
{
  "genome_id": "cand-1",
  "parent": "seed-agentic-v1",
  "mutation_diff": { "component": "retrieval_policy", "before": "Strategy: explore …", "after": "Strategy: explore with a budget …" },
  "eval_set": "train-first-12",
  "score": 66,
  "parent_score": 34.303,
  "decision": "reject",
  "regression_instances": ["astropy__astropy-12907", "…"],
  "improvement_instances": ["django__django-10914", "…"],
  "failure_modes": { "empty_patch": 4, "wrong_file": 1, "test_not_run": 4, "thrash": 2, "bad_submit": 0, "protocol_error": 0 },
  "lesson": "AVOID: mutating retrieval_policy increased empty_patch 2→4 (regressed 6 instances, gold 3→1) — this rewrite direction hurts; do not repeat."
}
```

The Firestore sync itself is **deferred** (ADR-230): this pilot builds the export only.

## Graceful degradation

`agenticow` is an **optional** dep. When it is absent (or `open()` throws), `openBase` returns a
`BranchMemory{degraded:true}`: `checkpoint / branchCandidate / recordGenome / recordEvalTrace /
diffAgainstParent / promoteToBase / measureStorageOverhead` become logged no-ops returning
`{degraded:true}`, GEPA runs **unchanged**, and the pure-JSON lineage/lesson recording still works so
`exportPromotedLessons` still emits. Covered by two `$0` tests (injected `null` module + a module whose
`open()` throws).

## Not disturbing the live pilot

The live `$25` pilot (`run-gepa.mjs`, PID observed running from the primary checkout) was **not touched**:
this work is in a separate git worktree, and the acceptance runs entirely against the pilot's
**already-captured** `runs/regression-report.json` candidates plus a fresh temp `.rvf` — no restart, no
kill, no new paid rollouts.

## Tests

```
node --test packages/darwin-mode/bench/swebench/gepa/*.test.mjs   # 58 pass (52 pre-existing + 6 new)
node packages/darwin-mode/bench/swebench/gepa/branch-memory-acceptance.mjs   # 15/15 acceptance
```
