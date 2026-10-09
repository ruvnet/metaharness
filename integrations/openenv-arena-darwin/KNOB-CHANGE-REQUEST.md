# Knob change request: bounded difficulty knobs for Darwin environment search

- **To:** the owner of `integrations/openenv-arena` (v2 worktree `projects/metaharness-arena-v2`, HEAD `4657e5b8`)
- **From:** the `integrations/openenv-arena-darwin` lane
- **Status:** this is a request only. Nothing under `integrations/openenv-arena/**` was edited.
- **Measurements:** all numbers were measured on 2026-10-08 with a scratch replica of the v2 generators. §8 describes the method and lists what remains unverified.

## 0. The ask

Expose every difficulty-coupled generator literal as a named, bounded integer **knob** that can be addressed from the task_id, for example `math_route-d2.slack0.win5`. Then accept that full task_id in `environment.reset` and `scripts/calibrate.py`.

The knobs follow four rules:

- **Defaults replay v2 bit for bit.** Plain `family` and `family-dN` IDs keep producing today's exact instances, so existing evidence stays valid.
- **New trap knobs default to 0.** At 0 they consume no RNG draws.
- **Validation is strict.** A wrong ID raises an error and is never silently normalized.
- **One spelling per configuration.**

Darwin then mutates one knob at a time and scores each variant on the real model. The Flywheel gate promotes only measured wins.

## 1. Why: v2 calibration snapshot

The run used Qwen3.8-27B (`qwen38@1d4bf0f2`) with arena accounting: completion budget 8192, context 16384, 4 attempts per cell, 64 episodes in total.

| cell | rewards | read-* obs tok | gen tok (mean) | failure |
|---|---|---|---|---|
| software_change d2 | 1 1 1 1 | 672 | 3794 | saturated |
| software_change d3 | .5 1 1 0 | 815 | 6096 | 1 reasoning (missed a transitive consumer) + 1 `completion_truncated` |
| industrial_schedule d2 | 0 0 0 0 | 388 | 7803 | 4/4 `completion_truncated` |
| industrial_schedule d3 | 0 0 0 0 | 469 | 7722 | 4/4 `completion_truncated` |
| science_calibration d2 | 1 .75 .75 .75 | 587 | 3073 | 3/3 omit quarantined samples from `medians` (see §6.1) |
| science_calibration d3 | .75 .75 1 .5 | 667 | 5171 | 2 omit quarantined; 1 genuine (`medians` + `accepted_mean`) |
| office_reconciliation d2 | 1 1 1 1 | 1460 | 2628 | saturated |
| office_reconciliation d3 | 1 .5 1 1 | 1777 | 2971 | reasoning (`contacts` provenance) |
| finance_ledger d2 | 1 1 1 1 | 1105 | 3038 | saturated |
| finance_ledger d3 | 1 .5 1 1 | 1303 | 2416 | reasoning (missed an applied reversal) |
| math_route d2 | 1 1 0 1 | 889 | 3976 | `completion_truncated` |
| math_route d3 | 1 .67 1 1 | 1168 | 4742 | reasoning (`exposure` off by one) |
| security_triage d2 | 1 1 1 1 | 1439 | 4249 | saturated |
| security_triage d3 | 1 1 1 1 | 1718 | 4709 | saturated |
| media_timeline d2 | 1 1 1 1 | 921 | 3713 | saturated |
| media_timeline d3 | 0 1 1 1 | 1096 | 5010 | `completion_truncated` |

Failures were attributed by regenerating each task with `make_task` and diffing the submitted answer against `expected`, component by component.

What the snapshot shows:

- **8 of 16 cells carry zero GRPO signal.** Six are saturated and two always truncate.
- **Size is not what produces reasoning failures.** The genuine reasoning failures are trap-shaped: a missed transitive consumer, a provenance tie-break, a missed reversal, an off-by-one total. Making instances bigger mainly adds tokens, and running out of tokens is the failure we are trying to remove.

**Observation tax.** In arena accounting, the observations that follow reset count against the per-episode completion budget (`calibrate.py`: `generation_used + observation_used <= completion_tokens`).

- The `read *` observation costs 370–1,460 tokens at d2. My replica counts match calibrate's `post_reset_observation_tokens` to within the roughly 35-token terminal observation.
- The final answer also comes out of the same budget. At the all-max corners in §2 it reaches up to 66–321 tokens, depending on the family.
- So a knob that adds X observation tokens is equivalent to cutting the token budget by X.

## 2. Per family: current difficulty parameters and proposed knobs

How to read the tables:

- **Tier A** knobs change trap density and move observation tokens by at most about 60.
- **Tier B** knobs change size, so they move both observation tokens and reasoning length.
- **Tier C** knobs are cosmetic.
- "obs @min / @max" is the mean `read *` observation, in tokens, with that one knob at its bound and every other knob at the d2 default. This is the same one-knob mutation that Darwin makes. Each figure uses 40 seeds.
- "Corners" are all knobs at min and all knobs at max.

