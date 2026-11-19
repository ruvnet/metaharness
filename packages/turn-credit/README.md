# @metaharness/turn-credit

<!-- ruv-seo:start (ADR-356) -->

Offline turn-level credit assignment for recorded agent trajectories: it turns one sparse success or failure into bounded per-turn weights, so you can see which tools, routes or retries mattered. It is advisory only: it never flips the verifier's outcome and never updates model weights.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). Pure JavaScript, no native build step. Dependency-free (Node built-ins only).

## Quickstart

```bash
mkdir demo && cd demo && npm init -y >/dev/null
npm install @metaharness/turn-credit
cat > quickstart.mjs <<'EOF'
import { processTrajectory, evidenceFromScorePairs, GOVERNED_DEFAULTS, creditByLabel } from '@metaharness/turn-credit';
const pairs = [
  { turn: 0, label: 'search', scoreWith: 0.4, scoreWithout: 0.4 },
  { turn: 1, label: 'read-file', scoreWith: 0.9, scoreWithout: 0.3 },
  { turn: 2, label: 'retry', scoreWith: 0.5, scoreWithout: 0.6 },
];
const credit = processTrajectory({
  evidence: evidenceFromScorePairs(pairs), mode: 'verifier-delta-proxy',
  prior: 0.3, success: true, config: GOVERNED_DEFAULTS,
});
console.log('bound:', credit.boundPct, 'pivotal turns:', credit.pivotalTurns);
for (const c of credit.credits) console.log(`turn ${c.turn} ${c.label}: multiplier ${c.multiplier}`);
console.log('top label:', creditByLabel(credit)[0].label);
EOF
node quickstart.mjs
```

Expected output:

```text
bound: 0.1 pivotal turns: [ 1 ]
turn 0 search: multiplier 0.951902
turn 1 read-file: multiplier 1.1
turn 2 retry: multiplier 0.909051
top label: read-file
```

**Next:** [`@metaharness/flywheel`](https://www.npmjs.com/package/@metaharness/flywheel) — the promotion loop that can consume these credits as advisory evidence.

**Where it fits:** `metaharness` depends on it and forwards `npx metaharness turn-credit <process|report>` to its CLI (`@metaharness/turn-credit/cli`, see `packages/create-agent-harness/src/index.ts`).
<!-- ruv-seo:end -->

## Reference

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
