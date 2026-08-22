import { MAX_ARC_RUN_ACTIONS, hashArcValue, validateArcAction } from './canonical.js';
import type {
  ArcAction,
  ArcActionName,
  BeliefEdge,
  BeliefGraphSnapshot,
  BeliefNode,
  ExactArcObservation,
  FrontierEdge,
} from './types.js';

export interface BeliefGraphOptions {
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
}

const HEX_HASH = /^[0-9a-f]{64}$/;
const BELIEF_KEY = /^belief_[0-9a-f]{64}$/;
const BELIEF_EDGE_KEY = /^belief_edge_[0-9a-f]{64}$/;
const STATES = new Set(['NOT_PLAYED', 'NOT_FINISHED', 'WIN', 'GAME_OVER']);
const ACTIONS = new Set([
  'RESET', 'ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6', 'ACTION7',
]);
const NODE_KEYS = new Set([
  'key',
  'principalScope',
  'opaqueGameScope',
  'runId',
  'observationHash',
  'frameHash',
  'latentContextHash',
  'state',
  'levelsCompleted',
  'availableActions',
  'visits',
]);
const EDGE_KEYS = new Set([
  'key',
  'fromBeliefKey',
  'observationHash',
  'action',
  'outcomes',
  'testedCount',
  'noEffectCount',
]);
const OUTCOME_KEYS = new Set(['toBeliefKey', 'receiptHashes', 'count']);

function assertExactRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.size || ownKeys.some(key =>
    typeof key !== 'string' || !keys.has(key) ||
    !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
    !('value' in Object.getOwnPropertyDescriptor(value, key)!))) {
    throw new Error(`${label} fields are invalid`);
  }
}

function assertDenseArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' ||
        (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) ||
      Object.keys(value).length !== value.length) {
    throw new Error(`${label} must be a dense plain array`);
  }
}

