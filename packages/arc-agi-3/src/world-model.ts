import {
  ArcValidationError,
  containsRawGameIdentityKey,
  hashArcValue,
  snapshotArcJson,
  validateArcAction,
} from './canonical.js';
import type {
  ArcAvoConfig,
  ArcRetrodiction,
  ArcRetrodictionVerdict,
  ArcWorldModelSnapshot,
} from './avo-types.js';
import type { ArcAction } from './types.js';

export const ARC_RETRODICTION_GENESIS = '0'.repeat(64);
const HEX_HASH = /^[0-9a-f]{64}$/;
const CANDIDATE_ID = /^arc_plan_[0-9a-f]{40}$/;
const WORLD_MODEL_KEYS = new Set([
  'schema',
  'modelVersion',
  'records',
  'headHash',
  'snapshotHash',
]);
const RETRODICTION_KEYS = new Set([
  'selectionHash',
  'candidateId',
  'coreReceiptHash',
  'action',
  'predictionError',
  'verdict',
  'supportedRuleIds',
  'contradictedRuleIds',
  'previousRetrodictionHash',
  'retrodictionHash',
]);

function assertExactWorldModelRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ArcValidationError('INVALID_AVO_CHECKPOINT', `${label} must be an object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.size || ownKeys.some(key =>
    typeof key !== 'string' || !keys.has(key) ||
    !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
    !('value' in Object.getOwnPropertyDescriptor(value, key)!))) {
    throw new ArcValidationError(
      'INVALID_AVO_CHECKPOINT',
      `${label} fields do not match the exact schema`,
    );
  }
}

export interface AppendRetrodictionInput {
  readonly selectionHash: string;
  readonly candidateId: string;
  readonly coreReceiptHash: string;
  readonly action: ArcAction;
  readonly predictionError: number;
  readonly supportedRuleIds: readonly string[];
  readonly contradictedRuleIds: readonly string[];
}

function uniqueBoundedIds(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > 80 || values.some(value =>
    typeof value !== 'string' || !value.trim() || value.length > 256) ||
    new Set(values).size !== values.length) {
    throw new ArcValidationError('INVALID_RETRODICTION', `${label} contains invalid rule ids`);
  }
  return Object.freeze([...values]);
}

export class EvidenceRetrodictiveWorldModel {
  readonly version = 'evidence-retrodiction-v1' as const;
  private readonly records: ArcRetrodiction[] = [];
  private readonly byReceipt = new Map<string, ArcRetrodiction>();
  private headHash = ARC_RETRODICTION_GENESIS;

  constructor(private readonly config: ArcAvoConfig) {}

  classify(predictionError: number): ArcRetrodictionVerdict {
    if (!Number.isFinite(predictionError) || predictionError < 0 || predictionError > 1) {
      throw new ArcValidationError(
        'INVALID_RETRODICTION',
        'predictionError must be finite and in 0..1',
      );
    }
    if (predictionError <= this.config.supportErrorMax) return 'SUPPORTED';
    if (predictionError >= this.config.contradictionErrorMin) return 'CONTRADICTED';
    return 'INCONCLUSIVE';
  }

  append(input: AppendRetrodictionInput): ArcRetrodiction {
    const replay = this.byReceipt.get(input.coreReceiptHash);
    if (replay) return replay;
    if (!HEX_HASH.test(input.selectionHash) || !HEX_HASH.test(input.coreReceiptHash) ||
        !CANDIDATE_ID.test(input.candidateId)) {
      throw new ArcValidationError('INVALID_RETRODICTION', 'retrodiction identity is invalid');
    }
    validateArcAction(input.action);
    const verdict = this.classify(input.predictionError);
    const supportedRuleIds = uniqueBoundedIds(input.supportedRuleIds, 'supportedRuleIds');
    const contradictedRuleIds = uniqueBoundedIds(
      input.contradictedRuleIds,
      'contradictedRuleIds',
    );
    if (supportedRuleIds.some(id => contradictedRuleIds.includes(id)) ||
        (verdict !== 'SUPPORTED' && supportedRuleIds.length > 0) ||
        (verdict !== 'CONTRADICTED' && contradictedRuleIds.length > 0)) {
      throw new ArcValidationError(
        'INVALID_RETRODICTION',
        'retrodiction rule evidence conflicts with its verdict',
      );
    }
    const body = Object.freeze({
      selectionHash: input.selectionHash,
      candidateId: input.candidateId,
      coreReceiptHash: input.coreReceiptHash,
      action: Object.freeze({ ...input.action }),
      predictionError: input.predictionError,
      verdict,
      supportedRuleIds,
      contradictedRuleIds,
      previousRetrodictionHash: this.headHash,
    });
    if (containsRawGameIdentityKey(body)) {
      throw new ArcValidationError('GAME_IDENTITY_LEAK', 'retrodiction contains raw game identity');
    }
    const record = Object.freeze({ ...body, retrodictionHash: hashArcValue(body) });
    this.records.push(record);
    this.byReceipt.set(record.coreReceiptHash, record);
    this.headHash = record.retrodictionHash;
    return record;
  }

  recent(limit = 32): readonly ArcRetrodiction[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new ArcValidationError('INVALID_RETRODICTION', 'retrodiction limit is invalid');
    }
    return Object.freeze(this.records.slice(-limit));
  }

  all(): readonly ArcRetrodiction[] {
    return Object.freeze([...this.records]);
  }

  snapshot(): ArcWorldModelSnapshot {
    const body = Object.freeze({
      schema: 'metaharness.arc_agi_3.world_model.v1' as const,
      modelVersion: this.version,
      records: Object.freeze([...this.records]),
      headHash: this.headHash,
    });
    return Object.freeze({ ...body, snapshotHash: hashArcValue(body) });
  }

  load(snapshot: ArcWorldModelSnapshot): void {
    let stable: ArcWorldModelSnapshot;
    try {
      stable = snapshotArcJson(snapshot) as unknown as ArcWorldModelSnapshot;
    } catch {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'world model is not strict JSON');
    }
    if (containsRawGameIdentityKey(stable)) {
      throw new ArcValidationError(
        'INVALID_AVO_CHECKPOINT',
        'world model contains raw game identity',
      );
    }
    assertExactWorldModelRecord(stable, WORLD_MODEL_KEYS, 'world model snapshot');
    if (stable.schema !== 'metaharness.arc_agi_3.world_model.v1' ||
        stable.modelVersion !== this.version || !Array.isArray(stable.records) ||
        stable.records.length > 10_000) {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'world model schema is invalid');
    }
    const { snapshotHash, ...snapshotBody } = stable;
    if (!HEX_HASH.test(snapshotHash) || hashArcValue(snapshotBody) !== snapshotHash) {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'world model snapshot hash is invalid');
    }
    const records: ArcRetrodiction[] = [];
    const receipts = new Set<string>();
    let head = ARC_RETRODICTION_GENESIS;
    for (const rawRecord of stable.records) {
      assertExactWorldModelRecord(rawRecord, RETRODICTION_KEYS, 'retrodiction record');
      if (containsRawGameIdentityKey(rawRecord)) {
        throw new ArcValidationError(
          'INVALID_AVO_CHECKPOINT',
          'retrodiction contains raw game identity',
        );
      }
      const record = rawRecord as unknown as ArcRetrodiction;
      const { retrodictionHash, ...body } = record;
      if (!HEX_HASH.test(record.selectionHash) || !HEX_HASH.test(record.coreReceiptHash) ||
          receipts.has(record.coreReceiptHash) || !CANDIDATE_ID.test(record.candidateId) ||
          record.previousRetrodictionHash !== head || !HEX_HASH.test(retrodictionHash) ||
          hashArcValue(body) !== retrodictionHash ||
          record.verdict !== this.classify(record.predictionError)) {
        throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'retrodiction chain is invalid');
      }
      validateArcAction(record.action);
      const supported = uniqueBoundedIds(record.supportedRuleIds, 'supportedRuleIds');
      const contradicted = uniqueBoundedIds(record.contradictedRuleIds, 'contradictedRuleIds');
      if (supported.some(id => contradicted.includes(id)) ||
          (record.verdict !== 'SUPPORTED' && supported.length > 0) ||
          (record.verdict !== 'CONTRADICTED' && contradicted.length > 0)) {
        throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'retrodiction evidence is invalid');
      }
      head = retrodictionHash;
      receipts.add(record.coreReceiptHash);
      records.push(record);
    }
    if (stable.headHash !== head) {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'world model head is invalid');
    }
    this.records.splice(0, this.records.length, ...records);
    this.byReceipt.clear();
    for (const record of records) this.byReceipt.set(record.coreReceiptHash, record);
    this.headHash = head;
  }
}
