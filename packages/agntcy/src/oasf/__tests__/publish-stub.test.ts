// SPDX-License-Identifier: MIT
//
// oasf/publish-stub.ts — publishToDirectory must always fail closed (no
// AGNTCY Directory client library exists, verified 404 on every plausible
// npm name — see packages/agntcy/README.md "Status"), and must say so
// honestly rather than silently no-opping or faking success.

import { describe, it, expect, afterEach } from 'vitest';
import { publishToDirectory } from '../publish-stub.js';
import type { OasfRecord } from '../record.js';

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

describe('publishToDirectory', () => {
  afterEach(() => {
    delete process.env.AGNTCY_DIRECTORY_ENDPOINT;
  });

  it('always reports published: false with an honest, specific reason (no directoryUrl)', async () => {
    const result = await publishToDirectory(VALID_RECORD);
    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/AGNTCY Directory not yet configured/);
    expect(result.reason).toMatch(/ADR-237/);
  });

  it('still reports published: false even when a directoryUrl is explicitly supplied', async () => {
    const result = await publishToDirectory(VALID_RECORD, 'https://directory.agntcy.example/v1');
    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/directory\.agntcy\.example/);
  });

  it('still reports published: false even when AGNTCY_DIRECTORY_ENDPOINT is configured via env', async () => {
    process.env.AGNTCY_DIRECTORY_ENDPOINT = 'https://env-configured.example/v1';
    const result = await publishToDirectory(VALID_RECORD);
    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/env-configured\.example/);
  });

  it('never throws and never returns published: true for any input', async () => {
    await expect(publishToDirectory(VALID_RECORD)).resolves.toMatchObject({ published: false });
    await expect(publishToDirectory(VALID_RECORD, '')).resolves.toMatchObject({ published: false });
  });

  it('flags an unsupported schema version distinctly rather than the generic not-configured reason', async () => {
    const badRecord = { ...VALID_RECORD, schema: 2 } as unknown as OasfRecord;
    const result = await publishToDirectory(badRecord);
    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/invalid OasfRecord/);
  });
});
