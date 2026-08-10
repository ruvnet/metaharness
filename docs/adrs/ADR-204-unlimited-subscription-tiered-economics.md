# ADR-204 — "Unlimited"-feeling flat-rate subscriptions on Cognitum Fugu: business model + budget-defense architecture

**Status**: Proposed (rev 2)
**Date:** 2026-06-29 — **rev 2** (peer review of the §5 Reserve-and-Commit design addressed: §5.2 multi-worker agent **sharding** + a **decoupled** account-headroom flag in place of an in-transaction subcollection scan, plus a new **§5.5** reservation-lease / recovery formalization; see the *Peer review addressed (rev 2)* changelog at the end). Status unchanged: **Proposed**.
**Companion to:** ADR-203 (Cognitum Fugu — GCP-hosted metered, tiered Completions API). This ADR is the **business model + abuse-defense** layer on top of ADR-203's tiering/metering/streaming. It adds **no new serving primitive** — it adds *packaging* (flat-rate bundles) and *one new control plane mechanism* (atomic budget **Reserve-and-Commit**), and reuses ADR-203 §5.1 (progressive token accounting) and §5.3 (scatter-gather rate limiting) for two of the three structural dangers.
**Related:** ADR-203 (tiered completions API — REQUIRED reading), ADR-201 (cheap-model lift / cheap-vs-frontier), ADR-150 ($0 local inference; removable-augmentation discipline), ADR-180 (GCP VM runner + Firestore store), cognitum-one/api ADR-092 (api.cognitum.one gateway, `cog_…` keys), AgentBBS ADR-0012 (emulator-first GCP).
**Grounding artifacts (read, cited — not invented):**
- `docs/research/retort-placement/PLACEMENT.md` (+ `results-*.csv`, `placement-analysis-v4.json`) — the **measured** cost-vs-capability Pareto data that *justifies* tiering being viable. This is the only hard data in this ADR; everything else (mix, prices, break-even, adoption) is **modeled / assumed** and labelled as such.
- ADR-203 §4.1 (tier rationale), §5.1 (progressive local token accounting), §5.3 (scatter-gather rate limit), §3.5 (inflight loop-detection / runaway terminate).
- `services/apicompletions/src/metering/{ledger,pricing,record}.ts`, `ratelimit/limiter.ts` — the live ADR-203 implementation this layer extends.
- AgentBBS `BbsRoomBudgetTracker` / better-sqlite3-WAL reserve-and-commit pattern (conceptual prior art for the per-room spend ledger; adapted here to Firestore — the AgentBBS code is a local single-node WAL row, this ADR re-derives it for a distributed serverless budget).

---

## 0. Executive summary

We propose two **flat-rate subscription bundles** on the ADR-203 Cognitum Fugu API that
*feel* unlimited for everyday work, sold against the **measured** finding that the cheap
tier is frontier-class on everyday tasks at ~12× lower cost:

- **Sovereign Solopreneur — $99/mo.** Everyday ops **forced to the `low` tier**
  (`max_tier=low`). The product promise: run your whole solo business on agents all day,
  flat rate, because everyday work genuinely does not need the frontier (PLACEMENT: cheap
  coverage **0.954** vs frontier **0.958**).
- **Agentic Autopilot / Ruflow Premium — $249/mo.** **Dynamic escalation `low→mid→high`**
  (`cognitum-auto`), so the hard tail gets the frontier when — and only when — the cheap
  tier's structural ceiling bites (PLACEMENT: no cheap config crosses 0.958).

**"Unlimited" is fair-use / soft-capped, not literally infinite** (true unlimited inference
is impossible — every token has a marginal provider cost). It *feels* unlimited because the
**measured** everyday-work mass stays on the cheap tier, which costs us almost nothing per
token. The bundles are made safe by a **budget-defense architecture** whose new piece is an
atomic **Reserve-and-Commit** spend ledger (§5) that denies overspend **at the write
boundary, before inference is invoked** — closing the one danger ADR-203 does not yet
cover (the *Darwin Runaway*: a looping agent escalating to `high` and running up a runaway
bill).

**Honesty up front — what is measured vs assumed:**

| Claim | Status |
|---|---|
| Cheap ties frontier on **everyday** work (0.954 vs 0.958, ~12× cheaper) | **MEASURED** (PLACEMENT §1) |
| Cost is 78.1% governed by model/tier choice (tier = dominant cost lever) | **MEASURED** (PLACEMENT §2 ANOVA) |
| Cheap-tier capability ceiling is **structural** on hard tasks (no cheap config > 0.958; glm vs deepseek base-model effect 0.3%, p=0.70) | **MEASURED** (PLACEMENT §8) |
| **75/20/5** low/mid/high traffic mix | **ASSUMED** — placeholder; must be calibrated from `usage_ledger` |
| Per-tier **cost** $0.15 / $1.00 / $15.00 per 1M tokens | **ASSUMED** — illustrative provider-cost placeholders |
| **~$1.06/1M** blended cost, **~188M-token** break-even | **MODELED** from the two assumptions above |
| Plan prices ($99 / $249), adoption, churn | **ASSUMED** — launch decisions, not data |

The "**80–85% of frontier capability**" framing is scoped: **≈frontier-parity on EVERYDAY
work** (measured), **NOT on hard tasks** (where the cheap ceiling is structural — measured).
That scoping is *why* the $249 tier exists and *why* High-tier escalation is a defended,
metered event rather than a free-for-all.

---

## Context / problem (§1)

ADR-203 ships a **usage-metered** tiered API: every request is priced linearly on the
*resolved* tier and written to `usage_ledger`. That is the correct *wholesale* primitive,
but it is a poor *retail* product: pay-per-token makes a customer's bill unpredictable and
makes the buying decision a constant cost-anxiety. The market the org wants (solopreneurs,
"agentic autopilot" power users, the Ruflo install base) responds to **flat-rate, "run it
all day" pricing** — the ChatGPT-Pro / Claude-Max shape — not to a token meter.

The tension: **a flat fee over a metered backend is a margin bet.** It only works if the
*typical* customer's blended serving cost stays well under the flat fee, and if no customer
(or runaway agent) can drive cost to infinity. ADR-203 already addresses two of the three
ways that bet blows up (stream-shaving leak §5.1; rate-limiter contention §5.3). The third —
an **autonomous agent looping and escalating to the `high` tier** — is uncovered, and it is
precisely the failure mode an "Agentic Autopilot" product *invites*. This ADR sets the
business model and adds the missing defense.