/** Validate a graph snapshot before it can influence frontier or hidden-state derivation. */
export function validateBeliefGraphSnapshot(
  snapshot: unknown,
  options: BeliefGraphOptions,
  maximumNodes = MAX_ARC_RUN_ACTIONS + 1,
  maximumEdges = MAX_ARC_RUN_ACTIONS,
): asserts snapshot is BeliefGraphSnapshot {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('belief graph snapshot must be an object');
  }
  const graph = snapshot as Record<string, unknown>;
  const graphKeys = Reflect.ownKeys(graph);
  if (graphKeys.some(key => typeof key !== 'string' ||
      (key !== 'nodes' && key !== 'edges' && key !== 'currentBeliefKey')) ||
      !Object.prototype.hasOwnProperty.call(graph, 'nodes') ||
      !Object.prototype.hasOwnProperty.call(graph, 'edges')) {
    throw new Error('belief graph snapshot shape or capacity is invalid');
  }
  assertDenseArray(graph.nodes, 'belief graph nodes');
  assertDenseArray(graph.edges, 'belief graph edges');
  if (graph.nodes.length > maximumNodes || graph.edges.length > maximumEdges) {
    throw new Error('belief graph snapshot exceeds bounded capacity');
  }

  const nodes = new Map<string, BeliefNode>();
  for (const rawNode of graph.nodes) {
    assertExactRecord(rawNode, NODE_KEYS, 'belief graph node');
    const node = rawNode as unknown as BeliefNode;
    if (typeof node.key !== 'string' || !BELIEF_KEY.test(node.key) || nodes.has(node.key) ||
        node.principalScope !== options.principalScope ||
        node.opaqueGameScope !== options.opaqueGameScope || node.runId !== options.runId ||
        typeof node.observationHash !== 'string' || !HEX_HASH.test(node.observationHash) ||
        typeof node.frameHash !== 'string' || !HEX_HASH.test(node.frameHash) ||
        typeof node.latentContextHash !== 'string' || !HEX_HASH.test(node.latentContextHash) ||
        !STATES.has(node.state) || !Number.isSafeInteger(node.levelsCompleted) ||
        node.levelsCompleted < 0 || !Number.isSafeInteger(node.visits) || node.visits < 1 ||
        node.visits > maximumEdges + 1) {
      throw new Error('belief graph snapshot contains an invalid or duplicate node');
    }
    assertDenseArray(node.availableActions, 'belief node availableActions');
    if (node.availableActions.length > ACTIONS.size || node.availableActions.some(action =>
          typeof action !== 'string' || !ACTIONS.has(action)) ||
        new Set(node.availableActions).size !== node.availableActions.length) {
      throw new Error('belief graph snapshot contains an invalid or duplicate node');
    }
    const expectedKey = hiddenStateSafeBeliefKey({
      principalScope: node.principalScope,
      opaqueGameScope: node.opaqueGameScope,
      runId: node.runId,
      observationHash: node.observationHash,
      latentContextHash: node.latentContextHash,
    });
    if (node.key !== expectedKey) {
      throw new Error('belief graph node key does not match its canonical body');
    }
    nodes.set(node.key, node);
  }

  const edgeKeys = new Set<string>();
  const receiptHashes = new Set<string>();
  for (const rawEdge of graph.edges) {
    assertExactRecord(rawEdge, EDGE_KEYS, 'belief graph edge');
    const edge = rawEdge as unknown as BeliefEdge;
    const from = nodes.get(edge.fromBeliefKey);
    if (typeof edge.key !== 'string' || !BELIEF_EDGE_KEY.test(edge.key) ||
        edgeKeys.has(edge.key) || !from || edge.observationHash !== from.observationHash) {
      throw new Error('belief graph snapshot contains an invalid or duplicate edge');
    }
    validateArcAction(edge.action);
    const expectedKey = `belief_edge_${hashArcValue({ from: edge.fromBeliefKey, action: edge.action })}`;
    assertDenseArray(edge.outcomes, 'belief graph outcomes');
    if (edge.key !== expectedKey || edge.outcomes.length < 1 ||
        edge.outcomes.length > maximumEdges) {
      throw new Error('belief graph edge key or outcomes are invalid');
    }
    const targets = new Set<string>();
    let outcomeCount = 0;
    for (const rawOutcome of edge.outcomes) {
      assertExactRecord(rawOutcome, OUTCOME_KEYS, 'belief graph outcome');
      const outcome = rawOutcome as unknown as BeliefEdge['outcomes'][number];
      if (typeof outcome.toBeliefKey !== 'string' || !nodes.has(outcome.toBeliefKey) ||
          targets.has(outcome.toBeliefKey)) {
        throw new Error('belief graph snapshot contains an invalid outcome');
      }
      assertDenseArray(outcome.receiptHashes, 'belief outcome receiptHashes');
      if (outcome.receiptHashes.length < 1 || outcome.receiptHashes.length > maximumEdges ||
          outcome.receiptHashes.some(hash => typeof hash !== 'string' || !HEX_HASH.test(hash) ||
            receiptHashes.has(hash)) ||
          new Set(outcome.receiptHashes).size !== outcome.receiptHashes.length ||
          !Number.isSafeInteger(outcome.count) || outcome.count !== outcome.receiptHashes.length) {
        throw new Error('belief graph snapshot contains an invalid outcome');
      }
      targets.add(outcome.toBeliefKey);
      for (const hash of outcome.receiptHashes) receiptHashes.add(hash);
      outcomeCount += outcome.count;
    }
    if (!Number.isSafeInteger(edge.testedCount) || edge.testedCount !== outcomeCount ||
        !Number.isSafeInteger(edge.noEffectCount) || edge.noEffectCount < 0 ||
        edge.noEffectCount > edge.testedCount) {
      throw new Error('belief graph edge counters do not match its outcomes');
    }
    edgeKeys.add(edge.key);
  }

  const current = graph.currentBeliefKey;
  if (current !== undefined && (typeof current !== 'string' || !nodes.has(current))) {
    throw new Error('belief graph snapshot current node is missing');
  }
  if ((nodes.size === 0) !== (current === undefined)) {
    throw new Error('belief graph snapshot current node presence is inconsistent');
  }
}

