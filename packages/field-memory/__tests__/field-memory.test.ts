import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FIELD_MEMORY_SCHEMA_VERSION,
  InMemoryFieldStorage,
  InMemoryRuVectorRecordRegistry,
  createFieldMemory,
  createRuVectorFieldStorage,
  type FieldMemory,
  type FieldMemoryConfig,
  type PrincipalVerifier,
} from '../src/index.js';

const DAY = 86_400_000;
const IDENTITY_KEY = 'field-memory-test-key-32-bytes-minimum';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function resign<State extends {
  schemaVersion: string;
  identityKeyId: string;
  policy: unknown;
  records: unknown;
  integrity: { algorithm: string; digest: string };
}>(state: State): State {
  const payload = {
    schemaVersion: state.schemaVersion,
    identityKeyId: state.identityKeyId,
    policy: state.policy,
    records: state.records,
  };
  state.integrity.digest = createHmac('sha256', IDENTITY_KEY).update(canonical(payload)).digest('hex');
  return state;
}

interface Proof {
  subject: string;
  domain: string;
  valid?: boolean;
}

const verifier: PrincipalVerifier<Proof> = async (proof) =>
  proof.valid === false ? null : { principalId: proof.subject, trustDomain: proof.domain };

function setup(overrides: Partial<FieldMemoryConfig> = {}, initialNow = 100 * DAY) {
  const time = { now: initialNow };
  const config: FieldMemoryConfig = {
    dimension: 2,
    minimumSupport: 1,
    minimumTrustDomains: 1,
    retrievalK: 1,
    bucketSizeMs: DAY,
    decayHalfLifeMs: 7 * DAY,
    driftWindowMs: 30 * DAY,
    influenceWindowMs: 30 * DAY,
    idempotencyWindowMs: 30 * DAY,
    ...overrides,
  };
  const storage = new InMemoryFieldStorage({ dimension: 2, metric: config.similarity ?? 'cosine' });
  const memory = createFieldMemory({
    config,
    storage,
    verifier,
    identityHashKey: IDENTITY_KEY,
    clock: () => time.now,
  });
  return { memory, storage, time };
}

async function learn(
  memory: FieldMemory<Proof>,
  input: {
    centroid?: string;
    configuration: string;
    reward: number;
    principal: string;
    domain?: string;
    at: number;
    vector?: number[];
    cost?: number;
    weight?: number;
    key?: string;
    valid?: boolean;
  },
) {
  return memory.update({
    centroidId: input.centroid ?? 'basin-a',
    embedding: input.vector ?? [1, 0],
    configurationId: input.configuration,
    reward: input.reward,
    cost: input.cost ?? 0,
    observedAt: input.at,
    idempotencyKey: input.key ?? `${input.configuration}:${input.principal}:${input.at}`,
    ...(input.weight === undefined ? {} : { weight: input.weight }),
    principalProof: {
      subject: input.principal,
      domain: input.domain ?? 'tenant-a',
      valid: input.valid,
    },
  });
}

describe('packed multihead retrieval', () => {
  it('stores four configuration heads behind one vector and never censors the fourth head at retrievalK=1', async () => {
    const { memory, storage, time } = setup({ retrievalK: 1 });
    for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) {
      await learn(memory, {
        configuration: id,
        reward: (index + 1) / 4,
        principal: `principal-${index}`,
        at: time.now,
      });
    }

    expect(storage.stats().entries).toBe(1);
    expect(4 / storage.stats().entries).toBe(4);
    const choice = await memory.choose({ embedding: [1, 0], now: time.now, retrievalK: 1 });
    expect(choice?.candidates.map((candidate) => candidate.configurationId)).toEqual(['d', 'c', 'b', 'a']);
    expect(choice?.configurationId).toBe('d');

    const fourthOnly = await memory.choose({
      embedding: [1, 0],
      now: time.now,
      retrievalK: 1,
      allowedConfigurations: ['d'],
    });
    expect(fourthOnly?.configurationId).toBe('d');
  });

  it('deduplicates a repeated storage ID before scoring', async () => {
    const { memory, storage, time } = setup();
    await learn(memory, { configuration: 'safe', reward: 1, principal: 'p1', at: time.now });
    const original = storage.search.bind(storage);
    storage.search = async (vector, limit) => {
      const [hit] = await original(vector, limit);
      return [hit, structuredClone(hit)];
    };
    const choice = await memory.choose({ embedding: [1, 0], now: time.now, retrievalK: 2 });
    expect(choice?.searchedCentroids).toBe(1);
    expect(choice?.candidates[0].centroidIds).toEqual(['basin-a']);
  });
});

