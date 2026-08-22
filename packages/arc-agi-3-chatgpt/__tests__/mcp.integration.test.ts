// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MemoryAuditSink } from '../src/audit.js';
import { startArcMcpServer } from '../src/server.js';
import type { StartedArcMcpServer } from '../src/types.js';
import {
  ACTOR_TOKEN,
  BOSS_TOKEN,
  createFactoryFixture,
  toolPayload,
} from './helpers.js';

function clientFor(url: URL, token: string): Client {
  const client = new Client(
    { name: 'arc-chatgpt-test', version: '0.1.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  return Object.assign(client, { testTransport: transport });
}

async function connect(url: URL, token: string): Promise<Client> {
  const client = clientFor(url, token) as Client & { testTransport: StreamableHTTPClientTransport };
  await client.connect(client.testTransport);
  return client;
}

describe('real Streamable HTTP MCP clients', () => {
  let stateRoot: string;
  let started: StartedArcMcpServer;
  const fixture = createFactoryFixture();
  const audit = new MemoryAuditSink();

  beforeAll(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), 'arc-chatgpt-mcp-'));
    started = await startArcMcpServer({
      controllerFactory: fixture.factory,
      stateRoot,
      port: 0,
      audit,
      auth: {
        bearerPrincipals: [
          { token: ACTOR_TOKEN, principalId: 'shared-operator', lanes: ['actor'] },
          { token: BOSS_TOKEN, principalId: 'shared-operator', lanes: ['boss'] },
        ],
      },
      policy: { maxToolCallsPerMinute: 1_000 },
    });
  });

  afterAll(async () => {
    await started.close();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('initializes, lists, calls actor and boss tools, and reads the exact UI resource', async () => {
    const actor = await connect(started.actorUrl, ACTOR_TOKEN);
    const actorTools = await actor.listTools();
    expect(actorTools.tools.map((tool) => tool.name)).toContain('arc_start');
    expect(actorTools.tools.map((tool) => tool.name)).not.toContain('arc_supervisor_directive_commit');
    const render = actorTools.tools.find((tool) => tool.name === 'arc_render');
    expect(render?._meta?.ui).toEqual(expect.objectContaining({
      resourceUri: 'ui://metaharness/arc-agi-3/canvas',
    }));
    for (const tool of actorTools.tools.filter((item) => item.name !== 'arc_render')) {
      expect(tool._meta?.ui).toBeUndefined();
    }
    expect(actorTools.tools.find((tool) => tool.name === 'arc_act')?.annotations)
      .toEqual(expect.objectContaining({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      }));
    expect(actorTools.tools.find((tool) => tool.name === 'arc_execute_guarded_plan')?.annotations)
      .toEqual(expect.objectContaining({
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      }));
    expect(actorTools.tools.find((tool) => tool.name === 'arc_resume')?.annotations)
      .toEqual(expect.objectContaining({
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      }));
    expect(actorTools.tools.find((tool) => tool.name === 'arc_start')?.annotations)
      .toEqual(expect.objectContaining({ destructiveHint: true, openWorldHint: true }));
    expect(actorTools.tools.find((tool) => tool.name === 'arc_observe')?.annotations)
      .toEqual(expect.objectContaining({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      }));
    expect(actorTools.tools.find((tool) => tool.name === 'arc_checkpoint')?.annotations)
      .toEqual(expect.objectContaining({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      }));

    const resources = await actor.listResources();
    expect(resources.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: 'ui://metaharness/arc-agi-3/canvas' }),
    ]));
    const resource = await actor.readResource({ uri: 'ui://metaharness/arc-agi-3/canvas' });
    expect(resource.contents[0]?.mimeType).toBe('text/html;profile=mcp-app');
    expect(resource.contents[0]?.text).toContain('ui/initialize');
    expect(resource.contents[0]?.text).toContain("availableDisplayModes: ['inline', 'fullscreen', 'pip']");

    const firstStart = await actor.callTool({
      name: 'arc_start',
      arguments: { idempotencyKey: 'start-same-request' },
    });
    const secondStart = await actor.callTool({
      name: 'arc_start',
      arguments: { idempotencyKey: 'start-same-request' },
    });
    const startedEpisode = toolPayload(firstStart);
    expect(toolPayload(secondStart).episodeId).toBe(startedEpisode.episodeId);
    expect(toolPayload(secondStart).mcpReplayed).toBe(true);
    expect(fixture.calls).toBe(1);
    const episodeId = startedEpisode.episodeId as string;
    const observation = startedEpisode.observation as { observationHash: string };

    const acted = toolPayload(await actor.callTool({
      name: 'arc_act',
      arguments: {
        episodeId,
        request: {
          expectedObservationHash: observation.observationHash,
          idempotencyKey: 'first-actor-action',
          action: { name: 'ACTION1' },
          expectation: {
            confidence: 0.5,
            expectedChanges: [{ x: 0, y: 0, before: 0, after: 1 }],
            rationale: 'test one visible transition',
          },
        },
      },
    }));
    const receipt = acted.receipt as { receiptHash: string };
    expect(fixture.environments[0]?.stepCalls).toBe(1);

    const memoryArguments = {
      episodeId,
      idempotencyKey: 'commit-memory-once',
      rule: {
        scope: 'GAME',
        kind: 'TRANSITION',
        statement: 'ACTION1 changed the visible top-left cell once',
        predictedEffect: 'the next comparable probe changes that cell',
        supportingReceiptHashes: [receipt.receiptHash],
      },
    };
    const firstMemory = toolPayload(await actor.callTool({
      name: 'arc_memory_commit', arguments: memoryArguments,
    }));
    const replayedMemory = toolPayload(await actor.callTool({
      name: 'arc_memory_commit', arguments: memoryArguments,
    }));
    expect((replayedMemory.rule as { id: string }).id)
      .toBe((firstMemory.rule as { id: string }).id);
    expect(replayedMemory.mcpReplayed).toBe(true);
    const statusAfterMemory = toolPayload(await actor.callTool({
      name: 'arc_status', arguments: { episodeId },
    }));
    expect((statusAfterMemory.status as { ruleCount: number }).ruleCount).toBe(1);

    const supervised = toolPayload(await actor.callTool({
      name: 'arc_supervise',
      arguments: {
        episodeId,
        idempotencyKey: 'open-explicit-case',
        contradiction: {
          trigger: 'MODEL_CONTRADICTION',
          evidenceReceiptHashes: [receipt.receiptHash],
        },
      },
    }));
    const caseBundle = supervised.caseBundle as {
      case: { id: string; caseHash: string };
      observation: { observationHash: string };
    };

    const boss = await connect(started.bossUrl, BOSS_TOKEN);
    const bossTools = await boss.listTools();
    expect(bossTools.tools.map((tool) => tool.name)).toEqual([
      'arc_supervisor_case',
      'arc_supervisor_directive_commit',
    ]);
    const bossCase = toolPayload(await boss.callTool({
      name: 'arc_supervisor_case',
      arguments: { episodeId },
    }));
    expect((bossCase.caseBundle as { case: { caseHash: string } }).case.caseHash)
      .toBe(caseBundle.case.caseHash);

    const hypothesis = (index: number) => ({
      hypothesis: `causal hypothesis ${index}`,
      evidenceReceiptHashes: [receipt.receiptHash],
      falsifier: `observable falsifier ${index}`,
      proposedNextAction: { name: 'ACTION1' },
    });
    const directiveInput = {
      caseId: caseBundle.case.id,
      caseHash: caseBundle.case.caseHash,
      observationHash: caseBundle.observation.observationHash,
      mode: 'EXPAND_FRONTIER',
      diagnosis: 'one transition is insufficient evidence',
      requiredEvidence: [receipt.receiptHash],
      prohibitedEdges: [],
      actionBudget: 3,
      expiresAfterActions: 0,
      hypotheses: [hypothesis(1), hypothesis(2), hypothesis(3)],
      recommendedStrategy: 'probe the least tested legal edge',
      constraints: ['stop on the first mismatch'],
    };
    const stale = await boss.callTool({
      name: 'arc_supervisor_directive_commit',
      arguments: {
        episodeId,
        idempotencyKey: 'boss-stale-directive',
        directive: { ...directiveInput, observationHash: '0'.repeat(64) },
      },
    });
    expect(stale.isError).toBe(true);
    const fabricated = await boss.callTool({
      name: 'arc_supervisor_directive_commit',
      arguments: {
        episodeId,
        idempotencyKey: 'boss-fabricated-evidence',
        directive: {
          ...directiveInput,
          requiredEvidence: ['f'.repeat(64)],
          hypotheses: directiveInput.hypotheses.map((item) => ({
            ...item,
            evidenceReceiptHashes: ['f'.repeat(64)],
          })),
        },
      },
    });
    expect(fabricated.isError).toBe(true);
    const committed = await boss.callTool({
      name: 'arc_supervisor_directive_commit',
      arguments: {
        episodeId,
        idempotencyKey: 'boss-directive-one',
        directive: directiveInput,
      },
    });
    const directive = toolPayload(committed).directive as {
      expectedObservationHash: string;
      hypotheses: unknown[];
      recommendedStrategy: string;
      constraints: string[];
    };
    expect(directive.expectedObservationHash).toBe(caseBundle.observation.observationHash);
    expect(directive.hypotheses).toHaveLength(3);
    expect(directive.recommendedStrategy).toContain('least tested');
    expect(directive.constraints).toEqual(['stop on the first mismatch']);
    expect(fixture.environments[0]?.stepCalls).toBe(1);
    const renderedAfterExpiry = toolPayload(await actor.callTool({
      name: 'arc_render', arguments: { episodeId },
    }));
    expect(renderedAfterExpiry.activeSupervisorDirective).toBeNull();
    const bossAfterExpiry = toolPayload(await boss.callTool({
      name: 'arc_supervisor_case', arguments: { episodeId },
    }));
    expect(bossAfterExpiry.priorDirective).toBeNull();

    await Promise.allSettled([actor.close(), boss.close()]);
  });

  it('rejects cross-lane credentials during initialize', async () => {
    await expect(connect(started.bossUrl, ACTOR_TOKEN)).rejects.toThrow();
    await expect(connect(started.actorUrl, BOSS_TOKEN)).rejects.toThrow();
  });

  it('rejects invalid coordinates, unfalsifiable expectations, and malformed directives', async () => {
    const actor = await connect(started.actorUrl, ACTOR_TOKEN);
    const fakeEpisodeId = `episode_${'x'.repeat(24)}`;
    const stepsBefore = fixture.environments.reduce((total, environment) => total + environment.stepCalls, 0);
    const coordinateResult = await actor.callTool({
      name: 'arc_act',
      arguments: {
        episodeId: fakeEpisodeId,
        request: {
          expectedObservationHash: '1'.repeat(64),
          idempotencyKey: 'invalid-coordinate',
          action: { name: 'ACTION6', x: -1, y: 64 },
          expectation: {
            confidence: 0.5,
            expectedChanges: [{ x: 64, y: -1 }],
          },
        },
      },
    });
    expect(coordinateResult.isError).toBe(true);
    expect(fixture.environments.reduce((total, environment) => total + environment.stepCalls, 0)).toBe(stepsBefore);

    for (const invalidExpectation of [
      { confidence: 0.5 },
      { confidence: 0.5, expectedChanges: [{ x: 0, y: 0 }] },
    ]) {
      const result = await actor.callTool({
        name: 'arc_act',
        arguments: {
          episodeId: fakeEpisodeId,
          request: {
            expectedObservationHash: '1'.repeat(64),
            idempotencyKey: `invalid-expectation-${JSON.stringify(invalidExpectation).length}`,
            action: { name: 'ACTION1' },
            expectation: invalidExpectation,
          },
        },
      });
      expect(result.isError).toBe(true);
    }
    expect(fixture.environments.reduce((total, environment) => total + environment.stepCalls, 0))
      .toBe(stepsBefore);

    const boss = await connect(started.bossUrl, BOSS_TOKEN);
    const baseHypothesis = {
      hypothesis: 'candidate',
      evidenceReceiptHashes: [],
      falsifier: 'visible mismatch',
      proposedNextAction: { name: 'ACTION1' },
    };
    const baseDirective = {
      caseId: 'case_x',
      caseHash: '2'.repeat(64),
      observationHash: '3'.repeat(64),
      mode: 'STOP',
      diagnosis: 'test',
      requiredEvidence: [],
      actionBudget: 0,
      expiresAfterActions: 0,
      recommendedStrategy: 'stop',
      constraints: [],
    };
    for (const hypotheses of [
      [baseHypothesis, baseHypothesis],
      [baseHypothesis, baseHypothesis, baseHypothesis, baseHypothesis],
    ]) {
      const result = await boss.callTool({
        name: 'arc_supervisor_directive_commit',
        arguments: {
          episodeId: fakeEpisodeId,
          idempotencyKey: `bad-count-${hypotheses.length}`,
          directive: { ...baseDirective, hypotheses },
        },
      });
      expect(result.isError).toBe(true);
    }
    await Promise.allSettled([actor.close(), boss.close()]);
  });
});