Bounds checked at every corner:

- Generation time ≤ 0.48 s.
- Oracle equals `expected` and `grade == 1.0` on every instance.
- Total file bytes ≤ 4,056, against the 14,000 test limit.

Literals marked *fixed* are deliberately left un-knobbed.

**Fault positions have no knob, on purpose.** Since v2 they are drawn uniformly for each seed (see `test_fault_positions_and_counts_are_not_fixed_templates`). What Darwin can usefully change is how many faults there are and how dense the traps are: `faultpct`, `unres`, `chain`, `edge`, `costmax`, `tlate`, `slack`, and so on.

### 2.1 software_change: d2 obs 658 tok (range 589–742), answer ≤ 99

| v2 parameter | v2 code | d1 | d2 | d3 | knob |
|---|---|---|---|---|---|
| modules | `4 + 2*d` | 6 | 8 | 10 | `modules` |
| deps per module | `randint(1, 3)`, capped by index | 1–3 | 1–3 | 1–3 | `deps` (upper bound) |
| changed modules | `d`, drawn from the first n//2 | 1 | 2 | 3 | `changed` |
| regular suites | `5 + d` | 6 | 7 | 8 | `suites` |
| targets per suite | `randint(1, min(4, d+2))` | 1–3 | 1–4 | 1–4 | `targets` (upper bound) |
| suite cost | `randint(2, 10)` | 2–10 | 2–10 | 2–10 | `costmax` |
| 2 fallback suites | cost `12 + d` | 13 | 14 | 15 | *fixed* (stays d-coupled) |

| knob | tier | min | max | default (d2) | d1 / d3 | obs @min / @max | measured effect |
|---|---|---|---|---|---|---|---|
| modules | B | 5 | 14 | 8 | 6 / 10 | 556 / 852 | |
| deps | A | 1 | 4 | 3 | 3 / 3 | 610 / 674 | transitive consumers 2.3 / 3.5 / 4.0 at 1 / 3 / 4 |
| changed | B | 1 | 5 | 2 | 1 / 3 | 649 / needs modules ≥ 10 | |
| suites | B | 3 | 10 | 7 | 6 / 8 | 489 / 785 | generation 0.15 s at 10 (2^12 cover subsets) |
| targets | B | 1 | 6 | 4 | 3 / 4 | 575 / 717 | |
| costmax | A | 3 | 10 | 10 | 10 / 10 | 656 / 658 | P(≥2 minimum-cost covers) 0.41 at 3, 0.08 at 10 |

- **Rules:** `changed <= floor(modules/2)` and `targets <= modules`.
- **Corners:** all-min 322 tokens. All-max 1,127 tokens (range 976–1,224), 1,446 bytes, answer ≤ 169 tokens.

### 2.2 industrial_schedule: d2 obs 376 tok (range 335–413)

| v2 parameter | v2 code | d1 | d2 | d3 | knob |
|---|---|---|---|---|---|
| jobs | `4 + d` | 5 | 6 | 7 | `jobs` |
| precedence probability per pair | `0.12*d` | .12 | .24 | .36 | `prec` (percent) |
| due | `randint(9, 30)` | 9–30 | 9–30 | 9–30 | `duemax` |
| duration / release / weight | `randint(2,8)` / `(0,8)` / `(1,5)` | | | | *fixed* |
| blackout | `[randint(7,11), randint(14,18)]` | | | | *fixed* |

| knob | tier | min | max | default | d1 / d3 | obs @min / @max | measured effect |
|---|---|---|---|---|---|---|---|
| jobs | B | 3 | 8 | 6 | 5 / 7 | 212 / 495 | mean feasible orders 3.8 / 10.6 / 35 / 105 / 494 at jobs 3 / 4 / 5 / 6 / 7 (prec 24) |
| prec | B | 0 | 60 | 24 | 12 / 36 | 323 / 458 | feasible orders 720 / 105 / 9.9 at 0 / 24 / 60 (jobs 6) |
| duemax | A | 12 | 40 | 30 | 30 / 30 | 371 / 372 | tighter due dates create more tardiness trade-offs |

- **Why `jobs` stops at 8:** the generator expands every feasible prefix, and `prec 0` is the worst case.
  - jobs 8: 0.48 s.
  - jobs 9: 3.4 s and 601 MB RSS, with an oracle time of 0.86 s (the oracle checks all n! permutations).
  - jobs 10: extrapolates to roughly 10× that, which exceeds the 2 GiB `memory_gib` default.
- **Corners:** all-min 200 tokens. All-max 652 tokens (range 568–719).
- **Evidence:** 8 of 8 v2 episodes truncated at jobs 6 and 7 while generating about 7.8k of 8,192 tokens. The model brute-forces orders, so this family needs a smaller search (jobs 4–5, or a higher `prec`), not just a bigger budget.

### 2.3 science_calibration: d2 obs 533 tok (range 508–553)

