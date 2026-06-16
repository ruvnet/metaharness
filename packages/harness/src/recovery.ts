// SPDX-License-Identifier: MIT
//
// Recovery layer (ADR-047): circuit breaker + retry budget. Together they make
// runaway loops impossible — the breaker stops hammering a failing dependency,
// and the budget caps total retries/spend across a whole run.

/** Circuit breaker states. */
export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Consecutive failures that trip the breaker open. */
  threshold: number;
  /** ms the breaker stays open before allowing a half-open trial. */
  cooldownMs: number;
  /** Clock injection for deterministic tests (default Date.now). */
  now?: () => number;
}

/**
 * A circuit breaker. `closed` → calls flow; after `threshold` consecutive
 * failures it trips `open` and rejects fast; after `cooldownMs` it goes
 * `half-open` to allow one trial — success closes it, failure re-opens it.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: BreakerOptions) {
    this.threshold = Math.max(1, opts.threshold);
    this.cooldownMs = Math.max(0, opts.cooldownMs);
    this.now = opts.now ?? Date.now;
  }

  /** Current state, accounting for cooldown expiry. */
  current(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
    }
    return this.state;
  }

  /** May a call proceed right now? */
  canProceed(): boolean {
    return this.current() !== 'open';
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    // A failure during a half-open trial re-opens immediately.
    if (this.current() === 'half-open') {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) this.trip();
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
  }
}

/**
 * A run-scoped retry budget. Caps both the number of retries and the USD spent on
 * them, so verification-driven repair loops cannot spiral. `tryConsume` returns
 * false (without consuming) when either cap would be exceeded.
 */
export class RetryBudget {
  private retriesUsed = 0;
  private usdUsed = 0;
  constructor(
    private readonly maxRetries: number,
    private readonly maxUsd = Infinity,
  ) {}

  /** Attempt to spend one retry costing `usd`. Returns false if it would exceed a cap. */
  tryConsume(usd = 0): boolean {
    if (this.retriesUsed + 1 > this.maxRetries) return false;
    if (this.usdUsed + usd > this.maxUsd) return false;
    this.retriesUsed += 1;
    this.usdUsed += usd;
    return true;
  }

  get remaining(): number {
    return this.maxRetries - this.retriesUsed;
  }

  get spentUsd(): number {
    return this.usdUsed;
  }
}