**Why the bet is plausible at all** is not marketing — it is the PLACEMENT measurement:
everyday work is genuinely cheap-tier-servable at frontier-class coverage (0.954 vs 0.958),
and cost is 78.1% governed by tier choice. So *if* the everyday-work mass really dominates
the traffic, the blended cost is low. The word "if" is the whole risk, and §4 makes it
explicit and measurable.

---

## Decision (§2)

1. Ship **two flat-rate bundles** over the ADR-203 API (§3), packaged as scope + routing-
   control presets on the existing `cog_…` key — **no new auth system, no new serving
   path**:
   - **Sovereign Solopreneur ($99/mo):** key holds `completions:low` only; requests pinned
     `max_tier=low` (everyday ops forced to the cheap tier).
   - **Agentic Autopilot ($249/mo):** key holds `completions:{low,mid,high}`; `cognitum-auto`
     with `low→mid→high` dynamic escalation.
2. State the "unlimited" claim **honestly as fair-use / soft-capped** (§3.3), backed by a
   per-period **serving budget** (a soft cap) and a **hard cap** beyond which the account is
   throttled — not infinite tokens.
3. Add an **atomic budget Reserve-and-Commit** control plane (§5) — the **one new
   mechanism** in this ADR — that reserves an estimated worst-case cost block **before** the
   provider call, commits the actual after, and **denies at the write boundary** when a
   reservation would breach the per-agent cap, the per-loop runaway cap, or the account hard
   cap. This is the AgentBBS `BbsRoomBudgetTracker` reserve-and-commit pattern, re-derived for
   Firestore (the AgentBBS original is a single-node better-sqlite3 WAL row; §5.2 explains the
   distributed adaptation and why the naive single-doc port hits ADR-203 §5.3's contention
   wall).
4. Reuse ADR-203 **§5.1** (progressive local token accounting) for the stream-shaving leak
   and **§5.3** (scatter-gather TTL'd ticks + `COUNT()`) for the rate-limit contention wall —
   *unchanged*. This ADR only adds the budget layer on top (§4 maps each danger to its owner).
5. Treat the **75/20/5 mix and per-tier prices as ASSUMPTIONS to be measured**, not facts
   (§4). Calibrate them live from `usage_ledger`; the *justification* for tiering being viable
   is the measured PLACEMENT data, but the exact distribution is workload-dependent.
6. **Emulator-first / $0** to build and validate, exactly as ADR-203 §7.3 (mock provider,
   Firestore emulator) — the whole reserve→invoke→commit→deny loop is exercised offline.

---

## 3. Product bundles

### 3.1 Sovereign Solopreneur — $99/mo

**Value prop.** "Run your entire solo business on agents, all day, one flat fee." The pitch
is grounded in the PLACEMENT finding that **everyday work does not need the frontier**: the
cheap tier reaches 0.954 coverage vs the frontier's 0.958 — a statistical tie — at ~12×
lower cost. The customer gets frontier-class *everyday* output without frontier *anxiety*.

**Mechanics.** Key holds `completions:low`. Requests are pinned `max_tier=low` (the ADR-203
§3.4 cost cap). Difficulty-routing and τ escalation are **disabled** for this plan (there is
no tier above `low` the key can reach), so cost per token is bounded by the cheapest rate.
A request whose intrinsic difficulty implies `high` returns the ADR-203 §6.2 `fail_fast`
envelope ("this task needs a higher tier; upgrade to Autopilot") — **never a silent
downgrade** that ships a likely-wrong answer.

**Honest boundary.** This plan is explicitly *not* for hard tasks — that is a feature, not a
limitation hidden from the buyer. The upgrade path (Autopilot) is the answer to "I hit the
cheap-tier ceiling," and the `fail_fast` message says so.

### 3.2 Agentic Autopilot / Ruflow Premium — $249/mo

**Value prop.** "Autonomous agents that escalate to the frontier exactly when the work is
hard, and only then." `cognitum-auto` with `low→mid→high` dynamic escalation: everyday steps
stay cheap; the genuinely hard tail (PLACEMENT: ~33% escalation recovered coverage
0.836→0.927) gets `mid`/`high`. The customer pays a flat fee and the *router* — not the
customer — decides when frontier spend is warranted.

**Mechanics.** Key holds all three scopes; default `cognitum-auto`; τ escalation active on
the non-streaming path, one-shot input-signal routing on streams (ADR-203 §3.3). Every
escalation is surfaced (`x_cognitum.resolved_tier`, `escalated`) and billed *internally*
against the account's serving budget — the customer sees a flat fee, we see the true tiered
cost in `usage_ledger`.

**Why $249 and not $99.** The structural cheap-tier ceiling (measured) means the hard tail
*must* draw `high`-tier tokens, which are the expensive ones (assumed ~$15/1M, ~100× `low`).
The price gap funds the escalation headroom. The exact gap is a margin decision tied to the
measured escalation fraction once `usage_ledger` data exists (§4.4).

### 3.3 "Unlimited" — stated honestly

We market the feeling of unlimited, and we say plainly what it is:

> **Fair-use unlimited.** Everyday work is effectively uncapped because it runs on the cheap
> tier, which costs us a fraction of a cent per request. There is a generous monthly
> **serving budget** (soft cap) sized so a normal heavy user never notices it; sustained
> usage beyond it is throttled, not billed by surprise. **True unlimited inference is
> impossible** — every token has a marginal cost — and anyone claiming literal-infinite is
> either rate-limiting you invisibly or losing money until they stop.

**The "80–85% of frontier capability" claim is scoped, not blanket:**
- **On everyday work:** ≈frontier-parity (**measured**: 0.954 vs 0.958). The "80–85%" is a
  *conservative* statement of this — we under-claim the measured tie to stay honest about
  variance and the latency caveat (cheap is 2–3× slower, PLACEMENT §1).
- **On hard tasks:** the cheap tier does **not** reach frontier capability — the ceiling is
  **structural and measured** (no cheap config > 0.958; base-model swap null, p=0.70). We do
  **not** claim 80–85% here. **This is exactly why High-tier escalation (and the $249 plan)
  exists** — the gap is real, so we route to the frontier rather than pretend the cheap tier
  closed it.

No "we capture 80–85% of frontier" without that everyday-vs-hard scoping. Capability
laundering is impossible by construction (ADR-203 §8: resolved tier + model are returned and
ledgered).

---

## 4. Financial model — measured justification, assumed distribution

### 4.1 The blended-cost formula

Let the traffic mix be fractions `(f_low, f_mid, f_high)` summing to 1, and per-tier blended
$/1M-token costs `(c_low, c_mid, c_high)`. The blended serving cost per 1M tokens is:

```
C_blend = f_low·c_low + f_mid·c_mid + f_high·c_high
```

**Worked example with the ASSUMED inputs** (mix 75/20/5; costs $0.15 / $1.00 / $15.00 per 1M):

```
C_blend = 0.75·$0.15 + 0.20·$1.00 + 0.05·$15.00
        = $0.1125    + $0.20       + $0.75
        = $1.0625  ≈  $1.06 / 1M tokens
```

> **CRITICAL HONESTY.** The **75/20/5 mix** and the **per-tier costs** are *assumptions*, not
> measurements. They are placeholders to make the model concrete and **must be calibrated
> from `usage_ledger`** post-launch (the ledger records resolved-tier + tokens per request —
> exactly the corpus to measure the real `f_*`). What *is* measured is the **justification**
> for tiering being viable at all: PLACEMENT shows cheap ties frontier coverage on everyday
> work (0.954 vs 0.958) at ~12× lower cost, and that cost is **78.1% governed by tier choice**
> (ANOVA). Those findings say *a low-tier-dominated mix is cheap*; they do **not** say the
> mix is 75/20/5 — that is workload-dependent and we will not know it until we meter it.

### 4.2 Break-even

Define a plan's **serving budget** `B` (the slice of the flat fee allocated to provider
inference, net of payment fees, infra, and target margin). Zero-margin break-even token
volume is:

```
T_breakeven (millions) = B / C_blend
```

With `B = $200/mo` (the serving slice of the $249 Autopilot fee) and the assumed
`C_blend = $1.06/1M`:

```
T_breakeven = $200 / $1.06  ≈  188 M tokens / month
```

So a flat-rate Autopilot account stays margin-positive up to **~188M tokens/mo** of
*assumed-mix* traffic; sustained usage beyond that is where the soft cap and Reserve-and-
Commit (§5) protect the bet.

**Value-prop anchor (assumed, for the buyer).** A *typical* heavy user consuming ~20M
tokens/mo of everyday-dominated work costs us ≈ 20·$1.06 ≈ **$21/mo** under tiering, but
would pay ≈ 20·$15 ≈ **~$300/mo** at always-frontier usage-based rates. They pay $249 flat,
we serve at ~$21 cost — fat margin on the typical user, *thin-to-negative* only on the
~9× heavier break-even user. That asymmetry is the entire flat-rate thesis: **price the
typical user, defend against the outlier.**

### 4.3 Sensitivity — the high-tier fraction is the whole game

`C_blend` is **dominated by `f_high`** because `c_high` is ~100× `c_low` (assumed). A small
drift in the high-tier share swings the blended cost and the break-even hard:

| mix (low/mid/high) | C_blend ($/1M) | break-even @ $200 (M tok) | note |
|---|---:|---:|---|
| 90 / 8 / 2 | $0.515 | 388 M | everyday-dominated — best case |
| 85 / 12 / 3 | $0.700 | 286 M | |
| **75 / 20 / 5** (assumed) | **$1.06** | **188 M** | the worked example |
| 70 / 20 / 10 | $1.81 | 110 M | high-tier doubles → break-even halves |
| 60 / 25 / 15 | $2.59 | 77 M | runaway-escalation regime — margin gone |

**Reading it:** the 5% high-tier slice alone contributes $0.75 of the $1.06 blended cost. A
drift from 5%→10% high-tier nearly **doubles** blended cost and **halves** break-even. This
is the **margin risk** and it is *mechanically the same event as the Darwin Runaway* (§4.5):
anything that pushes traffic up the tier ladder — a looping agent, an over-eager router, a
mis-tuned τ — attacks the margin at the most expensive point. **That is why the defense (§5)
caps spend at the tier-escalation boundary, not just at a token count.**

### 4.4 What we measure to replace the assumptions

Post-launch, from `usage_ledger` (ADR-203 §5.1) per account/plan:
- **`f_low / f_mid / f_high`** — the real resolved-tier distribution (replaces 75/20/5).
- **`c_*`** — realized provider $/1M per tier (replaces the price placeholders; reconciled
  against provider invoices, ADR-203 §5.2).
- **Escalation fraction** per plan (the PLACEMENT prior is ~33% on hard cells; the live
  number sets the Autopilot price).
- **Per-account token distribution** — to size `B`, the soft cap, and the hard cap so the
  typical user is uncapped and only true outliers are throttled.

Until then, **every number in §4.1–4.3 except the PLACEMENT-derived justification is a
modeling assumption**, and the plan prices are launch decisions, not data.

### 4.5 The margin risk, stated plainly

If the real mix is heavier on `high` than assumed — because customers run harder workloads,
or agents escalate more than the PLACEMENT 33% prior, or τ is mis-calibrated — `C_blend`
rises, break-even falls, and a flat-rate account can go **margin-negative**. The mitigations
are: (a) the **measured-not-assumed** calibration loop (§4.4); (b) the **Reserve-and-Commit**
hard cap (§5) that bounds the worst case per account; (c) **τ adaptation** (ADR-203 §6.5)
that keeps escalation concentrated on the genuinely-hard tail; (d) pricing levers (raise the
fee, lower the soft cap) once the live mix is known. We do **not** assume the mix is safe; we
**bound** it and **measure** it.

---

## 5. Defense architecture

### 5.1 The three structural dangers (and who owns each)

