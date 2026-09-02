// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { hashArcValue } from '@metaharness/arc-agi-3';
import { FileAuditSink, MemoryAuditSink } from '../src/audit.js';
import { opaqueAuditHash } from '../src/audit.js';
import { validateAuthConfig } from '../src/auth.js';
import {
  MAX_TOOL_CALLS_PER_MINUTE,
  MAX_TOOL_TIMEOUT_MS,
  ToolPolicyGate,
} from '../src/policy.js';
import {
  createArcMcpRuntime,
  MAX_SERVER_LIMITS,
  startArcMcpServer,
} from '../src/server.js';
import {
  ArcEpisodeStore,
  MAX_EPISODES_PER_PRINCIPAL,
  MAX_IDEMPOTENCY_ENTRIES_PER_PRINCIPAL,
  NonRetryableMutationError,
} from '../src/store.js';
import { ACTOR_TOKEN, BOSS_TOKEN, createFactoryFixture } from './helpers.js';

async function stateRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'arc-chatgpt-security-'));
}

describe('authentication and network boundaries', () => {
  it('rejects weak and duplicate bearer credentials at startup validation', () => {
    expect(() => validateAuthConfig({
      bearerPrincipals: [{ token: 'weak', principalId: 'operator', lanes: ['actor'] }],
    })).toThrow(/32 random bytes/);
    expect(() => validateAuthConfig({
      bearerPrincipals: [
        { token: ACTOR_TOKEN, principalId: 'operator', lanes: ['actor'] },
        { token: ACTOR_TOKEN, principalId: 'operator', lanes: ['boss'] },
      ],
    })).toThrow(/duplicate/);
  });

  it('publishes OAuth resource metadata, challenges, scopes, and verifies each lane', async () => {
    const root = await stateRoot();
    const fixture = createFactoryFixture();
    const oauth = {
      resource: 'https://arc-mcp.example',
      authorizationServers: ['https://identity.example/tenant'],
      actorScope: 'arc.actor',
      bossScope: 'arc.boss',
      verifyAccessToken: async (token: string) => token === 'actor-access-token'
        ? { principalId: 'operator', scopes: ['arc.actor'] }
        : token === 'boss-access-token'
          ? { principalId: 'operator', scopes: ['arc.boss'] }
          : null,
    };
    const started = await startArcMcpServer({
      controllerFactory: fixture.factory,
      stateRoot: root,
      port: 0,
      auth: { oauth },
    });

    const metadataUrl = new URL('/.well-known/oauth-protected-resource', started.actorUrl);
    const metadataResponse = await fetch(metadataUrl);
    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.json()).toEqual({
      resource: 'https://arc-mcp.example',
      authorization_servers: ['https://identity.example/tenant'],
      scopes_supported: ['arc.actor', 'arc.boss'],
    });

    const challenge = await fetch(started.actorUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://arc-mcp.example/.well-known/oauth-protected-resource"',
    );
    expect(challenge.headers.get('www-authenticate')).toContain('scope="arc.actor"');

    const actor = new Client(
      { name: 'chatgpt-oauth-actor', version: '0.1.0' },
      { capabilities: {} },
    );
    await actor.connect(new StreamableHTTPClientTransport(started.actorUrl, {
      requestInit: { headers: { authorization: 'Bearer actor-access-token' } },
    }));
    const tools = await actor.listTools();
    expect(tools.tools.some((tool) => tool.name === 'arc_act')).toBe(true);
    expect(tools.tools.some((tool) => tool.name === 'arc_supervisor_directive_commit')).toBe(false);
    const act = tools.tools.find((tool) => tool.name === 'arc_act') as unknown as {
      securitySchemes?: unknown;
      _meta?: Record<string, unknown>;
    };
    expect(act._meta?.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['arc.actor'] }]);
    const rawListResponse = await fetch(started.actorUrl, {
      method: 'POST',
      headers: {
        authorization: 'Bearer actor-access-token',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const rawList = await rawListResponse.json() as {
      result?: { tools?: Array<{ name?: string; securitySchemes?: unknown }> };
    };
    expect(rawList.result?.tools?.find((tool) => tool.name === 'arc_act')?.securitySchemes)
      .toEqual([{ type: 'oauth2', scopes: ['arc.actor'] }]);

    const wrongLane = new Client(
      { name: 'chatgpt-oauth-wrong-lane', version: '0.1.0' },
      { capabilities: {} },
    );
    await expect(wrongLane.connect(new StreamableHTTPClientTransport(started.bossUrl, {
      requestInit: { headers: { authorization: 'Bearer actor-access-token' } },
    })))
      .rejects.toThrow();

    await Promise.allSettled([actor.close(), wrongLane.close()]);
    await started.close();
    await rm(root, { recursive: true, force: true });
  });

  it('aborts timed out OAuth verification and caps unresolved and unauthenticated work', async () => {
    const root = await stateRoot();
    const fixture = createFactoryFixture();
    const signals: AbortSignal[] = [];
    const never = new Promise<null>(() => undefined);
    const started = await startArcMcpServer({
      controllerFactory: fixture.factory,
      stateRoot: root,
      port: 0,
      limits: {
        maxAuthenticationAttemptsPerMinute: 2,
        maxTrackedAuthenticationClients: 4,
      },
      auth: {
        oauth: {
          resource: 'https://arc-mcp.example',
          authorizationServers: ['https://identity.example'],
          actorScope: 'arc.actor',
          bossScope: 'arc.boss',
          verificationTimeoutMs: 100,
          maxConcurrentVerifications: 1,
          verifyAccessToken: async (_token, context) => {
            signals.push(context.signal);
            return never;
          },
        },
      },
    });
    const request = (token: string) => fetch(started.actorUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const timedOut = await request('hung-token');
    expect(timedOut.status).toBe(401);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);

    const capacity = await request('second-token');
    expect(capacity.status).toBe(429);
    expect(capacity.headers.get('retry-after')).toBe('1');
    const limited = await request('third-token');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');

    await started.close();
    await rm(root, { recursive: true, force: true });
  });

  it('rejects every nonloopback bind even with a strong scoped bearer', async () => {
    const root = await stateRoot();
    const fixture = createFactoryFixture();
    const options = {
      controllerFactory: fixture.factory,
      stateRoot: root,
      port: 0,
      auth: { bearerPrincipals: [{ token: ACTOR_TOKEN, principalId: 'operator', lanes: ['actor'] as const }] },
    };
    await expect(startArcMcpServer({ ...options, host: '0.0.0.0' })).rejects.toThrow(/loopback/);
    await expect(startArcMcpServer({ ...options, host: '192.0.2.10' })).rejects.toThrow(/loopback/);
    await rm(root, { recursive: true, force: true });
  });

  it('closes the factory when the requested listen port is already occupied', async () => {
    const firstRoot = await stateRoot();
    const secondRoot = await stateRoot();
    const firstFixture = createFactoryFixture();
    const secondFixture = createFactoryFixture();
    const first = await startArcMcpServer({
      controllerFactory: firstFixture.factory,
      stateRoot: firstRoot,
      port: 0,
    });
    await expect(startArcMcpServer({
      controllerFactory: secondFixture.factory,
      stateRoot: secondRoot,
      port: first.port,
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(secondFixture.factoryCloseCalls).toBe(1);
    await first.close();
    await Promise.all([
      rm(firstRoot, { recursive: true, force: true }),
      rm(secondRoot, { recursive: true, force: true }),
    ]);
  });

  it('requires OAuth or explicitly scoped bearer auth for public proxy hosts', async () => {
    const root = await stateRoot();
    const fixture = createFactoryFixture();
    await expect(createArcMcpRuntime({
      controllerFactory: fixture.factory,
      stateRoot: root,
      allowedHosts: ['public-tunnel.example'],
      auth: { anonymousPrincipalId: 'local' },
    })).rejects.toThrow(/OAuth or configured bearer/);
    await expect(createArcMcpRuntime({
      controllerFactory: fixture.factory,
      stateRoot: root,
      allowedHosts: ['public-tunnel.example'],
      auth: { bearerPrincipals: [{ token: ACTOR_TOKEN, principalId: 'operator' }] },
    })).rejects.toThrow(/lane scopes/);
    const runtime = await createArcMcpRuntime({
      controllerFactory: fixture.factory,
      stateRoot: root,
      allowedHosts: ['localhost', 'public-tunnel.example'],
      auth: {
        oauth: {
          resource: 'https://public-tunnel.example',
          authorizationServers: ['https://identity.example'],
          actorScope: 'arc.actor',
          bossScope: 'arc.boss',
          verifyAccessToken: async () => null,
        },
      },
    });
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  it('fails startup when the mandatory durable state root is omitted or unusable', async () => {
    const fixture = createFactoryFixture();
    await expect(createArcMcpRuntime({
      controllerFactory: fixture.factory,
      stateRoot: undefined as never,
    })).rejects.toThrow(/stateRoot is required/);
    const root = await stateRoot();
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'occupied');
    await expect(createArcMcpRuntime({
      controllerFactory: fixture.factory,
      stateRoot: file,
    })).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });
});

describe('hidden assignment leakage boundary', () => {
  it('sanitizes a factory failure from tool content, structured output, and audit events', async () => {
    const root = await stateRoot();
    const audit = new MemoryAuditSink();
    const sentinel = 'SECRET-GAME-ID-DO-NOT-LEAK';
    const started = await startArcMcpServer({
      controllerFactory: async () => { throw new Error(`factory failed for ${sentinel}`); },
      stateRoot: root,
      port: 0,
      audit,
    });
    const client = new Client({ name: 'leak-test', version: '0.1.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(started.actorUrl);
    await client.connect(transport);
    const result = await client.callTool({
      name: 'arc_start', arguments: { idempotencyKey: 'leak-test-start' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result.structuredContent ?? null)).not.toContain(sentinel);
    expect(JSON.stringify(audit.events)).not.toContain(sentinel);
    expect(JSON.stringify(audit.events)).not.toMatch(/game.?id/i);
    await Promise.allSettled([client.close()]);
    await started.close();
    await rm(root, { recursive: true, force: true });
  });

  it('derives a resumed active directive only from the verified checkpoint', async () => {
    const root = await stateRoot();
    const fixture = createFactoryFixture();
    const store = new ArcEpisodeStore(fixture.factory, root);
    const created = await store.create('boss-principal');
    const action = await created.record.controller.act({
      expectedObservationHash: created.observation.observationHash,
      idempotencyKey: 'boss-evidence-action',
      action: { name: 'ACTION1' },
      expectation: {
        confidence: 0.5,
        expectedChanges: [{ x: 0, y: 0, before: 0, after: 1 }],
      },
    });
    const bundle = created.record.controller.openSupervisorCase({
      trigger: 'MODEL_CONTRADICTION',
      evidenceReceiptHashes: [action.receipt.receiptHash],
    });
    if (!bundle) throw new Error('expected explicit supervisor case');
    const hypothesis = (index: number) => ({
      hypothesis: `hypothesis ${index}`,
      evidenceReceiptHashes: [action.receipt.receiptHash],
      falsifier: `falsifier ${index}`,
      proposedNextAction: { name: 'ACTION1' as const },
    });
    const directive = await created.record.controller.commitSupervisorDirective({
      caseId: bundle.case.id,
      caseHash: bundle.case.caseHash,
      expectedObservationHash: bundle.observation.observationHash,
      observationHash: bundle.observation.observationHash,
      mode: 'CONTINUE',
      diagnosis: 'test diagnosis',
      requiredEvidence: [action.receipt.receiptHash],
      actionBudget: 1,
      expiresAfterActions: 1,
      hypotheses: [hypothesis(1), hypothesis(2), hypothesis(3)],
      recommendedStrategy: 'one guarded probe',
      constraints: ['stay evidence bound'],
    });
    await store.saveBossDirective(created.record, directive);
    const checkpoint = await created.record.controller.checkpoint();
    const checkpointId = await store.saveCheckpoint(created.record, checkpoint);
    const path = join(
      root,
      `principal_${opaqueAuditHash('boss-principal')}`,
      created.record.episodeId,
      'active-directive.json',
    );
    const { directiveHash: _directiveHash, ...directiveBody } = directive;
    const forgedBody = {
      ...directiveBody,
      recommendedStrategy: 'fabricated replacement advice',
    };
    const forged = { ...forgedBody, directiveHash: hashArcValue(forgedBody) };
    await writeFile(path, JSON.stringify(forged), { encoding: 'utf8', mode: 0o600 });

    const restarted = new ArcEpisodeStore(fixture.factory, root);
    const resumed = await restarted.resumePersisted(
      'boss-principal',
      created.record.episodeId,
      checkpointId,
      checkpoint.checkpointHash,
    );
    expect(resumed.record.lastDirective).toEqual(directive);
    expect(resumed.record.lastDirective?.recommendedStrategy)
      .toBe('one guarded probe');
    await Promise.all([store.closeAll(), restarted.closeAll()]);
    await rm(root, { recursive: true, force: true });
  });
});

describe('mandatory auditing and deadlines', () => {
  it('rejects unbounded policy, server, and store capacities at startup', async () => {
    const audit = new MemoryAuditSink();
    expect(() => new ToolPolicyGate(audit, { toolTimeoutMs: Infinity }))
      .toThrow(/toolTimeoutMs/);
    expect(() => new ToolPolicyGate(audit, {
      maxToolCallsPerMinute: MAX_TOOL_CALLS_PER_MINUTE + 1,
    })).toThrow(/maxToolCallsPerMinute/);
    expect(() => new ToolPolicyGate(audit, { toolTimeoutMs: MAX_TOOL_TIMEOUT_MS + 1 }))
      .toThrow(/toolTimeoutMs/);

    const fixture = createFactoryFixture();
    const root = await stateRoot();
    expect(() => new ArcEpisodeStore(
      fixture.factory,
      root,
      () => new Date(),
      MAX_EPISODES_PER_PRINCIPAL + 1,
    )).toThrow(/maxEpisodesPerPrincipal/);
    expect(() => new ArcEpisodeStore(
      fixture.factory,
      root,
      () => new Date(),
      1,
      MAX_IDEMPOTENCY_ENTRIES_PER_PRINCIPAL + 1,
    )).toThrow(/maxIdempotencyEntriesPerPrincipal/);
    await expect(createArcMcpRuntime({
      controllerFactory: fixture.factory,
      stateRoot: root,
      limits: { requestTimeoutMs: MAX_SERVER_LIMITS.requestTimeoutMs + 1 },
    })).rejects.toThrow(/requestTimeoutMs/);
    await rm(root, { recursive: true, force: true });
  });

  it('blocks a mutation before execution when the authorization audit cannot be written', async () => {
    let bodyCalls = 0;
    const gate = new ToolPolicyGate({
      write: async () => { throw new Error('audit unavailable'); },
    });
    await expect(gate.run({
      lane: 'actor',
      tool: 'arc_start',
      principalId: 'principal',
      readOnly: false,
      body: async () => { bodyCalls += 1; },
    })).rejects.toThrow(/audit unavailable/);
    expect(bodyCalls).toBe(0);
  });

  it('retains a nonretryable post-commit persistence failure in the idempotency ledger', async () => {
    const root = await stateRoot();
    const fixture = createFactoryFixture();
    const store = new ArcEpisodeStore(fixture.factory, root);
    let commits = 0;
    const invoke = () => store.runIdempotent({
      principalId: 'boss-principal',
      tool: 'arc_supervisor_directive_commit',
      key: 'post-commit-storage-failure',
      input: { directiveHash: 'a'.repeat(64) },
      body: async () => {
        commits += 1;
        throw new NonRetryableMutationError('post-commit directive persistence failed');
      },
    });
    await expect(invoke()).rejects.toThrow(/persistence failed/);
    await expect(invoke()).rejects.toThrow(/persistence failed/);
    expect(commits).toBe(1);
    await store.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  it('applies deadlines only to reads and waits for mutations to finish', async () => {
    const audit = new MemoryAuditSink();
    const gate = new ToolPolicyGate(audit, { toolTimeoutMs: 5, maxToolCallsPerMinute: 100 });
    await expect(gate.run({
      lane: 'actor', tool: 'arc_status', principalId: 'p', readOnly: true,
      body: async () => new Promise((resolve) => setTimeout(() => resolve('late'), 25)),
    })).rejects.toThrow(/protected environment boundary/);
    let mutationFinished = false;
    const started = Date.now();
    await gate.run({
      lane: 'actor', tool: 'arc_start', principalId: 'p', readOnly: false,
      body: async () => new Promise<void>((resolve) => setTimeout(() => {
        mutationFinished = true;
        resolve();
      }, 25)),
    });
    expect(mutationFinished).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it('attempts controller cleanup even when HTTP shutdown reports a failure', async () => {
    const root = await stateRoot();
    const fixture = createFactoryFixture();
    const runtime = await createArcMcpRuntime({
      controllerFactory: fixture.factory,
      stateRoot: root,
      audit: new MemoryAuditSink(),
    });
    await runtime.store.create('shutdown-principal');
    await new Promise<void>((resolve, reject) => {
      runtime.server.once('error', reject);
      runtime.server.listen(0, '127.0.0.1', resolve);
    });
    const originalClose = runtime.server.close.bind(runtime.server);
    Object.defineProperty(runtime.server, 'close', {
      configurable: true,
      value: (callback?: (error?: Error) => void) => {
        callback?.(new Error('injected HTTP shutdown failure'));
        return runtime.server;
      },
    });
    await expect(runtime.close()).rejects.toThrow(/shutdown failed/);
    expect(fixture.environments[0]?.closeCalls).toBe(1);
    expect(fixture.factoryCloseCalls).toBe(1);
    Object.defineProperty(runtime.server, 'close', { configurable: true, value: originalClose });
    await new Promise<void>((resolve) => originalClose(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it('creates audit directories as 0700 and files as 0600 where POSIX modes apply', async () => {
    const root = await stateRoot();
    const path = join(root, 'private-audit', 'events.jsonl');
    const sink = new FileAuditSink(path);
    await sink.write({
      timestamp: new Date(0).toISOString(),
      lane: 'actor',
      tool: 'arc_start',
      principalHash: 'hashed',
      decision: 'allowed',
      reason: 'authorized',
      durationMs: 0,
    });
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'private-audit'))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(path, 'utf8')).not.toContain('principalId');
    await rm(root, { recursive: true, force: true });
  });
});
