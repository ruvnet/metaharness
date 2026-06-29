// API-key auth — the REAL cognitum.one cog_ scheme (ADR-203 §6).
// Identical to @cognitum-one/api-gateway public-api.ts verifyApiKey():
// read X-API-Key / Authorization: Bearer cog_… → SHA-256 → Firestore api_keys
// lookup by hash → check active, expiresAt, permissions[]. Server-side only;
// the plaintext key is NEVER logged (only the 12-char prefix, §6 logging contract).
import { createHash } from 'crypto';
import type { Tier } from '../types/openai';

export interface ApiKeyDoc {
  key: string; // SHA-256 hash (hex) of the cog_ key — indexed field in api_keys
  prefix: string; // first 12 chars (cog_XXXXXXXX) for logs/dashboard
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

/** cog_ + 64 lowercase/uppercase hex chars (256-bit, crypto.randomBytes(32)). */
const KEY_RE = /^cog_[0-9a-fA-F]{64}$/;

export function isValidKeyFormat(raw: string): boolean {
  return KEY_RE.test(raw);
}

/** SHA-256 hex of the raw key — the value stored (and indexed) in api_keys.key. */
export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** First 12 chars of the plaintext key — the only key material ever logged. */
export function keyPrefix(raw: string): string {
  return raw.slice(0, 12);
}

/**
 * The key lookup backend. Production binds this to a Firestore `api_keys`
 * lookup-by-hash (firebase-admin, deferred to the metering phase); tests and the
 * emulator-first path use {@link InMemoryKeyStore} so the whole auth → tier →
 * route loop runs at $0 with no GCP SDK.
 */
export interface KeyStore {
  findByHash(hash: string): Promise<ApiKeyDoc | null>;
}

/** $0 emulator-first / test key store. Seed with raw cog_ keys; it hashes them. */
export class InMemoryKeyStore implements KeyStore {
  private readonly byHash = new Map<string, ApiKeyDoc>();

  /** Register a raw cog_ key with its doc (key + prefix are derived). */
  add(rawKey: string, doc: Omit<ApiKeyDoc, 'key' | 'prefix'>): ApiKeyDoc {
    const full: ApiKeyDoc = { ...doc, key: hashKey(rawKey), prefix: keyPrefix(rawKey) };
    this.byHash.set(full.key, full);
    return full;
  }

  async findByHash(hash: string): Promise<ApiKeyDoc | null> {
    return this.byHash.get(hash) ?? null;
  }
}

/**
 * Result of an auth attempt — success carries the key doc, failure the wire error.
 * On failure the wire `code`/`error` are deliberately OPAQUE (§6, sec-review): malformed,
 * unknown, inactive and expired keys all collapse to a single `invalid_api_key` /
 * 'Invalid API key.' so a caller cannot enumerate valid-but-disabled keys. The granular
 * reason is preserved in `logCode`/`logReason` for SERVER-SIDE logs only (never sent to
 * the client).
 */
export type AuthOutcome =
  | { ok: true; key: ApiKeyDoc; rawPrefix: string }
  | { ok: false; status: number; code: string; error: string; logCode?: string; logReason?: string };

/**
 * Extract the raw cog_ key from the request headers.
 * `X-API-Key: cog_…` is preferred; `Authorization: Bearer cog_…` is the fallback
 * (matching the production header contract, §6).
 */
export function extractApiKey(headers: Record<string, unknown>): string | undefined {
  const direct = headers['x-api-key'];
  if (typeof direct === 'string' && direct.length > 0) return direct.trim();
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  return undefined;
}

/**
 * Verify a raw cog_ key against the store (ADR-203 §6 validation flow):
 * format check → SHA-256 → lookup → active / expiresAt. Scope (permissions[])
 * is checked later, at tier resolution, so a scope miss can return a tier-aware
 * 403 rather than a generic one. Never logs the plaintext key.
 */
export async function verifyApiKey(
  rawKey: string | undefined,
  store: KeyStore,
): Promise<AuthOutcome> {
  if (!rawKey) {
    return { ok: false, status: 401, code: 'missing_api_key', error: 'Missing API key. Provide X-API-Key or Authorization: Bearer.' };
  }
  // Opaque external response for every "this key won't authenticate" case — the granular
  // reason rides along in logCode/logReason for server logs only (anti-enumeration, §6).
  const invalid = (logCode: string, logReason: string): AuthOutcome => ({
    ok: false,
    status: 401,
    code: 'invalid_api_key',
    error: 'Invalid API key.',
    logCode,
    logReason,
  });
  if (!isValidKeyFormat(rawKey)) {
    return invalid('malformed', 'Malformed API key.');
  }
  const doc = await store.findByHash(hashKey(rawKey));
  if (!doc) {
    return invalid('unknown_key', 'Unknown API key.');
  }
  if (!doc.active) {
    return invalid('key_inactive', 'API key is inactive.');
  }
  if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) {
    return invalid('key_expired', 'API key has expired.');
  }
  return { ok: true, key: doc, rawPrefix: keyPrefix(rawKey) };
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
