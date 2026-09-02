import { describe, expect, it } from 'vitest';
import {
  ArcAvoLoop,
  ArcController,
  EvidenceRetrodictiveWorldModel,
  arcAvoFeaturesForArm,
  defaultSupervisorCommit,
  hashArcValue,
  memorySnapshotHashFor,
  observableEdgeKey,
  resolveArcAvoConfig,
  type ArcAction,
  type ArcAvoCheckpoint,
  type ArcAvoContext,
  type ArcCandidatePlan,
  type ArcCandidatePlanDraft,
  type ArcControllerOptions,
  type ArcEnvironment,
  type ArcSessionLog,
  type JsonValue,
  type RawArcObservation,
  type SupervisorCaseBundle,
} from '../src/index.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function raw(
  value = 0,
  state: RawArcObservation['state'] = 'NOT_FINISHED',
  levelsCompleted = state === 'WIN' ? 1 : 0,
  winLevels = 1,
): RawArcObservation {
  return {
    state,
    levelsCompleted,
    winLevels,
    availableActions: ['ACTION1', 'ACTION2'],
    frames: [{ width: 1, height: 1, cells: [[value]] }],
  };
}

class FakeEnvironment implements ArcEnvironment {
  current: RawArcObservation;
  readonly actions: ArcAction[] = [];
  resetCalls = 0;
  resumeCalls = 0;
  closeCalls = 0;
  stepHook?: (action: ArcAction) => RawArcObservation | Promise<RawArcObservation>;

  constructor(initial = raw()) { this.current = initial; }

  async reset(): Promise<RawArcObservation> {
    this.resetCalls++;
    return this.current;
  }

  async observe(): Promise<RawArcObservation> { return this.current; }

  async step(action: ArcAction): Promise<RawArcObservation> {
    this.actions.push(structuredClone(action));
    if (this.stepHook) this.current = await this.stepHook(action);
    return this.current;
  }

  async checkpoint(): Promise<JsonValue> { return { actions: this.actions.length }; }

  async resume(_checkpoint: JsonValue): Promise<RawArcObservation> {
    this.resumeCalls++;
    return this.current;
  }

  async close(): Promise<void> { this.closeCalls++; }
}

function controllerOptions(
  environment: ArcEnvironment,
  runId = 'avo-test-run',
  overrides: Partial<ArcControllerOptions> = {},
): ArcControllerOptions {
  return {
    principalId: 'avo test principal',
    runId,
    gameVersionHash: 'private-game-version',
    environment,
    runManifest: {
      visibleModelLabel: 'fixed-test-model',
      promptSnapshotHash: SHA_A,
      toolSchemaHash: SHA_B,
      environmentAdapterVersion: 'fake-arc-adapter-v1',
    },
    budget: { maxActions: 100, maxWallTimeMs: 60_000 },
    ...overrides,
  };
}

function plan(
  context: ArcAvoContext,
  input: {
    readonly key: string;
    readonly action?: ArcAction;
    readonly parentCandidateId?: string | null;
    readonly expectedWin?: boolean;
    readonly citedRuleIds?: readonly string[];
    readonly withRule?: boolean;
    readonly hypothesis?: string;
  },
): ArcCandidatePlanDraft {
  const action = input.action ?? { name: 'ACTION1' as const };
  const expectedWin = input.expectedWin ?? false;
  return {
    parentCandidateId: input.parentCandidateId ?? context.lineageHeadId ?? null,
    baseObservationHash: context.observation.observationHash,
    hypothesis: input.hypothesis ?? `Hypothesis for ${input.key}`,
    citedRuleIds: input.citedRuleIds ?? [],
    ruleHypotheses: input.withRule === false ? [] : [{
      scope: 'GAME',
      kind: 'ACTION_MAP',
      statement: `${action.name} has the predicted effect for ${input.key}`,
      preconditions: ['current visible state matches the plan base'],
      predictedEffect: expectedWin ? 'The game reaches WIN' : 'The current frame remains stable',
    }],
    steps: [{
      expectedObservationHash: context.observation.observationHash,
      idempotencyKey: input.key,
      action,
      expectation: expectedWin
        ? { confidence: 0.9, expectedState: 'WIN' }
        : { confidence: 0.9, expectedFrameHash: context.observation.currentFrame.frameHash },
      postcondition: expectedWin
        ? { state: 'WIN' }
        : { expectedFrameHash: context.observation.currentFrame.frameHash },
    }],
  };
}

function rehashAvoEnvelope(checkpoint: ArcAvoCheckpoint): void {
  const mutable = checkpoint as unknown as {
    archive: {
      outcomes: Array<Record<string, unknown>>;
      outcomeHeadHash: string;
      archiveHash: string;
      [key: string]: unknown;
    };
    worldModel: { snapshotHash: string; [key: string]: unknown };
    checkpointHash: string;
    [key: string]: unknown;
  };
  let outcomeHead = '0'.repeat(64);
  for (const outcome of mutable.archive.outcomes) {
    outcome.previousOutcomeHash = outcomeHead;
    const { outcomeHash: _outcomeHash, ...body } = outcome;
    outcome.outcomeHash = hashArcValue(body);
    outcomeHead = outcome.outcomeHash as string;
  }
  mutable.archive.outcomeHeadHash = outcomeHead;
  const { archiveHash: _archiveHash, ...archiveBody } = mutable.archive;
  mutable.archive.archiveHash = hashArcValue(archiveBody);
  const { snapshotHash: _snapshotHash, ...worldBody } = mutable.worldModel;
  mutable.worldModel.snapshotHash = hashArcValue(worldBody);
  const { checkpointHash: _checkpointHash, ...checkpointBody } = mutable;
  mutable.checkpointHash = hashArcValue(checkpointBody);
}

