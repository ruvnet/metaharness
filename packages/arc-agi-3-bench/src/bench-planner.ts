import type {
  ArcAvoContext,
  ArcAvoPlanner,
  ArcAvoSupervisor,
  ArcCandidatePlanDraft,
  SupervisorCaseBundle,
  SupervisorDirectiveCommit,
} from '@metaharness/arc-agi-3';

import { hashCanonical } from './canonical.js';
import { ModelTurnBudgetError, MeteredModelDriver } from './model-driver.js';
import type { BenchmarkArm, EpisodeIdentity, ModelTurnKind, ModelTurnRequest } from './types.js';

function requestId(identity: EpisodeIdentity, kind: ModelTurnKind, turnIndex: number): string {
  return `turn_${hashCanonical({ pairId: identity.pairId, arm: identity.arm, kind, turnIndex }).slice(0, 32)}`;
}

function opaqueTaskHandle(identity: EpisodeIdentity): string {
  return `task_${hashCanonical({ pairId: identity.pairId, seed: identity.episodeSeed }).slice(0, 32)}`;
}

export class BenchmarkPlanner implements ArcAvoPlanner {
  readonly version: string;
  readonly #identity: EpisodeIdentity;
  readonly #driver: MeteredModelDriver;
  #seenSupervisorTurns = 0;

  constructor(options: {
    readonly identity: EpisodeIdentity;
    readonly driver: MeteredModelDriver;
  }) {
    this.#identity = options.identity;
    this.#driver = options.driver;
    this.version = `arc-agi-3-bench/planner-v1/${options.identity.arm}`;
  }

  async propose(context: Readonly<ArcAvoContext>): Promise<readonly ArcCandidatePlanDraft[]> {
    const arm = this.#identity.arm;
    const supervisorTurns = this.#driver.summary().supervisorTurns;
    const supervisorFilledDeliberationSlot = arm === 'avo'
      && supervisorTurns > this.#seenSupervisorTurns;
    this.#seenSupervisorTurns = supervisorTurns;
    const needsRoutineReflection = arm === 'direct-reflection'
      || (arm === 'avo' && !supervisorFilledDeliberationSlot);
    const requiredTurns = 1 + Number(needsRoutineReflection);
    if (this.#driver.remainingTurns < requiredTurns) throw new ModelTurnBudgetError();

    let reflection: string | undefined;
    if (needsRoutineReflection) {
      const response = await this.#driver.turn(this.#request(
        'REFLECT',
        context,
        arm === 'avo'
          ? 'Bounded deliberation before proposing governed variants.'
          : 'Direct self-reflection before selecting one action.',
      ));
      reflection = response.reflection;
    }

    const response = await this.#driver.turn({
      ...this.#request('PLAN', context, arm === 'avo'
        ? 'Propose bounded alternative candidates for governed selection.'
        : 'Choose one direct action.'),
      ...(reflection === undefined ? {} : { reflection }),
    });
    const candidates = response.candidateActions;
    if (!candidates || candidates.length === 0) {
      throw new Error('model driver returned no candidate actions');
    }
    if (arm !== 'avo' && candidates.length !== 1) {
      throw new Error(`${arm} must return exactly one candidate action`);
    }
    const offered = new Set(context.observation.availableActions);
    return Object.freeze(candidates.map((candidate, index) => {
      if (!offered.has(candidate.action.name)) {
        throw new Error(`model proposed unoffered action ${candidate.action.name}`);
      }
      const stepId = hashCanonical({
        pairId: this.#identity.pairId,
        arm,
        observation: context.observation.observationHash,
        turnIndex: this.#driver.nextTurnIndex,
        candidate: index,
        action: candidate.action,
      }).slice(0, 32);
      return Object.freeze({
        parentCandidateId: context.config.features.planLineage
          ? context.lineageHeadId ?? null
          : null,
        baseObservationHash: context.observation.observationHash,
        hypothesis: candidate.hypothesis,
        citedRuleIds: Object.freeze([]),
        ruleHypotheses: context.config.features.semanticRuleMemory
          ? Object.freeze([{
              scope: 'LEVEL' as const,
              kind: 'TRANSITION' as const,
              statement: `${candidate.action.name} is an unresolved transition at the current visible state.`,
              preconditions: Object.freeze([
                `observation=${context.observation.observationHash}`,
              ]),
              predictedEffect: 'The action will yield exact evidence for progress, change, or no effect.',
            }])
          : Object.freeze([]),
        steps: Object.freeze([{
          expectedObservationHash: context.observation.observationHash,
          idempotencyKey: `bench_${stepId}`,
          action: Object.freeze({ ...candidate.action }),
          expectation: Object.freeze({
            confidence: candidate.confidence,
            expectedState: 'WIN' as const,
            rationale: candidate.hypothesis,
          }),
          postcondition: Object.freeze({ state: 'WIN' as const }),
        }]),
      });
    }));
  }

  #request(
    kind: ModelTurnKind,
    context: Readonly<ArcAvoContext>,
    purpose: string,
  ): ModelTurnRequest {
    const arm = this.#identity.arm;
    const turnIndex = this.#driver.nextTurnIndex;
    return Object.freeze({
      schema: 'metaharness.arc_agi_3.model_turn.v1',
      requestId: requestId(this.#identity, kind, turnIndex),
      kind,
      arm,
      opaqueTaskHandle: opaqueTaskHandle(this.#identity),
      episodeSeed: this.#identity.episodeSeed,
      turnIndex,
      observation: context.observation,
      availableActions: context.observation.availableActions,
      ...(arm === 'avo' ? { frontier: context.frontier, memory: context.memory } : {}),
      purpose,
    });
  }
}

export class BenchmarkSupervisor implements ArcAvoSupervisor {
  readonly version = 'arc-agi-3-bench/supervisor-driver-v1';
  readonly #identity: EpisodeIdentity;
  readonly #driver: MeteredModelDriver;

  constructor(options: {
    readonly identity: EpisodeIdentity;
    readonly driver: MeteredModelDriver;
  }) {
    this.#identity = options.identity;
    this.#driver = options.driver;
  }

  async review(bundle: Readonly<SupervisorCaseBundle>): Promise<SupervisorDirectiveCommit> {
    const turnIndex = this.#driver.nextTurnIndex;
    const response = await this.#driver.turn(Object.freeze({
      schema: 'metaharness.arc_agi_3.model_turn.v1',
      requestId: requestId(this.#identity, 'SUPERVISE', turnIndex),
      kind: 'SUPERVISE',
      arm: this.#identity.arm,
      opaqueTaskHandle: opaqueTaskHandle(this.#identity),
      episodeSeed: this.#identity.episodeSeed,
      turnIndex,
      supervisorCase: bundle,
      purpose: 'Resolve the typed blocking supervisor case without acting.',
    }));
    if (!response.supervisorDirective) {
      throw new Error('model driver returned no supervisor directive');
    }
    return response.supervisorDirective;
  }
}
