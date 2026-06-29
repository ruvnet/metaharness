import { describe, it, expect } from 'vitest';
import {
  COMPLETION_SCOPES,
  InMemoryKeyStore,
  extractApiKey,
  hashKey,
  highestHeldTier,
  holdsTier,
  isValidKeyFormat,
  keyPrefix,
  verifyApiKey,
} from '../src/auth/apiKey';

// Valid cog_ keys = cog_ + 64 hex chars (ADR-203 §6).
const VALID = 'cog_' + 'a'.repeat(64);
const VALID2 = 'cog_' + 'b'.repeat(64);

function store(): InMemoryKeyStore {
  const s = new InMemoryKeyStore();
  s.add(VALID, {
    permissions: [COMPLETION_SCOPES.low, COMPLETION_SCOPES.high],
    rateLimit: 120,
    active: true,
    expiresAt: null,
    accountId: 'acct_1',
  });
  return s;
}

describe('auth — cog_ key scheme (ADR-203 §6)', () => {
  it('validates the cog_ + 64-hex format', () => {
    expect(isValidKeyFormat(VALID)).toBe(true);
    expect(isValidKeyFormat('cog_short')).toBe(false);
    expect(isValidKeyFormat('sk-openai-style')).toBe(false);
    expect(isValidKeyFormat('cog_' + 'z'.repeat(64))).toBe(false); // z not hex
  });

  it('SHA-256 hashes the key and exposes only a 12-char prefix', () => {
    expect(hashKey(VALID)).toHaveLength(64);
    expect(hashKey(VALID)).not.toContain(VALID); // never the plaintext
    expect(keyPrefix(VALID)).toBe('cog_aaaaaaaa');
    expect(keyPrefix(VALID)).toHaveLength(12);
  });

  it('extracts the key from X-API-Key (preferred) or Bearer', () => {
    expect(extractApiKey({ 'x-api-key': VALID })).toBe(VALID);
    expect(extractApiKey({ authorization: `Bearer ${VALID}` })).toBe(VALID);
    expect(extractApiKey({ authorization: `bearer ${VALID}` })).toBe(VALID); // case-insensitive
    // X-API-Key wins when both present
    expect(extractApiKey({ 'x-api-key': VALID, authorization: `Bearer ${VALID2}` })).toBe(VALID);
    expect(extractApiKey({})).toBeUndefined();
  });

  it('rejects missing / malformed / unknown keys with 401', async () => {
    const s = store();
    expect((await verifyApiKey(undefined, s))).toMatchObject({ ok: false, status: 401, code: 'missing_api_key' });
    expect((await verifyApiKey('nope', s))).toMatchObject({ ok: false, status: 401, code: 'invalid_api_key' });
    expect((await verifyApiKey(VALID2, s))).toMatchObject({ ok: false, status: 401, code: 'invalid_api_key' });
  });

  it('rejects inactive and expired keys with an OPAQUE 401 (granular reason in logs only)', async () => {
    const s = new InMemoryKeyStore();
    s.add(VALID, { permissions: [COMPLETION_SCOPES.low], rateLimit: 1, active: false, expiresAt: null });
    s.add(VALID2, { permissions: [COMPLETION_SCOPES.low], rateLimit: 1, active: true, expiresAt: new Date(Date.now() - 1000) });
    // External wire code/error must NOT reveal key state (anti-enumeration, §6) — collapsed to
    // the same invalid_api_key / 'Invalid API key.' as an unknown key; reason kept in logCode.
    expect((await verifyApiKey(VALID, s))).toMatchObject({ ok: false, code: 'invalid_api_key', error: 'Invalid API key.', logCode: 'key_inactive' });
    expect((await verifyApiKey(VALID2, s))).toMatchObject({ ok: false, code: 'invalid_api_key', error: 'Invalid API key.', logCode: 'key_expired' });
  });

  it('returns an indistinguishable response for unknown vs inactive vs expired keys', async () => {
    const s = new InMemoryKeyStore();
    s.add(VALID, { permissions: [COMPLETION_SCOPES.low], rateLimit: 1, active: false, expiresAt: null });
    const unknown = await verifyApiKey(VALID2, s); // valid format, not in store
    const inactive = await verifyApiKey(VALID, s);
    if (unknown.ok || inactive.ok) throw new Error('expected both to fail');
    expect(unknown.status).toBe(inactive.status);
    expect(unknown.code).toBe(inactive.code);
    expect(unknown.error).toBe(inactive.error);
  });

  it('accepts a valid, active, scoped key', async () => {
    const out = await verifyApiKey(VALID, store());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.key.accountId).toBe('acct_1');
      expect(out.rawPrefix).toBe('cog_aaaaaaaa');
    }
  });

  it('computes held scopes (caps auto escalation, §6 item 2)', async () => {
    const out = await verifyApiKey(VALID, store());
    if (!out.ok) throw new Error('expected ok');
    expect(highestHeldTier(out.key)).toBe('high');
    expect(holdsTier(out.key, 'low')).toBe(true);
    expect(holdsTier(out.key, 'mid')).toBe(false); // low+high only
    expect(holdsTier(out.key, 'high')).toBe(true);
  });
});
