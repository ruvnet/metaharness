// @metaharness/turn-credit — the offline processor (ADR-248 §4). One call turns a
// recorded trajectory's per-turn evidence into a TrajectoryCredit: belief steps,
// aligned+bounded per-turn credits, and pivotal-turn identification. Pure and
// deterministic; the (single) teacher scoring pass that PRODUCES the evidence
// happens upstream, in the caller.

import { beliefTrajectory, clipPrior, round6 } from './belief.js';
import { effectiveBound, markPivotal, outcomeSign, reshapeCredits } from './reshape.js';
import { PAPER_DEFAULTS } from './types.js';
import type {
  CreditConfig,
  EvidenceMode,
  LogProbPair,
  ScorePair,
  TrajectoryCredit,
  TurnEvidence,
} from './types.js';

export interface ProcessInput {
  /** Ordered per-turn evidence e_k. Build with {@link evidenceFromLogProbs} (AgentOPSD
   *  proper) or {@link evidenceFromScorePairs} (labelled verifier-delta proxy). */
  evidence: TurnEvidence[];
  mode: EvidenceMode;
  /** Raw prior — e.g. the GRPO group success rate S/G, or a historical task base
   *  rate for a lone trajectory. Clipped to (ε₀, 1−ε₀) internally. */
  prior: number;
  /** Terminal sequence advantage. If omitted, derived as (success ? 1 : 0) − prior. */
  advantage?: number;
  /** Terminal verifier outcome — used only when `advantage` is omitted. */
  success?: boolean;
  config?: Partial<CreditConfig>;
}

/** Derive a GRPO-style advantage from a verified terminal outcome and the group prior. */
export function advantageFromOutcome(success: boolean, prior: number): number {
  return round6((success ? 1 : 0) - prior);
}

/** AgentOPSD proper: e_k = Σ_t [log π(y_t | s, c⁺, y_<t) − log π(y_t | s, y_<t)]. */
export function evidenceFromLogProbs(pairs: LogProbPair[]): TurnEvidence[] {
  return pairs.map((p) => {
    if (p.withContext.length !== p.withoutContext.length) {
      throw new Error(`turn ${p.turn}: with/without token counts differ (${p.withContext.length} vs ${p.withoutContext.length})`);
    }
    const evidence = p.withContext.reduce((acc, lp, i) => acc + (lp - p.withoutContext[i]), 0);
    return { turn: p.turn, evidence: round6(evidence), ...(p.label !== undefined ? { label: p.label } : {}) };
  });
}

/** Verifier-delta PROXY (not AgentOPSD proper): e_k = scale·(scoreWith − scoreWithout).
 *  `scale` converts the verifier's score units into log-odds-comparable evidence;
 *  keep it small (default 1) and treat magnitudes as ordinal, not calibrated. */
export function evidenceFromScorePairs(pairs: ScorePair[], scale = 1): TurnEvidence[] {
  return pairs.map((p) => ({
    turn: p.turn,
    evidence: round6(scale * (p.scoreWith - p.scoreWithout)),
    ...(p.label !== undefined ? { label: p.label } : {}),
  }));
}

/** Process one recorded trajectory into its full credit assignment. */
export function processTrajectory(input: ProcessInput): TrajectoryCredit {
  const config: CreditConfig = { ...PAPER_DEFAULTS, ...input.config };
  if (!(config.gamma > 0 && config.gamma <= 1)) throw new Error('gamma must be in (0, 1]');
  if (!(config.bound > 0 && config.bound < 1)) throw new Error('bound must be in (0, 1)');
  if (!(config.mix >= 0 && config.mix <= 1)) throw new Error('mix must be in [0, 1]');
  const prior = clipPrior(input.prior, config.priorEpsilon);
  const advantage =
    input.advantage !== undefined
      ? input.advantage
      : advantageFromOutcome(input.success === true, prior);
  const steps = beliefTrajectory(input.evidence, prior, config.gamma);
  const labels = new Map<number, string>();
  for (const e of input.evidence) if (e.label !== undefined) labels.set(e.turn, e.label);
  const credits = reshapeCredits(steps, advantage, config, labels);
  const pivotalTurns = markPivotal(credits, config.pivotalRatio);
  return {
    schema: 'turn-credit/v1',
    mode: input.mode,
    proxy: input.mode === 'verifier-delta-proxy',
    prior: round6(prior),
    advantage: round6(advantage),
    outcomeSign: outcomeSign(advantage),
    steps,
    credits,
    pivotalTurns,
    boundPct: effectiveBound(config),
    config,
  };
}
