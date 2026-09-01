import { hashArcValue } from './canonical.js';
import type {
  ArcEpisode,
  MemoryQuery,
  MemoryQueryResult,
  SemanticMemorySnapshot,
  SemanticRule,
  SemanticRuleCommit,
} from './types.js';

export interface SemanticMemoryOptions {
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
  readonly receiptExists: (receiptHash: string) => boolean;
}

export const MAX_SEMANTIC_RULE_VERSIONS = 10_000;
export const MAX_EPISODIC_MEMORIES = 10_000;

const HEX_HASH = /^[0-9a-f]{64}$/;
const RULE_ID = /^rule_[0-9a-f]{32}$/;
const RULE_SCOPES = new Set(['LEVEL', 'GAME', 'GENERIC']);
const RULE_KINDS = new Set([
  'ACTION_MAP',
  'OBJECT_ROLE',
  'TRANSITION',
  'GOAL',
  'CONSTRAINT',
  'STRATEGY',
]);
const RULE_STATUSES = new Set(['CANDIDATE', 'ACTIVE', 'FALSIFIED', 'SUPERSEDED']);
const RULE_REQUIRED_KEYS = new Set([
  'id',
  'principalScope',
  'opaqueGameScope',
  'version',
  'scope',
  'kind',
  'statement',
  'preconditions',
  'predictedEffect',
  'supportingReceiptHashes',
  'contradictingReceiptHashes',
  'alpha',
  'beta',
  'status',
  'commitHash',
  'ruleHash',
]);
const RULE_OPTIONAL_KEYS = new Set(['previousVersionHash']);

export interface MemoryCommitmentScope {
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
}

export interface MemorySnapshotHeads {
  readonly episodicHeadHash: string;
  readonly semanticHeadHash: string;
}

export function initialMemorySnapshotHeads(scope: MemoryCommitmentScope): MemorySnapshotHeads {
  return Object.freeze({
    episodicHeadHash: hashArcValue({
      schema: 'metaharness.arc_agi_3.episodic_memory.v1',
      genesis: true,
      ...scope,
    }),
    semanticHeadHash: hashArcValue({
      schema: 'metaharness.arc_agi_3.semantic_memory.v1',
      genesis: true,
      ...scope,
    }),
  });
}

export function appendEpisodeMemoryHead(previous: string, episode: ArcEpisode): string {
  return hashArcValue({ previous, episode });
}

export function appendSemanticMemoryHead(previous: string, semanticRule: SemanticRule): string {
  return hashArcValue({ previous, semanticRule });
}

export function combineMemorySnapshotHeads(
  scope: MemoryCommitmentScope,
  heads: MemorySnapshotHeads,
): string {
  return hashArcValue({
    schema: 'metaharness.arc_agi_3.memory_snapshot.v1',
    ...scope,
    ...heads,
  });
}

export function memorySnapshotHeadsFor(
  scope: MemoryCommitmentScope,
  episodes: readonly ArcEpisode[],
  snapshot: SemanticMemorySnapshot,
): MemorySnapshotHeads {
  let heads = initialMemorySnapshotHeads(scope);
  for (const episode of episodes) {
    heads = Object.freeze({
      ...heads,
      episodicHeadHash: appendEpisodeMemoryHead(heads.episodicHeadHash, episode),
    });
  }
  for (const rule of snapshot.rules) {
    heads = Object.freeze({
      ...heads,
      semanticHeadHash: appendSemanticMemoryHead(heads.semanticHeadHash, rule),
    });
  }
  return heads;
}

export function memorySnapshotHashFor(
  scope: MemoryCommitmentScope,
  episodes: readonly ArcEpisode[],
  snapshot: SemanticMemorySnapshot,
): string {
  return combineMemorySnapshotHeads(scope, memorySnapshotHeadsFor(scope, episodes, snapshot));
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function assertStoredStringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
  hashesOnly = false,
): asserts value is string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' ||
        (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) ||
      Object.keys(value).length !== value.length || value.length > maximumItems ||
      value.some(item => typeof item !== 'string' || !item.trim() ||
        item !== item.trim() || item.length > maximumLength ||
        (hashesOnly && !HEX_HASH.test(item))) ||
      new Set(value).size !== value.length) {
    throw new Error(`${label} must contain unique bounded strings`);
  }
}

