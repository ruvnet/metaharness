// Runtime configuration (ADR-203 §7). Emulator-first ($0) by default.
import type { Tier } from '../types/openai';

export interface TierPool {
  /** Ordered model fallback chain within the tier (commit de512bd) — fails over WITHIN tier. */
  models: string[];
  rateLimitPerMin: number;
  rateInPer1M: number;
  rateOutPer1M: number;
}

/**
 * Reserve-and-Commit budget defense knobs (ADR-204 rev-2 §5.2/§5.5). The per-agent runaway
 * cap is split across K shards (perShardCap = perAgentCap / K) so a single agentId scaling to
 * N parallel workers does not re-collapse onto one Firestore doc (§5.2 fix 1). Lease windows
 * are per request TYPE (§5.5): short for a synchronous completion, long for a streaming /
 * agentic request that legitimately runs to the step-cap.
 */
export interface BudgetConfig {
  /** K — number of per-agent shards. perShardCap = perAgentCapUsd / K (§5.2). */
  shardCount: number;
  /** Worst-case output token bound when the request omits max_tokens (estimate ceiling). */
  defaultMaxOutputTokens: number;
  /** Logical lease for a synchronous completion (~60s, §5.5). */
  leaseSyncMs: number;
  /** Logical lease for a streaming / agentic request (~20min step-cap, §5.5). */
  leaseStreamMs: number;
  /** Per-agent loop-rate cap (reservations/min); the per-shard cap is this / K (§5.2). */
  maxLoopRatePerMin: number;
  /** Rolling window over which the loop-rate is measured. */
  loopWindowMs: number;
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
  /** Reserve-and-Commit budget knobs (ADR-204 §5.2/§5.5). */
  budget: BudgetConfig;
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
    // ADR-204 §5.2/§5.5 defaults. shardCount/caps are per-agent-class tuning levers; the
    // lease windows are derived from the request-type timeouts (§5.5 — short sync, long stream).
    budget: {
      shardCount: Number(env.BUDGET_SHARD_COUNT ?? 4),
      defaultMaxOutputTokens: Number(env.BUDGET_DEFAULT_MAX_OUTPUT_TOKENS ?? 4096),
      leaseSyncMs: Number(env.BUDGET_LEASE_SYNC_MS ?? 60_000), // ~60s synchronous completion
      leaseStreamMs: Number(env.BUDGET_LEASE_STREAM_MS ?? 1_200_000), // ~20min streaming/agentic
      maxLoopRatePerMin: Number(env.BUDGET_MAX_LOOP_RATE_PER_MIN ?? 600),
      loopWindowMs: Number(env.BUDGET_LOOP_WINDOW_MS ?? 60_000),
    },
  };
}