| Danger | What it is | Owner |
|---|---|---|
| **Darwin Runaway** | An autonomous agent (Autopilot/Ruflow) **loops** and **escalates to `high`**, running up a runaway flat-rate bill — attacks the margin at the most expensive tier (§4.3). | **NEW — this ADR §5.2** (Reserve-and-Commit per-agent/per-loop cap) **+ ADR-203 §3.5** (inflight loop-detection → terminate) |
| **Stream-Shaving billing leak** | Client consumes `high`-tier output then **drops the TCP connection before the final `usage` frame** → usage unrecorded → free inference. | **ADR-203 §5.1** (progressive local token accounting; `truncated:true` partial record from the local family-correct counter) — *already covered, unchanged* |
| **DB lock-contention wall** | A busy account firing many parallel agents serializes on a single Firestore counter doc (~1 write/sec/doc) → lock contention → latency on the hot path. | **ADR-203 §5.3** (scatter-gather TTL'd `usage_ticks` + `COUNT()`) for rate-limit; **this ADR §5.2** adapts the same discipline for the *budget* doc (per-agent sharding + async account fold) |

Two of three are **already addressed by ADR-203**. The new piece is the budget layer, which
also re-uses ADR-203 §3.5's loop-detection as the runaway *kill switch* and ADR-203 §5.3's
sharding discipline to dodge the contention wall.

### 5.2 Atomic budget Reserve-and-Commit (the new mechanism)

**Principle (from AgentBBS `BbsRoomBudgetTracker`).** Before doing expensive work, **reserve**
an estimated worst-case cost block atomically; do the work; **commit** the actual and
**release** the unused reservation. Deny **at the reservation write** if it would breach a
cap — so an overspend is *impossible*: no reservation → no invoke. The AgentBBS original is a
single-node `better-sqlite3` WAL transaction on one room-budget row (reserve and commit are
WAL frames; a crash rolls back uncommitted frames). We re-derive it for Firestore.

**Why the naive port fails — and the adaptation (rev 2).** A single `subscriptions/{accountId}`
budget doc, transactionally incremented per request, hits **exactly the ADR-203 §5.3 contention
wall** (~1 write/sec/doc) under a parallel-agent Autopilot account. *But* — unlike the §5.3
rate limiter, which tolerates ≤1s **soft** over-admission — the per-agent deny boundary must be
**hard** (you cannot discover a runaway *after* it overspent). We resolve the tension by
moving the transactional contention to where it is *desirable* — and, per the rev-2 peer review,
by (a) **sharding** the per-agent doc so horizontal scaling does not re-create the wall, and
(b) **decoupling** the account-wide check from the hot-path transaction so it cannot be poisoned
by cross-account abort/retry storms.

- **Per-agent / per-loop budget, randomly sharded** across
  `subscriptions/{accountId}/agents/{agentId}_{shard}` with `shard ∈ [0, K)`. *Peer-review fix 1:*
  the rev-1 design used a single `agents/{agentId}` doc and called its serialization "the throttle
  we want." That holds for a *single* worker — but a Support-Pod-style agent that **scales
  horizontally to N parallel workers under the same `agentId`** puts all N back onto one doc →
  straight back into the ~1 write/sec/doc wall → serialization failures + backoff → crippled
  concurrency for a *legitimate* workload. The fix is **randomized agent sharding**: each worker
  picks a shard (random or round-robin) at invoke time, so writes spread across K docs while the
  budget stays **logically isolated per `agentId`**.
  - **Choosing K.** Size K to the expected per-agent parallelism (worker count) —
    `K ≈ ceil(expected_parallel_workers / writes_per_sec_per_doc)`. A solo `low`-tier agent uses
    `K=1`; an Autopilot Support Pod fanning out uses `K` in the small-tens. K is a per-plan /
    per-agent-class config, **not** a global constant, and is a tuning lever (raise K if shard
    contention reappears under the live worker fan-out).
  - **Per-shard sub-cap.** The per-agent runaway cap is split across shards —
    `perShardCapUsd = perAgentCapUsd / K` — so the *sum* of the K shard caps equals the per-agent
    cap. The synchronous deny on a single shard therefore still bounds that shard hard; the
    **headroom rollup sums `reservedUsd + committedUsd` across the agent's K shards** to enforce the
    true per-`agentId` cap (and to catch load skewed onto one shard).
  - Net: a single *logical* agent still cannot run away, but the horizontal-scaling contention the
    naive single-doc design re-introduced is gone.

- **Account-wide check, decoupled from the hot path.** *Peer-review fix 2:* the rev-1 RESERVE
  computed `outstanding = committedUsd + sumReserved(acct)` by **reading the reservations
  subcollection inside the hot-path transaction**. That is a trap — every doc a transaction reads
  joins its validation/mutation footprint, so *any* concurrent commit elsewhere in the account
  aborts and retries this transaction → an **exponential failure rate** under load **and** a
  Firestore **ops-bill blow-up** (each retry re-scans the whole subcollection). We decouple the
  global budget verification from the synchronous write:
  - The async **`aggregateUsage` rollup** (ADR-203 §5.1 Pub/Sub fold, on its few-second cadence)
    computes the account buffer `committedUsd + reservedUsd` and flips a single boolean
    **`headroomExhausted: true|false`** (alongside `status`) on the **single account doc**
    `subscriptions/{accountId}`. No hot-path reader ever scans the subcollection.
  - The hot-path **RESERVE** transaction now reads **only** (a) the account doc — a cheap field
    check `if (status !== 'active' || headroomExhausted) deny(402)` — and (b) the **agent-shard**
    doc for the synchronous per-agent / per-loop cap. **No subcollection scan, no cross-agent read
    locks**, so a commit on one agent's shard can never abort a reserve on another's.
  - **The trade, stated plainly.** `headroomExhausted` is **eventually consistent — a few seconds
    stale** (it lags the rollup cadence). So a **brief, bounded over-admission** is possible in the
    window between rollups when many agents reserve at once just before the flag flips. This is the
    *same accepted soft-limit trade* as the §5.3 rate limiter's ≤1s over-admission, and it is
    acceptable **here** only because the **per-agent-shard cap is the synchronous hard backstop**:
    the account flag is the *global, eventually-consistent* guard, the per-agent-shard cap is the
    *local, synchronous* one. A genuine runaway is still capped — the per-agent cap denies it within
    one transaction and the account flag flips within seconds — so the worst case is a small,
    bounded slice of extra `low`/`mid` spend, **never** an unbounded `high`-tier runaway.
  - At enterprise scale, Memorystore (Redis) is the scale-out account counter, exactly as ADR-203
    §5.3 notes — the serverless default stays Firestore.

**Data model.**

```
subscriptions/{accountId}                         # account budget rollup (read-hot, write-cold)
  plan             : "solopreneur" | "autopilot"
  periodStart, periodEnd
  servingBudgetUsd : number       # SOFT cap — the fair-use ceiling for the period (from plan)
  hardCapUsd       : number       # ABSOLUTE ceiling (e.g. 1.25× soft) → deny-all beyond
  committedUsd     : number       # folded actuals (async, via §5.1 Pub/Sub aggregateUsage)
  reservedUsd      : number       # rev 2: Σ active (non-expired) reservations, folded by the rollup
  headroomExhausted: boolean      # rev 2: set by aggregateUsage when committed+reserved ≥ hardCap
  status           : "active" | "throttled" | "suspended"

subscriptions/{accountId}/agents/{agentId}_{shard}   # rev 2: per-agent SHARDED tracker (txn unit, shard∈[0,K))
  reservedUsd     : number        # outstanding reservations on THIS shard not yet committed
  committedUsd    : number        # actuals committed on THIS shard
  perShardCapUsd  : number        # perAgentCapUsd / K — the per-agent runaway cap split across K shards
  invokeCount     : number        # rolling-window invoke count → loop-rate detection (per shard)
  windowStart     : timestamp
  # the true per-agentId cap = Σ (reservedUsd+committedUsd) over the agent's K shards (folded by the rollup)

subscriptions/{accountId}/reservations/{resId}    # rev 2: reservation LEASE (WAL-frame analog; see §5.5)
  accountId, agentId, shard
  amountUsd       : number        # worst-case estimate at ceilingTier (the headroom this lease holds)
  ceilingTier     : "low" | "mid" | "high"
  createdAt       : timestamp
  expiresAt       : timestamp     # LOGICAL lease deadline the headroom rollup RESPECTS (§5.5)
  state           : "active" | "committed" | "expired"
  actualUsd?      : number        # set at COMMIT
```

**Estimate function (worst-case, never under-reserves).** For ceiling tier = the request's
`max_tier` (the highest tier escalation can reach):

```
estimateUsd = promptTokens · Rate_In[ceilingTier]            # prompt known up front
            + maxTokens     · Rate_Out[ceilingTier]          # worst-case output at the ceiling
```

Over-reservation is *released* at commit (the `estimate − actual` gap returns to headroom), so
it only transiently reduces available budget — the conservative direction (we never admit a
request we couldn't afford at its worst case).

**RESERVE (atomic, pre-invoke) — the deny boundary:**

```
shard = pick_shard(agentId, K)                               # rev 2: random / round-robin per worker
firestore.runTransaction:                                    # reads only TWO single docs — NO subcollection scan
  acct     = get(subscriptions/{acct})                       # cheap field read of the rollup
  shardDoc = get(subscriptions/{acct}/agents/{agentId}_{shard})   # create-if-absent

  # (1) account-wide guard ── DECOUPLED, eventually-consistent (rev 2 fix 2)
  if acct.status != "active" or acct.headroomExhausted:      # boolean set by async aggregateUsage
        DENY 402  { code: "account_budget_exhausted" }        # NO sumReserved() scan on the hot path
  #   (the servingBudget soft-cap warning is likewise raised by the rollup and surfaced as
  #    x_cognitum.fair_use_warning — it is not computed synchronously here)

  # (2) per-agent-SHARD runaway cap ── SYNCHRONOUS hard backstop (rev 2 fix 1)
  if shardDoc.reservedUsd + shardDoc.committedUsd + estimate > shardDoc.perShardCapUsd:
        DENY 402  { code: "agent_budget_exhausted" }          # this shard of a single agent cannot run away
  if rate(shardDoc.invokeCount, shardDoc.windowStart) > maxLoopRate/K:   # loop-rate, per shard
        DENY 429  { code: "loop_detected" }                   # cross-ref ADR-203 §3.5 terminate

  # (3) write the reservation lease (the WAL-frame write)
  shardDoc.reservedUsd += estimate ; shardDoc.invokeCount += 1
  write reservations/{resId} = { state:"active", amountUsd:estimate, ceilingTier,
                                 agentId, shard, createdAt:now, expiresAt: now + lease(reqType) }
COMMIT TXN  →  only now is the provider call invoked
```

**COMMIT (atomic, post-invoke) — actual known:**

```
firestore.runTransaction:                         # rev 2: idempotent on resId (ADR-203 §5.3 Idempotency-Key)
  res = get(reservations/{resId})
  if res.state == "committed": return             # replay / already-committed → no double-charge
  shardDoc = get(subscriptions/{acct}/agents/{agentId}_{res.shard})
  shardDoc.reservedUsd  -= res.amountUsd          # release the lease (even if it already lapsed)
  shardDoc.committedUsd += actualUsd              # record what was really spent
  res.state = "committed" ; res.actualUsd = actualUsd
COMMIT TXN
publish(usageRecord)  →  §5.1 Pub/Sub fold updates acct.{committedUsd, reservedUsd, headroomExhausted} async
```

**Crash / timeout safety (the WAL-recovery analog).** A reservation that is never committed
(agent crashed, stream dropped, timeout) is an **open WAL frame**. Recovery does **not** depend on
physical deletion: each lease carries an `expiresAt` that the headroom rollup **respects** as a
*logical* lease, so the reservation stops consuming budget at lease expiry — *before* Firestore's
(best-effort) native TTL physically deletes the row. The full lease / reconciliation / idempotent-
commit semantics are formalized in **§5.5**. The §5.1 progressive counter still bills any tokens
that *were* generated before the drop (`truncated:true`) — so a dropped stream is **both** un-locked
**and** correctly billed.

### 5.3 How the pieces compose against the dangers

- **Darwin Runaway** → the **RESERVE** step's per-agent cap denies the (N+1)th reservation
  once a looping agent exhausts its `perAgentCapUsd`; ADR-203 §3.5 inflight loop-detection
  *terminates* the loop so it stops reserving at all. Two independent stops: spend-cap (this
  ADR) and loop-kill (ADR-203). The expensive escalation (the §4.3 margin attack) is gated at
  the `ceilingTier` estimate — a runaway that would escalate to `high` reserves the `high`
  worst-case *up front*, so it is denied *before* the first expensive token.
- **Stream-Shaving** → unchanged ADR-203 §5.1: progressive family-correct local token counter
  writes a `truncated:true` floor record on disconnect; the COMMIT path bills it.
- **Lock-contention** → per-agent **sharded** transactional docs `agents/{agentId}_{shard}` (rev 2:
  contention spread across K shards, never re-collapsing onto one doc even when a single `agentId`
  scales to N parallel workers — §5.2 fix 1) + async account fold (ADR-203 §5.1 Pub/Sub) + a
  **read-only, decoupled** account check on the hot path (the `headroomExhausted` flag — §5.2 fix 2,
  **no in-transaction subcollection scan**). No single hot budget doc, no `sumReserved()` read lock.

### 5.4 Rate limiting & idempotency (reused, unchanged)

The ADR-203 §5.3 scatter-gather rate limiter (per-key/per-tier TTL'd `usage_ticks` +
debounced `COUNT()`) and §5.3 idempotency (`Idempotency-Key` → cached, non-re-billed replay)
apply as-is. Reserve-and-Commit sits **above** rate limiting: rate limit answers "too many
requests?", the budget layer answers "too much spend?". A replayed idempotent request
**reuses its original reservation** (no double-reserve). The reservation-lifetime semantics this
idempotent replay relies on are formalized in §5.5.

### 5.5 Reservation TTL, leases & recovery (rev 2)

The rev-2 peer review asked us to **formalize reservation lifetime** — what an outstanding
reservation costs, *when* it stops counting, and *how* a crashed agent's budget is recovered. The
mechanism is a **logical lease**, **not** Firestore's native TTL.

**Reservation lease doc** `reservations/{resId}` (same shape as the §5.2 data model):

```
accountId, agentId, shard
amountUsd   : number      # worst-case estimate at ceilingTier (the headroom this lease holds)
ceilingTier : "low" | "mid" | "high"
createdAt   : timestamp
expiresAt   : timestamp   # the LOGICAL lease deadline (see below)
state       : "active" | "committed" | "expired"
actualUsd?  : number      # set at COMMIT
```

**`expiresAt` is a logical lease the headroom rollup RESPECTS — not a delete timer.** The
`aggregateUsage` rollup computes the live reservation buffer as:

```
reservedUsd = Σ amountUsd  WHERE state == "active" AND expiresAt > now
```

so an **orphaned / crashed reservation stops consuming headroom at `expiresAt`** — *before* any
physical row is removed. **This `expiresAt > now` predicate is the budget-recovery mechanism.**

> **Be explicit:** Firestore **native TTL is best-effort and can lag by hours** — it is **only
> eventual garbage collection of the dead row, NOT the budget-recovery path.** If we relied on
> native TTL to free headroom, a crashed agent could lock its reservation for hours. We do not: the
> rollup excludes a lapsed lease the moment `expiresAt` passes; native TTL just sweeps the row later.

**Lease window is per request TYPE, derived from the request timeout — not a flat constant.** The
lease must be `max-legitimate-request-duration-for-the-ceiling-tier + margin`:
- **short (~60s)** for a normal synchronous completion;
- **long (matching the ADR-203 step-cap, ~20 min)** for buffered / agentic / streaming requests that
  legitimately run long.

It is derived from the *same timeout that bounds the request*, so a valid-but-slow request stays
covered. **Hazard, called out:** a lease set **shorter than a slow-but-valid request** lapses while
that request is still running → its headroom is reclaimed early → **under-reservation / over-
admission** (the account looks like it has more headroom than it truly does). Mitigation: tie the
lease to the *request type's* timeout (long for streaming/agentic), never one global constant — and
keep COMMIT idempotent (below) so a late finish still books correctly.

**Reconciler rides the `aggregateUsage` cadence** (no separate cron job):
1. recompute `reservedUsd` excluding expired leases (the `expiresAt > now` predicate);
2. recompute `committedUsd + reservedUsd` and flip `headroomExhausted` on the account doc (§5.2);
3. mark lapsed leases `state = "expired"`; Firestore native TTL deletes them later (cosmetic GC).

**COMMIT is idempotent on `resId`** (the ADR-203 §5.3 `Idempotency-Key` discipline). A request that
runs **past its lease** still records its actual spend on COMMIT **without double-charging**: the
commit keys on `resId`, releases whatever `reservedUsd` is still attributed to that lease, and books
`actualUsd` exactly once. An expired lease the rollup already excluded is therefore **not
double-counted** when its late COMMIT lands.

**Crash safety, end to end:** reserve → crash (no COMMIT) → `expiresAt` passes → the **next rollup**
drops the lease from `reservedUsd` and re-opens that headroom → **no permanent lock**. A dead agent
costs at most one lease-window of phantom-reserved headroom, itself bounded by the per-shard cap.

---

## Consequences (§6)

**Positive**
- A flat-rate retail product over the ADR-203 wholesale meter, sold against a **measured**
  cost-vs-capability edge, with the margin bet **bounded** (hard cap) and **measurable**
  (`usage_ledger` calibration), not hoped-for.
- The new mechanism is **one** control-plane primitive (Reserve-and-Commit); two of the three
  dangers are already covered by ADR-203, so the new surface is small and the budget doc
  reuses the §5.1 fold and §5.3 sharding discipline.
- "Unlimited" is defensible because it is **honestly fair-use**: the soft/hard cap is stated,
  and the everyday-vs-hard capability scoping is in the marketing, not buried.

**Negative / costs**
- Reserve-and-Commit adds **two transactions per request** (reserve + commit) on the hot
  path — a latency tax. Mitigated by the per-agent doc (uncontended in the common case) and
  by the fact that `low`-tier requests can use a cheaper coarse-grained reservation (reserve
  per *session* not per *call*) since their worst-case cost is tiny.
- The margin depends on the **assumed mix being roughly right**; if the real `f_high` is much
  higher, flat-rate accounts can go negative until prices/caps are re-tuned (§4.5). The hard
  cap bounds the *worst* case but a structurally-wrong mix is a pricing error the cap cannot
  fix — only re-pricing can.
- Soft-cap throttling is a **UX cost**: a heavy legitimate user hitting the cap feels the
  "unlimited" promise break. The cap must be sized (from §4.4 data) so this is rare, and the
  `fair_use_warning` must be surfaced *before* the hard stop, not at it.

**Risks**

| Risk | Mitigation |
|---|---|
| Assumed 75/20/5 mix wrong → margin-negative flat-rate accounts | Calibrate `f_*` and `c_*` from `usage_ledger` (§4.4); hard cap bounds worst case; re-price once measured |
| Darwin Runaway (looping agent → `high` → runaway bill) | **NEW** Reserve-and-Commit per-agent/per-loop cap (§5.2, deny at reserve) **+** ADR-203 §3.5 inflight loop-kill |
| Reserve-and-Commit adds hot-path latency | Per-agent uncontended doc; coarse session-level reservation for `low`-tier; reserve/commit are small single-doc txns |
| Crashed agent locks budget via never-committed reservation | TTL on `reservations` + reconciler rollback (WAL-recovery analog, §5.2) |
| Stream-shaving free inference | ADR-203 §5.1 progressive family-correct local token floor (unchanged) |
| Budget-doc contention under parallel agents | **rev 2:** per-agent doc **sharded** `agents/{agentId}_{shard}` (K-way) + async account fold (ADR-203 §5.1/§5.3 discipline); Memorystore at scale (§5.2) |
| **rev 2 — Multi-worker `agentId` contention** (a Support Pod scales to N workers under one `agentId` → all serialize on one doc → ~1 write/sec/doc wall → crippled concurrency) | **Randomized agent sharding** `agents/{agentId}_{shard}`, K sized to expected per-agent parallelism; per-shard sub-cap `perAgentCapUsd/K`; headroom rollup sums `reserved+committed` across the agent's K shards (§5.2 fix 1) |
| **rev 2 — Stale-flag over-admission** (eventually-consistent `headroomExhausted` lags the rollup → brief over-admit in the window between folds) | **Bounded & accepted** — same soft-limit trade as §5.3's ≤1s over-admission; the **synchronous per-agent-shard cap is the hard backstop** and the flag flips within seconds → worst case is a small `low`/`mid` slice, never an unbounded `high`-tier runaway (§5.2 fix 2) |
| **rev 2 — Lease too short → under-reservation** (a lease shorter than a slow-but-valid request reclaims its headroom early → over-admission) | Lease = **per-request-type** max-duration + margin (≈60s sync, ≈20 min streaming/agentic), derived from the request timeout — never a flat constant; idempotent COMMIT books a late finish without double-charge (§5.5) |
| "Unlimited" mis-sold as literal-infinite | Marketing states fair-use / soft-cap plainly (§3.3); capability scoped everyday-vs-hard |
| Over-claiming "80–85% of frontier" on hard tasks | Claim scoped to **everyday** work (measured tie); hard-task ceiling stated as structural (measured) — High tier exists *because* of it |

---

## 7. Alternatives considered

1. **Pure usage-based billing (ADR-203 as the retail product).** Honest and zero margin risk,
   but loses the flat-rate market entirely (cost-anxiety kills conversion for solopreneurs and
   "run it all day" agentic users). **Rejected as the retail product; kept as the wholesale
   primitive** this ADR packages over.
2. **Flat-rate with no Reserve-and-Commit (trust rate limits + post-hoc ledger).** Simplest,
   but the Darwin Runaway can overspend *before* the post-hoc ledger notices — exactly the
   uncovered danger. Rate limits cap *request count*, not *spend* (a few `high` calls cost more
   than thousands of `low` calls). **Rejected:** spend must be gated at the write boundary, not
   reconciled after.
3. **Hybrid: flat base fee + metered overage above the soft cap.** A real contender — it
   removes the hard-cap UX cliff (heavy users pay-as-they-go past the soft cap instead of being
   throttled) and de-risks the mis-estimated-mix margin (overage recovers the cost of a heavy
   `high`-tier user). **Deferred, not rejected:** it is the natural v2 once `usage_ledger`
   calibration (§4.4) shows where the real soft cap should sit; v1 ships the cleaner flat-rate +
   throttle to keep the "unlimited-feel" promise crisp, and the Reserve-and-Commit layer already
   has the per-account spend accounting that metered-overage would bill from.
4. **Single "unlimited" tier (no Solopreneur/Autopilot split).** Rejected: it forces one price
   to cover both the cheap-only everyday user and the escalating power user, mispricing both;
   the measured structural cheap-tier ceiling (§3.3) is precisely the line the two-bundle split
   is drawn along.

---

## 8. Test contract

For this decision to be considered shipped (emulator-first, $0 — ADR-203 §7.3):

- **Reserve denies at the boundary.** A reservation that would breach `perAgentCapUsd` /
  `hardCapUsd` is denied (402) and **no provider call is invoked** (mock-provider call count
  unchanged). London-school: mock the provider, assert zero invocations on deny.
- **Commit releases and reconciles.** After COMMIT, the agent-shard `reservedUsd` returns to its
  pre-reserve value, `committedUsd` reflects the actual, and `estimate − actual` headroom is
  reclaimed.
- **Logical-lease recovery (rev 2).** An `active` reservation whose `expiresAt` has passed is
  **excluded from `reservedUsd` by the next rollup** (`expiresAt > now` predicate) — headroom is
  recovered **before** any physical TTL delete; the reconciler then marks it `state:"expired"`. Any
  tokens generated before the drop are still billed (`truncated:true`).
- **Idempotent COMMIT past lease (rev 2).** A COMMIT landing after `expiresAt` books `actualUsd`
  **exactly once** keyed on `resId`; an already-`committed` reservation re-COMMITted is a no-op
  (no double-charge, no double-count against an already-excluded lease).
- **No double-reserve on idempotent replay.** A replayed `Idempotency-Key` reuses the original
  reservation (ADR-203 §5.3) — reservation count unchanged.
- **Per-agent contention isolation (rev 2).** Parallel reservations across distinct `agentId`s do
  not serialize, **and** N parallel workers under the *same* `agentId` spread across the K
  `agents/{agentId}_{shard}` docs rather than collapsing onto one (integration test against the
  Firestore emulator), while their summed per-shard caps still enforce the per-`agentId` cap.
- **No subcollection scan on the hot path (rev 2).** The RESERVE transaction reads exactly two docs
  (account + agent-shard); asserting it never reads the `reservations` subcollection guards against
  the `sumReserved()` abort-storm regression.
- **Blended-cost / break-even calculator** (the §4 formula) is a pure unit under test with the
  assumed inputs producing $1.06/1M and 188M-token break-even — and **fails loudly if the
  inputs are still the placeholders** at launch-config time (a guard that the §4.4 calibration
  was wired, not skipped).
- **Capability-claim scoping** is asserted in the product copy lint: no "80–85% of frontier"
  string without the everyday-vs-hard qualifier (ADR-203 §8 conformance posture).

---

## 9. References

- **PLACEMENT.md** (`docs/research/retort-placement/`) — measured cost-vs-capability Pareto
  (cheap 0.954 vs frontier 0.958 coverage at ~12× lower cost; cost ANOVA 78.1% tier-governed;
  structural cheap-tier ceiling, base-model effect 0.3% p=0.70). The only hard data here.
- **ADR-203** §3.3 (streaming routing), §3.5 (inflight loop-detection / runaway terminate),
  §4.1 (tier rationale), §5.1 (progressive token accounting — stream-shaving), §5.2 (pricing),
  §5.3 (scatter-gather rate limit — contention wall), §6.5 (τ internal/adaptive), §8 (honesty).
- **ADR-201** (cheap-model lift / cheap-vs-frontier); **ADR-150** (removable-augmentation,
  $0 local inference); **ADR-180** (Firestore durable store).
- **AgentBBS** `BbsRoomBudgetTracker` / better-sqlite3-WAL reserve-and-commit (conceptual prior
  art for per-room spend reservation; re-derived for Firestore in §5.2).
- **cognitum-one/api** ADR-092 (`cog_…` keys, gateway); **AgentBBS** ADR-0012 (emulator-first GCP).

---

## Peer review addressed (rev 2)

This revision answers a peer review of the §5 Reserve-and-Commit design. **No business-model,
pricing, or measured-vs-assumed claim changed** — the §4 financial model, the PLACEMENT grounding,
and the measured-vs-assumed table are untouched. The fixes are confined to the **distributed budget
mechanism** (§5.2, §5.5) and its risk register. Status remains **Proposed**.

> **Section-numbering note.** This ADR's risk register lives in **§6 (Consequences → Risks)**, not a
> standalone "§10" — the three new risks below were added there.

1. **Multi-worker `agentId` contention (§5.2 fix 1).** The rev-1 claim that a single
   `agents/{agentId}` doc's serialization is "the throttle we want" **breaks under horizontal
   scaling**: a Support Pod fanning out to N parallel workers under one `agentId` puts all N back
   onto one doc → Firestore's ~1 write/sec/doc wall → serialization failures + backoff → crippled
   concurrency for a *legitimate* workload. **Fix:** randomized agent **sharding**
   `agents/{agentId}_{shard}`, `shard ∈ [0,K)`, K sized to expected parallelism; per-shard sub-cap
   `perAgentCapUsd / K`; the headroom rollup sums `reserved+committed` across the agent's K shards to
   enforce the true per-`agentId` cap. Budget stays logically isolated per `agentId`; choosing K and
   the per-shard sub-cap are documented.

2. **The `sumReserved(acct)` in-transaction read trap (§5.2 fix 2).** Rev 1 computed
   `outstanding = committedUsd + sumReserved(acct)` by reading the reservations subcollection
   **inside the hot-path transaction**. Every read joins the transaction's footprint, so any
   concurrent commit in the account aborts+retries this transaction → an **exponential failure rate**
   **and** a Firestore **ops-bill blow-up** (each retry re-scans the subcollection). **Fix:** decouple
   the global budget verification from the hot-path write. The async `aggregateUsage` rollup (ADR-203
   §5.1 Pub/Sub cadence, every few seconds) folds `committedUsd + reservedUsd` and flips a boolean
   **`headroomExhausted`** (+ `status`) on the single account doc `subscriptions/{accountId}`. The
   RESERVE transaction now reads **only** the account doc (cheap `status/headroomExhausted` check) and
   the **agent-shard** doc (synchronous per-agent/per-loop cap) — **no subcollection scan, no
   cross-agent read locks.** **Trade, stated plainly:** the account flag is eventually-consistent (a
   few seconds stale) → brief, bounded over-admission is possible between rollups (the same accepted
   soft-limit trade as the §5.3 rate limiter); the **per-agent-shard cap is the synchronous hard
   backstop**, the account flag the global eventually-consistent guard — so a runaway is still capped
   (per-agent cap synchronous + flag flips within seconds).

3. **Reservation TTL, leases & recovery — new §5.5.** Formalizes reservation lifetime. Each
   `reservations/{resId}` carries `accountId, agentId, shard, amountUsd (worst-case at ceilingTier),
   createdAt, expiresAt, state(active|committed|expired)`. **`expiresAt` is a logical lease the
   headroom rollup respects** (`reservedUsd = Σ active WHERE expiresAt > now`), so a crashed
   reservation stops consuming headroom at lease expiry — **Firestore native TTL is best-effort (can
   lag hours) and is only eventual GC, never the budget-recovery path.** The lease window is **per
   request type**, derived from the request timeout (≈60s sync; ≈20 min, matching the ADR-203
   step-cap, for buffered/agentic/streaming), with the **lease-too-short → under-reservation /
   over-admission** hazard called out. The reconciler rides the `aggregateUsage` cadence; **COMMIT is
   idempotent on `resId`** so a request past its lease still books actuals without double-charging;
   crash → no commit → `expiresAt` passes → next rollup recovers headroom (no permanent lock).

4. **Risk register updated (§6).** Three rows added — multi-worker contention, stale-flag
   over-admission, lease-too-short under-reservation — each with its mitigation; the existing
   "budget-doc contention" row now reflects sharding. Companion consistency edits landed in §5.3
   (compose-against-dangers) and §8 (test contract: shard-isolation, no-subcollection-scan,
   logical-lease recovery, idempotent late-COMMIT).