| v2 parameter | v2 code | d1 | d2 | d3 | knob |
|---|---|---|---|---|---|
| samples | `4 + 2*d` | 6 | 8 | 10 | `samples` |
| replicates | `3 if d == 1 else 5` | 3 | 5 | 5 | `reps` |
| faulty samples | `randint(1, n-2)` | 1–4 | 1–6 | 1–8 | `faultpct`: `randint(1, max(1, (n-2)*pct//100))` |
| fault mode | `random() < .5` chooses span outlier or +20 shift | | | | *fixed* |
| weights | `randint(1, 2+d)` | 1–3 | 1–4 | 1–5 | `wmax` |
| max_replicate_span | `randint(6, 9)` | | | | *fixed* (it limits `reps`) |
| boundary samples | none | 0 | 0 | 0 | `edge` (**new**) |

| knob | tier | min | max | default | d1 / d3 | obs @min / @max | measured effect |
|---|---|---|---|---|---|---|---|
| samples | B | 4 | 14 | 8 | 6 / 10 | 341 / 820 | |
| reps | B | 3 | 7 | 5 | 3 / 5 | 476 / 588 | must be odd |
| faultpct | A | 10 | 100 | 100 | 100 / 100 | 531 / 533 | quarantine share 0.125 at 10, 0.414 at 100 |
| wmax | A | 1 | 9 | 4 | 3 / 5 | 533 / 532 | larger weighted-mean fractions |
| edge | A | 0 | 3 | 0 | 0 / 0 | 533 / 532 | accepted samples placed exactly on a boundary |

**`edge` semantics.** Pick `min(edge, #non-faulty)` non-faulty samples. Turn each one into exactly one of these cases:

- corrected median exactly 15;
- corrected median exactly 35;
- replicate span exactly `max_replicate_span`.

All three are ACCEPTED under the existing wording ("inclusive interval", "exceeds"), so no prompt change is needed. The knob makes no RNG draws when it is 0.

- **Rules:** `reps` must be odd. `reps <= 7`, because a good sample's span (`reps - 1`) must stay at or below the smallest possible `max_replicate_span`, which is 6.
- **Corners:** all-min 313 tokens. All-max (reps 7) 915 tokens (range 860–964), answer ≤ 263 tokens.

### 2.4 office_reconciliation: d2 obs 1421 tok (range 1418–1424)

| v2 parameter | v2 code | d1 | d2 | d3 | knob |
|---|---|---|---|---|---|
| people | `3 + d` | 4 | 5 | 6 | `people` |
| change rows | `6 + 3*d` | 9 | 12 | 15 | `rows` |
| unresolved rows | exactly 1 (`randrange`) | 1 | 1 | 1 | `unres` |
| timestamps | `randint(100, 103)` | | | | `tspan`: `randint(100, 99+tspan)` |
| alias depth | one alias per person | | | | `chain` (**new**) |
| phone field present | `i % 3 != 0` | | | | *fixed* |

| knob | tier | min | max | default | d1 / d3 | obs @min / @max | measured effect |
|---|---|---|---|---|---|---|---|
| people | B | 3 | 8 | 5 | 4 / 6 | 1279 / 1634 | |
| rows | B | 6 | 21 | 12 | 9 / 15 | 934 / 2152 | about 80 tokens per row |
| unres | A | 1 | 4 | 1 | 1 / 1 | 1421 / 1417 | |
| tspan | A | 1 | 8 | 4 | 4 / 4 | 1421 / 1421 | share of multi-update groups decided by tie-break: 1.0 / 0.32 / 0.16 at 1 / 4 / 8 |
| chain | A | 0 | 3 | 0 | 0 / 0 | 1421 / 1461 | alias-of-alias rows become unresolved |

**`chain` semantics.** Pick `chain` rows that are not already unresolved. Give each row the email `relayP@example.invalid` and add the alias `relayP -> legacyP`, where `legacyP` is itself an alias rather than a master email. The prompt says "apply exactly one alias lookup", so these rows end up unresolved. The knob makes no RNG draws when it is 0.

- **Rules:** `unres + chain <= rows - 2`.
- **Corners:** all-min 792 tokens. All-max 2,404 tokens and 4,056 bytes, the largest of any corner.
- **Prefer the Tier A knobs here.** At about 80 tokens per row, `rows` is the costliest size knob of any family.

### 2.5 finance_ledger: d2 obs 1045 tok (range 940–1154)

| v2 parameter | v2 code | d1 | d2 | d3 | knob |
|---|---|---|---|---|---|
| accounts | `2 + d` | 3 | 4 | 5 | `accts` |
| entries | `5 + 2*d` | 7 | 9 | 11 | `entries` |
| reversals | `randint(3, 4+d)` | 3–5 | 3–6 | 3–7 | `revmax` |
| pending entries | `randint(0, d+1)` | 0–2 | 0–3 | 0–4 | `pendmax` |
| pending non-forced reversal | `random() > .2` | 20% | 20% | 20% | `revpend` (percent) |
| forced partial-reversal pair on the protected entry | 2 | | | | *fixed* |

