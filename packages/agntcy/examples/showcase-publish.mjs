#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// examples/showcase-publish.mjs — real, end-to-end demonstration of the
// build-time half of the AGNTCY integration (ADR-240): analyze a real repo
// with MetaHarness's own scorer/genome/mcp-scan, project the result into a
// real OASF record, and publish it to a real running AGNTCY Directory
// server. No mocks, no fixtures — every number below comes from actually
// running these tools against the target directory.
//
// This deliberately imports create-agent-harness directly, which the
// package itself (src/oasf/project.ts) never does — that's the ADR-002
// kernel-boundary rule for the PACKAGE, not for a demo script sitting
// outside it. A CLI subprocess bridge (`metaharness genome --json`) exists
// too, but its live JSON output is flat (top-level agent_topology, no
// plan/genome nesting) — a real, separate shape mismatch against
// project.ts's GenomeReportShape, worth its own fix. This script sidesteps
// that by calling buildGenomeReport() in-process, which returns the real
// nested shape project.ts expects.
//
// Usage:
//   node examples/showcase-publish.mjs [target-dir] [directory-server-address]
//   (defaults: target-dir = this repo's own root, server = localhost:8888)

import { buildRepoScorecard } from '../../create-agent-harness/dist/repo-scorecard.js';
import { buildGenomeReport } from '../../create-agent-harness/dist/genome.js';
import { scanMcp } from '../../create-agent-harness/dist/mcp-scan.js';
import { projectToOasf } from '../dist/oasf/project.js';
import { publishToDirectory } from '../dist/oasf/publish.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const targetDir = resolve(here, process.argv[2] ?? '../../..');
const serverAddress = process.argv[3] ?? 'localhost:8888';

function section(title) {
  console.log(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}`);
}

section('1. MetaHarness real analysis (score + genome + mcp-scan)');
console.log(`Target: ${targetDir}`);

const score = buildRepoScorecard(targetDir);
console.log('\nharness-score:');
console.log(`  harnessFit=${score.harnessFit} estCostPerRunUsd=$${score.estCostPerRunUsd} archetype=${score.archetype}`);

const genome = buildGenomeReport(targetDir);
console.log('\nharness-genome:');
console.log(`  agents=[${genome.plan.agents.join(', ')}]`);
console.log(`  skills=[${genome.plan.skills.join(', ')}]`);
console.log(`  agent_topology=[${genome.genome.agent_topology.join(', ')}] risk_score=${genome.genome.risk_score}`);

const mcpScan = scanMcp(targetDir);
console.log('\nharness-mcp-scan:');
console.log(`  mcpEnabled=${mcpScan.mcpEnabled} findings=${mcpScan.findings.length} worst=${mcpScan.worst}`);

section('2. Project into a real OASF record (ADR-240 §2.2)');
const projectionResult = projectToOasf({ score, genome, mcpScan });
// Real fail-closed behavior, not a bug: nothing this repo computes tells
// projectToOasf a billing MODEL (per-invocation vs. subscription vs.
// unmetered) — only a cost ESTIMATE (score.estCostPerRunUsd). Rather than
// have the library guess, it reports the gap honestly via missingFields —
// this is the ONE field projectToOasf can never derive today (see its own
// derivePricingMeteringClass, which always returns undefined).
console.log(`projectToOasf: incomplete=${'incomplete' in projectionResult}, missing=[${'incomplete' in projectionResult ? projectionResult.missingFields.join(', ') : ''}]`);

// Same fields projectToOasf itself would assemble (verified against its
// source), plus the one field only the CALLER can honestly supply: this
// harness is invoked per-run, evidenced by score.estCostPerRunUsd being a
// real number, not a guess.
const record = {
  schema: 1,
  generatedAt: genome.generatedAt,
  capabilities: [
    ...genome.plan.agents.map((id) => ({ id, kind: 'agent' })),
    ...genome.plan.skills.map((id) => ({ id, kind: 'skill' })),
    ...genome.genome.agent_topology.map((id) => ({ id, kind: 'topology' })),
  ],
  supportedProtocols: genome.plan.hosts.map((host) => ({ host })),
  modelRequirements: { recommendedMode: score.recommendedMode, estCostPerRunUsd: score.estCostPerRunUsd },
  resourceEnvelope: {
    mcpEnabled: mcpScan.mcpEnabled,
    shellAccess: mcpScan.findings.some((f) => f.id === 'allow-shell'),
    networkAccess: mcpScan.findings.some((f) => f.id === 'allow-network'),
    fileWriteAccess: mcpScan.findings.some((f) => f.id === 'allow-file-write'),
  },
  securityScopes: mcpScan.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title })),
  evaluationHistory: [
    { metric: 'harnessFit', value: score.harnessFit, source: 'harness-score' },
    { metric: 'compileConfidence', value: score.compileConfidence, source: 'harness-score' },
    { metric: 'taskCoverage', value: score.taskCoverage, source: 'harness-score' },
    { metric: 'toolSafety', value: score.toolSafety, source: 'harness-score' },
    { metric: 'memoryUsefulness', value: score.memoryUsefulness, source: 'harness-score' },
    { metric: 'riskScore', value: genome.genome.risk_score, source: 'harness-genome' },
    { metric: 'testConfidence', value: genome.genome.test_confidence, source: 'harness-genome' },
    { metric: 'publishReadiness', value: genome.genome.publish_readiness, source: 'harness-genome' },
  ],
  deploymentOptions: [{ mode: score.recommendedMode, hosts: genome.plan.hosts, template: score.template, archetype: score.archetype }],
  pricingMeteringClass: 'per_invocation',
};
console.log(`Capabilities: ${record.capabilities.length} (agents/skills/topology)`);
console.log(`Security scopes: ${record.securityScopes.length}`);

section(`3. Publish to a real AGNTCY Directory server (${serverAddress})`);
const harnessName = `showcase-${Date.now()}`;
const result = await publishToDirectory(record, {
  name: harnessName,
  version: '0.0.1-showcase',
  serverAddress,
});

if (!result.published) {
  console.error(`Publish failed: ${result.reason}`);
  console.error('(Start a local Directory server from agntcy/dir\'s install/docker/docker-compose.yml to see this succeed.)');
  process.exit(1);
}

console.log(`Published! name=${harnessName} ref=${JSON.stringify(result.ref)}`);
console.log(`\nHand-off for ruflo: ${JSON.stringify({ name: harnessName, ref: result.ref, capabilities: record.capabilities.map((c) => c.id) })}`);
