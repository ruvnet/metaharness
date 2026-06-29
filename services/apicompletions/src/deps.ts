// App dependency container (ADR-203 §2, §7.3). Dependency-injected so the whole
// auth → tier → route loop runs at $0 in tests/emulators: a seeded in-memory key store
// and the deterministic MockProvider by default; production swaps in a Firestore-backed
// KeyStore and the OpenRouterProvider (metering/limiter wiring lands in a later phase).
import { type KeyStore, InMemoryKeyStore } from './auth/apiKey';
import type { ModelProvider } from './providers/types';
import { MockProvider } from './providers/mockProvider';
import { OpenRouterProvider } from './providers/openrouter';
import { type Config, loadConfig } from './config';

export interface AppDeps {
  config: Config;
  keyStore: KeyStore;
  provider: ModelProvider;
}

export interface AppDepsOverrides {
  config?: Config;
  keyStore?: KeyStore;
  provider?: ModelProvider;
}

/**
 * Build the default deps. Emulator-first / $0: MockProvider unless a real
 * OPENROUTER_API_KEY is present and mock is not forced (§7.3). The key store defaults to
 * an empty in-memory store — tests seed it; production binds a Firestore-backed store.
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
  };
}