| knob | tier | min | max | default | d1 / d3 | obs @min / @max | measured effect |
|---|---|---|---|---|---|---|---|
| accts | B | 2 | 6 | 4 | 3 / 5 | 1022 / 1056 | |
| entries | B | 5 | 15 | 9 | 7 / 11 | 782 / 1441 | |
| revmax | B | 3 | 9 | 6 | 5 / 7 | 942 / 1140 | rejected events 1.2 / 2.3 / 3.4 at 3 / 6 / 9 |
| pendmax | A | 0 | 4 | 3 | 2 / 4 | 1046 / 1045 | held events 0.5 / 2.1 / 2.5 at 0 / 3 / 4 |
| revpend | A | 0 | 50 | 20 | 20 / 20 | 1045 / 1045 | |

- **Rules:** `pendmax <= entries - 1`, because the protected entry must not be pending. `revmax >= 3`.
- **Corners:** all-min 654 tokens. All-max 1,536 tokens (range 1,359–1,786).

### 2.6 math_route: d2 obs 875 tok (range 688–1176)

| v2 parameter | v2 code | d1 | d2 | d3 | knob |
|---|---|---|---|---|---|
| nodes | `6 + 2*d` | 8 | 10 | 12 | `nodes` |
| extra edge probability | `.23` | | | | `edges` (percent) |
| checkpoints | `d` | 1 | 2 | 3 | `ckpt` |
| node windows | `d + 1` | 2 | 3 | 4 | `win` |
| required_before | `d` | 1 | 2 | 3 | `before` |
| exposure slack | `randint(0, 3)` | | | | `slack` (upper bound) |
| window width | `randint(0,5)` / `randint(0,4)` | | | | *fixed* |

| knob | tier | min | max | default | d1 / d3 | obs @min / @max | measured effect |
|---|---|---|---|---|---|---|---|
| nodes | B | 6 | 14 | 10 | 8 / 12 | 469 / 1430 | |
| edges | B | 10 | 40 | 23 | 23 / 23 | 688 / 1127 | |
| ckpt | A | 0 | 4 | 2 | 1 / 3 | 861 / 889 | |
| win | A | 0 | 6 | 3 | 2 / 4 | 837 / 913 | |
| before | A | 0 | 4 | 2 | 1 / 3 | 846 / 905 | |
| slack | A | 0 | 6 | 3 | 3 / 3 | 875 / 875 | P(exposure cap changes the optimal route) 0.145 / 0.075 / 0.05 at 0 / 3 / 6 |

- **The constraint knobs are what make this family hard.** With `ckpt = win = before = 0` and `slack = 6`, the constraints change the optimal route in only 2.5% of instances. At d2 defaults they change it in 98%.
- **Rules:** `nodes >= 6`, `ckpt <= nodes - 3`, `win <= nodes - 3`, `before <= nodes - 4`.
- **Every knob vector stays solvable.** Windows are built around the backbone's arrival times and the exposure cap is at least the backbone's exposure, so the backbone route is always feasible.
- **`nodes` is limited by tokens, not CPU.** At edges 40, nodes 16 and 18 cost 2,428 and 3,040 observation tokens, yet generate in ≤ 8 ms.
- **Corners:** all-min 323 tokens. All-max 2,059 tokens (range 1,739–2,421).

### 2.7 security_triage: d2 obs 1400 tok (range 1395–1403)

| v2 parameter | v2 code | d1 | d2 | d3 | knob |
|---|---|---|---|---|---|
| identities | `3 + d` | 4 | 5 | 6 | `users` |
| events | `7 + 3*d` | 10 | 13 | 16 | `events` |
| event time vs `expires` 100 | `randint(95, 105)` | | | | `tlate`: `randint(95, 100+tlate)` |
| containment threshold | `2` | | | | `contain` |
| disabled identity / uniform field draws | `user_1` / `choice(...)` | | | | *fixed* |

| knob | tier | min | max | default | d1 / d3 | obs @min / @max | measured effect |
|---|---|---|---|---|---|---|---|
| users | B | 3 | 8 | 5 | 4 / 6 | 1348 / 1478 | |
| events | B | 6 | 20 | 13 | 10 / 16 | 808 / 1991 | about 85 tokens per event |
| tlate | A | 0 | 10 | 5 | 5 / 5 | 1395 / 1401 | expired share 0.16 / 0.51 / 0.63; share with ≥3 reasons 0.21 / 0.32 / 0.35 (at 0 / 5 / 10) |
| contain | A | 1 | 4 | 2 | 2 / 2 | 1400 / 1400 | contained users 4.5 / 3.4 / 0.7 out of 5 at 1 / 2 / 4 |

