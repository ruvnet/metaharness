// SPDX-License-Identifier: MIT
// Signed, tenant-scoped SIM handoff envelope (metaharness.sim.handoff.v2). ADR-325, issue #524.
//
// The v1 handoff is a portable JSON document with a local hash chain. A hash
// chain detects accidental corruption; it is not authentication. This module
// wraps v1 in an Ed25519-signed envelope over a canonical JSON encoding so a
// consumer (the Ruflo ingestion adapter) can check WHO produced it, WHICH
// tenant it is for, WHEN it expires, and that no byte changed in transit.
//
// Trust model: the envelope names a tenant, but a consumer must only accept
// it when its own trusted-key configuration binds the signing key to that
// tenant. A valid signature from a key bound to tenant A never authorizes a
// payload that claims tenant B.
//
// Node crypto only. Nothing here performs I/O or contacts a remote service.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { validateSimAttempt, type SimAttempt, type SimMemory, type SimQuery, type SimScope } from './sim-memory.js';

export const SIM_HANDOFF_V1_SCHEMA = 'metaharness.sim.handoff.v1';
export const SIM_HANDOFF_V2_SCHEMA = 'metaharness.sim.handoff.v2';
/** Domain separation: a v2 signature can never be replayed as a signature over another message type. */
const SIGNING_DOMAIN = SIM_HANDOFF_V2_SCHEMA + '\n';
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 500;
const MAX_LIFETIME_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_LIFETIME_MS = 7 * 24 * 3600 * 1000;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
const HANDOFF_KEYS = ['schema', 'audience', 'trust', 'scope', 'retrieval', 'estimatedTokens', 'attempts'];
/** Every field a SimAttempt may carry. Anything else (e.g. grader traces) is rejected, not dropped. */
const ATTEMPT_KEYS = [
  'id', 'createdAt', 'scope', 'problemKey', 'diagnosis', 'variantId', 'parentId', 'mutationSurface',
  'rationale', 'predictedDelta', 'observedDelta', 'finalScore', 'promoted', 'evidenceIds', 'previousHash', 'hash',
];
const PAYLOAD_KEYS = ['schema', 'eventId', 'keyId', 'tenant', 'createdAt', 'expiresAt', 'consent', 'retention', 'handoff'];

export interface SimTenant { owner: string; repo: string }
export interface SimHandoffV1 {
  schema: typeof SIM_HANDOFF_V1_SCHEMA;
  audience: 'harness_optimizer';
  trust: 'untrusted_evidence_only';
  scope: SimScope;
  retrieval: 'full' | 'lexical' | 'vector';
  estimatedTokens: number;
  attempts: SimAttempt[];
}
/** Consent is fixed: optimizer-only use, no sharing, no automatic promotion into any other memory. */
export interface SimConsent {
  purpose: 'harness_optimizer';
  sharing: 'none';
  promotion: 'manual_review_only';
}
export interface SimRetention { days: number }
export interface SimHandoffPayload {
  schema: typeof SIM_HANDOFF_V2_SCHEMA;
  eventId: string;
  keyId: string;
  tenant: SimTenant;
  createdAt: string;
  expiresAt: string;
  consent: SimConsent;
  retention: SimRetention;
  handoff: SimHandoffV1;
}
export interface SignedSimHandoff {
  payload: SimHandoffPayload;
  signature: { alg: 'ed25519'; value: string };
}
export interface SignSimHandoffOptions {
  privateKey: KeyObject | string;
  /** Defaults to the handoff scope's ownerId/repoId. */
  tenant?: SimTenant;
  createdAt?: Date;
  /** Envelope lifetime; default 7 days, max 30 days. */
  lifetimeMs?: number;
  /** Consumer retention in days, 1..3650; default 30. */
  retentionDays?: number;
}
export interface TrustedSimKey {
  keyId: string;
  /** SPKI PEM. */
  publicKey: string;
  /** Tenants this key may sign for, as "owner/repo". */
  tenants: string[];
  revoked?: boolean;
  notAfter?: string;
}
export type SimVerifyFailure =
  | 'too_large' | 'malformed' | 'unsigned' | 'unknown_key' | 'key_id_mismatch' | 'revoked_key'
  | 'key_expired' | 'bad_signature' | 'unsupported_schema' | 'not_yet_valid' | 'expired'
  | 'tenant_not_authorized' | 'scope_mismatch' | 'event_id_mismatch';
export type SimVerifyResult =
  | { ok: true; payload: SimHandoffPayload; keyId: string; eventId: string; tenant: string; payloadSha256: string }
  | { ok: false; reason: SimVerifyFailure; detail?: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Deterministic JSON: sorted keys, no whitespace, finite numbers only. Throws on anything else. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('SIM handoff: nesting too deep');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SIM handoff: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v, depth + 1)).join(',') + ']';
  if (object(value)) {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => {
      if (value[k] === undefined) throw new Error('SIM handoff: undefined field ' + k);
      return JSON.stringify(k) + ':' + canonicalJson(value[k], depth + 1);
    }).join(',') + '}';
  }
  throw new Error('SIM handoff: unsupported value type');
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable key id: sha256 of the raw 32-byte Ed25519 public key. */
export function simKeyId(publicKey: KeyObject | string): string {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('SIM handoff: key must be Ed25519');
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('SIM handoff: cannot export public key');
  return 'ed25519:' + sha256(Buffer.from(jwk.x, 'base64url')).slice(0, 32);
}

