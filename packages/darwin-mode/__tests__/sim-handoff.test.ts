// SPDX-License-Identifier: MIT
// Issue #524: signed, tenant-scoped SIM handoff envelope (metaharness.sim.handoff.v2).
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SimMemory } from '../src/sim-memory.js';
import type { SimAttemptInput, SimScope } from '../src/sim-memory.js';
import {
  canonicalJson, signSimHandoff, signedRufloHandoff, simEventId, simKeyId, verifySimHandoff,
  type SignedSimHandoff, type TrustedSimKey,
} from '../src/sim-handoff.js';

const FIXTURE = join(__dirname, 'fixtures', 'sim-handoff-v2');
const NOW = new Date('2026-11-20T01:00:00.000Z');
const CREATED = new Date('2026-11-20T00:00:00.000Z');
const dirs: string[] = [];

function scopeFor(ownerId: string, repoId = 'ruvnet/metaharness'): SimScope {
  return { ownerId, repoId, interfaceId: 'darwin-v1', modelId: 'm', benchmarkId: 'b', harnessVersion: '0.14.0' };
}
function attempt(id: string, scope: SimScope): SimAttemptInput {
  return {
    id, createdAt: '2026-11-19T00:00:00.000Z', scope, problemKey: 'retry-loop',
    diagnosis: 'Retried without changing inputs', variantId: 'v-' + id, parentId: 'baseline',
    mutationSurface: 'retryPolicy', rationale: 'Change inputs first', predictedDelta: null,
    observedDelta: -0.02, finalScore: 0.4, promoted: false, evidenceIds: ['archive:' + id],
  };
}
async function memoryFor(scope: SimScope, ids = ['one', 'two']): Promise<SimMemory> {
  const root = await mkdtemp(join(tmpdir(), 'sim-handoff-'));
  dirs.push(root);
  const memory = new SimMemory(join(root, 'sim.json'));
  for (const id of ids) await memory.append(attempt(id, scope));
  return memory;
}
function keyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('ed25519');
}
function trust(publicKey: KeyObject, tenants: string[], extra: Partial<TrustedSimKey> = {}): TrustedSimKey {
  return { keyId: simKeyId(publicKey), publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), tenants, ...extra };
}
/** Re-signs an arbitrary payload exactly as the spec says: Ed25519 over domain + canonical JSON. */
function rawSign(payload: unknown, privateKey: KeyObject): SignedSimHandoff {
  const value = sign(null, Buffer.from('metaharness.sim.handoff.v2\n' + canonicalJson(payload)), privateKey).toString('base64');
  return { payload, signature: { alg: 'ed25519', value } } as SignedSimHandoff;
}
async function signedFor(scope: SimScope, privateKey: KeyObject): Promise<SignedSimHandoff> {
  const memory = await memoryFor(scope);
  return signedRufloHandoff(memory, { scope, query: 'retry', mode: 'full' }, { privateKey, createdAt: CREATED });
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SIM handoff v2: cross-repo fixture (shared with ruflo)', () => {
  it('verifies both committed tenant envelopes against their public keys only', async () => {
    const trusted = JSON.parse(await readFile(join(FIXTURE, 'trusted-keys.json'), 'utf8'));
    expect(JSON.stringify(trusted)).not.toMatch(/PRIVATE KEY/);
    for (const name of ['a', 'b']) {
      const envelope = JSON.parse(await readFile(join(FIXTURE, 'envelope-' + name + '.json'), 'utf8'));
      const result = verifySimHandoff(envelope, { trustedKeys: trusted.keys, now: new Date(trusted.verifyAt) });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.tenant).toBe('tenant-' + name + '/ruvnet/metaharness');
        expect(result.payload.handoff.attempts).toHaveLength(2);
        expect(result.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('rejects the tenant-A fixture when only tenant-B is trusted for its key (zero cross-tenant acceptance)', async () => {
    const trusted = JSON.parse(await readFile(join(FIXTURE, 'trusted-keys.json'), 'utf8'));
    const envelope = JSON.parse(await readFile(join(FIXTURE, 'envelope-a.json'), 'utf8'));
    const keys = trusted.keys.map((k: TrustedSimKey) => ({ ...k, tenants: ['tenant-b/ruvnet/metaharness'] }));
    expect(verifySimHandoff(envelope, { trustedKeys: keys, now: NOW })).toMatchObject({ ok: false, reason: 'tenant_not_authorized' });
  });
});

describe('SIM handoff v2: producer', () => {
  it('signs SimMemory evidence with provenance, consent and retention, and verifies it', async () => {
    const { publicKey, privateKey } = keyPair();
    const envelope = await signedFor(scopeFor('tenant-a'), privateKey);
    expect(envelope.payload).toMatchObject({
      schema: 'metaharness.sim.handoff.v2', keyId: simKeyId(publicKey),
      tenant: { owner: 'tenant-a', repo: 'ruvnet/metaharness' },
      consent: { purpose: 'harness_optimizer', sharing: 'none', promotion: 'manual_review_only' },
      retention: { days: 30 }, createdAt: CREATED.toISOString(),
    });
    const result = verifySimHandoff(envelope, { trustedKeys: [trust(publicKey, ['tenant-a/ruvnet/metaharness'])], now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.handoff.attempts.map((a) => a.id).sort()).toEqual(['one', 'two']);
  });

  it('derives the event id from content, so redelivery and re-signing are idempotent', async () => {
    const { privateKey } = keyPair();
    const scope = scopeFor('tenant-a');
    const memory = await memoryFor(scope);
    const handoff = await memory.rufloHandoff({ scope, query: 'retry', mode: 'full' });
    const first = signSimHandoff(handoff, { privateKey, createdAt: CREATED });
    const second = signSimHandoff(handoff, { privateKey, createdAt: NOW });
    expect(first.payload.eventId).toBe(second.payload.eventId);
    expect(first.payload.eventId).toBe(simEventId(first.payload.tenant, first.payload.handoff));
  });

  it('refuses to sign attempts from another tenant or with smuggled grader fields', async () => {
    const { privateKey } = keyPair();
    const scope = scopeFor('tenant-a');
    const handoff = clone(await (await memoryFor(scope)).rufloHandoff({ scope, query: 'retry', mode: 'full' })) as any;
    const foreign = clone(handoff);
    foreign.attempts[0].scope.ownerId = 'tenant-b';
    expect(() => signSimHandoff(foreign, { privateKey })).toThrow(/tenant/);
    const smuggled = clone(handoff);
    smuggled.attempts[0].heldOutTrace = 'hidden test output';
    expect(() => signSimHandoff(smuggled, { privateKey })).toThrow(/unexpected field/);
    expect(() => signSimHandoff(handoff, { privateKey, tenant: { owner: 'tenant-b', repo: 'ruvnet/metaharness' } })).toThrow(/tenant/);
    expect(() => signSimHandoff(handoff, { privateKey, tenant: { owner: '../x', repo: 'r' } })).toThrow(/tenant/);
  });

  it('canonical JSON is key-order independent and rejects non-finite numbers', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
  });
});

describe('SIM handoff v2: adversarial verification', () => {
  const tenantA = 'tenant-a/ruvnet/metaharness';
  it('rejects a single tampered byte in the payload or signature', async () => {
    const { publicKey, privateKey } = keyPair();
    const envelope = await signedFor(scopeFor('tenant-a'), privateKey);
    const keys = [trust(publicKey, [tenantA])];
    const payload = clone(envelope);
    payload.payload.handoff.attempts[0].diagnosis += '!';
    expect(verifySimHandoff(payload, { trustedKeys: keys, now: NOW })).toMatchObject({ ok: false, reason: 'bad_signature' });
    const sigBytes = Buffer.from(envelope.signature.value, 'base64');
    sigBytes[0] ^= 1;
    const badSig = { ...clone(envelope), signature: { alg: 'ed25519' as const, value: sigBytes.toString('base64') } };
    expect(verifySimHandoff(badSig, { trustedKeys: keys, now: NOW })).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('rejects unsigned, malformed and unknown-key payloads', async () => {
    const { publicKey, privateKey } = keyPair();
    const envelope = await signedFor(scopeFor('tenant-a'), privateKey);
    const keys = [trust(publicKey, [tenantA])];
    const opts = { trustedKeys: keys, now: NOW };
    expect(verifySimHandoff({ payload: envelope.payload }, opts)).toMatchObject({ reason: 'unsigned' });
    expect(verifySimHandoff({ ...envelope, signature: { alg: 'none', value: 'x' } }, opts)).toMatchObject({ reason: 'unsigned' });
    expect(verifySimHandoff(null, opts)).toMatchObject({ reason: 'malformed' });
    expect(verifySimHandoff('{"payload":{}}', opts)).toMatchObject({ reason: 'malformed' });
    expect(verifySimHandoff({ ...envelope, extra: 1 }, opts)).toMatchObject({ reason: 'malformed' });
    expect(verifySimHandoff(envelope.payload.handoff, opts)).toMatchObject({ reason: 'malformed' });
    const other = keyPair();
    expect(verifySimHandoff(envelope, { trustedKeys: [trust(other.publicKey, [tenantA])], now: NOW })).toMatchObject({ reason: 'unknown_key' });
    // A config entry whose keyId does not belong to its public key cannot alias a key.
    const aliased = { ...trust(other.publicKey, [tenantA]), keyId: envelope.payload.keyId };
    expect(verifySimHandoff(envelope, { trustedKeys: [aliased], now: NOW })).toMatchObject({ reason: 'key_id_mismatch' });
  });

  it('rejects revoked keys, expired keys, expired envelopes and future-dated envelopes', async () => {
    const { publicKey, privateKey } = keyPair();
    const envelope = await signedFor(scopeFor('tenant-a'), privateKey);
    const verifyWith = (extra: Partial<TrustedSimKey>, now = NOW) =>
      verifySimHandoff(envelope, { trustedKeys: [trust(publicKey, [tenantA], extra)], now });
    expect(verifyWith({ revoked: true })).toMatchObject({ reason: 'revoked_key' });
    expect(verifyWith({ notAfter: '2026-11-19T00:00:00.000Z' })).toMatchObject({ reason: 'key_expired' });
    expect(verifyWith({}, new Date('2027-01-01T00:00:00.000Z'))).toMatchObject({ reason: 'expired' });
    expect(verifyWith({}, new Date('2026-11-19T00:00:00.000Z'))).toMatchObject({ reason: 'not_yet_valid' });
  });

  it('a validly signed envelope for another tenant, or with forged inner scope, is rejected', async () => {
    const a = keyPair();
    const keys = [trust(a.publicKey, [tenantA])];
    // Key A signs a perfectly-formed tenant-B envelope: signature valid, tenant not bound to the key.
    const forB = await signedFor(scopeFor('tenant-b'), a.privateKey);
    expect(verifySimHandoff(forB, { trustedKeys: keys, now: NOW })).toMatchObject({ ok: false, reason: 'tenant_not_authorized' });
    // Key A claims tenant A on the envelope but smuggles tenant-B records inside (bypassing the producer).
    const good = await signedFor(scopeFor('tenant-a'), a.privateKey);
    const forged = clone(good.payload) as any;
    forged.handoff.attempts[0].scope.ownerId = 'tenant-b';
    expect(verifySimHandoff(rawSign(forged, a.privateKey), { trustedKeys: keys, now: NOW }))
      .toMatchObject({ ok: false, reason: 'scope_mismatch' });
    // Smuggled grader artifacts in a signed record are rejected, not silently dropped.
    const smuggled = clone(good.payload) as any;
    smuggled.handoff.attempts[0].hiddenTests = ['assert secret'];
    expect(verifySimHandoff(rawSign(smuggled, a.privateKey), { trustedKeys: keys, now: NOW }))
      .toMatchObject({ ok: false, reason: 'scope_mismatch' });
    // A signer cannot pick an event id that collides with another event's content.
    const renamed = clone(good.payload) as any;
    renamed.eventId = 'sim-evt-' + '0'.repeat(40);
    expect(verifySimHandoff(rawSign(renamed, a.privateKey), { trustedKeys: keys, now: NOW }))
      .toMatchObject({ ok: false, reason: 'event_id_mismatch' });
    // Consent cannot be widened by the producer.
    const shared = clone(good.payload) as any;
    shared.consent.sharing = 'public';
    expect(verifySimHandoff(rawSign(shared, a.privateKey), { trustedKeys: keys, now: NOW }))
      .toMatchObject({ ok: false, reason: 'malformed' });
  });
});
