// SPDX-License-Identifier: MIT
//
// oasf/project.ts — projectToOasf against realistic fixtures shaped like the
// REAL `metaharness score --json` / `metaharness genome --json` /
// `metaharness mcp-scan --json` output (packages/create-agent-harness/src/
// repo-scorecard.ts, genome.ts, mcp-scan.ts).

import { describe, it, expect } from 'vitest';
import { projectToOasf } from '../project.js';

// A realistic `metaharness score --json` fixture (RepoScorecard).
const SCORE_FIXTURE = {
  schema: 1,
  repo: 'example-repo',
  harnessFit: 82,
  compileConfidence: 90,
  taskCoverage: 65,
  toolSafety: 75,
  memoryUsefulness: 58,
  estCostPerRunUsd: 0.012,
  recommendedMode: 'CLI + MCP',
  archetype: 'coding-agent',
  template: 'vertical_coding',
  scaffoldReady: true,
  hardConstraints: '6/6',
  generatedAt: '2026-07-30T12:00:00.000Z',
};

// A realistic `metaharness genome --json` fixture (Genome, nested inside a
// GenomeReport as `.genome`) plus the `.plan` (HarnessPlan) sibling field.
const GENOME_FIXTURE = {
  schema: 1,
  generatedAt: '2026-07-30T12:00:00.000Z',
  dir: '/repo/example-repo',
  plan: {
    name: 'example-repo',
    hosts: ['claude-code', 'codex'],
    template: 'vertical_coding',
    archetypeId: 'coding-agent',
    confidence: 0.82,
    engine: 'lexical',
    agents: ['coder', 'reviewer'],
    skills: ['test-gaps', 'security-scan'],
    commands: ['deploy'],
    mcp: 'local',
    policy: {},
    riskProfile: 'default-deny',
    suggestedCommands: [],
  },
  genome: {
    repo_type: 'application',
    agent_topology: ['coder', 'reviewer', 'tester'],
    risk_score: 0.22,
    mcp_surface: 'local_default_deny',
    test_confidence: 0.71,
    publish_readiness: 0.8,
  },
  verdict: 'ready',
  exitCode: 0,
};

// A realistic `metaharness mcp-scan --json` fixture (ScanReport) — one grant
// finding (allow-network) and one clean-ish medium finding.
const MCP_SCAN_FIXTURE = {
  dir: '/repo/example-repo',
  mcpEnabled: true,
  findings: [
    { id: 'allow-network', severity: 'medium', title: 'Network access granted', detail: 'allowNetwork=true widens the exfiltration surface.' },
    { id: 'no-call-budget', severity: 'low', title: 'No per-turn tool-call budget', detail: 'maxToolCallsPerTurn bounds runaway loops.' },
  ],
  worst: 'medium',
};

describe('projectToOasf', () => {
  it('fails closed on pricingMeteringClass even with fully complete, well-shaped inputs', () => {
    const result = projectToOasf({ score: SCORE_FIXTURE, genome: GENOME_FIXTURE, mcpScan: MCP_SCAN_FIXTURE });
    // Nothing in this repo computes a metering CLASS today (see record.ts) —
    // the projection must never fabricate one, even when every other input is
    // present and valid.
    expect(result).toEqual({ incomplete: true, missingFields: ['pricingMeteringClass'] });
  });

  it('reports every OASF field as missing when no inputs are supplied', () => {
    const result = projectToOasf({});
    expect(result).toEqual({
      incomplete: true,
      missingFields: [
        'capabilities',
        'supportedProtocols',
        'modelRequirements',
        'resourceEnvelope',
        'securityScopes',
        'evaluationHistory',
        'deploymentOptions',
        'pricingMeteringClass',
      ],
    });
  });

  it('only reports genome- and mcpScan-dependent fields missing when only score is supplied', () => {
    const result = projectToOasf({ score: SCORE_FIXTURE });
    expect(result).toEqual({
      incomplete: true,
      missingFields: [
        'capabilities', // genome-only
        'supportedProtocols', // genome-only
        'resourceEnvelope', // mcpScan-only
        'securityScopes', // mcpScan-only
        'deploymentOptions', // needs both score AND genome
        'pricingMeteringClass',
      ],
    });
  });

  it('treats a malformed score (wrong recommendedMode enum) the same as an absent score', () => {
    const malformedScore = { ...SCORE_FIXTURE, recommendedMode: 'not-a-real-mode' };
    const result = projectToOasf({ score: malformedScore, genome: GENOME_FIXTURE, mcpScan: MCP_SCAN_FIXTURE }) as {
      incomplete: true;
      missingFields: string[];
    };
    expect(result.incomplete).toBe(true);
    expect(result.missingFields).toContain('modelRequirements');
    expect(result.missingFields).toContain('deploymentOptions'); // needs score too
  });

  it('treats a malformed mcpScan finding (bad severity) the same as an absent mcpScan', () => {
    const malformedScan = { ...MCP_SCAN_FIXTURE, findings: [{ id: 'x', severity: 'critical', title: 't', detail: 'd' }] };
    const result = projectToOasf({ score: SCORE_FIXTURE, genome: GENOME_FIXTURE, mcpScan: malformedScan }) as {
      incomplete: true;
      missingFields: string[];
    };
    expect(result.incomplete).toBe(true);
    expect(result.missingFields).toEqual(expect.arrayContaining(['resourceEnvelope', 'securityScopes']));
  });

  it('never throws on completely unrelated input shapes', () => {
    expect(() => projectToOasf({ score: 'not an object', genome: 42, mcpScan: [1, 2, 3] })).not.toThrow();
    const result = projectToOasf({ score: 'not an object', genome: 42, mcpScan: [1, 2, 3] });
    expect(result).toMatchObject({ incomplete: true });
  });

  it('derives resourceEnvelope booleans strictly from finding ids that are present', () => {
    // Only 'allow-network' present → shellAccess/fileWriteAccess must be false,
    // not "unknown"/omitted — the projector must not guess.
    const scanWithOnlyNetworkGrant = {
      dir: '/repo',
      mcpEnabled: true,
      findings: [{ id: 'allow-network', severity: 'medium', title: 'x', detail: 'y' }],
      worst: 'medium',
    };
    // Force the "incomplete due to pricingMeteringClass only" path by giving all
    // three inputs, then inspect what missingFields tells us is/isn't derivable —
    // resourceEnvelope itself is NOT in missingFields, proving it was derived.
    const result = projectToOasf({ score: SCORE_FIXTURE, genome: GENOME_FIXTURE, mcpScan: scanWithOnlyNetworkGrant }) as {
      incomplete: true;
      missingFields: string[];
    };
    expect(result.missingFields).not.toContain('resourceEnvelope');
    expect(result.missingFields).not.toContain('securityScopes');
  });
});