export function simTenantId(tenant: SimTenant): string {
  if (!object(tenant) || typeof tenant.owner !== 'string' || typeof tenant.repo !== 'string' ||
    !OWNER_RE.test(tenant.owner) || !REPO_RE.test(tenant.repo)) {
    throw new Error('SIM handoff: tenant owner/repo must match [A-Za-z0-9._-] (repo may contain one "/")');
  }
  return tenant.owner + '/' + tenant.repo;
}

/** Content-derived event id: re-signing the same evidence for the same tenant yields the same id. */
export function simEventId(tenant: SimTenant, handoff: SimHandoffV1): string {
  return 'sim-evt-' + sha256(canonicalJson({ tenant, handoff })).slice(0, 40);
}

function exactKeys(value: Record<string, unknown>, allowed: string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error('SIM handoff: unexpected field ' + what + '.' + key);
  }
}

/** Validates a v1 handoff and binds every record to the tenant. Throws on any violation. */
export function validateSimHandoffV1(value: unknown, tenant: SimTenant): asserts value is SimHandoffV1 {
  simTenantId(tenant);
  if (!object(value)) throw new Error('SIM handoff: handoff must be an object');
  exactKeys(value, HANDOFF_KEYS, 'handoff');
  if (value.schema !== SIM_HANDOFF_V1_SCHEMA || value.audience !== 'harness_optimizer' ||
    value.trust !== 'untrusted_evidence_only') {
    throw new Error('SIM handoff: handoff must be an untrusted optimizer-only v1 document');
  }
  if (!['full', 'lexical', 'vector'].includes(value.retrieval as string)) throw new Error('SIM handoff: invalid retrieval');
  if (!Number.isSafeInteger(value.estimatedTokens) || (value.estimatedTokens as number) < 0) {
    throw new Error('SIM handoff: invalid estimatedTokens');
  }
  const scope = value.scope as SimScope;
  if (!object(scope) || scope.ownerId !== tenant.owner || scope.repoId !== tenant.repo) {
    throw new Error('SIM handoff: scope does not match tenant');
  }
  if (!Array.isArray(value.attempts) || value.attempts.length > MAX_ATTEMPTS) throw new Error('SIM handoff: invalid attempts');
  const ids = new Set<string>();
  for (const attempt of value.attempts) {
    if (!object(attempt)) throw new Error('SIM handoff: invalid attempt');
    exactKeys(attempt, ATTEMPT_KEYS, 'attempt');
    validateSimAttempt(attempt);
    const chain = [attempt.hash, attempt.previousHash];
    if (chain.some((h, i) => !(typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) && !(i === 1 && h === null))) {
      throw new Error('SIM handoff: invalid attempt hash fields');
    }
    const s = attempt.scope as SimScope;
    if (s.ownerId !== tenant.owner || s.repoId !== tenant.repo) throw new Error('SIM handoff: attempt scope does not match tenant');
    if (ids.has(attempt.id as string)) throw new Error('SIM handoff: duplicate attempt id');
    ids.add(attempt.id as string);
  }
}

function signingInput(payload: SimHandoffPayload): Buffer {
  return Buffer.from(SIGNING_DOMAIN + canonicalJson(payload), 'utf8');
}

/** Wraps a v1 handoff in a signed, tenant-scoped v2 envelope. */
export function signSimHandoff(handoff: unknown, options: SignSimHandoffOptions): SignedSimHandoff {
  const privateKey = typeof options.privateKey === 'string' ? createPrivateKey(options.privateKey) : options.privateKey;
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('SIM handoff: key must be Ed25519');
  const scope = object(handoff) && object(handoff.scope) ? handoff.scope : {};
  const tenant: SimTenant = options.tenant ?? { owner: String(scope.ownerId), repo: String(scope.repoId) };
  validateSimHandoffV1(handoff, tenant);
  const lifetime = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > MAX_LIFETIME_MS) {
    throw new Error('SIM handoff: lifetimeMs must be 1..30 days');
  }
  const days = options.retentionDays ?? 30;
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('SIM handoff: retentionDays must be 1..3650');
  const created = options.createdAt ?? new Date();
  // JSON round trip removes undefined/prototype oddities before hashing.
  const safe = JSON.parse(JSON.stringify(handoff)) as SimHandoffV1;
  const payload: SimHandoffPayload = {
    schema: SIM_HANDOFF_V2_SCHEMA,
    eventId: simEventId(tenant, safe),
    keyId: simKeyId(createPublicKey(privateKey)),
    tenant: { owner: tenant.owner, repo: tenant.repo },
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + lifetime).toISOString(),
    consent: { purpose: 'harness_optimizer', sharing: 'none', promotion: 'manual_review_only' },
    retention: { days },
    handoff: safe,
  };
  const value = sign(null, signingInput(payload), privateKey).toString('base64');
  return { payload, signature: { alg: 'ed25519', value } };
}