function rehashAvoRetrodictions(checkpoint: ArcAvoCheckpoint): void {
  const mutable = checkpoint as unknown as {
    archive: { outcomes: Array<{ retrodictionHashes: string[] }> };
    worldModel: {
      records: Array<Record<string, unknown>>;
      headHash: string;
    };
  };
  const replacements = new Map<string, string>();
  let head = '0'.repeat(64);
  for (const record of mutable.worldModel.records) {
    const oldHash = record.retrodictionHash as string;
    record.previousRetrodictionHash = head;
    const { retrodictionHash: _retrodictionHash, ...body } = record;
    const nextHash = hashArcValue(body);
    record.retrodictionHash = nextHash;
    replacements.set(oldHash, nextHash);
    head = nextHash;
  }
  mutable.worldModel.headHash = head;
  for (const outcome of mutable.archive.outcomes) {
    outcome.retrodictionHashes = outcome.retrodictionHashes.map(hash =>
      replacements.get(hash) ?? hash);
  }
}

function rehashAvoSelections(checkpoint: ArcAvoCheckpoint): void {
  const mutable = checkpoint as unknown as {
    archive: {
      selections: Array<Record<string, unknown>>;
      outcomes: Array<Record<string, unknown>>;
    };
    worldModel: { records: Array<Record<string, unknown>> };
  };
  const replacements = new Map<string, string>();
  for (const selection of mutable.archive.selections) {
    const oldHash = selection.selectionHash as string;
    const { selectionHash: _selectionHash, ...body } = selection;
    const nextHash = hashArcValue(body);
    selection.selectionHash = nextHash;
    replacements.set(oldHash, nextHash);
  }
  for (const outcome of mutable.archive.outcomes) {
    const replacement = replacements.get(outcome.selectionHash as string);
    if (replacement) outcome.selectionHash = replacement;
  }
  for (const record of mutable.worldModel.records) {
    const replacement = replacements.get(record.selectionHash as string);
    if (replacement) record.selectionHash = replacement;
  }
  rehashAvoRetrodictions(checkpoint);
  rehashAvoEnvelope(checkpoint);
}

function forgeCheckpointCandidate(
  checkpoint: ArcAvoCheckpoint,
  hypothesis: string,
  extraDraftFields: Readonly<Record<string, unknown>> = {},
): ArcCandidatePlan {
  const source = structuredClone(checkpoint.archive.candidates[0]!);
  const {
    id: _id,
    candidateHash: _candidateHash,
    depth,
    ...sourceDraft
  } = source;
  const draft = { ...sourceDraft, hypothesis, ...extraDraftFields };
  const candidateHash = hashArcValue({
    principalScope: checkpoint.coreCheckpoint.principalScope,
    opaqueGameScope: checkpoint.coreCheckpoint.opaqueGameScope,
    runId: checkpoint.coreCheckpoint.runId,
    configHash: checkpoint.config.configHash,
    draft,
    depth,
  });
  return {
    ...draft,
    id: `arc_plan_${candidateHash.slice(0, 40)}`,
    depth,
    candidateHash,
  } as unknown as ArcCandidatePlan;
}

