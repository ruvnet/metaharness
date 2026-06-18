# Darwin Mode — Performance & Bounds Validation

Scope: validate and measure the performance/safety bounds claimed for the
evolution loop. Tests live in `packages/darwin-mode/__tests__/perf/` and touch
nothing under `src/`.

Run: `npx vitest run packages/darwin-mode/__tests__/perf`

## 1. Bounded concurrency actually overlaps work (`concurrency.perf.test.ts`)

`evolve` evaluates a generation's children with `mapLimit(children, concurrency, …)`
(`src/evolve.ts:149`). The test drives the **real `evolve`** over a fixture repo
whose `scripts.test` is a ~120 ms sleep (`node -e "setTimeout(()=>{},120)"`),
resolved by the profiler to `npm test` and run once per variant by the sandbox.

It times one generation of 4 children at `concurrency=1` (sequential lower
bound) vs `concurrency=4`, and asserts `con < seq × 0.7`.

Measured (3 runs, this machine):

| run | seq (C=1) | con (C=4) | ratio |
|-----|-----------|-----------|-------|
| 1   | 1978 ms   | 869 ms    | 0.44  |
| 2   | 1465 ms   | 608 ms    | 0.42  |
| 3   | 1615 ms   | 594 ms    | 0.37  |

Ratio ≈ **0.37–0.44** (≈ 2.3–2.7× speedup), well under the 0.7 ceiling and
stable across runs. The ideal for 4 children at width 4 is ~0.25× of the child
phase; the residual is the serial baseline evaluation (present in both runs) plus
per-variant `npm` startup. Conclusion: concurrency is real and bounded.

## 2. `mapLimit` width bound + order (`mapLimit.test.ts`)

`mapLimit` is **not exported** from `src/evolve.ts`, and `src/` must not change,
so the invariants are checked two ways:

- **Unit (algorithm):** a verbatim copy of `src/evolve.ts`'s `mapLimit` is driven
  with an in-flight counter test double. With 13 items at limit 4 the observed
  max in-flight is exactly 4 (saturates, never exceeds), and results come back in
  input order (`results[i] === fn(items[i])`). Width also clamps to item count
  when `limit > items`.
- **End-to-end (real path):** `evolve` runs 6 children at `concurrency=3` against
  a `marker.cjs` testCommand that appends begin/end timestamps around an ~80 ms
  sleep. Replaying the markers, observed max overlap = **3**, i.e. `1 < overlap ≤
  concurrency` — real overlap, never exceeding the configured width.

> Note for the orchestrator: exporting `mapLimit` (or a `__test__` re-export)
> would let the width bound be asserted on the primitive directly rather than
> inferred from sandbox markers. Not required for correctness.

## 3. Resource bounds hold (`bounds.perf.test.ts`)

- **File size cap (256 KiB):** an oversized approved file whose bytes contain a
  blocked pattern (`process.env`) yields a `too large (… > 262144 bytes)` finding
  and **no content finding** — proving `inspectVariant` short-circuits on
  `stat.size > MAX_FILE_BYTES` and `continue`s **without reading** the file
  (`src/safety.ts:159-162`). It never pulls an oversized file into memory.
- **File count cap (MAX_FILES = 32):** a 33-entry directory is flagged
  `too many entries (33 > 32)` (`src/safety.ts:120`).
- **`maxBuffer`:** a command that floods ~5 MB to stdout under a 64 KiB
  `maxBufferBytes` is bounded — `execFile` aborts (ENOBUFS), the call **never
  throws**, returns a non-zero trace (exitCode 1), terminates in ~60 ms (no hang
  to the 15 s timeout, no OOM), and captured `stdout` is held to the 64 KiB cap.
  Measured: `elapsed≈60 ms, exitCode=1, stdoutBytes=65536`.

Also confirmed by the existing `sandbox.test.ts` suite (not re-tested here):
**scrubbed env** (only `PATH` + 3 identifying vars; ambient `process.env` does not
leak), **timeout** wall-clock budget, and **gate-first** disqualification
(exitCode 99 before any command runs).

## Big-O of the hot paths

- `inspectVariant(dir)` — **O(files × patterns + total bytes)**. Per entry: one
  `lstat`, an allowlist `Set.has` (O(1)), a scan over the fixed blocked-filename
  list, and (only if within the size cap) a `readFile` plus a fixed set of regex
  tests over the content. Files and pattern sets are both hard-capped (≤32 files,
  ≤256 KiB each, constant pattern counts), so each call is bounded by a small
  constant — it cannot blow up on a pathological variant.
- `evolve` — **O(generations × parents × childrenPerGeneration)** variant
  evaluations, each = `tasks` sandbox runs. Children per generation =
  `parents × childrenPerGeneration`; parents ≤ 2 on a stalled generation
  (`archive.selectParents(2)`) or the promoted set. Wall-clock per generation is
  divided by `concurrency` (the `mapLimit` width), bounded by `costBudgetSeconds`
  when set. Commit is a single serial writer pass — O(children) I/O, no fan-out.

## Optimization recommendation

**None needed — already bounded.** The concurrency width, per-generation cost
breaker, file size/count caps, `maxBuffer`, timeout, and scrubbed env are all
real and enforced in code, and the hot paths are constant- or
linearly-bounded with no unbounded fan-out or quadratic scans.

Optional, low-value (do **not** apply unless desired):
- `inspectVariant` reads each file with `readFile(full, 'utf8')` then runs ~17
  regexes over the whole string. Files are already capped at 256 KiB, so this is
  bounded; no change recommended.
- Exporting `mapLimit` would simplify the width-bound test (see §2 note); a
  test-ergonomics improvement only, not a performance change.