- **Rules:** `users >= 2`, because `user_1` is the disabled identity; a minimum of 3 keeps all roles present. `events >= 1`, because `events[0]` is the fixed allowed template.
- **Corners:** all-min 754 tokens. All-max 2,071 tokens.
- **Evidence:** 8 of 8 episodes were solved at d2 and d3, so this family needs knobs the most.

### 2.8 media_timeline: d2 obs 886 tok (range 880–892)

| v2 parameter | v2 code | d1 | d2 | d3 | knob |
|---|---|---|---|---|---|
| assets | `4 + d` | 5 | 6 | 7 | `assets` |
| clips | `4 + 2*d` | 6 | 8 | 10 | `clips` |
| delivery budget | `150 + 60*d` | 210 | 270 | 330 | `dbudget` |
| faulty clips | `randint(1, clips-2)` | 1–4 | 1–6 | 1–8 | `faultpct` (same form as science) |
| gap probability | `random() < .25` | 25% | 25% | 25% | `gap` (percent) |
| unlicensed assets / fault mode / overlap | `randint(1,2)` / uniform over 4 / `randint(0,30)`, `randint(8,18)` | | | | *fixed* |

| knob | tier | min | max | default | d1 / d3 | obs @min / @max | measured effect |
|---|---|---|---|---|---|---|---|
| assets | B | 3 | 8 | 6 | 5 / 7 | 790 / 949 | |
| clips | B | 4 | 14 | 8 | 6 / 10 | 585 / 1334 | |
| faultpct | A | 10 | 100 | 100 | 100 / 100 | 884 / 886 | rejected share 0.125 at 10, 0.417 at 100 |
| gap | A | 0 | 60 | 25 | 25 / 25 | 885 / 886 | retained clips with a gap: 0 / 0.26 / 0.58 at 0 / 25 / 60 |
| dbudget | C | 100 | 400 | 270 | 210 / 330 | 886 / 886 | only changes `over_budget_frames` |

- **Rules:** `assets >= 3`, so at least one licensed asset remains after `randint(1,2)` are unlicensed. `clips >= 3`.
- **Name:** the knob is `dbudget` rather than `budget`, because `<family>.budget` is already the Darwin token-budget gene.
- **Corners:** all-min 489 tokens. All-max 1,401 tokens.

## 3. Machine-readable registry

**Proposed home:** `arena_env/knob_registry.json`, loaded by `tasks.py`. It would be the single source of truth.

**Defaults:** `default` is the d2 value, which is Darwin's baseline. `byDifficulty` holds the `[d1, d2, d3]` defaults that a `-dN` prefix selects.

