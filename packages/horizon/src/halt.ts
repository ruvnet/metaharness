// HaltController — the ADK `halt_reason` mechanism as a TypeScript object over
// the pure Rust reducer. A long-horizon agent loops; this decides when to STOP.
//
// Faithful to ADK's shape: a guard ARMS a pending reason as it observes each
// step (iteration budget / no-progress / repeated-failure); `beforeModel()`
// CONSUMES the armed reason to halt the turn; `turnBoundary()` resets. The
// controller never halts on observe — only on the next beforeModel — so the
// "set now, consume next turn" contract is preserved exactly.
//
// State is a plain serializable object owned here, not hidden in the wasm. That
// is what makes a session resumable: `snapshot()` the state, persist it, and
// `HaltController.restore()` continues the exact same run.

import type { HorizonCore } from './core.js';

export interface HaltConfig {
  /** Hard cap on observed steps within a turn. */
  maxIterations: number;
  /** Halt after this many consecutive observes with an UNCHANGED progress signature. */
  noProgressLimit: number;
  /** Halt after this many consecutive observes with the SAME failure signature. */
  repeatedFailureLimit: number;
}

export interface HaltState {
  iteration: number;
  lastProgress: string | null;
  staleCount: number;
  lastFailure: string | null;
  failureRepeat: number;
  pending: HaltReason | null;
}

export type HaltReason = 'iteration-budget' | 'no-progress' | 'repeated-failure';

export interface HaltDecision {
  halt: boolean;
  reason: HaltReason | null;
}

interface ReduceResult {
  state?: HaltState;
  halt?: boolean;
  reason?: HaltReason | null;
  error?: string;
}

export const DEFAULT_HALT_CONFIG: HaltConfig = {
  maxIterations: 50,
  noProgressLimit: 3,
  repeatedFailureLimit: 3,
};

export class HaltController {
  private state: HaltState | null = null;

  constructor(
    private readonly core: HorizonCore,
    readonly config: HaltConfig = DEFAULT_HALT_CONFIG,
  ) {}

  /** Rehydrate a controller from a persisted snapshot (session resume). */
  static restore(core: HorizonCore, config: HaltConfig, state: HaltState): HaltController {
    const c = new HaltController(core, config);
    c.state = state;
    return c;
  }

  private reduce(action: Record<string, unknown>): ReduceResult {
    const r = this.core.eval<ReduceResult>({
      op: 'halt',
      config: this.config,
      state: this.state,
      action,
    });
    if (r.error) throw new Error(`horizon halt: ${r.error}`);
    this.state = r.state ?? this.state;
    return r;
  }

  /**
   * Record one step. `progress` is a signature of forward state (e.g. a hash of
   * files-changed + tests-passing); if it does not change for `noProgressLimit`
   * observes, a no-progress halt is armed. `failure` is a signature of an error
   * (null = the step succeeded, which breaks any failure streak); the same
   * failure `repeatedFailureLimit` times arms a repeated-failure halt. Observing
   * NEVER halts — it only arms; the next `beforeModel()` consumes.
   */
  observe(opts: { progress?: string; failure?: string | null } = {}): void {
    const action: Record<string, unknown> = { type: 'observe' };
    if (opts.progress !== undefined) action.progress = opts.progress;
    if ('failure' in opts) action.failure = opts.failure; // null is meaningful (success)
    this.reduce(action);
  }

  /** Consume any armed halt. Call once per turn before invoking the model. */
  beforeModel(): HaltDecision {
    const r = this.reduce({ type: 'before_model' });
    return { halt: r.halt === true, reason: r.reason ?? null };
  }

  /** Reset all counters at a turn boundary (ADK resets halts between turns). */
  turnBoundary(): void {
    this.reduce({ type: 'turn_boundary' });
  }

  /** Current serializable state (persist this to resume later). */
  snapshot(): HaltState {
    if (!this.state) {
      return {
        iteration: 0,
        lastProgress: null,
        staleCount: 0,
        lastFailure: null,
        failureRepeat: 0,
        pending: null,
      };
    }
    return { ...this.state };
  }
}