describe('time-dependent adaptation', () => {
  it('uses configuration-specific timestamps so a recent good head can outrank an old excellent head', async () => {
    const { memory, time } = setup({ decayHalfLifeMs: DAY, driftWindowMs: 20 * DAY });
    const old = time.now - 4 * DAY;
    await learn(memory, { configuration: 'old', reward: 1, principal: 'old-p', at: old });
    await learn(memory, { configuration: 'recent', reward: 0.6, principal: 'new-p', at: time.now });

    const choice = await memory.choose({ embedding: [1, 0], now: time.now });
    expect(choice?.configurationId).toBe('recent');
    const state = await memory.exportState();
    const heads = Object.fromEntries(state.records[0].heads.map((head) => [head.configurationId, head.lastUpdatedAt]));
    expect(heads.old).toBe(old);
    expect(heads.recent).toBe(time.now);
  });

  it('windows historical heads after distribution drift and compacts them deterministically', async () => {
    const { memory, time } = setup({ driftWindowMs: 5 * DAY, decayHalfLifeMs: DAY }, 10 * DAY);
    await learn(memory, { configuration: 'legacy', reward: 1, principal: 'legacy-p', at: time.now });
    expect((await memory.choose({ embedding: [1, 0], now: time.now }))?.configurationId).toBe('legacy');

    time.now += 6 * DAY;
    await learn(memory, { configuration: 'adapted', reward: 0.8, principal: 'new-p', at: time.now });
    const choice = await memory.choose({ embedding: [1, 0], now: time.now });
    expect(choice?.configurationId).toBe('adapted');
    expect(choice?.candidates.some((candidate) => candidate.configurationId === 'legacy')).toBe(false);

    const first = await memory.compact({ now: time.now });
    const bytes = await memory.exportStateJson();
    const second = await memory.compact({ now: time.now });
    expect(first.changed).toBe(0); // update already pruned the target centroid
    expect(second.changed).toBe(0);
    expect(await memory.exportStateJson()).toBe(bytes);
  });

  it('expires a stale high-similarity centroid before top-K can censor an active centroid', async () => {
    const { memory, time } = setup({ driftWindowMs: 5 * DAY, retrievalK: 1 }, 10 * DAY);
    await learn(memory, {
      centroid: 'stale-nearest', configuration: 'stale', reward: 1, principal: 'old',
      at: time.now, vector: [1, 0],
    });
    time.now += 6 * DAY;
    await learn(memory, {
      centroid: 'active-farther', configuration: 'active', reward: 1, principal: 'new',
      at: time.now, vector: [0.8, 0.6],
    });
    const choice = await memory.choose({ embedding: [1, 0], now: time.now, retrievalK: 1 });
    expect(choice?.configurationId).toBe('active');
    expect(choice?.searchedCentroids).toBe(1);
  });
});