```json
{
  "version": 1,
  "families": {
    "software_change": {
      "modules": {"min": 5, "max": 14, "type": "int", "default": 8, "byDifficulty": [6,8,10], "tier": "B"},
      "deps": {"min": 1, "max": 4, "type": "int", "default": 3, "byDifficulty": [3,3,3], "tier": "A"},
      "changed": {"min": 1, "max": 5, "type": "int", "default": 2, "byDifficulty": [1,2,3], "tier": "B"},
      "suites": {"min": 3, "max": 10, "type": "int", "default": 7, "byDifficulty": [6,7,8], "tier": "B"},
      "targets": {"min": 1, "max": 6, "type": "int", "default": 4, "byDifficulty": [3,4,4], "tier": "B"},
      "costmax": {"min": 3, "max": 10, "type": "int", "default": 10, "byDifficulty": [10,10,10], "tier": "A"}
    },
    "industrial_schedule": {
      "jobs": {"min": 3, "max": 8, "type": "int", "default": 6, "byDifficulty": [5,6,7], "tier": "B"},
      "prec": {"min": 0, "max": 60, "type": "int", "default": 24, "byDifficulty": [12,24,36], "tier": "B"},
      "duemax": {"min": 12, "max": 40, "type": "int", "default": 30, "byDifficulty": [30,30,30], "tier": "A"}
    },
    "science_calibration": {
      "samples": {"min": 4, "max": 14, "type": "int", "default": 8, "byDifficulty": [6,8,10], "tier": "B"},
      "reps": {"min": 3, "max": 7, "type": "int", "default": 5, "byDifficulty": [3,5,5], "tier": "B"},
      "faultpct": {"min": 10, "max": 100, "type": "int", "default": 100, "byDifficulty": [100,100,100], "tier": "A"},
      "wmax": {"min": 1, "max": 9, "type": "int", "default": 4, "byDifficulty": [3,4,5], "tier": "A"},
      "edge": {"min": 0, "max": 3, "type": "int", "default": 0, "byDifficulty": [0,0,0], "tier": "A"}
    },
    "office_reconciliation": {
      "people": {"min": 3, "max": 8, "type": "int", "default": 5, "byDifficulty": [4,5,6], "tier": "B"},
      "rows": {"min": 6, "max": 21, "type": "int", "default": 12, "byDifficulty": [9,12,15], "tier": "B"},
      "unres": {"min": 1, "max": 4, "type": "int", "default": 1, "byDifficulty": [1,1,1], "tier": "A"},
      "tspan": {"min": 1, "max": 8, "type": "int", "default": 4, "byDifficulty": [4,4,4], "tier": "A"},
      "chain": {"min": 0, "max": 3, "type": "int", "default": 0, "byDifficulty": [0,0,0], "tier": "A"}
    },
    "finance_ledger": {
      "accts": {"min": 2, "max": 6, "type": "int", "default": 4, "byDifficulty": [3,4,5], "tier": "B"},
      "entries": {"min": 5, "max": 15, "type": "int", "default": 9, "byDifficulty": [7,9,11], "tier": "B"},
      "revmax": {"min": 3, "max": 9, "type": "int", "default": 6, "byDifficulty": [5,6,7], "tier": "B"},
      "pendmax": {"min": 0, "max": 4, "type": "int", "default": 3, "byDifficulty": [2,3,4], "tier": "A"},
      "revpend": {"min": 0, "max": 50, "type": "int", "default": 20, "byDifficulty": [20,20,20], "tier": "A"}
    },
    "math_route": {
      "nodes": {"min": 6, "max": 14, "type": "int", "default": 10, "byDifficulty": [8,10,12], "tier": "B"},
      "edges": {"min": 10, "max": 40, "type": "int", "default": 23, "byDifficulty": [23,23,23], "tier": "B"},
      "ckpt": {"min": 0, "max": 4, "type": "int", "default": 2, "byDifficulty": [1,2,3], "tier": "A"},
      "win": {"min": 0, "max": 6, "type": "int", "default": 3, "byDifficulty": [2,3,4], "tier": "A"},
      "before": {"min": 0, "max": 4, "type": "int", "default": 2, "byDifficulty": [1,2,3], "tier": "A"},
      "slack": {"min": 0, "max": 6, "type": "int", "default": 3, "byDifficulty": [3,3,3], "tier": "A"}
    },
    "security_triage": {
      "users": {"min": 3, "max": 8, "type": "int", "default": 5, "byDifficulty": [4,5,6], "tier": "B"},
      "events": {"min": 6, "max": 20, "type": "int", "default": 13, "byDifficulty": [10,13,16], "tier": "B"},
      "tlate": {"min": 0, "max": 10, "type": "int", "default": 5, "byDifficulty": [5,5,5], "tier": "A"},
      "contain": {"min": 1, "max": 4, "type": "int", "default": 2, "byDifficulty": [2,2,2], "tier": "A"}
    },
    "media_timeline": {
      "assets": {"min": 3, "max": 8, "type": "int", "default": 6, "byDifficulty": [5,6,7], "tier": "B"},
      "clips": {"min": 4, "max": 14, "type": "int", "default": 8, "byDifficulty": [6,8,10], "tier": "B"},
      "faultpct": {"min": 10, "max": 100, "type": "int", "default": 100, "byDifficulty": [100,100,100], "tier": "A"},
      "gap": {"min": 0, "max": 60, "type": "int", "default": 25, "byDifficulty": [25,25,25], "tier": "A"},
      "dbudget": {"min": 100, "max": 400, "type": "int", "default": 270, "byDifficulty": [210,270,330], "tier": "C"}
    }
  }
}
```

**Cross-knob rules.** These belong in code next to the registry; §2 explains each one.

- **software_change:** `changed <= floor(modules/2)` and `targets <= modules`.
- **science_calibration:** `reps` is odd.
- **office_reconciliation:** `unres + chain <= rows - 2`.
- **finance_ledger:** `pendmax <= entries - 1`.
- **math_route:** `ckpt <= nodes - 3`, `win <= nodes - 3`, `before <= nodes - 4`.

**Reserved knob names:** `budget` and `difficulty`.

## 4. task_id grammar and validation

```
task_id := family [ "-d" level ] *( "." name value )
family  := software_change | industrial_schedule | science_calibration | office_reconciliation
         | finance_ledger | math_route | security_triage | media_timeline
level   := "1" | "2" | "3"
name    := [a-z]+                    ; letters only, so "jobs5" parses unambiguously
value   := "0" | [1-9][0-9]{0,3}     ; non-negative integer, no leading zeros
regex   := ^(<family alternation>)(?:-d([123]))?((?:\.[a-z]+(?:0|[1-9][0-9]{0,3}))*)$
```

The grammar is a strict subset of the arena's `ID_RE` (`[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`, from `submission.py`). Darwin's genome parameter for a knob is `<family>.<name>`. The env must reject an ID that breaks any of these rules, with a `ValueError` and never by normalizing:

1. **Length.** At most 128 characters. The worst case with every knob explicit is 71 characters (`software_change-d2.changed5.costmax10.deps4.modules14.suites10.targets6`).
2. **Difficulty prefix.** `-dN` is required whenever any knob is present. A bare `family` keeps working as the legacy alias for `-d2`, but manifests should spell out `-dN`.
3. **Order.** Knob segments are strictly sorted by name, with no duplicates.
4. **Range.** Every name is a registered knob of that family, and every value lies within `[min, max]` and passes the cross-knob rules. Unknown knobs are an error and are never ignored.
5. **Canonical form.** A knob whose value equals the default for the stated `-dN` must be omitted. As a result each (d, knob-vector) pair has exactly one accepted spelling, which keeps arena task-ID uniqueness and the Darwin cache keys stable.
6. **Seed derivation is unchanged.** The seed string stays `arena-curriculum-v2|{family}|{seed}|{d}`, and knobs are excluded. Variants that differ in one knob therefore share their RNG stream up to the first draw that knob affects, which partially gives common random numbers for the gate's seed-paired comparisons.
7. **Generator semantics.**
   - Each knob replaces exactly the v2 literal listed in §2.
   - With default values, the generator makes the identical RNG calls, so the output is bit-identical. Percent knobs compare against `pct/100`, which equals the v2 float in every default case.
   - Tier A knobs that default to 0 (`edge`, `chain`) are guarded with `if K[name]:` and make no RNG draws at 0.
8. **Task metadata.** The task gains `knobs` (the full effective vector) and `task_spec` (the canonical ID). `generator_version` stays 2. Add `knob_registry_version: 1`.

Valid and invalid examples, checked against the full grammar (the regex plus rules 2–5). A validator that checks only the regex is not enough.

- **Accepted:** `industrial_schedule-d2.jobs5.prec36`, `math_route-d2.slack0`, `math_route-d3`.
- **Rejected by the regex:**
  - `math_route-d2.nodes014` (leading zero)
  - `math_route-d2.Nodes9` (uppercase)
  - `math_route-d2.nodes=9` (`=` is not allowed)
  - `math_route-d4` (no level 4)
- **Match the regex but are rejected by a rule:**
  - `office_reconciliation-d2.tspan1.chain2` (rule 3: unsorted)
  - `math_route-d2.slack3` (rule 5: equals the d2 default)
  - `math_route.slack0` (rule 2: knobs without `-dN`)

## 5. Code changes requested from the env owner

None of these are ours to make.

1. **`arena_env/tasks.py`**
   - Load `knob_registry.json`.
   - Add `parse_task_id(task_id) -> (family, difficulty, knobs)` and `canonical_task_id(family, difficulty, knobs)`.
   - Extend `make_task(task_id, seed, difficulty=2, knobs=None)`: the effective vector is `byDifficulty[d]` overridden by `knobs`.
   - Have each generator read the substitutions listed in §2.
   - Implement `science.edge` and `office.chain` exactly as specified.
   - Leave the prompts unchanged; the existing wording already covers both new traps.
2. **`arena_env/environment.py`**
   - In `reset`, replace the `endswith(f"-d{level}")` loop with `parse_task_id`, keeping the same `ValueError` contract.
3. **`scripts/calibrate.py`** (today it blocks knob IDs in two places: `--task-id choices=TASK_IDS`, and `task_budgets` strips `[:-3]`)
   - Accept canonical task specs in `--task-id`, validated through `parse_task_id`, and derive the difficulty from the spec.
   - Call `reset(task_id=<spec>)`.
   - Key `task_budgets` and the manifest by the full spec.
   - Add `task_spec` and `knobs` to the episode and summary rows.
4. **Tests to add**
   - **Bit-identity:** for all families, d in 1..3 and seeds 0..299, `make_task(f, s, d) == make_task(f, s, d, knobs=byDifficulty[d])`.
   - **Oracle agreement:** at all-min, all-max and every one-knob min/max, with 40 seeds each.
   - **Limits:** at every corner, bytes < 14,000 and generation < 1 s.
   - **Grammar:** the accept and reject cases from §4.
5. **The hook our lane relies on.** The Darwin evaluator turns on knob genes only when `<env-dir>/arena_env/knob_registry.json` exists with `version: 1` and `calibrate.py --help` accepts specs. Until then, `lib/cells.mjs` keeps `RUNNER_KNOBS` empty and rejects `<family>.<knob>` loudly.

   On our side, two follow-ups:
   - `envSourceSha` should then also hash `knob_registry.json`.
   - `knobArgs` should emit `--task-id <canonical spec>` instead of one flag per knob, because the arena itself carries only the task_id.

`tasks.json` stays unchanged until the gate promotes a winner. The arena allows up to 50 task IDs, so a winner can ship several knob cells per family.

## 6. Related findings (not knobs; ship each as a separately gated change)

### 6.1 The science `medians` key is ambiguous

5 of the 6 non-solved science episodes lose exactly one component because they leave quarantined samples out of `medians`. The answer schema reads `"medians":{sample ID:integer}`, and nothing says "every sample".

