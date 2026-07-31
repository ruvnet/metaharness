// SPDX-License-Identifier: MIT
//
// oasf/publish.ts — real integration test against a real AGNTCY Directory
// server. Requires a running Directory instance (see repo README / ADR-240
// for `docker compose up` from github.com/agntcy/dir's install/docker/).
//
// This test suite auto-detects whether a server is reachable at
// AGNTCY_DIRECTORY_ENDPOINT / DIRECTORY_CLIENT_SERVER_ADDRESS (default
// localhost:8888) and skips the live-network tests when none is running —
// CI environments without the Directory docker stack still pass, they just
// don't exercise the live path. The fail-closed unit-level behavior (no
// server configured, bad schema) is always exercised regardless.

import { describe, it, expect, afterEach } from 'vitest';
import { Client, Config } from 'agntcy-dir';
import { connect } from 'node:net';
import { publishToDirectory } from '../publish.js';
import type { OasfRecord } from '../record.js';

/**
 * Raw TCP reachability check — "is anything listening at host:port" — kept
 * deliberately separate from any AGNTCY protocol-level call. An earlier
 * version of this probe used `client.lookup()` on a bogus CID as its
 * reachability signal, which was wrong in both directions: swallowing the
 * call's rejection internally made it report "reachable" even against
 * nothing (failed in real CI, no server running); removing that swallow
 * then made a genuine "record not found" response from a REAL, reachable
 * server look identical to "unreachable", since `lookup()` rejects for
 * both. TCP-level reachability has no such ambiguity.
 */
function isPortReachable(hostPort: string, timeoutMs = 1000): Promise<boolean> {
  const [host, portStr] = hostPort.split(':');
  const port = Number(portStr);
  if (!host || !Number.isFinite(port)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

const VALID_RECORD: OasfRecord = {
  schema: 1,
  generatedAt: '2026-07-30T12:00:00.000Z',
  capabilities: [{ id: 'coder', kind: 'agent' }],
  supportedProtocols: [{ host: 'claude-code' }],
  modelRequirements: { recommendedMode: 'CLI + MCP', estCostPerRunUsd: 0.01 },
  resourceEnvelope: { mcpEnabled: true, shellAccess: false, networkAccess: true, fileWriteAccess: false },
  securityScopes: [{ id: 'allow-network', severity: 'medium', title: 'Network access granted' }],
  evaluationHistory: [{ metric: 'harnessFit', value: 82, source: 'harness-score' }],
  deploymentOptions: [{ mode: 'CLI + MCP', hosts: ['claude-code'], template: 'vertical_coding', archetype: 'coding-agent' }],
  pricingMeteringClass: 'per_invocation',
};

const TEST_SERVER_ADDRESS = process.env.AGNTCY_DIRECTORY_ENDPOINT ?? process.env.DIRECTORY_CLIENT_SERVER_ADDRESS ?? 'localhost:8888';

// Top-level await: vitest evaluates the whole test file as an ESM module
// before running any suite, so this resolves before describe.runIf/it.skipIf
// below ever read it — unlike a beforeAll hook, which runs AFTER suite
// collection and so can never gate a describe.runIf() condition correctly.
const serverReachable = await isPortReachable(TEST_SERVER_ADDRESS);

describe('publishToDirectory — fail-closed behavior (no live server needed)', () => {
  afterEach(() => {
    delete process.env.AGNTCY_DIRECTORY_ENDPOINT;
  });

  it('fails closed with a clear reason when no server is configured', async () => {
    const originalEndpoint = process.env.AGNTCY_DIRECTORY_ENDPOINT;
    const originalClientAddr = process.env.DIRECTORY_CLIENT_SERVER_ADDRESS;
    delete process.env.AGNTCY_DIRECTORY_ENDPOINT;
    delete process.env.DIRECTORY_CLIENT_SERVER_ADDRESS;
    const result = await publishToDirectory(VALID_RECORD, { name: 'test-harness', version: '0.0.1' });
    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/No Directory server configured/);
    if (originalEndpoint) process.env.AGNTCY_DIRECTORY_ENDPOINT = originalEndpoint;
    if (originalClientAddr) process.env.DIRECTORY_CLIENT_SERVER_ADDRESS = originalClientAddr;
  });

  it('flags an unsupported schema version distinctly, before ever touching the network', async () => {
    const badRecord = { ...VALID_RECORD, schema: 2 } as unknown as OasfRecord;
    const result = await publishToDirectory(badRecord, { name: 'test-harness', version: '0.0.1', serverAddress: 'localhost:1' });
    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/invalid OasfRecord/);
  });

  it('reports a clear failure reason (not a throw) when the configured server is unreachable', async () => {
    const result = await publishToDirectory(VALID_RECORD, {
      name: 'test-harness',
      version: '0.0.1',
      serverAddress: 'localhost:1', // nothing listens here
    });
    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/Directory (push\/publish failed|push returned no)/);
  });
});

describe.runIf(serverReachable || process.env.CI !== 'true')('publishToDirectory — live server integration', () => {
  it.skipIf(!serverReachable)('pushes and publishes a real record to a real running Directory server, then it is lookup-able', async () => {
    const uniqueName = `metaharness-agntcy-test-${Date.now()}`;
    const result = await publishToDirectory(VALID_RECORD, {
      name: uniqueName,
      version: '0.0.1-test',
      serverAddress: TEST_SERVER_ADDRESS,
    });

    expect(result.published).toBe(true);
    expect(result.ref).toBeTruthy();

    // Verify independently: look the pushed record back up via a fresh client.
    const config = new Config(TEST_SERVER_ADDRESS);
    const transport = await Client.createGRPCTransport(config);
    const client = new Client(config, transport);
    const metadatas = await client.lookup([result.ref as never]);
    expect(metadatas.length).toBe(1);
  });

  if (!serverReachable) {
    it.skip(`(skipped: no Directory server reachable at ${TEST_SERVER_ADDRESS} — run docker compose up in agntcy/dir's install/docker/ to exercise this test live)`, () => {});
  }
});
