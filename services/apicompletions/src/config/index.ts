// Runtime configuration (ADR-203 §7). Emulator-first ($0) by default.
import type { Tier } from '../types/openai';

export interface TierPool {
  /** Ordered model fallback chain within the tier (commit de512bd) — fails over WITHIN tier. */
  models: string[];
  rateLimitPerMin: number;
  rateInPer1M: number;
  rateOutPer1M: number;
}

export interface Config {
  port: number;
  projectId: string;
  region: string;
  /** Emulator hosts — when set, all GCP access goes to the local emulators ($0). */
  firestoreEmulatorHost?: string;
  pubsubEmulatorHost?: string;
  usageTopic: string;
  /** When true, route every request to the canned mock provider (no spend). */
  useMockProvider: boolean;
  /** Seed tier pools — production pools live in Firestore tier_config/{tier} (hot-reloadable). */
  tierPools: Record<Tier, TierPool>;
}

// TODO(impl): hydrate from env + Firestore tier_config. Skeleton returns static defaults.
export function loadConfig(): Config {
  const env = process.env;
  return {
    port: Number(env.PORT ?? 8080),
    projectId: env.GOOGLE_CLOUD_PROJECT ?? 'demo-project',
    region: env.REGION ?? 'us-central1',
    firestoreEmulatorHost: env.FIRESTORE_EMULATOR_HOST,
    pubsubEmulatorHost: env.PUBSUB_EMULATOR_HOST,
    usageTopic: env.USAGE_TOPIC ?? 'completions-usage',
    useMockProvider: env.USE_MOCK_PROVIDER === 'true' || !env.OPENROUTER_API_KEY,
    // Rates are ILLUSTRATIVE ($/1M tokens) — the shape (low ≪ mid < high) is fixed by the
    // §4.1 DoE, the absolute numbers are a launch decision (§4.2). Asymmetric in/out per tier.
    tierPools: {
      low: { models: ['deepseek-v4-pro', 'glm-5.2'], rateLimitPerMin: 120, rateInPer1M: 0.1, rateOutPer1M: 0.3 },
      mid: { models: ['gpt-5.5', 'gemini-3.1-pro'], rateLimitPerMin: 60, rateInPer1M: 0.6, rateOutPer1M: 1.8 },
      high: { models: ['claude-opus-4.8', 'gpt-5.5'], rateLimitPerMin: 30, rateInPer1M: 2.5, rateOutPer1M: 7.5 },
    },
  };
}
