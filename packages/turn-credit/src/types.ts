// @metaharness/turn-credit — types (ADR-248). Offline recursive turn-level credit
// assignment (AgentOPSD, arXiv:2608.05987) for perpetual-agent trajectories.
//
// THESIS: a terminal success/failure score says nothing about which of 30 actions
// mattered. This package converts per-turn evidence (teacher-vs-student contrast)
// into a recursively-updated belief in eventual success, and turns marginal belief
// revisions into BOUNDED per-turn weights that modulate — never reverse — the
// verifier's terminal decision.
//
// HONEST BOUND: this is a trace POST-PROCESSOR. It never updates model weights;
// its outputs are advisory signals for routing, retry policy, retrieval feedback,
// and Darwin mutation promotion. The 'verifier-delta-proxy' evidence mode (for
// hosted models without token probabilities) is NOT AgentOPSD proper and is
// labelled as such in every artifact it touches. The source paper is a v1
// preprint (single model family, no multi-seed CIs) — gate any trust escalation
// behind your own acceptance run.

/** How the per-turn evidence e_k was produced.
 *  - 'logprob-gap': AgentOPSD proper — summed token-level log-probability gaps
 *    between the skill-conditioned (teacher) and unconditioned (student) pass.
 *  - 'verifier-delta-proxy': EXPERIMENTAL — a structured verifier score delta
 *    (with-context minus without-context) for hosted models that expose no token
 *    probabilities. Carried as `proxy: true` everywhere downstream. */
export type EvidenceMode = 'logprob-gap' | 'verifier-delta-proxy';

/** One turn's scalar evidence e_k toward eventual success (log-odds units in
 *  'logprob-gap' mode; scaled score delta in proxy mode). `label` is optional
 *  free-form attribution (tool name, route, 'retry', mutation surface, …). */
export interface TurnEvidence {
  turn: number;
  evidence: number;
  label?: string;
}

/** The knobs of the belief recursion + bounded reshaping (paper defaults). */
export interface CreditConfig {
  /** Evidence decay γ ∈ (0,1] in c_k = γ·c_{k-1} + e_k. Paper default 0.95. */
  gamma: number;
  /** Prior clip ε₀: B₀ = clip(prior, ε₀, 1−ε₀) keeps log-odds finite for unanimous groups. */
  priorEpsilon: number;
  /** Reshape half-width b ∈ (0,1): w_k = clip(1 + b·z_k, 1−b, 1+b). Paper default 0.5. */
  bound: number;
  /** Mixing strength λ ∈ [0,1]: multiplier m_k = (1−λ) + λ·w_k. Paper default 0.5. */
  mix: number;
  /** A turn is pivotal when |ΔB_k| ≥ pivotalRatio · max_j|ΔB_j| (and > 0). */
  pivotalRatio: number;
}

/** Paper defaults (γ=0.95, ε₀=1e-4, b=0.5, λ=0.5). Effective per-turn advantage
 *  modulation is bounded by λ·b = ±25%. */
export const PAPER_DEFAULTS: CreditConfig = {
  gamma: 0.95,
  priorEpsilon: 1e-4,
  bound: 0.5,
  mix: 0.5,
  pivotalRatio: 0.5,
};

/** Governed preset: λ·b = 0.1 — reshaping can move any turn's original advantage
 *  by at most ±10%, the invariant that fits a receipt-gated flywheel. */
export const GOVERNED_DEFAULTS: CreditConfig = {
  ...PAPER_DEFAULTS,
  bound: 0.2,
  mix: 0.5,
};

/** One step of the belief recursion (all values round6'd for byte-stable artifacts). */
export interface BeliefStep {
  turn: number;
  /** e_k as supplied. */
  evidence: number;
  /** c_k = γ·c_{k-1} + e_k. */
  accumulated: number;
  /** ℓ_k = logit(B₀) + c_k. */
  logOdds: number;
  /** B_k = σ(ℓ_k). */
  belief: number;
  /** ΔB_k = B_k − B_{k-1} — the marginal belief revision (the credit signal). */
  revision: number;
}

/** One turn's final credit after outcome alignment + bounded reshaping. */
export interface TurnCredit {
  turn: number;
  label?: string;
  /** ΔB_k. */
  revision: number;
  /** q_k = sign(A_seq)·ΔB_k — revision aligned with the terminal outcome. */
  credit: number;
  /** Within-trajectory standardized credit z_k. */
  z: number;
  /** Bounded weight w_k ∈ [1−b, 1+b]. */
  weight: number;
  /** Final multiplier m_k = (1−λ) + λ·w_k — apply as Ã_k = A_seq · m_k. */
  multiplier: number;
  pivotal: boolean;
}

/** The full processed trajectory — the unit stored, signed, and consumed downstream. */
export interface TrajectoryCredit {
  schema: 'turn-credit/v1';
  mode: EvidenceMode;
  /** True iff mode is the verifier-delta proxy (NOT AgentOPSD proper). */
  proxy: boolean;
  /** Clipped prior B₀ (e.g. the GRPO group success rate). */
  prior: number;
  /** Terminal sequence advantage A_seq the credits modulate. */
  advantage: number;
  /** sign(A_seq) ∈ {−1, 0, +1}. */
  outcomeSign: number;
  steps: BeliefStep[];
  credits: TurnCredit[];
  pivotalTurns: number[];
  /** λ·b — the guaranteed ceiling on per-turn advantage modulation (fraction of |A_seq|). */
  boundPct: number;
  config: CreditConfig;
}

/** A with/without-context verifier score pair for one turn (proxy mode input).
 *  Producing these — one teacher scoring pass per trajectory, with a RuVector-
 *  retrieved skill or prior pattern as the privileged context — is the caller's
 *  job; this package only consumes the pairs. */
export interface ScorePair {
  turn: number;
  label?: string;
  /** Verifier score of the recorded action WITH the retrieved context visible. */
  scoreWith: number;
  /** Verifier score of the same recorded action WITHOUT the context. */
  scoreWithout: number;
}

/** Token log-probability pair for one turn ('logprob-gap' mode input). */
export interface LogProbPair {
  turn: number;
  label?: string;
  /** Per-token log-probs of the recorded action under the skill-conditioned pass. */
  withContext: number[];
  /** Per-token log-probs of the recorded action under the plain pass. */
  withoutContext: number[];
}
