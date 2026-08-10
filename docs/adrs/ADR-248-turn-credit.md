# ADR-248: @metaharness/turn-credit — offline recursive turn-level credit assignment (AgentOPSD)

- **Status**: Accepted — processor + adapters + receipt payload shipped ($0, pure, 20 tests); model-weight training explicitly deferred behind the §6 acceptance gate.
- **Date**: 2026-08-10
- **Deciders**: ruv
- **Tags**: credit-assignment, turn-level, belief-update, advantage-reshaping, long-horizon, darwin-mode, flywheel, receipts, ruflo, sona, ruvector, metaharness
- **Source**: AgentOPSD (arXiv:2608.05987v1, Aug 2026) — recursive teacher-student belief updates for turn-level credit
- **Artifacts**: `packages/turn-credit/src/{types,belief,reshape,processor,adapters,receipt,cli,index}.ts`, `packages/turn-credit/__tests__/turn-credit.test.ts`

---

## 1. Context

A perpetual agent's terminal success/failure score says nothing about which of 30 actions mattered.
Uniform credit (GRPO-style) degrades fast with horizon; AgentOPSD reports −0.54 success points per
additional ALFWorld turn versus −2.91 for GRPO. The mechanism: aggregate teacher-vs-student evidence
per turn, recursively update a Bayesian belief in eventual success in log-odds space, and use the
*marginal belief revision* per turn as the credit signal — no critic, no extra environment rollouts,
one teacher scoring pass per trajectory.

The valuable part for this repo is the **credit mechanism**, not the RL training. RuFlo/SONA need
per-decision credit (tools, routes, retries); Darwin needs to know whether a mutation *earned* the
outcome change; RuVector retrieval wants credit-weighted feedback; receipts need the belief revisions
as audit evidence. All of that is model-independent and reversible.

## 2. Decision

Ship `@metaharness/turn-credit` — a pure, dependency-free (Node built-ins), phase-1 package:

- **Belief recursion** (`belief.ts`): `B₀ = clip(prior, ε₀, 1−ε₀)` (ε₀=1e-4, prior = group success
  rate S/G or historical base rate), `c_k = γ·c_{k−1} + e_k` (γ=0.95), `B_k = σ(logit(B₀) + c_k)`,
  credit signal `ΔB_k = B_k − B_{k−1}`.
- **Outcome alignment + bounded reshaping** (`reshape.ts`): `q_k = sign(A_seq)·ΔB_k`,
  within-trajectory standardization, `w_k = clip(1 + b·z_k, 1−b, 1+b)`, multiplier
  `m_k = (1−λ) + λ·w_k`. **Invariant (tested): m_k > 0 and |m_k − 1| ≤ λ·b, so reshaping modulates
  emphasis and can never reverse the verifier's decision.** Paper defaults (b=0.5, λ=0.5) bound
  modulation at ±25%; `GOVERNED_DEFAULTS` (b=0.2) caps it at **±10%** for the receipt-gated flywheel.
- **Two evidence modes** (`processor.ts`): `logprob-gap` (AgentOPSD proper — summed token log-prob
  gaps between the skill-conditioned and plain pass) and `verifier-delta-proxy` (structured verifier
  score delta for hosted models without token probabilities). The proxy is **not AgentOPSD proper**
  and is carried as `proxy: true` in every credit, receipt payload, and CLI line.
- **Pivotal turns**: `|ΔB_k| ≥ pivotalRatio·max|ΔB|` — the turns that moved the belief.
- **Adapters** (`adapters.ts`, structurally typed, no sibling imports): `creditByLabel` (which
  decisions/tools/routes/retries mattered — the RuFlo/SONA consumption), `attributeMutation`
  (parent-vs-child per-label credit deltas + whether the mutated surface improved — Darwin evidence,
  **never a gate by itself**), `toQualityLabels` (RouterExample.quality seam), `toMemoryFeedback`
  (the existing `MemoryLayer.feedback({retrievedIds, resolved, weight})` seam, credit-weighted).
- **Receipt payload** (`receipt.ts`): belief revisions, bounded weights, pivotal turns, outcome
  alignment, `boundPct`, `verifierVersion`, retrieved-evidence digest, trajectory digest, credit
  digest — sorted-key canonical JSON, sha256. Drops into the flywheel's Ed25519 `Signer.sign(payload)`
  open bag or a harness ReceiptLog step. Signing stays where the keys live.
- **CLI** (`cli.ts`): `metaharness turn-credit process|report`, `{code, lines}` dispatch convention;
  surfaced via a `turn-credit` case in `create-agent-harness`.

The teacher scoring pass that *produces* evidence (replay each recorded action with and without a
RuVector-retrieved skill/pattern as privileged context) happens **upstream in the caller** — RuFlo's
replay machinery in the companion repo, or any host harness. This package only consumes the pairs,
which is what keeps it $0, pure, and host-agnostic.

## 3. Consequences

- RuFlo/SONA, Darwin, router, and retrieval each gain a per-turn credit signal from data they already
  record; nothing existing changes behavior until a caller opts in. `meetsPromotionRule`, the Darwin
  scorer, and all gates are untouched — credit is ADDITIONAL evidence.
- Belief revisions and pivotal turns become signable audit artifacts (tamper-evident digests), so a
  credit-influenced decision can be replayed and re-checked by an external reviewer.
- Cross-repo split follows the ADR-324 precedent: MetaHarness owns the processor; RuFlo (companion
  repo) owns wiring its replay/teacher pass and emitting `ScorePair`s. That wiring is a separate PR
  in `ruvnet/ruflo`.

## 4. Honest bounds

- **Advisory, model-independent, reversible.** No model weights are updated anywhere. Deleting the
  package (or ignoring its outputs) restores prior behavior exactly.
- **The proxy mode is an experiment**, labelled as such end-to-end; treat magnitudes as ordinal.
- **Source reproducibility is unproven**: v1 preprint, Qwen2.5 3B/7B only, no multi-seed CIs,
  training code "coming". That is precisely why this ADR ships the mechanism, not the training.

## 5. Alternatives considered

- *Inside darwin-mode or flywheel*: couples a generic trace primitive to one consumer; both stay
  clean by importing (or being fed by) turn-credit instead.
- *Unbounded reward redistribution*: rejected — the λ·b bound is the safety property that makes the
  signal compatible with a governed, receipt-gated promotion loop.
- *Learned critic*: rejected — reintroduces the training dependency the mechanism exists to avoid.

## 6. Acceptance gate (before any trust escalation or model training)

Run 300 long-horizon RuFlo tasks across three seeds. Proceed only if recursive credit improves
verified completion by ≥5 percentage points, adds <20% processing cost, and produces zero increase
in verifier gaming or governance violations. Until then, credit signals stay advisory.