function validateStoredRule(
  raw: unknown,
  options: SemanticMemoryOptions,
): SemanticRule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new Error('semantic memory snapshot rule must be an object');
  }
  const record = raw as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.some(key => typeof key !== 'string' ||
      (!RULE_REQUIRED_KEYS.has(key) && !RULE_OPTIONAL_KEYS.has(key)) ||
      !Object.getOwnPropertyDescriptor(record, key)?.enumerable ||
      !('value' in Object.getOwnPropertyDescriptor(record, key)!)) ||
      [...RULE_REQUIRED_KEYS].some(key => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new Error('semantic memory snapshot rule fields are invalid');
  }
  if (typeof record.id !== 'string' || !RULE_ID.test(record.id) ||
      record.principalScope !== options.principalScope ||
      record.opaqueGameScope !== options.opaqueGameScope) {
    throw new Error('semantic memory snapshot has an invalid rule ID or foreign scope');
  }
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1 ||
      (record.version as number) > MAX_SEMANTIC_RULE_VERSIONS ||
      typeof record.scope !== 'string' || !RULE_SCOPES.has(record.scope) ||
      typeof record.kind !== 'string' || !RULE_KINDS.has(record.kind) ||
      typeof record.status !== 'string' || !RULE_STATUSES.has(record.status)) {
    throw new Error(`semantic rule ${record.id} has an invalid version, scope, kind, or status`);
  }
  if (typeof record.statement !== 'string' || !record.statement ||
      record.statement !== record.statement.trim() || record.statement.length > 4_096 ||
      typeof record.predictedEffect !== 'string' || !record.predictedEffect ||
      record.predictedEffect !== record.predictedEffect.trim() ||
      record.predictedEffect.length > 4_096) {
    throw new Error(`semantic rule ${record.id} has invalid bounded text`);
  }
  assertStoredStringArray(record.preconditions, 'semantic rule preconditions', 128, 1_024);
  assertStoredStringArray(
    record.supportingReceiptHashes,
    'semantic rule supporting evidence',
    256,
    64,
    true,
  );
  assertStoredStringArray(
    record.contradictingReceiptHashes,
    'semantic rule contradicting evidence',
    256,
    64,
    true,
  );
  if (record.supportingReceiptHashes.length + record.contradictingReceiptHashes.length === 0) {
    throw new Error(`semantic rule ${record.id} has no receipt evidence`);
  }
  if (record.alpha !== 1 + record.supportingReceiptHashes.length ||
      record.beta !== 1 + record.contradictingReceiptHashes.length ||
      typeof record.commitHash !== 'string' || !HEX_HASH.test(record.commitHash) ||
      typeof record.ruleHash !== 'string' || !HEX_HASH.test(record.ruleHash) ||
      (record.previousVersionHash !== undefined && (
        typeof record.previousVersionHash !== 'string' || !HEX_HASH.test(record.previousVersionHash)
      ))) {
    throw new Error(`semantic rule ${record.id} has invalid evidence counts or hashes`);
  }
  return record as unknown as SemanticRule;
}

export class EvidenceBackedMemory {
  private readonly episodes: ArcEpisode[] = [];
  private readonly episodeIds = new Set<string>();
  private readonly versions = new Map<string, SemanticRule[]>();
  private readonly orderedRules: SemanticRule[] = [];
  private readonly commitResults = new Map<string, SemanticRule>();

  constructor(private readonly options: SemanticMemoryOptions) {}

  appendEpisode(episode: ArcEpisode): void {
    if (this.episodes.length >= MAX_EPISODIC_MEMORIES) {
      throw new Error('episodic memory capacity reached');
    }
    if (episode.principalScope !== this.options.principalScope ||
        episode.opaqueGameScope !== this.options.opaqueGameScope ||
        episode.runId !== this.options.runId) {
      throw new Error('episode scope does not match this memory');
    }
    if (!this.options.receiptExists(episode.receiptHash)) {
      throw new Error(`episode cites unknown receipt ${episode.receiptHash}`);
    }
    if (this.episodeIds.has(episode.id)) {
      throw new Error(`episode ${episode.id} already exists`);
    }
    this.episodes.push(Object.freeze({ ...episode }));
    this.episodeIds.add(episode.id);
  }

