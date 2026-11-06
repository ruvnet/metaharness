// Terminal-RSI inspired harness adaptation. No model weights or protected tests enter rewriting.
import { createHash } from 'node:crypto';
import { canon } from './receipts.js';
import type { Proposer, Score } from './types.js';

export interface TerminalOutcome {
  /** Set only by a trusted, protected verifier, never by the actor. */
  strictSuccess: boolean;
  passedChecks: number;
  totalChecks: number;
  reportValid: boolean;
  cost: number;
  safetyViolation: boolean;
}

function validOutcome(o: TerminalOutcome): void {
  if (!o || typeof o.strictSuccess !== 'boolean' || typeof o.reportValid !== 'boolean' ||
      typeof o.safetyViolation !== 'boolean' || !Number.isSafeInteger(o.passedChecks) ||
      !Number.isSafeInteger(o.totalChecks) || o.passedChecks < 0 || o.totalChecks < o.passedChecks ||
      !Number.isFinite(o.cost) || o.cost < 0) throw new Error('invalid terminal outcome');
}

/** Diagnostic SPR only. Never use this shaped reward as Flywheel's primary score. */
export function successPrioritizedReward(o: TerminalOutcome, familyDivisor: number): number {
  validOutcome(o);
  if (!Number.isFinite(familyDivisor) || familyDivisor <= 0) throw new Error('invalid family divisor');
  const success = o.strictSuccess && !o.safetyViolation;
  // Clamp floating-point saturation so even MAX_SAFE_INTEGER passing checks cannot round to 1.
  const progress = o.reportValid ? Math.min(1 - Number.EPSILON, 1 / (1 + familyDivisor / Math.max(1, o.passedChecks))) : 0;
  return Number(success) + (o.passedChecks > 0 ? progress : 0);
}

/** Existing Flywheel Evaluator seam: strict completion alone determines primary and itemWins. */
export function terminalOutcomesToScore(outcomes: readonly TerminalOutcome[]): Score {
  if (!outcomes.length) throw new Error('empty terminal suite');
  outcomes.forEach(validOutcome);
  const itemWins = outcomes.map(o => o.strictSuccess && !o.safetyViolation);
  const wins = itemWins.filter(Boolean).length;
  const cost = outcomes.reduce((sum, o) => sum + o.cost, 0);
  if (!Number.isFinite(cost)) throw new Error('terminal cost overflow');
  return {
    primary: wins / outcomes.length,
    // Completion failures are not necessarily no-ops. This adapter uses the floor so the existing
    // gate requires strict completion lift or lower cost/win; actual no-op evidence belongs upstream.
    noopRate: 0,
    costPerWin: wins ? cost / wins : Number.MAX_VALUE,
    regressed: outcomes.some(o => o.safetyViolation),
    itemWins,
  };
}

export interface PublicRewriteTask {
  split: 'development';
  id: string;
  instruction: string;
  snapshotDigest: string;
  /** Only development traces explicitly approved for public reuse. No raw system/tool messages. */
  publicSteps: string[];
}

export interface RewriteSession {
  /** Trusted adapter must provision a distinct clean environment for each call. */
  id: string;
  snapshotDigest: string;
  execute(runbook: string, signal: AbortSignal): Promise<void>;
  /** Runs outside the actor's writable environment. */
  verify(signal: AbortSignal): Promise<TerminalOutcome>;
  close(): Promise<void>;
}

export interface VerifiedRewriteConfig {
  task: PublicRewriteTask;
  /** Must be established by a trusted development verifier before any rewriting. */
  discoveryOutcome: TerminalOutcome;
  rewrite(task: Readonly<PublicRewriteTask>, signal: AbortSignal): Promise<string>;
  /** Independent leakage/compatibility review; exact true required. No protected tests supplied. */
  review(task: Readonly<PublicRewriteTask>, runbook: string, signal: AbortSignal): Promise<boolean>;
  open(task: Readonly<PublicRewriteTask>, signal: AbortSignal): Promise<RewriteSession>;
  repeats?: number;
  maxReplayCost: number;
  signal: AbortSignal;
}

export interface VerifiedRewriteResult {
  accepted: boolean;
  reason: string;
  runbook: string | null;
  taskDigest: string;
  runbookDigest: string | null;
  sessions: string[];
  outcomes: TerminalOutcome[];
  replayCost: number;
}

function digest(v: unknown): string {
  return createHash('sha256').update(canon(v)).digest('hex');
}