describe('ARC AVO enforced loop', () => {
  it('freezes named arms, hashes every resolved condition, and rejects invalid custom dependencies', () => {
    const direct = resolveArcAvoConfig({ arm: 'DIRECT_ACTOR' });
    const full = resolveArcAvoConfig({ arm: 'AVO_FULL' });
    const retrodiction = resolveArcAvoConfig({ arm: 'AVO_FULL_RETRODICTION' });

    expect(direct.features).toEqual(arcAvoFeaturesForArm('DIRECT_ACTOR'));
    expect(full.features.supervisorGate).toBe('BLOCKING');
    expect(full.features.retrodictiveWorldModel).toBe(false);
    expect(retrodiction.features.retrodictiveWorldModel).toBe(true);
    expect(new Set([direct.configHash, full.configHash, retrodiction.configHash]).size).toBe(3);
    expect(Object.isFrozen(full)).toBe(true);
    expect(Object.isFrozen(full.features)).toBe(true);

    expect(() => resolveArcAvoConfig({
      arm: 'CUSTOM',
      features: {
        candidatePlanSelection: false,
        planLineage: true,
        semanticRuleMemory: false,
        beliefFrontier: false,
        supervisorGate: 'OFF',
        guardedExecution: false,
        retrodictiveWorldModel: false,
      },
    })).toThrow(/planLineage requires/);
    expect(() => resolveArcAvoConfig({
      arm: 'AVO_FULL',
      features: arcAvoFeaturesForArm('AVO_FULL'),
    })).toThrow(/cannot override/);
  });

  it('rejects an oversized candidate batch before archive or environment mutation', async () => {
    const environment = new FakeEnvironment();
    const loop = new ArcAvoLoop({
      controllerOptions: controllerOptions(environment, 'bounded-candidate-batch'),
      config: { arm: 'AVO_FULL', maxCandidatesPerDecision: 4 },
    });
    const context = await loop.start();
    const candidates = Array.from({ length: 3 }, (_, candidateIndex): ArcCandidatePlanDraft => ({
      parentCandidateId: null,
      baseObservationHash: context.observation.observationHash,
      hypothesis: `Oversized candidate ${candidateIndex}`,
      citedRuleIds: [],
      ruleHypotheses: Array.from({ length: 16 }, (_, ruleIndex) => ({
        scope: 'GAME' as const,
        kind: 'TRANSITION' as const,
        statement: `${candidateIndex}:${ruleIndex}:` + 's'.repeat(3_900),
        preconditions: [`candidate-${candidateIndex}-rule-${ruleIndex}`],
        predictedEffect: `${candidateIndex}:${ruleIndex}:` + 'p'.repeat(3_900),
      })),
      steps: [{
        expectedObservationHash: context.observation.observationHash,
        idempotencyKey: `oversized-candidate-${candidateIndex}`,
        action: { name: 'ACTION1' },
        expectation: { confidence: 0.5, expectedState: 'NOT_FINISHED' },
        postcondition: { state: 'NOT_FINISHED' },
      }],
    }));

    await expect(loop.stepWithCandidates(candidates)).rejects.toMatchObject({
      code: 'INVALID_CANDIDATE_BATCH',
    });
    expect(environment.actions).toHaveLength(0);
    expect(loop.context().recentCandidates).toHaveLength(0);
  });

  it('uses planner order only as a deterministic evidence-tie preference and snapshots input', async () => {
    const run = async (reverse: boolean) => {
      const environment = new FakeEnvironment();
      environment.stepHook = action => action.name === 'ACTION2' ? raw(1, 'WIN') : raw();
      const loop = new ArcAvoLoop({
        controllerOptions: controllerOptions(environment, 'deterministic-selection'),
        config: { arm: 'AVO_FULL' },
      });
      const context = await loop.start();
      const explore = plan(context, {
        key: 'candidate-explore-0001',
        action: { name: 'ACTION1' },
        hypothesis: 'Explore without expected progress',
      });
      const win = plan(context, {
        key: 'candidate-winning-0001',
        action: { name: 'ACTION2' },
        expectedWin: true,
        hypothesis: 'Complete the current game',
      });
      const drafts = reverse ? [win, explore] : [explore, win];
      const pending = loop.stepWithCandidates(drafts);
      (drafts[0]!.steps[0]!.action as { name: string }).name = 'ACTION7';
      const result = await pending;
      return { environment, loop, result };
    };

    const forward = await run(false);
    const reverse = await run(true);
    expect(forward.result.candidate.hypothesis).toBe('Explore without expected progress');
    expect(reverse.result.candidate.hypothesis).toBe('Complete the current game');
    expect(forward.result.selection.selectionHash).not.toBe(reverse.result.selection.selectionHash);
    expect(forward.environment.actions).toEqual([{ name: 'ACTION1' }]);
    expect(reverse.environment.actions).toEqual([{ name: 'ACTION2' }]);
    expect(forward.result.context.status.phase).toBe('ACTIVE');
    expect(reverse.result.context.status.phase).toBe('WON');
  });

  it('blocks an unresolved supervisor case before dispatch and accepts an external boss directive', async () => {
    const environment = new FakeEnvironment();
    const loop = new ArcAvoLoop({
      controllerOptions: controllerOptions(environment, 'blocking-supervisor', {
        supervisorThresholds: { noEffectCount: 1, noEffectWindow: 1 },
      }),
      config: { arm: 'AVO_SUPERVISOR_MEMORY' },
    });
    let context = await loop.start();
    const first = await loop.stepWithCandidates([plan(context, { key: 'blocked-step-0001' })]);
    context = first.context;
    expect(loop.status().openSupervisorCaseId).toBeDefined();

    await expect(loop.stepWithCandidates([plan(context, {
      key: 'blocked-step-0002',
      parentCandidateId: context.lineageHeadId,
    })])).rejects.toMatchObject({ code: 'SUPERVISION_REQUIRED' });
    expect(environment.actions).toHaveLength(1);

    const authority = loop.asSupervisor();
    const bundle = authority.openSupervisorCase()!;
    await authority.commitSupervisorDirective(
      defaultSupervisorCommit(bundle.case, bundle.observation.observationHash),
    );
    const resumed = await loop.stepWithCandidates([plan(context, {
      key: 'blocked-step-0003',
      parentCandidateId: context.lineageHeadId,
    })]);
    expect(resumed.completed).toHaveLength(1);
    expect(resumed.completed[0]!.receipt.directiveId).toBeDefined();
    expect(environment.actions).toHaveLength(2);
  });

  it('stops a guarded plan before step two when step one opens a supervisor case', async () => {
    const environment = new FakeEnvironment();
    const loop = new ArcAvoLoop({
      controllerOptions: controllerOptions(environment, 'mid-plan-supervisor', {
        supervisorThresholds: { noEffectCount: 1, noEffectWindow: 1 },
      }),
      config: { arm: 'AVO_FULL' },
    });
    const context = await loop.start();
    const observationHash = context.observation.observationHash;
    const candidate: ArcCandidatePlanDraft = {
      parentCandidateId: null,
      baseObservationHash: observationHash,
      hypothesis: 'Stop this plan if the first no-effect action needs supervision',
      citedRuleIds: [],
      ruleHypotheses: [{
        scope: 'GAME',
        kind: 'TRANSITION',
        statement: 'Repeated no-effect actions require a new plan',
        preconditions: ['the current exact observation remains unchanged'],
        predictedEffect: 'The boss lane opens before another action',
      }],
      steps: [
        {
          expectedObservationHash: observationHash,
          idempotencyKey: 'mid-plan-step-0001',
          action: { name: 'ACTION1' },
          expectation: {
            confidence: 0.9,
            expectedFrameHash: context.observation.currentFrame.frameHash,
          },
          postcondition: { expectedObservationHash: observationHash },
        },
        {
          expectedObservationHash: observationHash,
          idempotencyKey: 'mid-plan-step-0002',
          action: { name: 'ACTION2' },
          expectation: {
            confidence: 0.9,
            expectedFrameHash: context.observation.currentFrame.frameHash,
          },
          postcondition: { expectedObservationHash: observationHash },
        },
      ],
    };

    const result = await loop.stepWithCandidates([candidate]);
    expect(result.stopReason).toBe('ACTION_REJECTED');
    expect(result.completed).toHaveLength(1);
    expect(environment.actions).toEqual([{ name: 'ACTION1' }]);
    expect(result.context.status.openSupervisorCaseId).toBeDefined();
    expect(result.context.recentOutcomes.at(-1)).toMatchObject({
      stopReason: 'ACTION_REJECTED',
      coreReceiptHashes: [result.completed[0]!.receipt.receiptHash],
    });
    expect(result.updatedRules[0]).toMatchObject({
      status: 'CANDIDATE',
      proposalReceiptHashes: [result.completed[0]!.receipt.receiptHash],
      supportingReceiptHashes: [],
      contradictingReceiptHashes: [],
      alpha: 1,
      beta: 1,
    });
    expect(result.retrodictions).toEqual([]);
  });

  it('scores progress from receipts rather than a planner claim of WIN', async () => {
    const environment = new FakeEnvironment(raw(0, 'NOT_FINISHED', 0, 2));
    environment.stepHook = action =>
      environment.actions.length === 1 && action.name === 'ACTION1'
        ? raw(1, 'NOT_FINISHED', 1, 2)
        : environment.current;
    const loop = new ArcAvoLoop({
      controllerOptions: controllerOptions(environment, 'evidence-selection'),
      config: { arm: 'AVO_LINEAGE' },
    });
    let context = await loop.start();
    context = (await loop.stepWithCandidates([plan(context, {
      key: 'evidence-seed-0001',
      action: { name: 'ACTION1' },
      withRule: false,
      hypothesis: 'Receipted ACTION1 progress',
    })])).context;
    const evidenceBacked = plan(context, {
      key: 'evidence-choice-0001',
      action: { name: 'ACTION1' },
      withRule: false,
      hypothesis: 'Choose the action with observed progress',
    });
    const liar = plan(context, {
      key: 'evidence-choice-0002',
      action: { name: 'ACTION2' },
      expectedWin: true,
      withRule: false,
      hypothesis: 'Unseen action claims an unsupported WIN',
    });

    const result = await loop.stepWithCandidates([liar, evidenceBacked]);
    const offered = result.context.recentCandidates.filter(candidate =>
      result.selection.offeredCandidateIds.includes(candidate.id));
    const evidenceId = offered.find(candidate => candidate.hypothesis ===
      'Choose the action with observed progress')!.id;
    const liarId = offered.find(candidate => candidate.hypothesis ===
      'Unseen action claims an unsupported WIN')!.id;
    expect(result.selection.scores[evidenceId]!.expectedProgress).toBe(1);
    expect(result.selection.scores[liarId]!.expectedProgress).toBe(0);
    expect(result.candidate.id).toBe(evidenceId);
    expect(environment.actions.at(-1)).toEqual({ name: 'ACTION1' });
  });

  it('audits offered candidates but selects only supervisor-legal alternatives', async () => {
    const environment = new FakeEnvironment(raw(0, 'NOT_FINISHED', 0, 2));
    environment.stepHook = action =>
      environment.actions.length === 1 && action.name === 'ACTION1'
        ? raw(1, 'NOT_FINISHED', 1, 2)
        : environment.current;
    const loop = new ArcAvoLoop({
      controllerOptions: controllerOptions(environment, 'legal-selection'),
      config: { arm: 'AVO_SUPERVISOR_MEMORY' },
    });
    let context = await loop.start();
    const seeded = await loop.stepWithCandidates([plan(context, {
      key: 'legal-seed-0001',
      action: { name: 'ACTION1' },
      hypothesis: 'Seed authoritative progress for ACTION1',
    })]);
    context = seeded.context;
    const authority = loop.asSupervisor();
    const bundle = authority.openSupervisorCase({
      trigger: 'MODEL_CONTRADICTION',
      evidenceReceiptHashes: [seeded.completed[0]!.receipt.receiptHash],
    })!;
    await authority.commitSupervisorDirective({
      ...defaultSupervisorCommit(bundle.case, bundle.observation.observationHash),
      prohibitedEdges: [observableEdgeKey(context.observation.observationHash, {
        name: 'ACTION1',
      })],
    });
    const prohibited = plan(context, {
      key: 'legal-choice-0001',
      action: { name: 'ACTION1' },
      parentCandidateId: context.lineageHeadId,
      hypothesis: 'High-evidence but prohibited ACTION1',
    });
    const legal = plan(context, {
      key: 'legal-choice-0002',
      action: { name: 'ACTION2' },
      parentCandidateId: context.lineageHeadId,
      hypothesis: 'Supervisor-legal ACTION2',
    });

    const result = await loop.stepWithCandidates([prohibited, legal]);
    const offered = result.context.recentCandidates.filter(candidate =>
      result.selection.offeredCandidateIds.includes(candidate.id));
    const prohibitedId = offered.find(candidate => candidate.hypothesis ===
      'High-evidence but prohibited ACTION1')!.id;
    const legalId = offered.find(candidate => candidate.hypothesis ===
      'Supervisor-legal ACTION2')!.id;
    expect(result.selection.offeredCandidateIds).toHaveLength(2);
    expect(result.selection.eligibleCandidateIds).toEqual([legalId]);
    expect(result.selection.rejectionCodes).toEqual({ [prohibitedId]: 'PROHIBITED_EDGE' });
    expect(result.selection.scores[prohibitedId]!.expectedProgress).toBeGreaterThan(
      result.selection.scores[legalId]!.expectedProgress,
    );
    expect(result.candidate.id).toBe(legalId);
    expect(environment.actions.at(-1)).toEqual({ name: 'ACTION2' });
  });

  it('publishes a terminal observation before fallible rule postprocessing', async () => {
    const environment = new FakeEnvironment();
    environment.stepHook = action => action.name === 'ACTION2' ? raw(1, 'WIN') : raw();
    const sessionLog: ArcSessionLog = {
      async append(kind: string): Promise<void> {
        if (kind === 'arc.memory_rule_intent') throw new Error('rule store unavailable');
      },
      stateHash(): string { return SHA_A; },
    };
    const core = new ArcController(controllerOptions(environment, 'terminal-publication', {
      supervisionGate: 'BLOCKING',
      sessionLog,
    }));
    const loop = new ArcAvoLoop({ controller: core, config: { arm: 'AVO_FULL' } });
    const context = await loop.start();

    // Deliberately predict a stable frame so the terminal transition also
    // exercises guarded-plan divergence after WIN.
    await expect(loop.stepWithCandidates([plan(context, {
      key: 'terminal-publication-0001',
      action: { name: 'ACTION2' },
      expectedWin: false,
      hypothesis: 'A deliberately fallible terminal hypothesis',
    })])).rejects.toMatchObject({ code: 'SESSION_LOG_FAILED' });

    expect(environment.actions).toEqual([{ name: 'ACTION2' }]);
    expect(loop.context().observation.state).toBe('WIN');
    expect(loop.status()).toMatchObject({ phase: 'WON', actionCount: 1 });
    expect(core.verifyReceipts()).toMatchObject({ ok: true, count: 1 });
    const checkpoint = await loop.checkpoint();
    expect(checkpoint.observationHash).toBe(loop.context().observation.observationHash);
    expect(checkpoint.archive.outcomes.at(-1)).toMatchObject({
      stopReason: 'ACTION_REJECTED',
      coreReceiptHashes: [checkpoint.coreCheckpoint.receipts[0]!.receiptHash],
    });
  });

  it('rolls back an all-illegal genesis batch and binds injected receipt baselines', async () => {
    const environment = new FakeEnvironment();
    const core = new ArcController(controllerOptions(environment, 'injected-baseline', {
      supervisionGate: 'BLOCKING',
    }));
    const initial = await core.start();
    const preLoop = await core.act({
      expectedObservationHash: initial.observationHash,
      idempotencyKey: 'injected-baseline-0001',
      action: { name: 'ACTION1' },
      expectation: { confidence: 1, expectedFrameHash: initial.currentFrame.frameHash },
    });
    const authority = core.asSupervisor();
    const bundle = authority.openSupervisorCase({
      trigger: 'MODEL_CONTRADICTION',
      evidenceReceiptHashes: [preLoop.receipt.receiptHash],
    })!;
    await authority.commitSupervisorDirective({
      ...defaultSupervisorCommit(bundle.case, bundle.observation.observationHash),
      prohibitedEdges: [observableEdgeKey(bundle.observation.observationHash, {
        name: 'ACTION1',
      })],
    });
    const loop = new ArcAvoLoop({
      controller: core,
      config: { arm: 'AVO_SUPERVISOR_MEMORY' },
    });
    const context = await loop.start();
    await expect(loop.stepWithCandidates([plan(context, {
      key: 'all-illegal-0001',
      action: { name: 'ACTION1' },
      parentCandidateId: null,
      hypothesis: 'This genesis option is prohibited',
    })])).rejects.toMatchObject({ code: 'NO_LEGAL_CANDIDATE' });
    expect(loop.context().recentCandidates).toEqual([]);

    const recovered = await loop.stepWithCandidates([plan(context, {
      key: 'all-illegal-retry-0001',
      action: { name: 'ACTION2' },
      parentCandidateId: null,
      hypothesis: 'A legal genesis retry',
    })]);
    expect(recovered.completed).toHaveLength(1);
    const validCheckpoint = await loop.checkpoint();
    expect(validCheckpoint.coreReceiptBaselineCount).toBe(1);
    expect(validCheckpoint.coreReceiptBaselineHeadHash).toBe(preLoop.receipt.receiptHash);

    const activeDirectiveId = core.status().activeDirectiveId!;
    await core.act({
      expectedObservationHash: recovered.context.observation.observationHash,
      idempotencyKey: 'uncited-external-action-0001',
      action: { name: 'ACTION2' },
      expectation: {
        confidence: 1,
        expectedFrameHash: recovered.context.observation.currentFrame.frameHash,
      },
      directiveId: activeDirectiveId,
    });
    await expect(loop.checkpoint()).rejects.toMatchObject({
      code: 'INVALID_AVO_CHECKPOINT',
    });
    expect(environment.actions).toHaveLength(3);
  });

  it('retrodicts every transition, versions rules, deep-clones supervisor input, and resumes bound state', async () => {
    const environment = new FakeEnvironment();
    let supervisorCalls = 0;
    const supervisor = {
      version: 'test-supervisor-v1',
      review: async (bundle: SupervisorCaseBundle) => {
        supervisorCalls++;
        const originalHash = bundle.case.caseHash;
        (bundle.case as { caseHash: string }).caseHash = 'f'.repeat(64);
        return defaultSupervisorCommit(
          { ...bundle.case, caseHash: originalHash },
          bundle.observation.observationHash,
        );
      },
    };
    const options = controllerOptions(environment, 'retrodictive-resume', {
      supervisorThresholds: { noEffectCount: 1, noEffectWindow: 1 },
    });
    const loop = new ArcAvoLoop({
      controllerOptions: options,
      config: { arm: 'AVO_FULL_RETRODICTION' },
      supervisor,
    });
    let context = await loop.start();
    const first = await loop.stepWithCandidates([plan(context, { key: 'retro-step-0001' })]);
    expect(first.retrodictions[0]).toMatchObject({ verdict: 'SUPPORTED', predictionError: 0 });
    expect(first.updatedRules[0]).toMatchObject({ status: 'CANDIDATE', alpha: 2, beta: 1 });

    context = first.context;
    const ruleId = context.memory.rules.at(-1)!.id;
    const second = await loop.stepWithCandidates([plan(context, {
      key: 'retro-step-0002',
      parentCandidateId: context.lineageHeadId,
      citedRuleIds: [ruleId],
      withRule: false,
    })]);
    expect(supervisorCalls).toBe(1);
    expect(second.updatedRules.at(-1)).toMatchObject({ id: ruleId, status: 'ACTIVE', alpha: 3 });
    expect(second.retrodictions).toHaveLength(1);
    expect(loop.status().ruleCount).toBe(2);

    const checkpoint = await loop.checkpoint();
    const replacementEnvironment = new FakeEnvironment(environment.current);
    const replacement = new ArcAvoLoop({
      controllerOptions: controllerOptions(replacementEnvironment, 'retrodictive-resume', {
        supervisorThresholds: { noEffectCount: 1, noEffectWindow: 1 },
      }),
      config: { arm: 'AVO_FULL_RETRODICTION' },
      supervisor,
    });
    const resumed = await replacement.resume(checkpoint);
    expect(resumed.lineageHeadId).toBe(second.context.lineageHeadId);
    expect(resumed.memory.rules).toEqual(second.context.memory.rules);
    expect(resumed.recentRetrodictions).toEqual(second.context.recentRetrodictions);
    expect(replacementEnvironment.resumeCalls).toBe(1);

    const tampered = structuredClone(checkpoint);
    tampered.archive.outcomeHeadHash = 'e'.repeat(64);
    const rejectedEnvironment = new FakeEnvironment(environment.current);
    const rejected = new ArcAvoLoop({
      controllerOptions: controllerOptions(rejectedEnvironment, 'retrodictive-resume', {
        supervisorThresholds: { noEffectCount: 1, noEffectWindow: 1 },
      }),
      config: { arm: 'AVO_FULL_RETRODICTION' },
      supervisor,
    });
    await expect(rejected.resume(tampered)).rejects.toMatchObject({
      code: 'INVALID_AVO_CHECKPOINT',
    });
    expect(rejectedEnvironment.resumeCalls).toBe(0);

    const spliced = structuredClone(checkpoint);
    const record = spliced.worldModel.records.at(-1)! as unknown as {
      action: ArcAction;
      retrodictionHash: string;
      [key: string]: unknown;
    };
    const oldRetrodictionHash = record.retrodictionHash;
    record.action = { name: 'ACTION2' };
    const { retrodictionHash: _retrodictionHash, ...recordBody } = record;
    record.retrodictionHash = hashArcValue(recordBody);
    spliced.worldModel.headHash = record.retrodictionHash;
    const outcome = spliced.archive.outcomes.find(item =>
      item.retrodictionHashes.includes(oldRetrodictionHash))!;
    (outcome as unknown as { retrodictionHashes: string[] }).retrodictionHashes = [
      record.retrodictionHash,
    ];
    rehashAvoEnvelope(spliced);
    const splicedEnvironment = new FakeEnvironment(environment.current);
    const splicedLoop = new ArcAvoLoop({
      controllerOptions: controllerOptions(splicedEnvironment, 'retrodictive-resume', {
        supervisorThresholds: { noEffectCount: 1, noEffectWindow: 1 },
      }),
      config: { arm: 'AVO_FULL_RETRODICTION' },
      supervisor,
    });
    await expect(splicedLoop.resume(spliced)).rejects.toMatchObject({
      code: 'INVALID_AVO_CHECKPOINT',
    });
    expect(splicedEnvironment.resumeCalls).toBe(0);

    const orphaned = structuredClone(checkpoint);
    const lastOutcome = orphaned.archive.outcomes.at(-1)!;
    (lastOutcome as unknown as { retrodictionHashes: string[] }).retrodictionHashes = [];
    rehashAvoEnvelope(orphaned);
    const orphanedEnvironment = new FakeEnvironment(environment.current);
    const orphanedLoop = new ArcAvoLoop({
      controllerOptions: controllerOptions(orphanedEnvironment, 'retrodictive-resume', {
        supervisorThresholds: { noEffectCount: 1, noEffectWindow: 1 },
      }),
      config: { arm: 'AVO_FULL_RETRODICTION' },
      supervisor,
    });
    await expect(orphanedLoop.resume(orphaned)).rejects.toMatchObject({
      code: 'INVALID_AVO_CHECKPOINT',
    });
    expect(orphanedEnvironment.resumeCalls).toBe(0);
  });

  it('rejects rehashed invalid, raw-identity, and orphan archive nodes before resume', async () => {
    const environment = new FakeEnvironment();
    const options = controllerOptions(environment, 'archive-orphan-integrity');
    const loop = new ArcAvoLoop({
      controllerOptions: options,
      config: { arm: 'AVO_FULL' },
    });
    const context = await loop.start();
    await loop.stepWithCandidates([plan(context, { key: 'archive-integrity-step-0001' })]);
    const checkpoint = await loop.checkpoint();

    const expectRejectedBeforeResume = async (forged: ArcAvoCheckpoint): Promise<void> => {
      const replacementEnvironment = new FakeEnvironment(environment.current);
      const replacement = new ArcAvoLoop({
        controllerOptions: controllerOptions(
          replacementEnvironment,
          'archive-orphan-integrity',
        ),
        config: { arm: 'AVO_FULL' },
      });
      await expect(replacement.resume(forged)).rejects.toMatchObject({
        code: 'INVALID_AVO_CHECKPOINT',
      });
      expect(replacementEnvironment.resumeCalls).toBe(0);
    };

    const strictSchemaInvalid = structuredClone(checkpoint);
    (strictSchemaInvalid.archive.candidates as ArcCandidatePlan[]).push(
      forgeCheckpointCandidate(
        strictSchemaInvalid,
        'Candidate with a forbidden extra schema field',
        { unexpectedCheckpointField: true },
      ),
    );
    rehashAvoEnvelope(strictSchemaInvalid);
    await expectRejectedBeforeResume(strictSchemaInvalid);

    const rawIdentity = structuredClone(checkpoint);
    (rawIdentity.archive.candidates as ArcCandidatePlan[]).push(
      forgeCheckpointCandidate(
        rawIdentity,
        'Candidate containing forbidden raw game identity',
        { gameId: 'secret-private-game' },
      ),
    );
    rehashAvoEnvelope(rawIdentity);
    await expectRejectedBeforeResume(rawIdentity);

    const archiveIdentity = structuredClone(checkpoint);
    (archiveIdentity.archive as unknown as Record<string, unknown>).gameTitle =
      'secret-private-game';
    rehashAvoEnvelope(archiveIdentity);
    await expectRejectedBeforeResume(archiveIdentity);

    const strictSelection = structuredClone(checkpoint);
    const selection = strictSelection.archive.selections[0]! as unknown as Record<string, unknown>;
    selection.unexpectedCheckpointField = true;
    const { selectionHash: _selectionHash, ...selectionBodyWithExtra } = selection;
    selection.selectionHash = hashArcValue(selectionBodyWithExtra);
    (strictSelection.archive.outcomes[0] as unknown as { selectionHash: string }).selectionHash =
      selection.selectionHash as string;
    rehashAvoEnvelope(strictSelection);
    await expectRejectedBeforeResume(strictSelection);

    const strictOutcome = structuredClone(checkpoint);
    (strictOutcome.archive.outcomes[0] as unknown as Record<string, unknown>)
      .unexpectedCheckpointField = true;
    rehashAvoEnvelope(strictOutcome);
    await expectRejectedBeforeResume(strictOutcome);

    const orphanCandidate = structuredClone(checkpoint);
    (orphanCandidate.archive.candidates as ArcCandidatePlan[]).push(
      forgeCheckpointCandidate(orphanCandidate, 'Validly hashed but unoffered candidate'),
    );
    rehashAvoEnvelope(orphanCandidate);
    await expectRejectedBeforeResume(orphanCandidate);

    const orphanSelection = structuredClone(checkpoint);
    const forgedCandidate = forgeCheckpointCandidate(
      orphanSelection,
      'Validly hashed candidate offered by an outcome-less selection',
    );
    (orphanSelection.archive.candidates as ArcCandidatePlan[]).push(forgedCandidate);
    const sourceSelection = orphanSelection.archive.selections[0]!;
    const sourceScore = sourceSelection.scores[sourceSelection.selectedCandidateId]!;
    const selectionBody = {
      observationHash: forgedCandidate.baseObservationHash,
      offeredCandidateIds: [forgedCandidate.id],
      eligibleCandidateIds: [forgedCandidate.id],
      rejectionCodes: {},
      scores: { [forgedCandidate.id]: sourceScore },
      selectedCandidateId: forgedCandidate.id,
      configHash: sourceSelection.configHash,
    };
    (orphanSelection.archive.selections as Array<typeof sourceSelection>).push({
      ...selectionBody,
      selectionHash: hashArcValue(selectionBody),
    });
    rehashAvoEnvelope(orphanSelection);
    await expectRejectedBeforeResume(orphanSelection);
  });

  it('rejects fully rehashed checkpoint and world-model schema or identity extensions before resume', async () => {
    const environment = new FakeEnvironment();
    const loop = new ArcAvoLoop({
      controllerOptions: controllerOptions(environment, 'avo-envelope-integrity'),
      config: { arm: 'AVO_FULL_RETRODICTION' },
    });
    const context = await loop.start();
    await loop.stepWithCandidates([plan(context, { key: 'avo-envelope-integrity-0001' })]);
    const checkpoint = await loop.checkpoint();
    expect(checkpoint.worldModel.records).toHaveLength(1);

    const expectWorldLoadRejected = (forged: ArcAvoCheckpoint): void => {
      const model = new EvidenceRetrodictiveWorldModel(
        resolveArcAvoConfig({ arm: 'AVO_FULL_RETRODICTION' }),
      );
      let rejection: unknown;
      try {
        model.load(forged.worldModel);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({ code: 'INVALID_AVO_CHECKPOINT' });
    };

    const expectRejectedBeforeResume = async (forged: ArcAvoCheckpoint): Promise<void> => {
      const replacementEnvironment = new FakeEnvironment(environment.current);
      const replacement = new ArcAvoLoop({
        controllerOptions: controllerOptions(
          replacementEnvironment,
          'avo-envelope-integrity',
        ),
        config: { arm: 'AVO_FULL_RETRODICTION' },
      });
      await expect(replacement.resume(forged)).rejects.toMatchObject({
        code: 'INVALID_AVO_CHECKPOINT',
      });
      expect(replacementEnvironment.resumeCalls).toBe(0);
    };

    const checkpointExtra = structuredClone(checkpoint);
    (checkpointExtra as unknown as Record<string, unknown>).unexpectedCheckpointField = true;
    rehashAvoEnvelope(checkpointExtra);
    await expectRejectedBeforeResume(checkpointExtra);

    const checkpointIdentity = structuredClone(checkpoint);
    (checkpointIdentity as unknown as Record<string, unknown>).gameTitle = 'private-game-title';
    rehashAvoEnvelope(checkpointIdentity);
    await expectRejectedBeforeResume(checkpointIdentity);

    const worldExtra = structuredClone(checkpoint);
    (worldExtra.worldModel as unknown as Record<string, unknown>).unexpectedWorldField = true;
    rehashAvoEnvelope(worldExtra);
    expectWorldLoadRejected(worldExtra);
    await expectRejectedBeforeResume(worldExtra);

    const worldIdentity = structuredClone(checkpoint);
    (worldIdentity.worldModel as unknown as Record<string, unknown>).gameId = 'private-game-id';
    rehashAvoEnvelope(worldIdentity);
    expectWorldLoadRejected(worldIdentity);
    await expectRejectedBeforeResume(worldIdentity);

    const recordExtra = structuredClone(checkpoint);
    (recordExtra.worldModel.records[0] as unknown as Record<string, unknown>)
      .unexpectedRetrodictionField = true;
    rehashAvoRetrodictions(recordExtra);
    rehashAvoEnvelope(recordExtra);
    expectWorldLoadRejected(recordExtra);
    await expectRejectedBeforeResume(recordExtra);

    const recordIdentity = structuredClone(checkpoint);
    (recordIdentity.worldModel.records[0] as unknown as Record<string, unknown>)
      .gameName = 'private-game-name';
    rehashAvoRetrodictions(recordIdentity);
    rehashAvoEnvelope(recordIdentity);
    expectWorldLoadRejected(recordIdentity);
    await expectRejectedBeforeResume(recordIdentity);
  });

  it('rejects fully rehashed duplicate, oversized, stale-base, and reordered archives before resume', async () => {
    const environment = new FakeEnvironment();
    const loop = new ArcAvoLoop({
      controllerOptions: controllerOptions(environment, 'avo-chronology-integrity'),
      // DIRECT_ACTOR exposes a configured maximum for manifest parity, but its
      // runtime-realizable effective batch cap is one.
      config: { arm: 'DIRECT_ACTOR', maxCandidatesPerDecision: 8 },
    });
    let context = await loop.start();
    context = (await loop.stepWithCandidates([plan(context, {
      key: 'avo-chronology-integrity-0001',
      withRule: false,
    })])).context;
    await loop.stepWithCandidates([{
      ...plan(context, {
        key: 'avo-chronology-integrity-0002',
        withRule: false,
      }),
      parentCandidateId: null,
    }]);
    const checkpoint = await loop.checkpoint();
    expect(checkpoint.archive.selections).toHaveLength(2);
    expect(checkpoint.archive.outcomes).toHaveLength(2);

    const expectRejectedBeforeResume = async (forged: ArcAvoCheckpoint): Promise<void> => {
      const replacementEnvironment = new FakeEnvironment(environment.current);
      const replacement = new ArcAvoLoop({
        controllerOptions: controllerOptions(
          replacementEnvironment,
          'avo-chronology-integrity',
        ),
        config: { arm: 'DIRECT_ACTOR', maxCandidatesPerDecision: 8 },
      });
      await expect(replacement.resume(forged)).rejects.toMatchObject({
        code: 'INVALID_AVO_CHECKPOINT',
      });
      expect(replacementEnvironment.resumeCalls).toBe(0);
    };

    const duplicateCandidate = structuredClone(checkpoint);
    (duplicateCandidate.archive.candidates as ArcCandidatePlan[]).push(
      structuredClone(duplicateCandidate.archive.candidates[0]!),
    );
    rehashAvoEnvelope(duplicateCandidate);
    await expectRejectedBeforeResume(duplicateCandidate);

    const addOfferedCandidate = (
      forged: ArcAvoCheckpoint,
      candidate: ArcCandidatePlan,
    ): void => {
      (forged.archive.candidates as ArcCandidatePlan[]).push(candidate);
      const selection = forged.archive.selections[0]! as unknown as {
        offeredCandidateIds: string[];
        eligibleCandidateIds: string[];
        scores: Record<string, unknown>;
        selectedCandidateId: string;
      };
      selection.offeredCandidateIds.push(candidate.id);
      selection.eligibleCandidateIds.push(candidate.id);
      selection.scores[candidate.id] = structuredClone(
        selection.scores[selection.selectedCandidateId],
      );
    };

    const oversizedSelection = structuredClone(checkpoint);
    addOfferedCandidate(
      oversizedSelection,
      forgeCheckpointCandidate(oversizedSelection, 'Extra offered candidate one'),
    );
    addOfferedCandidate(
      oversizedSelection,
      forgeCheckpointCandidate(oversizedSelection, 'Extra offered candidate two'),
    );
    rehashAvoSelections(oversizedSelection);
    await expectRejectedBeforeResume(oversizedSelection);

    const staleOfferedBase = structuredClone(checkpoint);
    const staleHash = 'd'.repeat(64);
    const sourceSteps = structuredClone(staleOfferedBase.archive.candidates[0]!.steps);
    sourceSteps[0] = { ...sourceSteps[0]!, expectedObservationHash: staleHash };
    addOfferedCandidate(
      staleOfferedBase,
      forgeCheckpointCandidate(
        staleOfferedBase,
        'Offered candidate based on another observation',
        { baseObservationHash: staleHash, steps: sourceSteps },
      ),
    );
    rehashAvoSelections(staleOfferedBase);
    await expectRejectedBeforeResume(staleOfferedBase);

    const reorderedSelections = structuredClone(checkpoint);
    (reorderedSelections.archive.selections as Array<unknown>).reverse();
    rehashAvoEnvelope(reorderedSelections);
    await expectRejectedBeforeResume(reorderedSelections);

    const reorderedReceipts = structuredClone(checkpoint);
    const firstHashes = reorderedReceipts.archive.outcomes[0]!.coreReceiptHashes as string[];
    const secondHashes = reorderedReceipts.archive.outcomes[1]!.coreReceiptHashes as string[];
    [firstHashes[0], secondHashes[0]] = [secondHashes[0]!, firstHashes[0]!];
    rehashAvoEnvelope(reorderedReceipts);
    await expectRejectedBeforeResume(reorderedReceipts);
  });

  it('migrates legacy semantic rules that predate neutral proposal evidence', async () => {
    const environment = new FakeEnvironment();
    const source = new ArcController(controllerOptions(environment, 'legacy-rule-checkpoint'));
    const initial = await source.start();
    const transition = await source.act({
      expectedObservationHash: initial.observationHash,
      idempotencyKey: 'legacy-rule-action-0001',
      action: { name: 'ACTION1' },
      expectation: { confidence: 1, expectedFrameHash: initial.currentFrame.frameHash },
    });
    await source.commitMemoryRule({
      scope: 'GAME',
      kind: 'TRANSITION',
      statement: 'Legacy supported rule',
      predictedEffect: 'The frame remains stable',
      supportingReceiptHashes: [transition.receipt.receiptHash],
      status: 'CANDIDATE',
    });
    const legacy = structuredClone(await source.checkpoint());
    const legacyRule = legacy.memory.rules[0]! as unknown as {
      proposalReceiptHashes?: string[];
      ruleHash: string;
      [key: string]: unknown;
    };
    delete legacyRule.proposalReceiptHashes;
    const { ruleHash: _ruleHash, ...legacyRuleBody } = legacyRule;
    legacyRule.ruleHash = hashArcValue(legacyRuleBody);
    legacy.memorySnapshotHash = memorySnapshotHashFor({
      principalScope: legacy.principalScope,
      opaqueGameScope: legacy.opaqueGameScope,
      runId: legacy.runId,
    }, legacy.episodes, legacy.memory);
    const { checkpointHash: _checkpointHash, ...legacyBody } = legacy;
    legacy.checkpointHash = hashArcValue(legacyBody);

    const replacementEnvironment = new FakeEnvironment(environment.current);
    const replacement = new ArcController(controllerOptions(
      replacementEnvironment,
      'legacy-rule-checkpoint',
    ));
    await replacement.resume(legacy);
    expect(replacement.queryMemory().rules[0]!.proposalReceiptHashes).toEqual([]);
    const migrated = await replacement.checkpoint();
    expect(migrated.memory.rules[0]!.proposalReceiptHashes).toEqual([]);
  });

  it('preserves legacy advisory supervision and does not close an injected controller', async () => {
    const environment = new FakeEnvironment();
    const core = new ArcController(controllerOptions(environment, 'legacy-advisory', {
      supervisorThresholds: { noEffectCount: 1, noEffectWindow: 1 },
    }));
    const initial = await core.start();
    await core.act({
      expectedObservationHash: initial.observationHash,
      idempotencyKey: 'legacy-action-0001',
      action: { name: 'ACTION1' },
      expectation: { confidence: 1, expectedFrameHash: initial.currentFrame.frameHash },
    });
    expect(core.status().openSupervisorCaseId).toBeDefined();
    await expect(core.act({
      expectedObservationHash: initial.observationHash,
      idempotencyKey: 'legacy-action-0002',
      action: { name: 'ACTION1' },
      expectation: { confidence: 1, expectedFrameHash: initial.currentFrame.frameHash },
    })).resolves.toBeDefined();

    const loop = new ArcAvoLoop({ controller: core, config: { arm: 'DIRECT_ACTOR' } });
    await loop.start();
    await loop.close();
    expect(environment.closeCalls).toBe(0);
    await core.close();
    expect(environment.closeCalls).toBe(1);
  });
});
