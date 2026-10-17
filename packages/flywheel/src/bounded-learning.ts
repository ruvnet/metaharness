import { createHash } from 'node:crypto';
import { canon } from './receipts.js';
import type { Policy, PromotionReceipt, Signer } from './types.js';

/** Trusted host adapters only. This API is not a process or network sandbox. */
export type LearningStage = 'train' | 'confirm' | 'rewrite' | 'remove' | 'corrupt';
export interface LearningObservation {
  successes: number;
  trials: number;
  costMicroUsd: number;
  permissionViolations: number;
}
export interface LearningReply<T> { value: T; costMicroUsd: number }
export interface LearningAdapters {
  /** Receives training results only. Never receives confirmation items or scores. */
  propose(input: { baseline: Policy; training: LearningObservation[]; round: number },
    limits: { maxCostMicroUsd: number; signal: AbortSignal }): Promise<LearningReply<Policy>>;
  /** Resolve private suite IDs inside the trusted evaluator, not the proposer. */
  evaluate(policy: Policy, family: string, stage: LearningStage,
    limits: { maxCostMicroUsd: number; signal: AbortSignal }): Promise<LearningObservation>;
}
export interface BoundedLearningConfig {
  baseline: Policy;
  families: string[];
  allowedLevers: string[];
  sourceDigest: string;
  trainingDigest: string;
  confirmationDigest: string;
  evidenceClass: 'synthetic' | 'independent_confirmation';
  maxRounds: number;
  maxCalls: number;
  maxCostMicroUsd: number;
  perCallCostMicroUsd: number;
  timeoutMs: number;
}
export interface LearningRecord {
  kind: 'propose' | LearningStage;
  family?: string;
  policyDigest?: string;
  costMicroUsd: number;
  observation?: LearningObservation;
}
export interface BoundedLearningResult {
  verdict: 'REVIEW_REQUIRED' | 'REJECTED';
  authority: 'none';
  reasons: string[];
  candidate: Policy | null;
  records: LearningRecord[];
  calls: number;
  costMicroUsd: number;
  receipt: PromotionReceipt;
}
const digest = (value: unknown) => createHash('sha256').update(canon(value)).digest('hex');
const integer = (n: number, min = 0) => Number.isSafeInteger(n) && n >= min;
function policyOK(p: Policy, base: Policy, allowed: string[]) {
  return p && typeof p === 'object' && !Array.isArray(p) &&
    Object.keys(p).sort().join('\0') === Object.keys(base).sort().join('\0') &&
    Object.entries(p).every(([k, v]) => typeof v === 'string' && v.length <= 65536 &&
      (allowed.includes(k) || v === base[k]));
}
function observationOK(o: LearningObservation) {
  return o && integer(o.trials, 1) && integer(o.successes) && o.successes <= o.trials &&
    integer(o.costMicroUsd, 1) && integer(o.permissionViolations);
}
const efficiency = (o: LearningObservation) => o.successes / o.costMicroUsd;

/** Additive propose/probe/confirm path. No automatic promotion or model-weight updates.
 * Costs include all attempts, training and drift evaluation. Adapters must enforce provider
 * reservations and terminate their worker on abort; Promise timeouts alone cannot kill a process.
 */