/** Fail closed on review, replay, verifier, cleanup, snapshot, cancellation, or budget failure.
 * Adapter callbacks are a trusted boundary, not a sandbox supplied by this library. They must honor
 * cancellation and enforce spend limits themselves; post-run accounting cannot prevent overspend.
 */
export async function verifyTrajectoryRewrite(cfg: VerifiedRewriteConfig): Promise<VerifiedRewriteResult> {
  const repeats = cfg.repeats ?? 2;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 8 ||
      !Number.isFinite(cfg.maxReplayCost) || cfg.maxReplayCost <= 0) throw new Error('invalid rewrite budget');
  validOutcome(cfg.discoveryOutcome);
  const t = cfg.task;
  if (!t || t.split !== 'development' || typeof t.id !== 'string' || !t.id || t.id.length > 1024 || typeof t.instruction !== 'string' || !t.instruction ||
      typeof t.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(t.snapshotDigest) ||
      !Array.isArray(t.publicSteps) || !t.publicSteps.length || t.publicSteps.length > 1024 ||
      t.publicSteps.some(s => typeof s !== 'string' || !s || s.length > 16384) || t.instruction.length > 65536)
    throw new Error('invalid public rewrite task');
  // Explicit projection: extra rawTrace/protectedTests/credentials fields never cross this boundary.
  const task = Object.freeze({ split: 'development' as const, id: t.id, instruction: t.instruction, snapshotDigest: t.snapshotDigest,
    publicSteps: Object.freeze([...t.publicSteps]) as unknown as string[] });
  const result: VerifiedRewriteResult = { accepted: false, reason: 'discovery_not_verified', runbook: null,
    taskDigest: digest(task), runbookDigest: null, sessions: [], outcomes: [], replayCost: 0 };
  if (!cfg.discoveryOutcome.strictSuccess || cfg.discoveryOutcome.safetyViolation) return result;
  let runbook: string;
  try {
    cfg.signal.throwIfAborted();
    runbook = await cfg.rewrite(task, cfg.signal);
    cfg.signal.throwIfAborted();
    if (typeof runbook !== 'string' || !runbook.trim() || runbook.length > 65536) throw new Error('invalid runbook');
    result.runbookDigest = digest(runbook);
    if (await cfg.review(task, runbook, cfg.signal) !== true) return { ...result, reason: 'review_rejected' };
    for (let i = 0; i < repeats; i++) {
      cfg.signal.throwIfAborted();
      if (result.replayCost >= cfg.maxReplayCost) return { ...result, reason: 'replay_budget_exhausted' };
      const session = await cfg.open(task, cfg.signal);
      try {
        cfg.signal.throwIfAborted();
        if (typeof session.id !== 'string' || !session.id || session.id.length > 1024 ||
            result.sessions.includes(session.id) || session.snapshotDigest !== task.snapshotDigest)
          return { ...result, reason: 'replay_not_fresh' };
        result.sessions.push(session.id);
        await session.execute(runbook, cfg.signal);
        cfg.signal.throwIfAborted();
        const outcome = await session.verify(cfg.signal);
        cfg.signal.throwIfAborted();
        validOutcome(outcome);
        result.outcomes.push({ ...outcome });
        result.replayCost += outcome.cost;
        if (!Number.isFinite(result.replayCost) || result.replayCost > cfg.maxReplayCost)
          return { ...result, reason: 'replay_budget_exhausted' };
        if (!outcome.strictSuccess || outcome.safetyViolation) return { ...result, reason: 'replay_failed' };
      } finally {
        await session.close();
      }
    }
    cfg.signal.throwIfAborted();
    return { ...result, accepted: true, reason: 'verified_replay', runbook };
  } catch {
    // Do not leak exception messages containing private verifier output or credentials.
    return { ...result, reason: cfg.signal.aborted ? 'cancelled' : 'adapter_failed' };
  }
}

/** Replays qualify a proposal, NOT a promotion. Existing holdout/anchor gates still decide that. */
export function createVerifiedRewriteProposer(
  target: string, config: () => VerifiedRewriteConfig,
  observe?: (result: VerifiedRewriteResult) => void,
): Proposer {
  return async (base, requestedTarget) => {
    if (requestedTarget !== target) return base.policy[requestedTarget] ?? '';
    const result = await verifyTrajectoryRewrite(config());
    observe?.(structuredClone(result));
    if (!result.accepted) return base.policy[target] ?? '';
    return { value: result.runbook!, summary: `verified-rewrite task=${result.taskDigest} runbook=${result.runbookDigest} replays=${result.sessions.length}` };
  };
}