- **Effect:** about 75% of science's v2 failures are an instruction ambiguity rather than reasoning.
- **Proposed fix (one line):** "medians: EVERY sample in samples.json, including quarantined ones".
- **Consequence:** the fix will probably saturate science d2, so `edge` and `wmax` become the levers there.

### 6.2 `read *` double-escapes JSON

`content=json.dumps(files)` wraps JSON strings that are already JSON. `model_dump_json` then escapes them again. Returning `### name\n<file>` sections instead would save, at d2 (mean of 30 seeds, same tokenizer):

| family | saving |
|---|---|
| software_change | 29% |
| industrial_schedule | 34% |
| science_calibration | 21% |
| office_reconciliation | 38% |
| finance_ledger | 40% |
| math_route | 37% |
| security_triage | 43% |
| media_timeline | 36% |

That is roughly 110 to 600 tokens of completion budget handed back to reasoning. It changes every observation, so it needs its own A/B through the gate and a fresh calibration baseline.

### 6.3 The context limit can bind before the budget

Calibrate counts context as canonical JSON of all messages, reasoning included. That count inflates the `read *` observation by a further 1.23–1.33×. So:

- The context needed is roughly `budget + initial (500–610) + 0.3 × obs`.
- With `--context-tokens 16384`, a budget gene near 16,384 cannot be reached.
- Our evaluator should use `context = min(32768, budget + 2048)`. This is our change, not the env owner's.

## 7. Suggested first Darwin wave (at most 3 knobs per family, one-at-a-time mutation)

| family | knobs | direction to explore | evidence |
|---|---|---|---|
| industrial_schedule | jobs, prec, (budget) | jobs ↓ to 4–5, prec ↑ | 8/8 truncated; feasible orders 105 → 35 → 11 |
| security_triage | events, tlate, contain | Tier A first | 8/8 solved at d2 and d3 |
| software_change | deps, costmax, changed | deps ↑, costmax ↓ | d3 missed transitive consumer; tie rate 0.08 → 0.41 |
| office_reconciliation | tspan, chain, unres | tspan ↓, chain ↑ | d3 provenance error; tie share 0.32 → 1.0 |
| finance_ledger | revmax, revpend, pendmax | ↑ | d3 missed applied reversal |
| math_route | slack, before, nodes | slack ↓, before ↑, nodes ↓ (d2 truncation) | d3 exposure error |
| media_timeline | gap, faultpct, clips | gap ↑ | d2 saturated, d3 truncated |
| science_calibration | edge, wmax (after §6.1) | ↑ | blocked by the `medians` ambiguity |

Notes for the Darwin side (our lane):

- **Freeze `<family>.difficulty` at 2 in knob mode.** Every d-coupled literal except software's fallback cost has a knob, so changing d would mostly just reseed. Freezing it keeps attribution to one knob per mutation.
- **Canonicalize before `cellKey`.** Drop knobs equal to the d default, so equivalent cells share a cache entry.

## 8. How this was measured; verified vs unverified

**Method.** A scratch replica of the 8 v2 generators lived in the session scratchpad (`.../scratchpad/knobs/knobbed.py`, `run.py`). It is never committed and contains no repo changes. In it:

- The d-literals were replaced by the §3 knobs.
- Defaults were run through the real `arena_env.tasks` (`_task`, `_ids`, `oracle_answer`, `grade`) and `ArenaObservation.model_dump_json()`.
- Tokens were counted with the pinned tokenizer (`sha256 0997f410…29b9f3`) using `add_special_tokens=False`, exactly as `calibrate.py` counts them.

**Verified:**

- **Bit-identity:** 0 mismatches in `files` and `expected` against v2 `make_task` over 7,200 instances (8 families × d1–d3 × seeds 0–299).
- **Oracle agreement and limits:** oracle equals `expected` and `grade == 1.0` with 0 generator errors at all-min, all-max and every one-knob extreme (40 seeds each). Maxima: 4,056 bytes, 0.48 s generation, 321 answer tokens.
- **Cost probes beyond the bounds:** industrial jobs 9 at prec 0 takes 3.4 s and 601 MB. math_route nodes 18 at edges 40 costs 3,040 observation tokens.
- **Grammar:** the regex and worst-case lengths were checked against `ID_RE`.
- **Failure attribution:** every non-solved v2 episode was diffed against regenerated `expected`.

**Unverified:**

- **Real model.** No knob variant has run on the model, so it is unknown whether Tier A knobs produce reasoning failures rather than truncation. That is precisely the question the Darwin evaluator is built to answer.
- **The env owner's implementation.** The replica is not that implementation; the bit-identity test in §5.4 must pass on the real code.
- **Live arena validation.** I checked only `submission.py`'s `ID_RE` mirror, not the live validator.
- **Production token overhead.** The production chat-wrapper overhead is unknown.
- **Timing on arena hardware.** Generation times were measured on a 32-core host, not on the arena's 1-vCPU floor.
- **Sample size.** The v2 calibration has n = 4 per cell; treat its rates as anecdotes, not estimates.