export async function runBoundedLearning(input: BoundedLearningConfig, adapters: LearningAdapters,
  signer: Signer): Promise<BoundedLearningResult> {
  const cfg = structuredClone(input);
  if (!integer(cfg.maxRounds, 1) || cfg.maxRounds > 3 || !integer(cfg.maxCalls, 1) ||
      !integer(cfg.maxCostMicroUsd, 1) || !integer(cfg.perCallCostMicroUsd, 1) ||
      !integer(cfg.timeoutMs, 1) || cfg.timeoutMs > 300000 ||
      cfg.families.length < 2 || new Set(cfg.families).size !== cfg.families.length ||
      !cfg.families.every(x => typeof x === 'string' && x.length > 0) ||
      !['synthetic', 'independent_confirmation'].includes(cfg.evidenceClass) ||
      ![cfg.sourceDigest, cfg.trainingDigest, cfg.confirmationDigest].every(x => /^[a-f0-9]{64}$/.test(x)) ||
      cfg.trainingDigest === cfg.confirmationDigest ||
      !policyOK(cfg.baseline, cfg.baseline, cfg.allowedLevers)) throw new Error('Invalid frozen learning configuration');
  const records: LearningRecord[] = [], reasons: string[] = [];
  let calls = 0, spent = 0, candidate: Policy | null = null;
  async function invoke<T>(fn: (limits: { maxCostMicroUsd: number; signal: AbortSignal }) => Promise<T>): Promise<T> {
    if (calls >= cfg.maxCalls || spent + cfg.perCallCostMicroUsd > cfg.maxCostMicroUsd)
      throw new Error('Budget exhausted before dispatch');
    calls++;
    // Reserve the full amount. Failed/unknown calls retain this conservative reservation.
    spent += cfg.perCallCostMicroUsd;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([fn({ maxCostMicroUsd: cfg.perCallCostMicroUsd, signal: controller.signal }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('Worker timeout; cost reserved'));
        }, cfg.timeoutMs); })]);
    } finally { clearTimeout(timer!); }
  }
  function charge(cost: number) {
    if (!integer(cost) || cost > cfg.perCallCostMicroUsd) throw new Error('Invalid or exceeded cost reservation');
    spent -= cfg.perCallCostMicroUsd - cost;
  }
  async function evaluate(p: Policy, family: string, stage: LearningStage) {
    const o = structuredClone(await invoke(limits => adapters.evaluate(structuredClone(p), family, stage, limits)));
    if (!observationOK(o)) throw new Error('Invalid evaluator observation');
    charge(o.costMicroUsd);
    records.push({ kind: stage, family, policyDigest: digest(p), costMicroUsd: o.costMicroUsd, observation: o });
    if (o.permissionViolations) throw new Error('Permission violation');
    return o;
  }
  try {
    const training: LearningObservation[] = [];
    for (const f of cfg.families) training.push(await evaluate(cfg.baseline, f, 'train'));
    let best = training.reduce((s, o) => s + efficiency(o), 0);
    // Select exclusively on training. Confirmation runs once, after all proposal rounds.
    for (let round = 1; round <= cfg.maxRounds; round++) {
      const reply = structuredClone(await invoke(limits => adapters.propose({
        baseline: structuredClone(cfg.baseline), training: structuredClone(training), round,
      }, limits)));
      charge(reply.costMicroUsd);
      records.push({ kind: 'propose', costMicroUsd: reply.costMicroUsd });
      if (!policyOK(reply.value, cfg.baseline, cfg.allowedLevers)) throw new Error('Candidate changed a forbidden lever');
      let score = 0;
      for (const f of cfg.families) score += efficiency(await evaluate(reply.value, f, 'train'));
      if (score > best) { best = score; candidate = structuredClone(reply.value); }
    }
    if (!candidate) throw new Error('No training improvement');
    // >=10% successful completions per dollar for EACH family and EACH drift condition.
    // Exact quality non-regression is stricter than an unspecified "meaningful" regression.
    for (const stage of ['confirm', 'rewrite', 'remove', 'corrupt'] as const) {
      for (const f of cfg.families) {
        const b = await evaluate(cfg.baseline, f, stage), c = await evaluate(candidate, f, stage);
        if (b.trials !== c.trials || b.successes === 0 || c.successes < b.successes ||
            efficiency(c) < 1.1 * efficiency(b)) reasons.push(`${f}/${stage}: efficiency or quality gate failed`);
      }
    }
    const baselineId = digest(cfg.baseline);
    const confirmed = records.filter(r => r.observation && r.kind !== 'train');
    const base = confirmed.filter(r => r.policyDigest === baselineId);
    const child = confirmed.filter(r => r.policyDigest !== baselineId);
    const baseCost = base.reduce((s, r) => s + r.costMicroUsd, 0);
    const baseWins = base.reduce((s, r) => s + r.observation!.successes, 0);
    const childWins = child.reduce((s, r) => s + r.observation!.successes, 0);
    // Charge ALL development costs to the candidate, including rejected proposals and
    // baseline training. No assumed future traffic or unreported amortization horizon.
    const fullCandidateCost = spent - baseCost;
    if (!baseCost || !fullCandidateCost || childWins / fullCandidateCost < 1.1 * baseWins / baseCost)
      reasons.push('Full-cycle efficiency gate failed');
    if (cfg.evidenceClass !== 'independent_confirmation') reasons.push('Synthetic evidence cannot establish useful improvement');
  } catch (error) { reasons.push(error instanceof Error ? error.message : 'Worker failed'); }
  const verdict = reasons.length ? 'REJECTED' as const : 'REVIEW_REQUIRED' as const;
  const payload = { version: 'bounded-learning-v1', config: cfg, verdict, authority: 'none',
    reasons, candidate, records, calls, costMicroUsd: spent };
  return { verdict, authority: 'none', reasons, candidate, records, calls, costMicroUsd: spent,
    receipt: signer.sign(payload) };
}
