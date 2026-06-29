// App dependency container (ADR-203 §2, §7.3). Dependency-injected so the whole
// auth → tier → route → meter → bill loop runs at $0 in tests/emulators: a seeded
// in-memory key store, the deterministic MockProvider, and in-memory metering / rate-limit
// / idempotency stores by default; production swaps in the Firestore-/PubSub-backed
// adapters (FirestoreLedgerStore, PubSubUsagePublisher, FirestoreRateLimitStore,
// FirestoreIdempotencyStore) and the OpenRouterProvider.
import { type KeyStore, InMemoryKeyStore } from './auth/apiKey';
import type { ModelProvider } from './providers/types';
import { MockProvider } from './providers/mockProvider';
import { OpenRouterProvider } from './providers/openrouter';
import { type Config, loadConfig } from './config';
import {
  type LedgerStore,
  type UsagePublisher,
  InMemoryLedgerStore,
  InMemoryUsagePublisher,
} from './metering/ledger';
import { RateLimiter, InMemoryRateLimitStore } from './ratelimit/limiter';
import { type IdempotencyStore, InMemoryIdempotencyStore } from './ratelimit/idempotency';
import type { BudgetTracker } from './budget/types';
import { InMemoryBudgetTracker } from './budget/tracker';

export interface AppDeps {
  config: Config;
  keyStore: KeyStore;
  provider: ModelProvider;
  /** Billing source of truth — written on the response path (§5.1). */
  ledger: LedgerStore;
  /** Fire-and-forget rollup feed (§5.1). */
  usagePublisher: UsagePublisher;
  /** Scatter-gather per-(key,tier) rate limiter (§5.3). */
  rateLimiter: RateLimiter;
  /** 24h replay cache (§5.3). */
  idempotency: IdempotencyStore;
  /** Reserve-and-Commit budget defense (ADR-204 §5.2). Unmetered until an account opts in. */
  budget: BudgetTracker;
}

export interface AppDepsOverrides {
  config?: Config;
  keyStore?: KeyStore;
  provider?: ModelProvider;
  ledger?: LedgerStore;
  usagePublisher?: UsagePublisher;
  rateLimiter?: RateLimiter;
  idempotency?: IdempotencyStore;
  budget?: BudgetTracker;
}

/**
 * Build the default deps. Emulator-first / $0: MockProvider unless a real
 * OPENROUTER_API_KEY is present and mock is not forced (§7.3); the key store, ledger,
 * publisher, rate-limit tick store, and idempotency cache all default to in-memory fakes —
 * tests seed/inspect them; production binds Firestore/PubSub adapters.
 */
export function defaultDeps(overrides: AppDepsOverrides = {}): AppDeps {
  const config = overrides.config ?? loadConfig();
  const provider =
    overrides.provider ??
    (config.useMockProvider
      ? new MockProvider()
      : new OpenRouterProvider(process.env.OPENROUTER_API_KEY ?? ''));
  return {
    config,
    keyStore: overrides.keyStore ?? new InMemoryKeyStore(),
    provider,
    ledger: overrides.ledger ?? new InMemoryLedgerStore(),
    usagePublisher: overrides.usagePublisher ?? new InMemoryUsagePublisher(),
    rateLimiter: overrides.rateLimiter ?? new RateLimiter(new InMemoryRateLimitStore()),
    idempotency: overrides.idempotency ?? new InMemoryIdempotencyStore(),
    // Default to the in-memory tracker with NO seeded accounts → transparent (admits all,
    // no reservation) until an account opts into enforcement. Production binds
    // FirestoreBudgetTracker(admin.firestore(), config).
    budget: overrides.budget ?? new InMemoryBudgetTracker(config),
  };
}
