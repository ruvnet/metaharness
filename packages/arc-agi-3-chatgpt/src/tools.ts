// SPDX-License-Identifier: MIT

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod/v3';
import type {
  ActRequest,
  ExplicitSupervisorCaseRequest,
  GuardedPlanRequest,
  MemoryQuery,
  SemanticRuleCommit,
  SupervisorDirectiveCommit,
} from '@metaharness/arc-agi-3';
import type { McpLane } from './types.js';
import { exactPublicJson } from './types.js';
import { NonRetryableMutationError, type ArcEpisodeStore, type EpisodeRecord } from './store.js';
import { ToolPolicyGate } from './policy.js';

export const ARC_WIDGET_URI = 'ui://metaharness/arc-agi-3/canvas';

const episodeId = z.string().regex(/^episode_[A-Za-z0-9_-]{16,128}$/);
const checkpointId = z.string().regex(/^checkpoint_[A-Za-z0-9_-]{16,128}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const idempotencyKey = z.string().regex(/^[\x21-\x7e]{8,200}$/);
const safeNonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const gameState = z.enum(['NOT_PLAYED', 'NOT_FINISHED', 'WIN', 'GAME_OVER']);
const actionName = z.enum([
  'RESET',
  'ACTION1',
  'ACTION2',
  'ACTION3',
  'ACTION4',
  'ACTION5',
  'ACTION6',
  'ACTION7',
]);
const simpleActionName = z.enum([
  'RESET',
  'ACTION1',
  'ACTION2',
  'ACTION3',
  'ACTION4',
  'ACTION5',
  'ACTION7',
]);
const action = z.union([
  z.object({ name: simpleActionName }).strict(),
  z.object({
    name: z.literal('ACTION6'),
    x: z.number().int().min(0).max(63),
    y: z.number().int().min(0).max(63),
  }).strict(),
]);
const cellValue = z.number().int().min(0).max(15);
const expectedChangeCoordinates = {
  x: z.number().int().min(0).max(63),
  y: z.number().int().min(0).max(63),
};
const expectedChange = z.union([
  z.object({
    ...expectedChangeCoordinates,
    before: cellValue,
    after: cellValue.optional(),
  }).strict(),
  z.object({
    ...expectedChangeCoordinates,
    before: cellValue.optional(),
    after: cellValue,
  }).strict(),
]);
const expectationBase = z.object({
  confidence: z.number().min(0).max(1),
  hypothesisIds: z.array(z.string().min(1).max(200)).max(32).optional(),
  expectedObservationHash: sha256.optional(),
  expectedState: gameState.optional(),
  expectedLevelsCompleted: safeNonnegativeInteger.optional(),
  expectedFrameHash: sha256.optional(),
  expectedChanges: z.array(expectedChange).max(512).optional(),
  rationale: z.string().max(1000).optional(),
}).strict();
const expectation = z.union([
  expectationBase.extend({ expectedObservationHash: sha256 }),
  expectationBase.extend({ expectedState: gameState }),
  expectationBase.extend({ expectedLevelsCompleted: safeNonnegativeInteger }),
  expectationBase.extend({ expectedFrameHash: sha256 }),
  expectationBase.extend({ expectedChanges: z.array(expectedChange).min(1).max(512) }),
]);
const actRequest = z.object({
  expectedObservationHash: sha256,
  idempotencyKey,
  action,
  expectation,
  directiveId: z.string().min(1).max(200).optional(),
}).strict();
const postconditionBase = z.object({
  expectedObservationHash: sha256.optional(),
  expectedFrameHash: sha256.optional(),
  state: gameState.optional(),
  levelsCompleted: safeNonnegativeInteger.optional(),
}).strict();
const postcondition = z.union([
  postconditionBase.extend({ expectedObservationHash: sha256 }),
  postconditionBase.extend({ expectedFrameHash: sha256 }),
  postconditionBase.extend({ state: gameState }),
  postconditionBase.extend({ levelsCompleted: safeNonnegativeInteger }),
]);
const guardedStep = actRequest.extend({ postcondition });
const memoryScope = z.enum(['LEVEL', 'GAME', 'GENERIC']);
const memoryKind = z.enum(['ACTION_MAP', 'OBJECT_ROLE', 'TRANSITION', 'GOAL', 'CONSTRAINT', 'STRATEGY']);
const memoryStatus = z.enum(['CANDIDATE', 'ACTIVE', 'FALSIFIED', 'SUPERSEDED']);
const memoryQuery = z.object({
  scope: memoryScope.optional(),
  kind: memoryKind.optional(),
  status: memoryStatus.optional(),
  receiptHash: sha256.optional(),
  text: z.string().max(1000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
const memoryCommit = z.object({
  id: z.string().min(1).max(200).optional(),
  scope: memoryScope,
  kind: memoryKind,
  statement: z.string().min(1).max(4000),
  preconditions: z.array(z.string().min(1).max(1000)).max(64).optional(),
  predictedEffect: z.string().min(1).max(4000),
  supportingReceiptHashes: z.array(sha256).max(256).optional(),
  contradictingReceiptHashes: z.array(sha256).max(256).optional(),
  status: memoryStatus.optional(),
}).strict();
const explicitSupervisorCase = z.object({
  trigger: z.literal('MODEL_CONTRADICTION'),
  evidenceReceiptHashes: z.array(sha256).min(1).max(128),
  metrics: z.record(z.number().finite()).optional(),
}).strict();
const supervisorMode = z.enum([
  'CONTINUE',
  'FALSIFY_RULE',
  'EXPAND_FRONTIER',
  'REBUILD_MODEL',
  'ROLLBACK_PLAN',
  'RESET',
  'NEW_ACTOR_CONTEXT',
  'STOP',
]);
const supervisorHypothesis = z.object({
  hypothesis: z.string().min(1).max(4000),
  evidenceReceiptHashes: z.array(sha256).max(128),
  falsifier: z.string().min(1).max(4000),
  proposedNextAction: action,
}).strict();
const directiveCommit = z.object({
  caseId: z.string().min(1).max(200),
  caseHash: sha256,
  observationHash: sha256,
  mode: supervisorMode,
  diagnosis: z.string().min(1).max(4000),
  requiredEvidence: z.array(sha256).max(64).optional(),
  prohibitedEdges: z.array(z.string().min(1).max(256)).max(128).optional(),
  actionBudget: z.number().int().min(0).max(1000),
  expiresAfterActions: z.number().int().min(0).max(1000),
  hypotheses: z.tuple([
    supervisorHypothesis,
    supervisorHypothesis,
    supervisorHypothesis,
  ]),
  recommendedStrategy: z.string().min(1).max(4000),
  constraints: z.array(z.string().min(1).max(1000)).max(64),
}).strict();

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const MUTATING: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const GUARDED_ENV_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
const GUARDED_ENV_ACCESS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

function structured(value: unknown): CallToolResult {
  const exact = exactPublicJson(value);
  const structuredContent = (
    exact && typeof exact === 'object' && !Array.isArray(exact)
      ? exact
      : { value: exact }
  ) as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function protectedError(): CallToolResult {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: 'ARC operation failed at the protected environment boundary. No hidden assignment details were exposed.',
    }],
  };
}

export interface ArcToolContext {
  lane: McpLane;
  principalId: string;
  store: ArcEpisodeStore;
  policy: ToolPolicyGate;
}

async function invoke(
  context: ArcToolContext,
  tool: string,
  options: { episodeId?: string; readOnly: boolean },
  body: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return structured(await context.policy.run({
      lane: context.lane,
      tool,
      principalId: context.principalId,
      episodeId: options.episodeId,
      readOnly: options.readOnly,
      body,
    }));
  } catch {
    return protectedError();
  }
}

function record(context: ArcToolContext, id: string): EpisodeRecord {
  return context.store.get(context.principalId, id);
}

async function idempotent<T extends Record<string, unknown>>(
  context: ArcToolContext,
  tool: string,
  key: string,
  input: unknown,
  body: () => Promise<T>,
): Promise<T & { mcpReplayed: boolean }> {
  const result = await context.store.runIdempotent({
    principalId: context.principalId,
    tool,
    key,
    input,
    body,
  });
  return { ...result.value, mcpReplayed: result.replayed };
}

function statusWithoutRawError(value: ReturnType<EpisodeRecord['controller']['status']>): Record<string, unknown> {
  const { lastError: _lastError, ...safe } = value;
  return _lastError ? { ...safe, diagnostic: 'environment error redacted' } : safe;
}

function activeDirective(session: EpisodeRecord): EpisodeRecord['lastDirective'] | null {
  const activeId = session.controller.status().activeDirectiveId;
  if (!session.lastDirective || session.lastDirective.id !== activeId) {
    session.lastDirective = undefined;
    return null;
  }
  return session.lastDirective;
}

export function registerActorTools(server: McpServer, context: ArcToolContext): void {
  server.registerTool('arc_start', {
    title: 'Start isolated ARC episode',
    description: 'Start the operator-selected hidden ARC assignment. Takes no game identifier and returns only an opaque game scope plus exact visible state.',
    inputSchema: { idempotencyKey },
    annotations: GUARDED_ENV_WRITE,
  }, async ({ idempotencyKey: key }) => invoke(context, 'arc_start', { readOnly: false }, async () => (
    idempotent(context, 'arc_start', key, {}, async () => {
      const created = await context.store.create(context.principalId);
      return {
        episodeId: created.record.episodeId,
        opaqueGameScope: created.observation.opaqueGameScope,
        observation: created.observation,
        status: statusWithoutRawError(created.record.controller.status()),
      };
    })
  )));

  server.registerTool('arc_observe', {
    title: 'Observe exact ARC state',
    description: 'Read the authoritative current observation. Call this first when entering an existing actor conversation.',
    inputSchema: { episodeId },
    annotations: GUARDED_ENV_ACCESS,
  }, async ({ episodeId: id }) => invoke(context, 'arc_observe', { episodeId: id, readOnly: false }, async () => {
    const session = record(context, id);
    const observation = await session.controller.observe();
    context.store.updateObservation(session, observation);
    return {
      episodeId: id,
      observation,
      status: statusWithoutRawError(session.controller.status()),
      activeSupervisorDirective: activeDirective(session),
    };
  }));

  server.registerTool('arc_act', {
    title: 'Apply one guarded ARC action',
    description: 'Apply exactly one legal action using compare-and-set observation hash and an idempotency key. RESET is accepted only when no live progress can be discarded.',
    inputSchema: { episodeId, request: actRequest },
    annotations: GUARDED_ENV_WRITE,
  }, async ({ episodeId: id, request }) => invoke(context, 'arc_act', { episodeId: id, readOnly: false }, async () => {
    return idempotent(context, 'arc_act', request.idempotencyKey, { episodeId: id, request }, async () => {
      const session = record(context, id);
      const result = await session.controller.act(request as ActRequest);
      context.store.updateObservation(session, result.observation);
      return { episodeId: id, ...result };
    });
  }));

  server.registerTool('arc_supervise', {
    title: 'Open deterministic supervisor case',
    description: 'Persist a deterministic supervisor case after a plateau, loop, contradiction, or repeated failure. This does not act in the environment.',
    inputSchema: { episodeId, idempotencyKey, contradiction: explicitSupervisorCase.optional() },
    annotations: MUTATING,
  }, async ({ episodeId: id, idempotencyKey: key, contradiction }) => invoke(context, 'arc_supervise', { episodeId: id, readOnly: false }, async () => (
    idempotent(context, 'arc_supervise', key, { episodeId: id, contradiction }, async () => {
      const session = record(context, id);
      const bundle = session.controller.openSupervisorCase(
        contradiction as ExplicitSupervisorCaseRequest | undefined,
      );
      session.lastSupervisorCase = bundle ?? undefined;
      return {
        episodeId: id,
        caseBundle: bundle,
        status: statusWithoutRawError(session.controller.status()),
      };
    })
  )));

  server.registerTool('arc_checkpoint', {
    title: 'Persist ARC checkpoint',
    description: 'Atomically persist a bounded checkpoint under the configured state root and return only opaque handles and integrity hash.',
    inputSchema: { episodeId, idempotencyKey },
    annotations: GUARDED_ENV_ACCESS,
  }, async ({ episodeId: id, idempotencyKey: key }) => invoke(context, 'arc_checkpoint', { episodeId: id, readOnly: false }, async () => (
    idempotent(context, 'arc_checkpoint', key, { episodeId: id }, async () => {
      const session = record(context, id);
      const checkpoint = await session.controller.checkpoint();
      const idForCheckpoint = await context.store.saveCheckpoint(session, checkpoint);
      return {
        episodeId: id,
        checkpointId: idForCheckpoint,
        checkpointHash: checkpoint.checkpointHash,
        observationHash: session.lastObservation.observationHash,
      };
    })
  )));

  server.registerTool('arc_resume', {
    title: 'Resume ARC checkpoint',
    description: 'Restore an opaque durable checkpoint for this authenticated principal. This replaces the live episode state.',
    inputSchema: { episodeId, checkpointId, expectedCheckpointHash: sha256, idempotencyKey },
    annotations: { ...GUARDED_ENV_WRITE, idempotentHint: true },
  }, async ({ episodeId: id, checkpointId: checkpoint, expectedCheckpointHash, idempotencyKey: key }) => invoke(context, 'arc_resume', { episodeId: id, readOnly: false }, async () => (
    idempotent(context, 'arc_resume', key, { episodeId: id, checkpointId: checkpoint, expectedCheckpointHash }, async () => {
      const resumed = await context.store.resumePersisted(
        context.principalId,
        id,
        checkpoint,
        expectedCheckpointHash,
      );
      return {
        episodeId: id,
        checkpointId: checkpoint,
        observation: resumed.observation,
        status: statusWithoutRawError(resumed.record.controller.status()),
      };
    })
  )));

  server.registerTool('arc_status', {
    title: 'Read ARC episode status',
    description: 'Read action and wall-time budgets, progress, receipt counts, and terminal state without changing the environment.',
    inputSchema: { episodeId },
    annotations: READ_ONLY,
  }, async ({ episodeId: id }) => invoke(context, 'arc_status', { episodeId: id, readOnly: true }, async () => ({
    episodeId: id,
    status: statusWithoutRawError(record(context, id).controller.status()),
  })));

  server.registerTool('arc_receipts_verify', {
    title: 'Verify recorded ARC receipt-chain integrity',
    description: 'Verify integrity and continuity of the receipts recorded by this controller. This is not proof that no unreceipted environment actions occurred.',
    inputSchema: { episodeId },
    annotations: READ_ONLY,
  }, async ({ episodeId: id }) => invoke(context, 'arc_receipts_verify', { episodeId: id, readOnly: true }, async () => ({
    episodeId: id,
    verification: record(context, id).controller.verifyReceipts(),
  })));

  server.registerTool('arc_memory_query', {
    title: 'Query durable ARC memory',
    description: 'Retrieve evidence-backed rules and episodes from durable controller memory. Use this after ChatGPT context rotation or compaction.',
    inputSchema: { episodeId, query: memoryQuery.optional() },
    annotations: READ_ONLY,
  }, async ({ episodeId: id, query }) => invoke(context, 'arc_memory_query', { episodeId: id, readOnly: true }, async () => ({
    episodeId: id,
    memory: record(context, id).controller.queryMemory(query as MemoryQuery | undefined),
  })));

  server.registerTool('arc_memory_commit', {
    title: 'Commit evidence-backed ARC rule',
    description: 'Version and persist a semantic rule with supporting and contradicting receipt hashes. This mutates durable memory, not the environment.',
    inputSchema: { episodeId, idempotencyKey, rule: memoryCommit },
    annotations: MUTATING,
  }, async ({ episodeId: id, idempotencyKey: key, rule }) => invoke(context, 'arc_memory_commit', { episodeId: id, readOnly: false }, async () => (
    idempotent(context, 'arc_memory_commit', key, { episodeId: id, rule }, async () => ({
      episodeId: id,
      rule: await record(context, id).controller.commitMemory(rule as SemanticRuleCommit),
    }))
  )));

  server.registerTool('arc_graph_frontier', {
    title: 'Inspect belief graph frontier',
    description: 'Read the highest-novelty untested action edges from the episode belief graph.',
    inputSchema: { episodeId, limit: z.number().int().min(1).max(100).optional() },
    annotations: READ_ONLY,
  }, async ({ episodeId: id, limit }) => invoke(context, 'arc_graph_frontier', { episodeId: id, readOnly: true }, async () => ({
    episodeId: id,
    frontier: record(context, id).controller.graphFrontier(limit),
  })));

  server.registerTool('arc_execute_guarded_plan', {
    title: 'Execute guarded ARC plan',
    description: 'Execute bounded idempotent steps and stop immediately on the first observation postcondition mismatch.',
    inputSchema: {
      episodeId,
      idempotencyKey,
      plan: z.object({
        planId: z.string().min(1).max(200),
        steps: z.array(guardedStep).min(1).max(32),
      }).strict(),
    },
    annotations: GUARDED_ENV_WRITE,
  }, async ({ episodeId: id, idempotencyKey: key, plan }) => invoke(context, 'arc_execute_guarded_plan', { episodeId: id, readOnly: false }, async () => (
    idempotent(context, 'arc_execute_guarded_plan', key, { episodeId: id, plan }, async () => {
      const session = record(context, id);
      const result = await session.controller.executeGuardedPlan(plan as GuardedPlanRequest);
      if (result.completed.length > 0) {
        context.store.updateObservation(
          session,
          result.completed[result.completed.length - 1]!.observation,
        );
      }
      return { episodeId: id, plan: result };
    })
  )));

  registerAppTool(server, 'arc_render', {
    title: 'Render exact ARC canvas',
    description: 'Render the latest authoritative exact frame. This tool never computes state or score.',
    inputSchema: { episodeId },
    annotations: READ_ONLY,
    _meta: {
      ui: {
        resourceUri: ARC_WIDGET_URI,
        visibility: ['model', 'app'],
      },
    },
  }, async ({ episodeId: id }) => invoke(context, 'arc_render', { episodeId: id, readOnly: true }, async () => {
    const session = record(context, id);
    return {
      episodeId: id,
      observation: session.lastObservation,
      status: statusWithoutRawError(session.controller.status()),
      activeSupervisorDirective: activeDirective(session),
    };
  }));
}

export function registerBossTools(server: McpServer, context: ArcToolContext): void {
  server.registerTool('arc_supervisor_case', {
    title: 'Read supervisor evidence case',
    description: 'Pure read of exact visible evidence, durable memory, belief frontier, and receipt summary. The boss lane has no action capability.',
    inputSchema: { episodeId },
    annotations: READ_ONLY,
  }, async ({ episodeId: id }) => invoke(context, 'arc_supervisor_case', { episodeId: id, readOnly: true }, async () => {
    const session = record(context, id);
    const authority = context.store.supervisorAuthority(session);
    const bundle = authority.supervisorCaseBundle();
    if (bundle) session.lastSupervisorCase = bundle;
    return {
      episodeId: id,
      caseBundle: bundle,
      observation: session.lastObservation,
      memory: authority.queryMemory({ limit: 50 }),
      graphFrontier: authority.graphFrontier(50),
      status: statusWithoutRawError(authority.status()),
      priorDirective: activeDirective(session),
    };
  }));

  server.registerTool('arc_supervisor_directive_commit', {
    title: 'Commit supervisor directive',
    description: 'Commit typed bounded advice against the current supervisor case. This lane cannot invoke an ARC environment action.',
    inputSchema: { episodeId, idempotencyKey, directive: directiveCommit },
    annotations: MUTATING,
  }, async ({ episodeId: id, idempotencyKey: key, directive }) => invoke(context, 'arc_supervisor_directive_commit', { episodeId: id, readOnly: false }, async () => (
    idempotent(context, 'arc_supervisor_directive_commit', key, { episodeId: id, directive }, async () => {
      const session = record(context, id);
      const authority = context.store.supervisorAuthority(session);
      const current = authority.supervisorCaseBundle();
      if (
        !current ||
        current.case.id !== directive.caseId ||
        current.case.caseHash !== directive.caseHash ||
        current.observation.observationHash !== directive.observationHash
      ) {
        throw new Error('directive does not target the current supervisor case');
      }
      await context.store.prepareBossDirective(session, key, directive);
      let committed;
      try {
        committed = await authority.commitSupervisorDirective({
          caseId: directive.caseId,
          caseHash: directive.caseHash,
          observationHash: directive.observationHash,
          expectedObservationHash: directive.observationHash,
          mode: directive.mode,
          diagnosis: directive.diagnosis,
          requiredEvidence: directive.requiredEvidence,
          prohibitedEdges: directive.prohibitedEdges,
          actionBudget: directive.actionBudget,
          expiresAfterActions: directive.expiresAfterActions,
          hypotheses: directive.hypotheses,
          recommendedStrategy: directive.recommendedStrategy,
          constraints: directive.constraints,
        } satisfies SupervisorDirectiveCommit);
      } catch (error) {
        await context.store.discardBossDirectiveIntent(session, key);
        throw error;
      }
      session.lastDirective = committed;
      let active;
      try {
        active = await context.store.saveBossDirective(session, committed, key);
      } catch {
        // Core has committed. Retain the idempotency failure so retries cannot
        // apply the directive twice; the durable pre-commit intent remains.
        throw new NonRetryableMutationError('post-commit directive persistence failed');
      }
      return { episodeId: id, directive: active };
    })
  )));
}

export function toolNamesForLane(lane: McpLane): readonly string[] {
  return lane === 'actor'
    ? [
        'arc_start',
        'arc_observe',
        'arc_act',
        'arc_supervise',
        'arc_checkpoint',
        'arc_resume',
        'arc_status',
        'arc_receipts_verify',
        'arc_memory_query',
        'arc_memory_commit',
        'arc_graph_frontier',
        'arc_execute_guarded_plan',
        'arc_render',
      ]
    : ['arc_supervisor_case', 'arc_supervisor_directive_commit'];
}

export const ARC_ACTION_NAMES = actionName.options;