interface NextBelief {
  readonly key: string;
  readonly latentContextHash: string;
}

export function hiddenStateSafeBeliefKey(input: {
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
  readonly observationHash: string;
  readonly latentContextHash: string;
}): string {
  return `belief_${hashArcValue(input)}`;
}

export function observableEdgeKey(observationHash: string, action: ArcAction): string {
  return `edge_${hashArcValue({ observationHash, action })}`;
}

function availableForObservation(observation: ExactArcObservation): readonly ArcActionName[] {
  if (observation.state === 'NOT_PLAYED' || observation.state === 'GAME_OVER') {
    return Object.freeze(['RESET']);
  }
  if (observation.state === 'WIN') return Object.freeze([]);
  return observation.availableActions.filter(action => action !== 'RESET');
}

export class BeliefGraph {
  private readonly nodes = new Map<string, BeliefNode>();
  private readonly edges = new Map<string, BeliefEdge>();
  private currentKey?: string;

  constructor(private readonly options: BeliefGraphOptions) {}

  initialize(observation: ExactArcObservation): BeliefNode {
    if (observation.opaqueGameScope !== this.options.opaqueGameScope) {
      throw new Error('observation belongs to a foreign opaque game scope');
    }
    const latentContextHash = hashArcValue({ genesis: true, observation: observation.observationHash });
    const key = hiddenStateSafeBeliefKey({
      ...this.options,
      observationHash: observation.observationHash,
      latentContextHash,
    });
    const node = this.makeNode(key, latentContextHash, observation, 1);
    this.nodes.set(key, node);
    this.currentKey = key;
    return node;
  }

  previewNext(
    action: ArcAction,
    observation: ExactArcObservation,
    sequence: number,
  ): NextBelief {
    const current = this.current();
    const latentContextHash = hashArcValue({
      previousLatentContextHash: current.latentContextHash,
      previousBeliefKey: current.key,
      action,
      resultingObservationHash: observation.observationHash,
      sequence,
    });
    return {
      key: hiddenStateSafeBeliefKey({
        ...this.options,
        observationHash: observation.observationHash,
        latentContextHash,
      }),
      latentContextHash,
    };
  }

  recordTransition(input: {
    readonly action: ArcAction;
    readonly observation: ExactArcObservation;
    readonly next: NextBelief;
    readonly receiptHash: string;
    readonly noEffect: boolean;
  }): BeliefNode {
    const from = this.current();
    const existingNode = this.nodes.get(input.next.key);
    const to = existingNode
      ? this.makeNode(
          existingNode.key,
          existingNode.latentContextHash,
          input.observation,
          existingNode.visits + 1,
        )
      : this.makeNode(input.next.key, input.next.latentContextHash, input.observation, 1);
    this.nodes.set(to.key, to);

    const key = `belief_edge_${hashArcValue({ from: from.key, action: input.action })}`;
    const prior = this.edges.get(key);
    const outcomes = prior ? [...prior.outcomes] : [];
    const outcomeIndex = outcomes.findIndex(outcome => outcome.toBeliefKey === to.key);
    if (outcomeIndex >= 0) {
      const outcome = outcomes[outcomeIndex]!;
      outcomes[outcomeIndex] = Object.freeze({
        toBeliefKey: outcome.toBeliefKey,
        receiptHashes: Object.freeze([...outcome.receiptHashes, input.receiptHash]),
        count: outcome.count + 1,
      });
    } else {
      outcomes.push(Object.freeze({
        toBeliefKey: to.key,
        receiptHashes: Object.freeze([input.receiptHash]),
        count: 1,
      }));
    }
    const edge: BeliefEdge = Object.freeze({
      key,
      fromBeliefKey: from.key,
      observationHash: from.observationHash,
      action: input.action,
      outcomes: Object.freeze(outcomes),
      testedCount: (prior?.testedCount ?? 0) + 1,
      noEffectCount: (prior?.noEffectCount ?? 0) + (input.noEffect ? 1 : 0),
    });
    this.edges.set(key, edge);
    this.currentKey = to.key;
    return to;
  }

