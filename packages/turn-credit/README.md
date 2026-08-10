# @metaharness/turn-credit

Offline **recursive turn-level credit assignment** for agent trajectories, after
AgentOPSD ([arXiv:2608.05987](https://arxiv.org/abs/2608.05987)). A terminal
success/failure score says nothing about which of 30 actions mattered. This
package converts per-turn evidence into a recursively-updated belief in eventual
success, and turns marginal belief revisions into **bounded** per-turn weights
that modulate — never reverse — the verifier's terminal decision.

No critic, no extra environment rollouts. The one cost is a single teacher
scoring pass per trajectory (produced upstream by the caller — e.g. a RuFlo
replay with a RuVector-retrieved skill as privileged context).

## The mechanism

```
B0  = clip(prior, e0, 1-e0)      verifier-grounded prior (e.g. group success rate)
c_k = g*c_{k-1} + e_k            decayed evidence accumulation      (g = 0.95)
B_k = sigmoid(logit(B0) + c_k)   belief in eventual success after turn k
dB_k = B_k - B_{k-1}             marginal belief revision — the credit signal

q_k = sign(A_seq) * dB_k         outcome alignment
z_k = standardize(q_k)           within-trajectory
w_k = clip(1 + b*z_k, 1-b, 1+b)  bounded weight                     (b = 0.5)
m_k = (1-l) + l*w_k              final multiplier; A~_k = A_seq * m_k  (l = 0.5)
```

**Safety invariant:** `m_k ∈ [1 − λ·b, 1 + λ·b]` and strictly positive, so
`sign(Ã_k) = sign(A_seq)` always. Paper defaults bound modulation at ±25%;
`GOVERNED_DEFAULTS` caps it at **±10%** for receipt-gated flywheels.

## Evidence modes

- `logprob-gap` — AgentOPSD proper: summed token-level log-probability gaps
  between the skill-conditioned and plain pass of the **same** recorded action.
- `verifier-delta-proxy` — EXPERIMENTAL stand-in for hosted models without token
  probabilities: a structured verifier score delta (with vs. without context).
  Carried as `proxy: true` in every credit, receipt, and CLI line it touches.

## Usage

```ts
import {
  processTrajectory, evidenceFromScorePairs, GOVERNED_DEFAULTS,
  creditByLabel, attributeMutation, toMemoryFeedback, buildCreditReceiptPayload,
} from '@metaharness/turn-credit';

const credit = processTrajectory({
  evidence: evidenceFromScorePairs(pairs),  // one teacher pass, produced upstream
  mode: 'verifier-delta-proxy',
  prior: 0.3,                               // group success rate S/G
  success: true,
  config: GOVERNED_DEFAULTS,                // ±10% bounded reshaping
});

creditByLabel(credit);                      // which tools/routes/retries mattered
attributeMutation(parent, child, 'retryPolicy'); // Darwin: did the mutation earn it?
toMemoryFeedback(credit, retrievedIdsByTurn);    // credit-weighted retrieval feedback
signer.sign(buildCreditReceiptPayload({ credit, verifierVersion, retrievedEvidence, trajectory }));
```

CLI: `metaharness turn-credit process <input.json> [--out credit.json] [--governed]`,
then `metaharness turn-credit report <credit.json>`.

## Honest bounds

- **Advisory only.** Outputs feed routing quality labels, retry/tool analysis,
  retrieval feedback, and mutation attribution. Nothing here updates model
  weights, and `attributeMutation` is evidence for a promotion gate, not a gate.
- **The proxy mode is not AgentOPSD.** Treat proxy magnitudes as ordinal.
- **The source is a v1 preprint** (single model family, no multi-seed CIs).
  Gate any trust escalation behind your own acceptance run — see ADR-248's
  acceptance criteria.