/** Convenience: build the v1 handoff from SIM memory and sign it in one step. */
export async function signedRufloHandoff(memory: SimMemory, query: SimQuery, options: SignSimHandoffOptions): Promise<SignedSimHandoff> {
  return signSimHandoff(await memory.rufloHandoff(query), options);
}

function fail(reason: SimVerifyFailure, detail?: string): SimVerifyResult {
  return { ok: false, reason, ...(detail ? { detail } : {}) };
}

function isoTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) || new Date(t).toISOString() !== value ? null : t;
}

/**
 * Verifies a v2 envelope against a trusted key set. Order: shape, key lookup,
 * signature, then payload semantics. Every failure is a typed reason; nothing
 * is partially accepted.
 */
export function verifySimHandoff(
  envelope: unknown,
  options: { trustedKeys: TrustedSimKey[]; now?: Date; maxSkewMs?: number },
): SimVerifyResult {
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(envelope) ?? '', 'utf8'); } catch { return fail('malformed'); }
  if (bytes > MAX_ENVELOPE_BYTES) return fail('too_large');
  if (!object(envelope) || !object(envelope.payload)) return fail('malformed');
  for (const key of Object.keys(envelope)) if (key !== 'payload' && key !== 'signature') return fail('malformed', 'envelope.' + key);
  const sig = envelope.signature;
  if (!object(sig) || sig.alg !== 'ed25519' || typeof sig.value !== 'string' || sig.value.length === 0) return fail('unsigned');
  const payload = envelope.payload;
  for (const key of Object.keys(payload)) if (!PAYLOAD_KEYS.includes(key)) return fail('malformed', 'payload.' + key);
  if (payload.schema !== SIM_HANDOFF_V2_SCHEMA) return fail('unsupported_schema');
  const trusted = options.trustedKeys.find((k) => k.keyId === payload.keyId);
  if (!trusted) return fail('unknown_key');
  const now = (options.now ?? new Date()).getTime();
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(trusted.publicKey);
    if (simKeyId(publicKey) !== trusted.keyId) return fail('key_id_mismatch');
  } catch { return fail('key_id_mismatch'); }
  if (trusted.revoked) return fail('revoked_key');
  if (trusted.notAfter !== undefined) {
    const notAfter = isoTime(trusted.notAfter);
    if (notAfter === null || now > notAfter) return fail('key_expired');
  }
  let message: Buffer;
  try { message = signingInput(payload as unknown as SimHandoffPayload); } catch { return fail('malformed'); }
  const signature = Buffer.from(sig.value, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== sig.value) return fail('bad_signature');
  if (!verify(null, message, publicKey, signature)) return fail('bad_signature');

  // Signature is valid: the producer said exactly this. Now check it is allowed.
  const created = isoTime(payload.createdAt);
  const expires = isoTime(payload.expiresAt);
  if (created === null || expires === null || expires <= created || expires - created > MAX_LIFETIME_MS) return fail('malformed', 'times');
  if (created > now + (options.maxSkewMs ?? 300_000)) return fail('not_yet_valid');
  if (now > expires) return fail('expired');
  const consent = payload.consent;
  if (!object(consent) || canonicalJson(consent) !== canonicalJson({ purpose: 'harness_optimizer', sharing: 'none', promotion: 'manual_review_only' })) {
    return fail('malformed', 'consent');
  }
  const retention = payload.retention;
  if (!object(retention) || Object.keys(retention).join() !== 'days' || !Number.isSafeInteger(retention.days) ||
    (retention.days as number) < 1 || (retention.days as number) > 3650) return fail('malformed', 'retention');
  let tenantId: string;
  const tenant = payload.tenant as SimTenant;
  try {
    if (!object(tenant) || Object.keys(tenant).sort().join() !== 'owner,repo') throw new Error('tenant');
    tenantId = simTenantId(tenant);
  } catch { return fail('malformed', 'tenant'); }
  if (!trusted.tenants.includes(tenantId)) return fail('tenant_not_authorized');
  try { validateSimHandoffV1(payload.handoff, tenant); } catch (error) {
    return fail('scope_mismatch', (error as Error).message);
  }
  if (payload.eventId !== simEventId(tenant, payload.handoff as SimHandoffV1)) return fail('event_id_mismatch');
  return {
    ok: true,
    payload: payload as unknown as SimHandoffPayload,
    keyId: trusted.keyId,
    eventId: payload.eventId as string,
    tenant: tenantId,
    payloadSha256: sha256(message),
  };
}