describe('governed updates and privacy', () => {
  it('accounts influence only against verified principals and enforces the principal cap', async () => {
    const { memory, time } = setup({ principalInfluenceCap: 2, trustDomainInfluenceCap: 20 });
    expect((await learn(memory, {
      configuration: 'route', reward: 1, principal: 'verified-p', at: time.now, key: 'one',
    })).status).toBe('accepted');
    expect((await learn(memory, {
      configuration: 'route', reward: 1, principal: 'verified-p', at: time.now, key: 'two',
    })).status).toBe('accepted');
    const capped = await learn(memory, {
      configuration: 'route', reward: -1, principal: 'verified-p', at: time.now, key: 'three',
    });
    expect(capped.status).toBe('principal-cap');
    expect(capped.acceptedWeight).toBe(0);

    const rejected = await learn(memory, {
      configuration: 'route', reward: -1, principal: 'spoofed', at: time.now, key: 'invalid', valid: false,
    });
    expect(rejected.status).toBe('verification-failed');
    expect((await memory.choose({ embedding: [1, 0], now: time.now }))?.candidates[0].rewardScore).toBeGreaterThan(0);
  });

  it('bounds every update contribution and reports partial clamping', async () => {
    const { memory, time } = setup({ maxContributionWeight: 0.25, principalInfluenceCap: 1 });
    const receipt = await learn(memory, {
      configuration: 'route', reward: 1, principal: 'p1', at: time.now, weight: 10,
    });
    expect(receipt.acceptedWeight).toBe(0.25);
    expect(receipt.contributionClamped).toBe(true);
  });

  it('never rounds a tiny accepted contribution above the request or any cap', async () => {
    const { memory, time } = setup({
      maxContributionWeight: 1e-12,
      principalInfluenceCap: 1e-12,
      trustDomainInfluenceCap: 1e-12,
      maxAggregateWeight: 1e-12,
    });
    const receipt = await learn(memory, {
      configuration: 'route', reward: 1, principal: 'p1', at: time.now, weight: 1e-12,
    });
    expect(receipt.acceptedWeight).toBe(1e-12);
    expect(receipt.acceptedWeight).toBeLessThanOrEqual(receipt.requestedWeight);
    expect(receipt.acceptedWeight).toBeLessThanOrEqual(memory.config.maxContributionWeight);
    expect(receipt.acceptedWeight).toBeLessThanOrEqual(memory.config.principalInfluenceCap);
    await expect(learn(memory, {
      configuration: 'route', reward: 1, principal: 'p2', at: time.now, weight: 6e-13,
    })).rejects.toThrow(/at least 1e-12/);
  });

  it('does not round a fractional remaining influence budget up by one quantum', async () => {
    const { memory, time } = setup({
      principalInfluenceCap: 1.5e-12,
      trustDomainInfluenceCap: 10,
      maxAggregateWeight: 10,
    });
    expect((await learn(memory, {
      configuration: 'route', reward: 1, principal: 'p1', at: time.now, weight: 1e-12, key: 'one',
    })).acceptedWeight).toBe(1e-12);
    const second = await learn(memory, {
      configuration: 'route', reward: 1, principal: 'p1', at: time.now, weight: 1e-12, key: 'two',
    });
    expect(second.acceptedWeight).toBe(0);
    expect(second.status).toBe('principal-cap');
  });

  it('keeps minimum-weight dense embeddings representable through support activation and import', async () => {
    const dimension = 384;
    const dense = Array.from({ length: dimension }, () => 1);
    const time = { now: 100 * DAY };
    const config = { dimension, minimumSupport: 3 } as const;
    const memory = createFieldMemory({
      config,
      verifier,
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    const receipts = [];
    for (const principal of ['p1', 'p2', 'p3']) {
      receipts.push(await memory.update({
        centroidId: 'dense',
        embedding: dense,
        configurationId: 'route',
        reward: 1,
        cost: 0,
        observedAt: time.now,
        idempotencyKey: principal,
        weight: 1e-12,
        principalProof: { subject: principal, domain: 'tenant-a' },
      }));
    }
    expect(receipts.map((receipt) => receipt.status)).toEqual([
      'privacy-buffered', 'privacy-buffered', 'accepted',
    ]);
    const state = await memory.exportState();
    expect(Math.hypot(...state.records[0].vector)).toBeCloseTo(1, 10);
    expect((await memory.choose({ embedding: dense, now: time.now }))?.configurationId).toBe('route');

    const restored = createFieldMemory({
      config,
      verifier,
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    await restored.importState(state);
    expect(await restored.exportStateJson()).toBe(await memory.exportStateJson());

    const zeroed = structuredClone(state);
    zeroed.records[0].heads[0].embeddingBuckets[0].weightedSum.fill(0);
    resign(zeroed);
    await expect(restored.importState(zeroed)).rejects.toThrow(/published centroid/);

    const oversized = structuredClone(state);
    const headBucket = oversized.records[0].heads[0].embeddingBuckets[0];
    headBucket.weightedSum[0] = headBucket.weight * 2;
    resign(oversized);
    await expect(restored.importState(oversized)).rejects.toThrow(/magnitude exceeds/);
  });

  it('quarantines a support-qualified cosine head whose contributions cancel to zero', async () => {
    const { memory, time } = setup({ minimumSupport: 2 });
    expect((await learn(memory, {
      configuration: 'cancelled', reward: 1, principal: 'p1', at: time.now, vector: [1, 0],
    })).status).toBe('privacy-buffered');
    const cancelled = await learn(memory, {
      configuration: 'cancelled', reward: 1, principal: 'p2', at: time.now, vector: [-1, 0],
    });
    expect(cancelled.status).toBe('privacy-buffered');
    expect(cancelled.eligible).toBe(false);
    expect(await memory.choose({ embedding: [1, 0], now: time.now })).toBeNull();
    expect((await memory.exportState()).records[0].searchable).toBe(false);
  });

  it('keeps a singleton unroutable until distinct verified-principal support reaches policy', async () => {
    const { memory, time } = setup({ minimumSupport: 3 });
    const singleton = await learn(memory, {
      configuration: 'rare', reward: 1, principal: 'p1', at: time.now, key: 'p1',
    });
    expect(singleton.status).toBe('privacy-buffered');
    expect(singleton.eligible).toBe(false);
    expect(await memory.choose({ embedding: [1, 0], now: time.now })).toBeNull();

    await learn(memory, { configuration: 'rare', reward: 1, principal: 'p2', at: time.now, key: 'p2' });
    const threshold = await learn(memory, {
      configuration: 'rare', reward: 1, principal: 'p3', at: time.now, key: 'p3',
    });
    expect(threshold.status).toBe('accepted');
    expect(threshold.support).toBe(3);
    expect((await memory.choose({ embedding: [1, 0], now: time.now }))?.configurationId).toBe('rare');
  });

  it('quarantines a singleton head without moving an already searchable centroid', async () => {
    const { memory, storage, time } = setup({ minimumSupport: 2, principalInfluenceCap: 10 });
    await learn(memory, {
      configuration: 'established', reward: 1, principal: 'p1', at: time.now, vector: [1, 0], key: 'e1',
    });
    await learn(memory, {
      configuration: 'established', reward: 1, principal: 'p2', at: time.now, vector: [1, 0], key: 'e2',
    });
    const before = (await storage.get('basin-a'))?.vector;

    const singleton = await learn(memory, {
      configuration: 'rare', reward: 1, principal: 'p3', at: time.now, vector: [0, 1], key: 'rare',
    });
    expect(singleton.status).toBe('privacy-buffered');
    expect((await storage.get('basin-a'))?.vector).toEqual(before);
    expect((await memory.choose({ embedding: [1, 0], now: time.now }))?.configurationId).toBe('established');
  });

  it('retains a quarantined record across compaction so later support can activate it', async () => {
    const { memory, storage, time } = setup({ minimumSupport: 2 });
    await learn(memory, { configuration: 'rare', reward: 1, principal: 'p1', at: time.now, key: 'one' });
    expect(storage.stats()).toEqual({ entries: 0, records: 1 });
    await memory.compact({ now: time.now });
    expect(storage.stats()).toEqual({ entries: 0, records: 1 });
    const accepted = await learn(memory, {
      configuration: 'rare', reward: 1, principal: 'p2', at: time.now, key: 'two',
    });
    expect(accepted.status).toBe('accepted');
    expect(storage.stats()).toEqual({ entries: 1, records: 1 });
  });

  it('treats the support gate as routing quarantine, not confidentiality of authorized exports', async () => {
    const { memory, time } = setup({ minimumSupport: 2 });
    await learn(memory, { configuration: 'rare', reward: 0.75, cost: 0.2, principal: 'p1', at: time.now });
    const state = await memory.exportState();
    expect(state.records[0].searchable).toBe(false);
    expect(state.records[0].embeddingBuckets).toEqual([]);
    expect(state.records[0].heads[0].buckets[0].rewardSum).toBe(0.75);
    expect(state.records[0].heads[0].embeddingBuckets[0].weightedSum).toEqual([1, 0]);
  });

  it('does not expose a raw episode or reconstruction API', () => {
    const { memory } = setup();
    expect('episodes' in memory).toBe(false);
    expect('reconstruct' in memory).toBe(false);
    expect('getEpisode' in memory).toBe(false);
  });
});

describe('routing policy', () => {
  it('penalizes inference cost when rewards are equal', async () => {
    const { memory, time } = setup({ costPenaltyWeight: 1, costScale: 1 });
    await learn(memory, { configuration: 'expensive', reward: 1, cost: 1, principal: 'p1', at: time.now });
    await learn(memory, { configuration: 'cheap', reward: 1, cost: 0.1, principal: 'p2', at: time.now });
    expect((await memory.choose({ embedding: [1, 0], now: time.now }))?.configurationId).toBe('cheap');
  });

  it('defaults hysteresis to zero and refuses persistence across a semantic discontinuity', async () => {
    const baseline = setup({ hysteresisMargin: 0 });
    await learn(baseline.memory, {
      configuration: 'previous', reward: 0.5, principal: 'p1', at: baseline.time.now,
    });
    await learn(baseline.memory, {
      configuration: 'winner', reward: 1, principal: 'p2', at: baseline.time.now,
    });
    const noHysteresis = await baseline.memory.choose({
      embedding: [1, 0],
      now: baseline.time.now,
      previous: { configurationId: 'previous', queryEmbedding: [1, 0] },
    });
    expect(noHysteresis?.configurationId).toBe('winner');
    expect(noHysteresis?.hysteresisApplied).toBe(false);

    const guarded = setup({ hysteresisMargin: 1, semanticContinuityThreshold: 0.9 });
    await learn(guarded.memory, {
      configuration: 'previous', reward: 0.5, principal: 'p1', at: guarded.time.now,
    });
    await learn(guarded.memory, {
      configuration: 'winner', reward: 1, principal: 'p2', at: guarded.time.now,
    });
    const discontinuous = await guarded.memory.choose({
      embedding: [1, 0],
      now: guarded.time.now,
      previous: { configurationId: 'previous', queryEmbedding: [0, 1] },
    });
    expect(discontinuous?.semanticContinuity).toBe(0);
    expect(discontinuous?.configurationId).toBe('winner');
    expect(discontinuous?.hysteresisApplied).toBe(false);

    const continuous = await guarded.memory.choose({
      embedding: [1, 0],
      now: guarded.time.now,
      previous: { configurationId: 'previous', queryEmbedding: [1, 0] },
    });
    expect(continuous?.configurationId).toBe('previous');
    expect(continuous?.hysteresisApplied).toBe(true);
  });

  it('scores an immutable query snapshot when the caller mutates input during compaction', async () => {
    const { memory, storage, time } = setup();
    await learn(memory, { configuration: 'safe', reward: 1, principal: 'p1', at: time.now });
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalList = storage.list.bind(storage);
    storage.list = async () => {
      started();
      await gate;
      return originalList();
    };
    const input = {
      embedding: [1, 0],
      now: time.now,
      allowedConfigurations: ['safe'],
      previous: { configurationId: 'safe', queryEmbedding: [1, 0] },
    };
    const pending = memory.choose(input);
    await began;
    input.embedding.splice(0, 2, 0, 1);
    input.allowedConfigurations[0] = 'mutated';
    input.previous.configurationId = 'mutated';
    input.previous.queryEmbedding.splice(0, 2, 0, 1);
    release();
    expect((await pending)?.configurationId).toBe('safe');
  });
});

describe('portable reversible state', () => {
  it('derives byte-identical packed centroids regardless of head insertion order', async () => {
    const first = setup({ principalInfluenceCap: 10 });
    const second = setup({ principalInfluenceCap: 10 });
    const updates = [
      { configuration: 'z', reward: 0.7, principal: 'pz', vector: [1, 1e-12], weight: 1 },
      { configuration: 'a', reward: 0.8, principal: 'pa', vector: [-1, 1], weight: 1 },
      { configuration: 'm', reward: 0.9, principal: 'pm', vector: [1e-12, -1], weight: 1e-12 },
    ];
    for (const update of updates) await learn(first.memory, { ...update, at: first.time.now });
    for (const update of [updates[2], updates[0], updates[1]]) {
      await learn(second.memory, { ...update, at: second.time.now });
    }
    expect(await second.memory.exportStateJson()).toBe(await first.memory.exportStateJson());
  });

  it('exports byte-identical canonical state, verifies integrity, and imports reversibly', async () => {
    const first = setup({ minimumSupport: 2 });
    await learn(first.memory, {
      centroid: 'z', configuration: 'route-b', reward: 0.8, principal: 'p2', at: first.time.now,
    });
    await learn(first.memory, {
      centroid: 'z', configuration: 'route-b', reward: 0.9, principal: 'p1', at: first.time.now,
    });
    await learn(first.memory, {
      centroid: 'a', configuration: 'route-a', reward: 0.7, principal: 'p4', at: first.time.now,
    });
    await learn(first.memory, {
      centroid: 'a', configuration: 'route-a', reward: 0.6, principal: 'p3', at: first.time.now,
    });

    const bytes1 = await first.memory.exportStateJson();
    const bytes2 = await first.memory.exportStateJson();
    expect(bytes1).toBe(bytes2);
    expect(JSON.parse(bytes1).schemaVersion).toBe(FIELD_MEMORY_SCHEMA_VERSION);
    expect(bytes1).not.toContain('principalProof');

    const second = setup({ minimumSupport: 2 });
    await second.memory.importState(bytes1, { mode: 'replace' });
    expect(await second.memory.exportStateJson()).toBe(bytes1);
    expect((await second.memory.choose({ embedding: [1, 0], now: second.time.now }))?.configurationId)
      .toBe((await first.memory.choose({ embedding: [1, 0], now: first.time.now }))?.configurationId);

    const tampered = bytes1.replace('route-a', 'route-x');
    await expect(second.memory.importState(tampered)).rejects.toThrow(/integrity/);
  });

  it('round-trips an accepted observation within the configured future-skew allowance', async () => {
    const time = { now: 100 * DAY };
    const config = { dimension: 2, minimumSupport: 1, maxFutureSkewMs: 60_000 } as const;
    const memory = createFieldMemory({
      config,
      verifier,
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    expect((await learn(memory, {
      configuration: 'route', reward: 1, principal: 'p1', at: time.now + 30_000,
    })).status).toBe('accepted');
    const state = await memory.exportStateJson();
    const restored = createFieldMemory({
      config,
      verifier,
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    await restored.importState(state);
    expect(await restored.exportStateJson()).toBe(state);
  });

  it('rejects an import under a different policy rather than silently changing semantics', async () => {
    const source = setup({ costPenaltyWeight: 0.1 });
    const target = setup({ costPenaltyWeight: 0.2 });
    await expect(target.memory.importState(await source.memory.exportStateJson())).rejects.toThrow(/policy/);
  });

  it('rejects restore with a different identity key before historical caps can be bypassed', async () => {
    const source = setup();
    await learn(source.memory, { configuration: 'route', reward: 1, principal: 'p1', at: source.time.now });
    const target = createFieldMemory({
      config: source.memory.config,
      verifier,
      identityHashKey: 'a-different-field-memory-key-32-bytes',
      clock: () => source.time.now,
    });
    await expect(target.importState(await source.memory.exportStateJson())).rejects.toThrow(/identity key/);
  });

  it('rejects semantically invalid state even when an attacker recomputes its HMAC', async () => {
    const source = setup();
    await learn(source.memory, { configuration: 'route', reward: 1, principal: 'p1', at: source.time.now });

    const duplicateHead = structuredClone(await source.memory.exportState());
    duplicateHead.records[0].heads.push(structuredClone(duplicateHead.records[0].heads[0]));
    resign(duplicateHead);
    await expect(source.memory.importState(duplicateHead)).rejects.toThrow(/duplicate reward head/);

    const inconsistentVector = structuredClone(await source.memory.exportState());
    inconsistentVector.records[0].vector = [0, 1];
    resign(inconsistentVector);
    await expect(source.memory.importState(inconsistentVector)).rejects.toThrow(/published centroid/);

    const duplicateBucket = structuredClone(await source.memory.exportState());
    duplicateBucket.records[0].heads[0].buckets.push(
      structuredClone(duplicateBucket.records[0].heads[0].buckets[0]),
    );
    resign(duplicateBucket);
    await expect(source.memory.importState(duplicateBucket)).rejects.toThrow(/duplicate reward bucket/);

    const excessiveInfluence = structuredClone(await source.memory.exportState());
    excessiveInfluence.records[0].principalInfluence[0].buckets[0].weight = 100;
    resign(excessiveInfluence);
    await expect(source.memory.importState(excessiveInfluence)).rejects.toThrow(/influence exceeds/);
  });
});

describe('validation and idempotency', () => {
  it('rejects malformed vectors and future observations', async () => {
    const { memory, time } = setup({ maxFutureSkewMs: 0 });
    await expect(memory.update({
      centroidId: 'a',
      embedding: [1],
      configurationId: 'route',
      reward: 1,
      cost: 0,
      observedAt: time.now,
      idempotencyKey: 'bad-vector',
      principalProof: { subject: 'p', domain: 'd' },
    })).rejects.toThrow(/exactly 2/);
    await expect(learn(memory, {
      configuration: 'route', reward: 1, principal: 'p', at: time.now + 1,
    })).rejects.toThrow(/future clock skew/);
  });

  it('rejects trivially stale or future observations before invoking the verifier', async () => {
    const time = { now: 100 * DAY };
    let verifierCalls = 0;
    const memory = createFieldMemory({
      config: { dimension: 2, driftWindowMs: 30 * DAY, bucketSizeMs: DAY, maxFutureSkewMs: 0 },
      verifier: async () => {
        verifierCalls += 1;
        return { principalId: 'p1', trustDomain: 'tenant-a' };
      },
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    expect((await learn(memory, {
      configuration: 'route', reward: 1, principal: 'ignored', at: time.now - 31 * DAY,
    })).status).toBe('stale');
    await expect(learn(memory, {
      configuration: 'route', reward: 1, principal: 'ignored', at: time.now + 1,
    })).rejects.toThrow(/future clock skew/);
    expect(verifierCalls).toBe(0);
  });

  it('applies an idempotency key once even under concurrent submissions', async () => {
    const { memory, time } = setup();
    const operation = () => learn(memory, {
      configuration: 'route', reward: 1, principal: 'p', at: time.now, key: 'same',
    });
    const receipts = await Promise.all([operation(), operation()]);
    expect(receipts.map((receipt) => receipt.status).sort()).toEqual(['accepted', 'duplicate']);
    const state = await memory.exportState();
    expect(state.records[0].heads[0].buckets[0].updates).toBe(1);
  });

  it('scopes idempotency keys to a verified principal', async () => {
    const { memory, time } = setup({ principalInfluenceCap: 10 });
    const first = await learn(memory, {
      configuration: 'route', reward: 1, principal: 'p1', at: time.now, key: 'common',
    });
    const otherPrincipal = await learn(memory, {
      configuration: 'route', reward: 1, principal: 'p2', at: time.now, key: 'common',
    });
    const replay = await learn(memory, {
      configuration: 'route', reward: 1, principal: 'p1', at: time.now, key: 'common',
    });
    expect(first.status).toBe('accepted');
    expect(otherPrincipal.status).toBe('accepted');
    expect(replay.status).toBe('duplicate');
  });

  it('serializes influence and idempotency across two FieldMemory instances sharing storage', async () => {
    const { storage, time, memory: first } = setup({ principalInfluenceCap: 2, trustDomainInfluenceCap: 20 });
    const second = createFieldMemory({
      config: first.config,
      storage,
      verifier,
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    const receipts = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      learn(index % 2 === 0 ? first : second, {
        configuration: 'route',
        reward: 1,
        principal: 'same-principal',
        at: time.now,
        key: `shared-${index}`,
      })));
    expect(receipts.filter((receipt) => receipt.acceptedWeight > 0)).toHaveLength(2);
    expect(receipts.filter((receipt) => receipt.status === 'principal-cap')).toHaveLength(8);
    const state = await first.exportState();
    expect(state.records[0].heads[0].buckets[0].updates).toBe(2);
  });

  it('charges influence and replay retention at acceptance time, not a backdated observation time', async () => {
    const { memory, time } = setup({
      driftWindowMs: 30 * DAY,
      influenceWindowMs: 60 * DAY,
      idempotencyWindowMs: 60 * DAY,
      principalInfluenceCap: 1,
      trustDomainInfluenceCap: 10,
    });
    const backdated = time.now - 29 * DAY;
    expect((await learn(memory, {
      configuration: 'route', reward: 1, principal: 'p1', at: backdated, key: 'receipt',
    })).status).toBe('accepted');
    time.now += 2 * DAY;
    const replay = await learn(memory, {
      configuration: 'route', reward: 1, principal: 'p1', at: time.now, key: 'receipt',
    });
    const newKey = await learn(memory, {
      configuration: 'route', reward: 1, principal: 'p1', at: time.now, key: 'new-receipt',
    });
    expect(replay.status).toBe('duplicate');
    expect(newKey.status).toBe('principal-cap');
  });

  it('requires a nontrivial identity HMAC key and rejects unsafe Euclidean magnitude', async () => {
    expect(() => createFieldMemory({
      config: { dimension: 2 },
      verifier,
      identityHashKey: 'short',
    })).toThrow(/at least 32 bytes/);
    const { memory, time } = setup({ similarity: 'euclidean', maxVectorMagnitude: 10 });
    await expect(learn(memory, {
      configuration: 'route', reward: 1, principal: 'p', at: time.now, vector: [1e308, 0],
    })).rejects.toThrow(/maxVectorMagnitude/);
  });

  it('stores the exact validated snapshot even when a caller mutates its object during verification', async () => {
    let release!: () => void;
    let verifierStarted!: () => void;
    const started = new Promise<void>((resolve) => { verifierStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const time = { now: 100 * DAY };
    const storage = new InMemoryFieldStorage({ dimension: 2 });
    const delayedVerifier: PrincipalVerifier<Proof> = async (proof) => {
      verifierStarted();
      await gate;
      return { principalId: proof.subject, trustDomain: proof.domain };
    };
    const memory = createFieldMemory({
      config: { dimension: 2, minimumSupport: 1 },
      storage,
      verifier: delayedVerifier,
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    const mutable = {
      centroidId: 'authorized-centroid',
      embedding: [1, 0],
      configurationId: 'authorized-route',
      reward: 0.8,
      cost: 0.2,
      observedAt: time.now,
      idempotencyKey: 'authorized-receipt',
      principalProof: { subject: 'p1', domain: 'tenant-a' },
    };
    const pending = memory.update(mutable);
    await started;
    mutable.centroidId = 'mutated-centroid';
    mutable.embedding[0] = 0;
    mutable.embedding[1] = 1;
    mutable.configurationId = 'mutated-route';
    mutable.reward = -1;
    mutable.cost = 999;
    mutable.idempotencyKey = 'mutated-receipt';
    release();
    expect((await pending).status).toBe('accepted');
    const state = await memory.exportState();
    expect(state.records[0].id).toBe('authorized-centroid');
    expect(state.records[0].heads[0].configurationId).toBe('authorized-route');
    expect(state.records[0].heads[0].buckets[0].rewardSum).toBe(0.8);
    expect(state.records[0].vector).toEqual([1, 0]);
    const replay = await memory.update({
      centroidId: 'authorized-centroid',
      embedding: [1, 0],
      configurationId: 'authorized-route',
      reward: 0.8,
      cost: 0.2,
      observedAt: time.now,
      idempotencyKey: 'authorized-receipt',
      principalProof: { subject: 'p1', domain: 'tenant-a' },
    });
    expect(replay.status).toBe('duplicate');
  });

  it('uses the trusted clock after slow verification when deciding whether an observation is stale', async () => {
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const time = { now: 100 * DAY };
    const memory = createFieldMemory({
      config: { dimension: 2, driftWindowMs: 30 * DAY, bucketSizeMs: DAY },
      verifier: async (proof: Proof) => {
        started();
        await gate;
        return { principalId: proof.subject, trustDomain: proof.domain };
      },
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    const pending = learn(memory, {
      configuration: 'route', reward: 1, principal: 'p1', at: time.now - 29 * DAY,
    });
    await began;
    time.now += 2 * DAY;
    release();
    expect((await pending).status).toBe('stale');
    expect((await memory.exportState()).records).toEqual([]);
  });

  it('does not let caller-controlled query time trigger destructive compaction', async () => {
    const { memory, time } = setup();
    await learn(memory, { configuration: 'route', reward: 1, principal: 'p1', at: time.now });
    const before = await memory.exportStateJson();
    await expect(memory.choose({ embedding: [1, 0], now: Number.MAX_SAFE_INTEGER }))
      .rejects.toThrow(/trusted clock window/);
    expect(await memory.exportStateJson()).toBe(before);
  });
});

class FakeRuVectorDb {
  readonly indexType = 'flat' as const;
  readonly rows = new Map<string, { vector: number[]; metadata?: Record<string, unknown> }>();
  deletes = 0;
  inserts = 0;
  failDeleteAfterRemoval = false;
  failInsert = false;

  constructor(
    readonly storagePath = '/tmp/field-memory-test.db',
    readonly dimensions = 2,
    readonly distanceMetric = 'cosine',
    readonly mutationMode: 'in-place' | 'rebuild' = 'in-place',
    readonly configurationVerified = true,
  ) {}

  getIndexInfo() {
    return {
      indexType: this.indexType,
      dimensions: this.dimensions,
      distanceMetric: this.distanceMetric,
      storagePath: this.storagePath,
      mutationMode: this.mutationMode,
      configurationVerified: this.configurationVerified,
    };
  }

  async insert(entry: { id?: string; vector: Float32Array | number[]; metadata?: Record<string, unknown> }) {
    this.inserts += 1;
    if (this.failInsert) {
      this.failInsert = false;
      throw new Error('injected insert failure');
    }
    const id = entry.id ?? `generated-${this.rows.size}`;
    this.rows.set(id, { vector: [...entry.vector], metadata: entry.metadata });
    return id;
  }

  async search(query: { vector: Float32Array | number[]; k: number }) {
    const norm = (values: number[]) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
    return [...this.rows.entries()].map(([id, row]) => {
      const dot = row.vector.reduce((sum, value, index) => sum + value * query.vector[index], 0);
      const similarity = dot / (norm(row.vector) * norm([...query.vector]));
      return { id, score: 1 - similarity, metadata: row.metadata };
    }).sort((a, b) => a.score - b.score).slice(0, query.k);
  }

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? { id, vector: Float32Array.from(row.vector), metadata: row.metadata } : null;
  }

  async delete(id: string) {
    this.deletes += 1;
    const result = this.rows.delete(id);
    if (this.failDeleteAfterRemoval) {
      this.failDeleteAfterRemoval = false;
      throw new Error('injected ambiguous delete failure');
    }
    return result;
  }

  async len() {
    return this.rows.size;
  }
}

describe('RuVector adapter', () => {
  it('wraps a flat VectorDb and keeps one packed physical centroid', async () => {
    const db = new FakeRuVectorDb();
    const registry = new InMemoryRuVectorRecordRegistry();
    const storage = createRuVectorFieldStorage({
      db,
      registry,
      storagePath: '/tmp/field-memory-test.db',
      dimension: 2,
      metric: 'cosine',
    });
    const time = { now: 100 * DAY };
    const memory = createFieldMemory({
      config: { dimension: 2, minimumSupport: 1, principalInfluenceCap: 10 },
      storage,
      verifier,
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    for (const [index, configuration] of ['a', 'b', 'c', 'd'].entries()) {
      await learn(memory, {
        configuration, reward: index / 3, principal: `p${index}`, at: time.now,
      });
    }
    expect(db.rows.size).toBe(1);
    expect((await registry.list())).toHaveLength(1);
    expect(db.inserts).toBe(4);
    expect(db.deletes).toBe(0);
    expect((await memory.choose({ embedding: [1, 0], now: time.now }))?.configurationId).toBe('d');
    expect([...db.rows.values()][0]?.metadata).not.toHaveProperty('metaharnessFieldMemory.record');
    await expect(memory.importState(await memory.exportStateJson())).rejects.toThrow(/atomicReplace/);
  });

  it('maps RuVector cosine distance to exact field similarity', async () => {
    const db = new FakeRuVectorDb('/tmp/field-memory-cosine.db');
    const storage = createRuVectorFieldStorage({
      db,
      registry: new InMemoryRuVectorRecordRegistry(),
      storagePath: '/tmp/field-memory-cosine.db',
      dimension: 2,
      metric: 'cosine',
    });
    const time = { now: 100 * DAY };
    const memory = createFieldMemory({
      config: { dimension: 2, minimumSupport: 1, similarity: 'cosine' },
      storage,
      verifier,
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    await learn(memory, {
      centroid: 'aligned', configuration: 'a', reward: 1, principal: 'p1', at: time.now, vector: [1, 0],
    });
    await learn(memory, {
      centroid: 'orthogonal', configuration: 'b', reward: 1, principal: 'p2', at: time.now, vector: [0, 1],
    });
    const hits = await storage.search([1, 0], 2);
    expect(hits.map((hit) => [hit.record.id, hit.similarity])).toEqual([
      ['aligned', 1],
      ['orthogonal', 0],
    ]);
  });

  it('requires an absolute storage identity and an explicit registry', () => {
    const db = new FakeRuVectorDb();
    expect(() => createRuVectorFieldStorage({
      db,
      registry: new InMemoryRuVectorRecordRegistry(),
      storagePath: 'relative.db',
      dimension: 2,
    })).toThrow(/absolute/);
    expect(() => createRuVectorFieldStorage({
      db: new FakeRuVectorDb('/tmp/field.db'),
      storagePath: '/tmp/field.db',
      dimension: 2,
    } as never)).toThrow(/registry/);
    expect(() => createRuVectorFieldStorage({
      db: {
        ...new FakeRuVectorDb('/tmp/hnsw.db'),
        indexType: 'hnsw',
        getIndexInfo: () => ({
          indexType: 'hnsw', dimensions: 2, distanceMetric: 'cosine',
          storagePath: '/tmp/hnsw.db', mutationMode: 'rebuild', configurationVerified: true,
        }),
      },
      registry: new InMemoryRuVectorRecordRegistry(),
      storagePath: '/tmp/hnsw.db',
      dimension: 2,
    } as never)).toThrow(/flat, in-place/);
    expect(() => createRuVectorFieldStorage({
      db: new FakeRuVectorDb('/tmp/legacy.db', 2, 'cosine', 'in-place', false),
      registry: new InMemoryRuVectorRecordRegistry(),
      storagePath: '/tmp/legacy.db',
      dimension: 2,
    })).toThrow(/configuration-verified/);
    expect(() => createRuVectorFieldStorage({
      db: new FakeRuVectorDb('/tmp/other.db'),
      registry: new InMemoryRuVectorRecordRegistry(),
      storagePath: '/tmp/field.db',
      dimension: 2,
    })).toThrow(/storagePath/);
    expect(() => createRuVectorFieldStorage({
      db: new FakeRuVectorDb('/tmp/field.db', 3),
      registry: new InMemoryRuVectorRecordRegistry(),
      storagePath: '/tmp/field.db',
      dimension: 2,
    })).toThrow(/dimension/);
    expect(() => createRuVectorFieldStorage({
      db: new FakeRuVectorDb('/tmp/field.db', 2, 'euclidean'),
      registry: new InMemoryRuVectorRecordRegistry(),
      storagePath: '/tmp/field.db',
      dimension: 2,
    })).toThrow(/metric/);
    expect(() => createRuVectorFieldStorage({
      db: new FakeRuVectorDb('/tmp/field.db'),
      registry: new InMemoryRuVectorRecordRegistry(),
      storagePath: '/tmp/field.db',
      dimension: 2,
      metric: 'euclidean',
    } as never)).toThrow(/only the cosine/);
    expect(() => createRuVectorFieldStorage({
      db: new FakeRuVectorDb('/tmp/field.db'),
      registry: new InMemoryRuVectorRecordRegistry(),
      storagePath: '/tmp/field.db',
      dimension: 2,
      scoreKind: 'similarity',
    } as never)).toThrow(/score semantics/);
  });

  it('rolls back a failed physical revision insert without losing the current centroid', async () => {
    const db = new FakeRuVectorDb('/tmp/field-memory-fault.db');
    const registry = new InMemoryRuVectorRecordRegistry();
    const storage = createRuVectorFieldStorage({
      db,
      registry,
      storagePath: '/tmp/field-memory-fault.db',
      dimension: 2,
    });
    const time = { now: 100 * DAY };
    const memory = createFieldMemory({
      config: { dimension: 2, minimumSupport: 1, principalInfluenceCap: 10 },
      storage,
      verifier,
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    await learn(memory, { configuration: 'stable', reward: 1, principal: 'p1', at: time.now, key: 'first' });
    db.failInsert = true;
    await expect(learn(memory, {
      configuration: 'new', reward: 1, principal: 'p2', at: time.now, key: 'second',
    })).rejects.toThrow(/injected insert/);
    expect(db.rows.size).toBe(1);
    expect((await registry.list())[0].heads.map((head) => head.configurationId)).toEqual(['stable']);
    expect((await memory.choose({ embedding: [1, 0], now: time.now }))?.configurationId).toBe('stable');
  });

  it('does not pair a native vector with aggregates from a different registry revision', async () => {
    const db = new FakeRuVectorDb('/tmp/field-memory-split.db');
    const registry = new InMemoryRuVectorRecordRegistry();
    const storage = createRuVectorFieldStorage({
      db,
      registry,
      storagePath: '/tmp/field-memory-split.db',
      dimension: 2,
    });
    const time = { now: 100 * DAY };
    const memory = createFieldMemory({
      config: { dimension: 2, minimumSupport: 1 },
      storage,
      verifier,
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    await learn(memory, { configuration: 'stable', reward: 1, principal: 'p1', at: time.now });
    const row = db.rows.get('basin-a');
    expect(row).toBeDefined();
    const fieldMetadata = row?.metadata?.metaharnessFieldMemory as { revision: number };
    fieldMetadata.revision += 1;
    expect(await memory.choose({ embedding: [1, 0], now: time.now })).toBeNull();
  });

  it('restores the searchable row after an ambiguous native delete failure', async () => {
    const db = new FakeRuVectorDb('/tmp/field-memory-delete-fault.db');
    const registry = new InMemoryRuVectorRecordRegistry();
    const storage = createRuVectorFieldStorage({
      db,
      registry,
      storagePath: '/tmp/field-memory-delete-fault.db',
      dimension: 2,
    });
    const time = { now: 100 * DAY };
    const memory = createFieldMemory({
      config: { dimension: 2, minimumSupport: 1, principalInfluenceCap: 10 },
      storage,
      verifier,
      identityHashKey: IDENTITY_KEY,
      clock: () => time.now,
    });
    await learn(memory, { configuration: 'stable', reward: 1, principal: 'p1', at: time.now });
    db.failDeleteAfterRemoval = true;
    await expect(memory.compact({ now: time.now + 31 * DAY })).rejects.toThrow(/ambiguous delete/);
    expect(db.rows.size).toBe(1);
    expect((await registry.list())[0]?.heads[0]?.configurationId).toBe('stable');
  });

});
