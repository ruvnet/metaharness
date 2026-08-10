# credit-feedback replay — does credit-weighted retrieval feedback beat uniform feedback?

**The claim under test.** `@metaharness/turn-credit`'s `toMemoryFeedback` emits
one `{retrievedIds, resolved, weight}` record per retrieval-bearing turn, with
`weight` = that turn's bounded credit multiplier `m_k ∈ [0.75, 1.25]` (paper
defaults) instead of the uniform `weight = 1`. The claim: when turn-level
evidence genuinely separates helpful retrievals from useless ones, feeding
those weights back into a retrieval index improves subsequent retrieval of the
genuinely-helpful skills — and uniform feedback structurally *cannot*, because
it rewards every retrieved item of a resolved trajectory identically.

This is a **seeded, deterministic, $0 replay** — no network, no model calls,
no wall-clock or unseeded randomness anywhere.

## Design

- **Skill index.** 10 query pools per seed, each with 2 genuinely-helpful
  skills and 6 distractors. Retrieval ranks a pool by
  `base + 0.05 · accumulatedFeedback` (ties broken by id). Base relevance is
  drawn so distractors sit slightly *above* helpful skills
  (distractor base ∈ U(0.45, 0.60) vs helpful ∈ U(0.40, 0.55)) — the
  deliberate hard case the feedback has to fix.
- **Synthetic trajectories.** 3 seeds (101, 202, 303) × 120 trajectories.
  Each trajectory visits its pool's 8 skills in a seeded random permutation —
  one retrieval per turn, so **helpful and distractor skills are retrieved
  exactly equally often**. Helpful turns carry a positive verifier-score delta
  (per-trajectory strength ∈ U(0.10, 0.45), ± 0.05 noise); distractor turns
  carry ~zero (± 0.05 noise). A trajectory resolves iff its summed raw delta
  exceeds 0.35 (measured resolve rate ≈ 0.764, so the failure path — where
  credit *shrinks* the penalty on helpful turns — is exercised too).
- **Processing.** Each trajectory goes through `processTrajectory` (mode
  `'verifier-delta-proxy'`, prior 0.5, `PAPER_DEFAULTS`, evidence from
  `evidenceFromScorePairs` at scale 2). The **credit arm** applies
  `toMemoryFeedback`'s records as-is (`accum[id] += (resolved ? +1 : −1) · m_k`);
  the **uniform arm** applies the *same* records with `weight = 1`. Nothing
  else differs between arms.
- **Measurement.** A held-out retrieval pass per pool after all feedback:
  hit@1 (top-1 is helpful), hit@3 (any helpful in top-3), recall@3 (fraction
  of the 2 helpful skills inside the top-3), averaged over the 10 pools.

## Measured results (these exact numbers reproduce byte-for-byte)

```
seed   arm          hit@1     hit@3  recall@3
101    uniform   0.000000  0.100000  0.050000
101    credit    1.000000  1.000000  1.000000
202    uniform   0.100000  0.400000  0.200000
202    credit    1.000000  1.000000  1.000000
303    uniform   0.000000  0.200000  0.100000
303    credit    1.000000  1.000000  1.000000
mean   uniform   0.033333  0.233333  0.116667
mean   credit    1.000000  1.000000  1.000000

mean trajectory success rate: 0.763889
```

Diagnostic (seed 101): mean *signed* credit weight ≈ **0.80** on helpful-skill
turns vs ≈ **0.41** on distractor turns — that per-record gap, compounded over
12 records per skill, is what flips the rankings.

## Honest bounds — read before quoting these numbers

- **The construction favors the mechanism by design.** Helpful skills carry
  higher per-turn evidence *because we wrote the generator that way*, and equal
  retrieval frequency makes the uniform arm exactly **rank-inert** within a
  pool (every pool member accrues identical uniform feedback, so uniform ==
  the base-score ranking). The saturated credit-arm 1.000000 therefore says
  "the plumbing separates skills when turn-level evidence is real and the
  signal is strong", not "credit weighting wins on real corpora". This is a
  **mechanism testbed, not a benchmark claim.**
- **Proxy evidence mode.** `verifier-delta-proxy` is the EXPERIMENTAL stand-in,
  not AgentOPSD's log-prob gap; magnitudes are ordinal.
- **A null would have been reported as a null.** Had the credit arm matched or
  trailed uniform, that table would appear here unchanged — the design was
  frozen (lib.mjs `CONFIG`) before the first run and not tuned afterward.
- What a *real* test needs: recorded trajectories with real teacher score
  pairs, retrieval frequency imbalance, and evidence noise not chosen by the
  experimenter. This harness gives that test its plumbing and its
  determinism gate, nothing more.

## Run it

```bash
node experiments/credit-feedback/run.mjs          # prints the table above, exits 0
node experiments/credit-feedback/run.mjs --check  # + re-runs all seeds, non-zero exit on any drift
node experiments/credit-feedback/assert.mjs       # determinism gate + m_k ∈ [0.75, 1.25] invariant
```