  commit(input: SemanticRuleCommit): SemanticRule {
    if (!input || typeof input !== 'object') throw new Error('semantic rule commit is required');
    if (!RULE_SCOPES.has(input.scope) || !RULE_KINDS.has(input.kind) ||
        (input.status !== undefined && !RULE_STATUSES.has(input.status))) {
      throw new Error('semantic rule scope, kind, or status is invalid');
    }
    if (typeof input.statement !== 'string' || typeof input.predictedEffect !== 'string') {
      throw new Error('semantic rule text fields must be strings');
    }
    const statement = input.statement.trim();
    const predictedEffect = input.predictedEffect.trim();
    if (!statement || !predictedEffect) {
      throw new Error('semantic rule statement and predictedEffect must be non-empty');
    }
    if (statement.length > 4_096 || predictedEffect.length > 4_096) {
      throw new Error('semantic rule text exceeds 4096 characters');
    }
    if ((input.supportingReceiptHashes !== undefined && !Array.isArray(input.supportingReceiptHashes)) ||
        (input.contradictingReceiptHashes !== undefined && !Array.isArray(input.contradictingReceiptHashes)) ||
        (input.supportingReceiptHashes?.length ?? 0) > 256 ||
        (input.contradictingReceiptHashes?.length ?? 0) > 256 ||
        [...(input.supportingReceiptHashes ?? []), ...(input.contradictingReceiptHashes ?? [])]
          .some(value => typeof value !== 'string' || !value.trim() || value.length > 256)) {
      throw new Error('semantic rule evidence arrays may contain at most 256 entries each');
    }
    if (input.id !== undefined &&
        (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 256)) {
      throw new Error('semantic rule id must be non-empty and at most 256 characters');
    }
    const commitHash = hashArcValue(input);
    const replay = this.commitResults.get(commitHash);
    if (replay) return replay;
    if (this.ruleCount >= MAX_SEMANTIC_RULE_VERSIONS) {
      throw new Error('semantic memory rule-version capacity reached');
    }
    const logicalId = input.id?.trim() || hashArcValue({
      scope: input.scope,
      kind: input.kind,
      statement,
    });
    const existingId = this.versions.has(logicalId) ? logicalId : undefined;
    const id = existingId ?? `rule_${hashArcValue({
      principalScope: this.options.principalScope,
      opaqueGameScope: this.options.opaqueGameScope,
      logicalId,
    }).slice(0, 32)}`;
    const history = this.versions.get(id) ?? [];
    const previous = history[history.length - 1];
    const supportingReceiptHashes = unique([
      ...(previous?.supportingReceiptHashes ?? []),
      ...(input.supportingReceiptHashes ?? []),
    ]);
    const contradictingReceiptHashes = unique([
      ...(previous?.contradictingReceiptHashes ?? []),
      ...(input.contradictingReceiptHashes ?? []),
    ]);
    if (supportingReceiptHashes.length > 256 || contradictingReceiptHashes.length > 256) {
      throw new Error('versioned semantic rule evidence exceeds bounded limits');
    }
    const evidence = unique([...supportingReceiptHashes, ...contradictingReceiptHashes]);
    if (evidence.length === 0) {
      throw new Error('semantic rule must cite at least one transition receipt');
    }
    for (const receiptHash of evidence) {
      if (!this.options.receiptExists(receiptHash)) {
        throw new Error(`semantic rule cites unknown receipt ${receiptHash}`);
      }
    }
    if (input.preconditions !== undefined && (!Array.isArray(input.preconditions) ||
        input.preconditions.some(value => typeof value !== 'string'))) {
      throw new Error('semantic rule preconditions must be strings');
    }
    const preconditions = unique([
      ...(previous?.preconditions ?? []),
      ...(input.preconditions ?? []),
    ].map(value => value.trim()).filter(Boolean));
    if (preconditions.length > 128 || preconditions.some(value => value.length > 1_024)) {
      throw new Error('semantic rule preconditions exceed bounded limits');
    }
    const version = (previous?.version ?? 0) + 1;
    const body = {
      id,
      principalScope: this.options.principalScope,
      opaqueGameScope: this.options.opaqueGameScope,
      version,
      scope: input.scope,
      kind: input.kind,
      statement,
      preconditions,
      predictedEffect,
      supportingReceiptHashes,
      contradictingReceiptHashes,
      alpha: 1 + supportingReceiptHashes.length,
      beta: 1 + contradictingReceiptHashes.length,
      status: input.status ?? previous?.status ?? 'CANDIDATE',
      previousVersionHash: previous?.ruleHash,
      commitHash,
    } as const;
    const rule: SemanticRule = Object.freeze({ ...body, ruleHash: hashArcValue(body) });
    history.push(rule);
    this.versions.set(id, history);
    this.orderedRules.push(rule);
    this.commitResults.set(commitHash, rule);
    return rule;
  }

