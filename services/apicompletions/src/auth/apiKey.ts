// API-key auth — the REAL cognitum.one cog_ scheme (ADR-203 §6).
// Identical to @cognitum-one/api-gateway public-api.ts verifyApiKey():
// read X-API-Key / Authorization: Bearer cog_… → SHA-256 → Firestore api_keys
// lookup by hash → check active, expiresAt, permissions[]. Server-side only.
import type { Tier } from '../types/openai';

export interface ApiKeyDoc {
  key: string;        // SHA-256 hash of the cog_ key
  prefix: string;     // first 12 chars (cog_XXXXXXXX) for logs/dashboard
  permissions: string[];
  rateLimit: number;
  active: boolean;
  expiresAt: Date | null;
  /** §6 integration dependency — needed for usage_rollups attribution. */
  accountId?: string;
}

export const COMPLETION_SCOPES = {
  low: 'completions:low',
  mid: 'completions:mid',
  high: 'completions:high',
} as const satisfies Record<Tier, string>;

/** TODO(impl): SHA-256 the header value, Firestore api_keys lookup, expiry/active check. */
export async function verifyApiKey(_apiKeyHeader: string | undefined): Promise<ApiKeyDoc | null> {
  throw new Error('not implemented: verifyApiKey (ADR-203 §6)');
}

/** Highest tier the key is scoped for (caps auto-mode escalation, §6 item 2). */
export function highestHeldTier(doc: ApiKeyDoc): Tier | null {
  if (doc.permissions.includes(COMPLETION_SCOPES.high)) return 'high';
  if (doc.permissions.includes(COMPLETION_SCOPES.mid)) return 'mid';
  if (doc.permissions.includes(COMPLETION_SCOPES.low)) return 'low';
  return null;
}

export function holdsTier(doc: ApiKeyDoc, tier: Tier): boolean {
  return doc.permissions.includes(COMPLETION_SCOPES[tier]);
}