  frontier(observation: ExactArcObservation, limit = 32): readonly FrontierEdge[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
      throw new Error('graph frontier limit must be an integer in 1..256');
    }
    const current = this.current();
    const frontier = availableForObservation(observation).map(actionName => {
      const testedCount = this.observableTestedCount(observation.observationHash, actionName);
      return Object.freeze({
        fromBeliefKey: current.key,
        observationHash: observation.observationHash,
        actionName,
        testedCount,
        noveltyPriority: 1 / (1 + testedCount),
      });
    });
    return Object.freeze(frontier
      .sort((a, b) => b.noveltyPriority - a.noveltyPriority ||
        a.actionName.localeCompare(b.actionName))
      .slice(0, limit));
  }

  observableTestedCount(observationHash: string, actionName: ArcActionName): number {
    let count = 0;
    for (const edge of this.edges.values()) {
      if (edge.observationHash === observationHash && edge.action.name === actionName) {
        count += edge.testedCount;
      }
    }
    return count;
  }

  current(): BeliefNode {
    if (!this.currentKey) throw new Error('belief graph is not initialized');
    const node = this.nodes.get(this.currentKey);
    if (!node) throw new Error('belief graph current node is missing');
    return node;
  }

  node(key: string): BeliefNode | undefined {
    return this.nodes.get(key);
  }

  snapshot(): BeliefGraphSnapshot {
    return Object.freeze({
      nodes: Object.freeze([...this.nodes.values()]),
      edges: Object.freeze([...this.edges.values()]),
      currentBeliefKey: this.currentKey,
    });
  }

  load(snapshot: BeliefGraphSnapshot): void {
    validateBeliefGraphSnapshot(snapshot, this.options);
    this.nodes.clear();
    this.edges.clear();
    for (const node of snapshot.nodes) {
      this.nodes.set(node.key, Object.freeze({
        ...node,
        availableActions: Object.freeze([...node.availableActions]),
      }));
    }
    for (const edge of snapshot.edges) {
      this.edges.set(edge.key, Object.freeze({
        ...edge,
        action: Object.freeze({ ...edge.action }),
        outcomes: Object.freeze(edge.outcomes.map(outcome => Object.freeze({
          ...outcome,
          receiptHashes: Object.freeze([...outcome.receiptHashes]),
        }))),
      }));
    }
    this.currentKey = snapshot.currentBeliefKey;
  }

  /** Observable graph SCCs are used only for cycle supervision, never state merging. */
  componentSize(observationHash: string): number {
    const adjacency = new Map<string, Set<string>>();
    for (const edge of this.edges.values()) {
      const targets = adjacency.get(edge.observationHash) ?? new Set<string>();
      for (const outcome of edge.outcomes) {
        const node = this.nodes.get(outcome.toBeliefKey);
        if (node) targets.add(node.observationHash);
      }
      adjacency.set(edge.observationHash, targets);
    }
    for (const node of this.nodes.values()) {
      if (!adjacency.has(node.observationHash)) adjacency.set(node.observationHash, new Set());
    }
    const reachable = (start: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const next = stack.pop()!;
        if (seen.has(next)) continue;
        seen.add(next);
        for (const target of adjacency.get(next) ?? []) stack.push(target);
      }
      return seen;
    };
    const outward = reachable(observationHash);
    let count = 0;
    for (const candidate of outward) {
      if (reachable(candidate).has(observationHash)) count++;
    }
    return count;
  }

  private makeNode(
    key: string,
    latentContextHash: string,
    observation: ExactArcObservation,
    visits: number,
  ): BeliefNode {
    return Object.freeze({
      key,
      principalScope: this.options.principalScope,
      opaqueGameScope: this.options.opaqueGameScope,
      runId: this.options.runId,
      observationHash: observation.observationHash,
      frameHash: observation.currentFrame.frameHash,
      latentContextHash,
      state: observation.state,
      levelsCompleted: observation.levelsCompleted,
      availableActions: observation.availableActions,
      visits,
    });
  }
}