  query(query: MemoryQuery = {}): MemoryQueryResult {
    if (!query || typeof query !== 'object') throw new Error('memory query must be an object');
    if (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 4_096)) {
      throw new Error('memory query text must be a string of at most 4096 characters');
    }
    const text = query.text?.trim().toLowerCase();
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('memory query limit must be an integer in 1..1000');
    }
    const episodes = this.episodes.filter(episode =>
      query.receiptHash === undefined || episode.receiptHash === query.receiptHash,
    );
    const rules = this.orderedRules.filter(rule => {
      if (query.scope !== undefined && rule.scope !== query.scope) return false;
      if (query.kind !== undefined && rule.kind !== query.kind) return false;
      if (query.status !== undefined && rule.status !== query.status) return false;
      if (query.receiptHash !== undefined &&
          !rule.supportingReceiptHashes.includes(query.receiptHash) &&
          !rule.contradictingReceiptHashes.includes(query.receiptHash)) return false;
      if (text !== undefined &&
          !`${rule.statement}\n${rule.predictedEffect}\n${rule.preconditions.join('\n')}`
            .toLowerCase().includes(text)) return false;
      return true;
    });
    return Object.freeze({
      episodes: Object.freeze(episodes.slice(-limit)),
      rules: Object.freeze(rules.slice(-limit)),
    });
  }

  snapshot(): SemanticMemorySnapshot {
    return Object.freeze({
      rules: Object.freeze([...this.orderedRules]),
    });
  }

  load(snapshot: SemanticMemorySnapshot): void {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
        Object.getPrototypeOf(snapshot) !== Object.prototype ||
        Reflect.ownKeys(snapshot).length !== 1 ||
        Reflect.ownKeys(snapshot)[0] !== 'rules' || !Array.isArray(snapshot.rules) ||
        Object.getPrototypeOf(snapshot.rules) !== Array.prototype ||
        Object.keys(snapshot.rules).length !== snapshot.rules.length ||
        snapshot.rules.length > MAX_SEMANTIC_RULE_VERSIONS) {
      throw new Error('semantic memory snapshot exceeds bounded rule capacity');
    }
    this.versions.clear();
    this.orderedRules.splice(0, this.orderedRules.length);
    this.commitResults.clear();
    for (const rawRule of snapshot.rules) {
      const rule = validateStoredRule(rawRule, this.options);
      if (rule.principalScope !== this.options.principalScope ||
          rule.opaqueGameScope !== this.options.opaqueGameScope) {
        throw new Error('semantic memory snapshot has a foreign scope');
      }
      const { ruleHash, ...body } = rule;
      if (hashArcValue(body) !== ruleHash) {
        throw new Error(`semantic rule ${rule.id} failed hash verification`);
      }
      const evidence = [...rule.supportingReceiptHashes, ...rule.contradictingReceiptHashes];
      for (const receiptHash of evidence) {
        if (!this.options.receiptExists(receiptHash)) {
          throw new Error(`semantic rule ${rule.id} cites unknown receipt ${receiptHash}`);
        }
      }
      const history = this.versions.get(rule.id) ?? [];
      const expectedVersion = history.length + 1;
      if (rule.version !== expectedVersion ||
          (expectedVersion === 1 && rule.previousVersionHash !== undefined) ||
          (expectedVersion > 1 && rule.previousVersionHash !== history.at(-1)!.ruleHash)) {
        throw new Error(`semantic rule ${rule.id} has a broken version chain`);
      }
      const stableRule: SemanticRule = Object.freeze({
        ...rule,
        preconditions: Object.freeze([...rule.preconditions]),
        supportingReceiptHashes: Object.freeze([...rule.supportingReceiptHashes]),
        contradictingReceiptHashes: Object.freeze([...rule.contradictingReceiptHashes]),
      });
      history.push(stableRule);
      this.versions.set(rule.id, history);
      const priorCommit = this.commitResults.get(rule.commitHash);
      if (priorCommit && priorCommit.ruleHash !== rule.ruleHash) {
        throw new Error(`semantic rule ${rule.id} reuses a commit hash`);
      }
      this.orderedRules.push(stableRule);
      this.commitResults.set(rule.commitHash, stableRule);
    }
  }

  loadEpisodes(episodes: readonly ArcEpisode[]): void {
    if (!Array.isArray(episodes) || Object.getPrototypeOf(episodes) !== Array.prototype ||
        Object.keys(episodes).length !== episodes.length ||
        episodes.length > MAX_EPISODIC_MEMORIES) {
      throw new Error('episodic memory snapshot exceeds bounded capacity');
    }
    this.episodes.splice(0, this.episodes.length);
    this.episodeIds.clear();
    for (const episode of episodes) this.appendEpisode(episode);
  }

  allEpisodes(): readonly ArcEpisode[] {
    return Object.freeze([...this.episodes]);
  }

  ruleForCommitHash(commitHash: string): SemanticRule | undefined {
    return this.commitResults.get(commitHash);
  }

  get ruleCount(): number {
    return this.orderedRules.length;
  }

  get episodeCount(): number {
    return this.episodes.length;
  }
}
