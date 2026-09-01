// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createArcController,
  type ArcAction,
  type ArcCandidatePlanDraft,
  type ArcEnvironment,
  type RawArcObservation,
} from '@metaharness/arc-agi-3';
import { ArcEpisodeStore } from '../src/store.js';
import { MemoryAuditSink, opaqueAuditHash } from '../src/audit.js';
import { startArcMcpServer } from '../src/server.js';
import { toolNamesForLane } from '../src/tools.js';
import type { ArcControllerFactory } from '../src/types.js';
import {
  ACTOR_TOKEN,
  BOSS_TOKEN,
  HASH,
  createFactoryFixture,
  toolPayload,
} from './helpers.js';

async function connect(url: URL, token: string): Promise<Client> {
  const client = new Client(
    { name: 'arc-avo-chatgpt-test', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

function candidate(
  observationHash: string,
  parentCandidateId: string | null,
  idempotencyPrefix: string,
  steps = 1,
  exactHashChain = false,
): ArcCandidatePlanDraft {
  return {
    parentCandidateId,
    baseObservationHash: observationHash,
    hypothesis: `ACTION1 tests visible transition ${idempotencyPrefix}`,
    citedRuleIds: [],
    ruleHypotheses: [{
      scope: 'LEVEL',
      kind: 'TRANSITION',
      statement: `ACTION1 may change the visible state ${idempotencyPrefix}`,
      preconditions: ['The current exact frame is visible'],
      predictedEffect: 'A visible state transition or a falsifying no-effect receipt',
    }],
    steps: Array.from({ length: steps }, (_, index) => ({
      expectedObservationHash: observationHash,
      idempotencyKey: `${idempotencyPrefix}-core-${index}`,
      action: { name: 'ACTION1' as const },
      expectation: { confidence: 0.6, expectedState: 'NOT_FINISHED' as const },
      postcondition: exactHashChain
        ? { expectedObservationHash: observationHash }
        : { state: 'NOT_FINISHED' as const },
    })),
  };
}

function candidateForAction(
  observationHash: string,
  parentCandidateId: string | null,
  idempotencyPrefix: string,
  action: ArcAction,
  postconditionState: 'NOT_FINISHED' | 'WIN' = 'NOT_FINISHED',
): ArcCandidatePlanDraft {
  return {
    parentCandidateId,
    baseObservationHash: observationHash,
    hypothesis: `${action.name} tests visible transition ${idempotencyPrefix}`,
    citedRuleIds: [],
    ruleHypotheses: [{
      scope: 'LEVEL',
      kind: 'TRANSITION',
      statement: `${action.name} may change the visible state ${idempotencyPrefix}`,
      preconditions: ['The current exact frame is visible'],
      predictedEffect: 'A visible state transition or a falsifying no-effect receipt',
    }],
    steps: [{
      expectedObservationHash: observationHash,
      idempotencyKey: `${idempotencyPrefix}-core`,
      action,
      expectation: { confidence: 0.6, expectedState: 'NOT_FINISHED' },
      postcondition: { state: postconditionState },
    }],
  };
}

describe('opt-in ChatGPT AVO MCP surface', () => {
  it('rejects an attested factory profile that differs from the registered actor surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arc-chatgpt-avo-profile-'));
    const fixture = createFactoryFixture();
    const mismatchedFactory = Object.assign(fixture.factory, {
      actorProfile: Object.freeze({
        mode: 'legacy' as const,
        toolNames: Object.freeze([...toolNamesForLane('actor', 'legacy')]),
      }),
    }) as ArcControllerFactory;
    try {
      await expect(startArcMcpServer({
        controllerFactory: mismatchedFactory,
        stateRoot: root,
        port: 0,
        avo: { arm: 'AVO_FULL' },
        auth: {
          bearerPrincipals: [
            { token: ACTOR_TOKEN, principalId: 'profile-operator', lanes: ['actor'] },
          ],
        },
      })).rejects.toThrow(/actor profile does not match/);
      expect(fixture.calls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports the DIRECT_ACTOR ablation without lineage or rule-memory fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arc-chatgpt-avo-direct-'));
    const fixture = createFactoryFixture();
    const started = await startArcMcpServer({
      controllerFactory: fixture.factory,
      stateRoot: root,
      port: 0,
      audit: new MemoryAuditSink(),
      avo: { arm: 'DIRECT_ACTOR', maxCandidatesPerDecision: 1 },
      auth: {
        bearerPrincipals: [
          { token: ACTOR_TOKEN, principalId: 'direct-operator', lanes: ['actor'] },
        ],
      },
      policy: { maxToolCallsPerMinute: 1_000 },
    });
    const actor = await connect(started.actorUrl, ACTOR_TOKEN);
    try {
      const opened = toolPayload(await actor.callTool({
        name: 'arc_start',
        arguments: { idempotencyKey: 'direct-ablation-start' },
      }));
      const episodeId = opened.episodeId as string;
      const context = opened.avoContext as {
        config: {
          maxCandidatesPerDecision: number;
          features: { planLineage: boolean; semanticRuleMemory: boolean };
        };
        observation: { observationHash: string };
      };
      expect(context.config).toMatchObject({
        maxCandidatesPerDecision: 1,
        features: { planLineage: false, semanticRuleMemory: false },
      });
      const result = toolPayload(await actor.callTool({
        name: 'arc_avo_step',
        arguments: {
          episodeId,
          idempotencyKey: 'direct-ablation-outer-step',
          candidates: [{
            parentCandidateId: null,
            baseObservationHash: context.observation.observationHash,
            hypothesis: 'ACTION1 tests the only direct candidate.',
            citedRuleIds: [],
            ruleHypotheses: [],
            steps: [{
              expectedObservationHash: context.observation.observationHash,
              idempotencyKey: 'direct-ablation-inner-step',
              action: { name: 'ACTION1' },
              expectation: { confidence: 0.5, expectedState: 'NOT_FINISHED' },
              postcondition: { state: 'NOT_FINISHED' },
            }],
          }],
        },
      }));
      expect((result.result as { completed: unknown[] }).completed).toHaveLength(1);
      expect(fixture.environments[0]?.stepCalls).toBe(1);
    } finally {
      await Promise.allSettled([actor.close()]);
      await started.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes raw mutation bypasses, validates exact candidates, and preserves lineage on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arc-chatgpt-avo-'));
    const fixture = createFactoryFixture();
    const started = await startArcMcpServer({
      controllerFactory: fixture.factory,
      stateRoot: root,
      port: 0,
      audit: new MemoryAuditSink(),
      avo: { arm: 'AVO_FULL' },
      auth: {
        bearerPrincipals: [
          { token: ACTOR_TOKEN, principalId: 'avo-operator', lanes: ['actor'] },
          { token: BOSS_TOKEN, principalId: 'avo-operator', lanes: ['boss'] },
        ],
      },
      policy: { maxToolCallsPerMinute: 1_000 },
    });
    const actor = await connect(started.actorUrl, ACTOR_TOKEN);
    try {
      const listed = await actor.listTools();
      const names = listed.tools.map(tool => tool.name);
      expect([...names].sort()).toEqual([...toolNamesForLane('actor', 'avo')].sort());
      expect(listed.tools.find(tool => tool.name === 'arc_avo_step')?.annotations)
        .toEqual(expect.objectContaining({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        }));
      expect(names).not.toEqual(expect.arrayContaining([
        'arc_act',
        'arc_observe',
        'arc_supervise',
        'arc_execute_guarded_plan',
        'arc_memory_commit',
      ]));

      const start = toolPayload(await actor.callTool({
        name: 'arc_start',
        arguments: { idempotencyKey: 'avo-surface-start' },
      }));
      const episodeId = start.episodeId as string;
      const startContext = start.avoContext as { observation: { observationHash: string } };
      const firstDraft = candidate(
        startContext.observation.observationHash,
        null,
        'avo-first-step',
      );
      const callsBeforeInvalid = fixture.environments[0]!.stepCalls;
      const invalid = await actor.callTool({
        name: 'arc_avo_step',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-invalid-candidate',
          candidates: [{ ...firstDraft, utility: 1 }],
        },
      });
      expect(invalid.isError).toBe(true);
      expect(fixture.environments[0]!.stepCalls).toBe(callsBeforeInvalid);
      const bypass = await actor.callTool({
        name: 'arc_act',
        arguments: {},
      });
      expect(bypass.isError).toBe(true);
      expect(fixture.environments[0]!.stepCalls).toBe(callsBeforeInvalid);

      const first = toolPayload(await actor.callTool({
        name: 'arc_avo_step',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-first-mcp-step',
          candidates: [firstDraft],
        },
      }));
      const firstResult = first.result as {
        candidate: { id: string };
        context: { observation: { observationHash: string }; recentOutcomes: unknown[] };
      };
      expect(firstResult.context.recentOutcomes).toHaveLength(1);

      const saved = toolPayload(await actor.callTool({
        name: 'arc_checkpoint',
        arguments: { episodeId, idempotencyKey: 'avo-checkpoint-save' },
      }));
      expect(saved.checkpointHash).toMatch(/^[a-f0-9]{64}$/);
      const descriptor = JSON.parse(await readFile(join(
        root,
        `principal_${opaqueAuditHash('avo-operator')}`,
        episodeId,
        'checkpoints',
        `${saved.checkpointId as string}.json`,
      ), 'utf8')) as {
        schema: string;
        checkpoint: { archive: Record<string, unknown>; worldModel: Record<string, unknown> };
        candidateObjectHashes: string[];
        selectionObjectHashes: string[];
        outcomeObjectHashes: string[];
      };
      expect(descriptor.schema).toBe('metaharness.arc_mcp.avo_checkpoint_ref.v2');
      expect(descriptor.checkpoint.archive).not.toHaveProperty('candidates');
      expect(descriptor.checkpoint.archive).not.toHaveProperty('selections');
      expect(descriptor.checkpoint.archive).not.toHaveProperty('outcomes');
      expect(descriptor.checkpoint.worldModel).not.toHaveProperty('records');
      expect(descriptor.candidateObjectHashes).toHaveLength(1);
      expect(descriptor.selectionObjectHashes).toHaveLength(1);
      expect(descriptor.outcomeObjectHashes).toHaveLength(1);
      const resumed = toolPayload(await actor.callTool({
        name: 'arc_resume',
        arguments: {
          episodeId,
          checkpointId: saved.checkpointId,
          expectedCheckpointHash: saved.checkpointHash,
          idempotencyKey: 'avo-checkpoint-resume',
        },
      }));
      const resumedContext = resumed.avoContext as {
        lineageHeadId: string;
        recentCandidates: Array<{ id: string }>;
        recentOutcomes: unknown[];
        observation: { observationHash: string };
      };
      expect(resumedContext.lineageHeadId).toBe(firstResult.candidate.id);
      expect(resumedContext.recentCandidates.map(item => item.id))
        .toContain(firstResult.candidate.id);
      expect(resumedContext.recentOutcomes).toHaveLength(1);

      const conflictingResume = await actor.callTool({
        name: 'arc_resume',
        arguments: {
          episodeId,
          checkpointId: saved.checkpointId,
          expectedCheckpointHash: '0'.repeat(64),
          idempotencyKey: 'avo-checkpoint-conflicting-hash',
        },
      });
      expect(conflictingResume.isError).toBe(true);
      expect(fixture.calls).toBe(2);

      const second = toolPayload(await actor.callTool({
        name: 'arc_avo_step',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-second-mcp-step',
          candidates: [candidate(
            resumedContext.observation.observationHash,
            resumedContext.lineageHeadId,
            'avo-second-step',
          )],
        },
      }));
      const secondContext = (second.result as { context: {
        recentCandidates: unknown[];
        recentOutcomes: unknown[];
      } }).context;
      expect(secondContext.recentCandidates).toHaveLength(2);
      expect(secondContext.recentOutcomes).toHaveLength(2);
      expect(fixture.calls).toBe(2);
    } finally {
      await Promise.allSettled([actor.close()]);
      await started.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks a mid-plan second action until the separate boss commits a directive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arc-chatgpt-avo-supervisor-'));
    class NoEffectEnvironment implements ArcEnvironment {
      stepCalls = 0;

      private observation(): RawArcObservation {
        return {
          state: 'NOT_FINISHED',
          levelsCompleted: 0,
          winLevels: 1,
          availableActions: ['ACTION1'],
          frames: [{ width: 1, height: 1, cells: [[0]], frameIndex: this.stepCalls }],
        };
      }

      async reset(): Promise<RawArcObservation> {
        this.stepCalls = 0;
        return this.observation();
      }

      async observe(): Promise<RawArcObservation> { return this.observation(); }

      async step(_action: ArcAction): Promise<RawArcObservation> {
        this.stepCalls += 1;
        return this.observation();
      }

      async checkpoint(): Promise<{ stepCalls: number }> { return { stepCalls: this.stepCalls }; }

      async resume(value: { stepCalls?: number }): Promise<RawArcObservation> {
        this.stepCalls = value.stepCalls ?? 0;
        return this.observation();
      }
    }
    const environments: NoEffectEnvironment[] = [];
    const requestedGates: Array<'OFF' | 'BLOCKING' | undefined> = [];
    const factory = (async ({ principalId, runId, requestedSupervisionGate }) => {
      const environment = new NoEffectEnvironment();
      environments.push(environment);
      requestedGates.push(requestedSupervisionGate);
      return createArcController({
        principalId,
        runId,
        gameVersionHash: 'f'.repeat(64),
        environment,
        runManifest: {
          visibleModelLabel: 'ChatGPT AVO supervision test',
          promptSnapshotHash: HASH,
          toolSchemaHash: HASH,
          environmentAdapterVersion: '@metaharness/arc-agi-3/test@0.1.0',
        },
        budget: { maxActions: 20, maxWallTimeMs: 60_000 },
        supervisionGate: requestedSupervisionGate,
        supervisorThresholds: { noEffectCount: 1, noEffectWindow: 1 },
      });
    }) as ArcControllerFactory;
    const started = await startArcMcpServer({
      controllerFactory: factory,
      stateRoot: root,
      port: 0,
      audit: new MemoryAuditSink(),
      avo: { arm: 'AVO_FULL' },
      auth: {
        bearerPrincipals: [
          { token: ACTOR_TOKEN, principalId: 'supervised-operator', lanes: ['actor'] },
          { token: BOSS_TOKEN, principalId: 'supervised-operator', lanes: ['boss'] },
        ],
      },
      policy: { maxToolCallsPerMinute: 1_000 },
    });
    const actor = await connect(started.actorUrl, ACTOR_TOKEN);
    const boss = await connect(started.bossUrl, BOSS_TOKEN);
    try {
      const startedEpisode = toolPayload(await actor.callTool({
        name: 'arc_start',
        arguments: { idempotencyKey: 'avo-supervised-start' },
      }));
      const episodeId = startedEpisode.episodeId as string;
      const observationHash = (
        startedEpisode.avoContext as { observation: { observationHash: string } }
      ).observation.observationHash;
      const first = toolPayload(await actor.callTool({
        name: 'arc_avo_step',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-mid-plan-step',
          candidates: [candidate(observationHash, null, 'avo-mid-plan', 2, true)],
        },
      }));
      const firstResult = first.result as {
        candidate: { id: string };
        completed: unknown[];
        stopReason: string;
        context: { observation: { observationHash: string }; status: { openSupervisorCaseId?: string } };
      };
      expect(firstResult.completed).toHaveLength(1);
      expect(firstResult.stopReason).toBe('ACTION_REJECTED');
      expect(firstResult.context.status.openSupervisorCaseId).toBeTruthy();
      expect(requestedGates).toEqual(['BLOCKING']);
      expect(environments[0]!.stepCalls).toBe(1);

      const replayed = toolPayload(await actor.callTool({
        name: 'arc_avo_step',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-mid-plan-step',
          candidates: [candidate(observationHash, null, 'avo-mid-plan', 2, true)],
        },
      }));
      expect(replayed.mcpReplayed).toBe(true);
      expect(environments[0]!.stepCalls).toBe(1);

      const blocked = await actor.callTool({
        name: 'arc_avo_step',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-blocked-without-boss',
          candidates: [candidate(
            firstResult.context.observation.observationHash,
            firstResult.candidate.id,
            'avo-blocked',
          )],
        },
      });
      expect(blocked.isError).toBe(true);
      expect(environments[0]!.stepCalls).toBe(1);

      const bossView = toolPayload(await boss.callTool({
        name: 'arc_supervisor_case',
        arguments: { episodeId },
      }));
      const bundle = bossView.caseBundle as {
        case: { id: string; caseHash: string; evidenceReceiptHashes: string[] };
        observation: { observationHash: string };
      };
      const hypothesis = (index: number) => ({
        hypothesis: `No-effect explanation ${index}`,
        evidenceReceiptHashes: bundle.case.evidenceReceiptHashes,
        falsifier: `A visible change on guarded probe ${index}`,
        proposedNextAction: { name: 'ACTION1' as const },
      });
      const committed = await boss.callTool({
        name: 'arc_supervisor_directive_commit',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-boss-directive',
          directive: {
            caseId: bundle.case.id,
            caseHash: bundle.case.caseHash,
            observationHash: bundle.observation.observationHash,
            mode: 'CONTINUE',
            diagnosis: 'The first action had no visible effect',
            requiredEvidence: bundle.case.evidenceReceiptHashes,
            actionBudget: 1,
            expiresAfterActions: 1,
            hypotheses: [hypothesis(1), hypothesis(2), hypothesis(3)],
            recommendedStrategy: 'Run one guarded falsification probe',
            constraints: ['Stop after the bounded probe'],
          },
        },
      });
      expect(committed.isError).not.toBe(true);
      const resumed = await actor.callTool({
        name: 'arc_avo_step',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-after-boss-step',
          candidates: [candidate(
            firstResult.context.observation.observationHash,
            firstResult.candidate.id,
            'avo-after-boss',
          )],
        },
      });
      expect(resumed.isError).not.toBe(true);
      expect(environments[0]!.stepCalls).toBe(2);
    } finally {
      await Promise.allSettled([actor.close(), boss.close()]);
      await started.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renews expired AVO authority before dispatch and preserves MCP retry safety', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arc-chatgpt-avo-expiry-'));
    class ExpiringAuthorityEnvironment implements ArcEnvironment {
      stepCalls = 0;

      private observation(): RawArcObservation {
        return {
          state: 'NOT_FINISHED',
          levelsCompleted: 0,
          winLevels: 1,
          availableActions: ['ACTION1', 'ACTION2'],
          frames: [{ width: 1, height: 1, cells: [[0]] }],
        };
      }

      async reset(): Promise<RawArcObservation> {
        this.stepCalls = 0;
        return this.observation();
      }

      async observe(): Promise<RawArcObservation> { return this.observation(); }

      async step(_action: ArcAction): Promise<RawArcObservation> {
        this.stepCalls += 1;
        return this.observation();
      }

      async checkpoint(): Promise<{ stepCalls: number }> { return { stepCalls: this.stepCalls }; }

      async resume(value: { stepCalls?: number }): Promise<RawArcObservation> {
        this.stepCalls = value.stepCalls ?? 0;
        return this.observation();
      }
    }
    const environments: ExpiringAuthorityEnvironment[] = [];
    const factory = (async ({ principalId, runId, requestedSupervisionGate }) => {
      const environment = new ExpiringAuthorityEnvironment();
      environments.push(environment);
      return createArcController({
        principalId,
        runId,
        gameVersionHash: 'e'.repeat(64),
        environment,
        runManifest: {
          visibleModelLabel: 'ChatGPT AVO expiry test',
          promptSnapshotHash: HASH,
          toolSchemaHash: HASH,
          environmentAdapterVersion: '@metaharness/arc-agi-3/test@0.1.0',
        },
        budget: { maxActions: 20, maxWallTimeMs: 60_000 },
        supervisionGate: requestedSupervisionGate,
        supervisorThresholds: {
          noEffectCount: 10,
          noEffectWindow: 10,
          repeatedEdgeCount: 10,
          stagnationWindow: 10,
          predictionErrorWindow: 10,
        },
      });
    }) as ArcControllerFactory;
    const started = await startArcMcpServer({
      controllerFactory: factory,
      stateRoot: root,
      port: 0,
      audit: new MemoryAuditSink(),
      avo: { arm: 'AVO_FULL' },
      auth: {
        bearerPrincipals: [
          { token: ACTOR_TOKEN, principalId: 'expiry-operator', lanes: ['actor'] },
          { token: BOSS_TOKEN, principalId: 'expiry-operator', lanes: ['boss'] },
        ],
      },
      policy: { maxToolCallsPerMinute: 1_000 },
    });
    const actor = await connect(started.actorUrl, ACTOR_TOKEN);
    const boss = await connect(started.bossUrl, BOSS_TOKEN);
    try {
      const start = toolPayload(await actor.callTool({
        name: 'arc_start',
        arguments: { idempotencyKey: 'avo-expiry-start' },
      }));
      const episodeId = start.episodeId as string;
      const initialObservationHash = (
        start.avoContext as { observation: { observationHash: string } }
      ).observation.observationHash;

      // Deliberately fail a postcondition after one real transition so the
      // external boss lane has an initial evidence-bound case to authorize.
      const divergent = toolPayload(await actor.callTool({
        name: 'arc_avo_step',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-expiry-divergence',
          candidates: [candidateForAction(
            initialObservationHash,
            null,
            'avo-expiry-divergence',
            { name: 'ACTION1' },
            'WIN',
          )],
        },
      }));
      const divergentResult = divergent.result as {
        candidate: { id: string };
        completed: unknown[];
        stopReason: string;
        context: { observation: { observationHash: string } };
      };
      expect(divergentResult.completed).toHaveLength(1);
      expect(divergentResult.stopReason).toBe('DIVERGED');
      expect(environments[0]!.stepCalls).toBe(1);

      const firstBossView = toolPayload(await boss.callTool({
        name: 'arc_supervisor_case',
        arguments: { episodeId },
      }));
      const firstBundle = firstBossView.caseBundle as {
        case: { id: string; caseHash: string; evidenceReceiptHashes: string[] };
        observation: { observationHash: string };
      };
      const hypothesesFor = (
        evidenceReceiptHashes: string[],
        action: ArcAction,
        label: string,
      ) => [1, 2, 3].map(index => ({
        hypothesis: `${label} explanation ${index}`,
        evidenceReceiptHashes,
        falsifier: `${label} falsifier ${index}`,
        proposedNextAction: action,
      }));
      const firstDirective = await boss.callTool({
        name: 'arc_supervisor_directive_commit',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-expiry-first-directive',
          directive: {
            caseId: firstBundle.case.id,
            caseHash: firstBundle.case.caseHash,
            observationHash: firstBundle.observation.observationHash,
            mode: 'CONTINUE',
            diagnosis: 'Run exactly one alternate probe',
            requiredEvidence: firstBundle.case.evidenceReceiptHashes,
            actionBudget: 1,
            expiresAfterActions: 1,
            hypotheses: hypothesesFor(
              firstBundle.case.evidenceReceiptHashes,
              { name: 'ACTION2' },
              'alternate probe',
            ),
            recommendedStrategy: 'Run ACTION2 once, then renew authority',
            constraints: ['One environment action only'],
          },
        },
      });
      expect(firstDirective.isError).not.toBe(true);

      const authorized = toolPayload(await actor.callTool({
        name: 'arc_avo_step',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-expiry-authorized-step',
          candidates: [candidateForAction(
            divergentResult.context.observation.observationHash,
            divergentResult.candidate.id,
            'avo-expiry-authorized',
            { name: 'ACTION2' },
          )],
        },
      }));
      const authorizedResult = authorized.result as {
        candidate: { id: string };
        completed: unknown[];
        context: { observation: { observationHash: string } };
      };
      expect(authorizedResult.completed).toHaveLength(1);
      expect(environments[0]!.stepCalls).toBe(2);

      const expiredArguments = {
        episodeId,
        idempotencyKey: 'avo-expiry-blocked-retry',
        candidates: [candidateForAction(
          authorizedResult.context.observation.observationHash,
          authorizedResult.candidate.id,
          'avo-expiry-blocked',
          { name: 'ACTION1' },
        )],
      };
      const blocked = await actor.callTool({
        name: 'arc_avo_step',
        arguments: expiredArguments,
      });
      expect(blocked.isError).toBe(true);
      expect(environments[0]!.stepCalls).toBe(2);

      // Failed pre-dispatch attempts are retryable at the transport boundary,
      // but the unresolved renewal obligation remains authoritative.
      const blockedReplay = await actor.callTool({
        name: 'arc_avo_step',
        arguments: expiredArguments,
      });
      expect(blockedReplay.isError).toBe(true);
      expect(environments[0]!.stepCalls).toBe(2);

      const renewalView = toolPayload(await boss.callTool({
        name: 'arc_supervisor_case',
        arguments: { episodeId },
      }));
      const renewalBundle = renewalView.caseBundle as {
        case: {
          id: string;
          caseHash: string;
          trigger: string;
          evidenceReceiptHashes: string[];
          metrics: Record<string, number>;
        };
        observation: { observationHash: string };
      };
      expect(renewalBundle.case.trigger).toBe('MODEL_CONTRADICTION');
      expect(renewalBundle.case.metrics.directiveExpired).toBe(1);
      expect(renewalBundle.case.evidenceReceiptHashes).toHaveLength(1);

      const renewedDirective = await boss.callTool({
        name: 'arc_supervisor_directive_commit',
        arguments: {
          episodeId,
          idempotencyKey: 'avo-expiry-renewed-directive',
          directive: {
            caseId: renewalBundle.case.id,
            caseHash: renewalBundle.case.caseHash,
            observationHash: renewalBundle.observation.observationHash,
            mode: 'CONTINUE',
            diagnosis: 'Renew one bounded probe after directive expiry',
            requiredEvidence: renewalBundle.case.evidenceReceiptHashes,
            actionBudget: 1,
            expiresAfterActions: 1,
            hypotheses: hypothesesFor(
              renewalBundle.case.evidenceReceiptHashes,
              { name: 'ACTION1' },
              'renewed probe',
            ),
            recommendedStrategy: 'Run the renewed ACTION1 probe once',
            constraints: ['One renewed environment action only'],
          },
        },
      });
      expect(renewedDirective.isError).not.toBe(true);

      // Reusing the formerly blocked request is safe: it never entered the
      // successful MCP ledger and no candidate/action was committed before.
      const resumed = toolPayload(await actor.callTool({
        name: 'arc_avo_step',
        arguments: expiredArguments,
      }));
      expect((resumed.result as { completed: unknown[] }).completed).toHaveLength(1);
      expect(environments[0]!.stepCalls).toBe(3);

      const successfulReplay = toolPayload(await actor.callTool({
        name: 'arc_avo_step',
        arguments: expiredArguments,
      }));
      expect(successfulReplay.mcpReplayed).toBe(true);
      expect(environments[0]!.stepCalls).toBe(3);
    } finally {
      await Promise.allSettled([actor.close(), boss.close()]);
      await started.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('snapshots untrusted candidate input before asynchronous execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arc-chatgpt-avo-mutation-'));
    const fixture = createFactoryFixture();
    const store = new ArcEpisodeStore(
      fixture.factory,
      root,
      () => new Date(),
      32,
      50_000,
      { arm: 'AVO_FULL' },
    );
    try {
      const created = await store.create('mutation-operator');
      const draft = candidate(
        created.observation.observationHash,
        null,
        'avo-mutation',
      ) as ArcCandidatePlanDraft & { hypothesis: string };
      const originalHypothesis = draft.hypothesis;
      const pending = created.record.avoLoop!.stepWithCandidates([draft]);
      draft.hypothesis = 'mutated after dispatch';
      const result = await pending;
      expect(result.candidate.hypothesis).toBe(originalHypothesis);
      expect(result.candidate.hypothesis).not.toBe(draft.hypothesis);
      expect(fixture.environments[0]!.stepCalls).toBe(1);
    } finally {
      await store.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an injected factory ignores the requested blocking gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arc-chatgpt-avo-gate-mismatch-'));
    const fixture = createFactoryFixture();
    const mismatchedFactory = (async (context) => {
      const controller = await fixture.factory({
        ...context,
        requestedSupervisionGate: 'OFF',
      });
      return controller;
    }) as ArcControllerFactory;
    const store = new ArcEpisodeStore(
      mismatchedFactory,
      root,
      () => new Date(),
      32,
      50_000,
      { arm: 'AVO_FULL' },
    );
    try {
      await expect(store.create('mismatched-gate-operator')).rejects.toThrow(/start failed/);
      expect(fixture.environments).toHaveLength(1);
      expect(fixture.environments[0]!.stepCalls).toBe(0);
      expect(store.sizeForPrincipal('mismatched-gate-operator')).toBe(0);
    } finally {
      await store.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  });
});
