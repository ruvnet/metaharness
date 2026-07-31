// SPDX-License-Identifier: MIT
//
// @metaharness/agntcy — oasf/project.ts (ADR-237 §2.2)
//
// Projects the REAL, already-computed output of:
//   - `metaharness score`    → packages/create-agent-harness/src/repo-scorecard.ts  (RepoScorecard)
//   - `metaharness genome`   → packages/create-agent-harness/src/genome.ts          (GenomeReport)
//   - `metaharness mcp-scan` → packages/create-agent-harness/src/mcp-scan.ts        (ScanReport)
// into an OasfRecord (./record.ts).
//
// Inputs are typed `unknown` on purpose. In practice a caller obtains these by
// invoking `metaharness score --json` / `genome --json` / `mcp-scan --json` as a
// subprocess (the ruflo-metaharness skill pattern, ADR-150 "removable
// augmentation") and `JSON.parse()`s the result — this package deliberately
// does NOT take a hard dependency on `@metaharness/create-agent-harness` (kernel-
// boundary discipline, ADR-002 / ADR-237 §5), so the shapes are re-validated
// structurally at this boundary rather than imported and trusted.
//
// Fail-closed (ADR-237 §2.2): every OASF field is derived ONLY from data that is
// actually present and well-shaped. Any field that cannot be derived — including
// `pricingMeteringClass`, which nothing in this repo computes today (see
// record.ts's file header) — is reported via `missingFields` instead of being
// filled with an invented placeholder. If `missingFields` is non-empty,
// `projectToOasf` returns `{ incomplete: true, missingFields }` rather than a
// partially-fabricated `OasfRecord`.

import type {
  OasfCapability,
  OasfDeploymentOption,
  OasfEvaluationRecord,
  OasfModelRequirements,
  OasfPricingMeteringClass,
  OasfRecord,
  OasfResourceEnvelope,
  OasfSecurityScope,
  OasfSecurityScopeSeverity,
  OasfSupportedProtocol,
} from './record.js';

export interface ProjectToOasfInput {
  score?: unknown;
  genome?: unknown;
  mcpScan?: unknown;
}

export type OasfProjection = OasfRecord | { incomplete: true; missingFields: string[] };

// --- minimal structural shapes of the REAL subcommand outputs ---------------
// Only the fields this projector actually reads are validated; extra fields on
// the real RepoScorecard/GenomeReport/ScanReport (e.g. `hardConstraints`,
// `profile`, `dir`) are ignored, not required.

interface RepoScorecardShape {
  harnessFit: number;
  compileConfidence: number;
  taskCoverage: number;
  toolSafety: number;
  memoryUsefulness: number;
  estCostPerRunUsd: number;
  recommendedMode: 'CLI' | 'CLI + MCP';
  archetype: string;
  template: string;
}

interface GenomeReportShape {
  generatedAt: string;
  plan: {
    hosts: string[];
    agents: string[];
    skills: string[];
  };
  genome: {
    agent_topology: string[];
    risk_score: number;
    test_confidence: number;
    publish_readiness: number;
  };
}

interface FindingShape {
  id: string;
  severity: OasfSecurityScopeSeverity;
  title: string;
}

interface ScanReportShape {
  mcpEnabled: boolean;
  findings: FindingShape[];
}

// --- runtime guards -----------------------------------------------------------

function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const RECOMMENDED_MODES = new Set<string>(['CLI', 'CLI + MCP']);
const SEVERITIES = new Set<string>(['high', 'medium', 'low', 'info']);

function asRepoScorecard(v: unknown): RepoScorecardShape | undefined {
  if (!isRecordObject(v)) return undefined;
  const { harnessFit, compileConfidence, taskCoverage, toolSafety, memoryUsefulness, estCostPerRunUsd, recommendedMode, archetype, template } = v;
  if (![harnessFit, compileConfidence, taskCoverage, toolSafety, memoryUsefulness, estCostPerRunUsd].every(isFiniteNumber)) return undefined;
  if (typeof recommendedMode !== 'string' || !RECOMMENDED_MODES.has(recommendedMode)) return undefined;
  if (typeof archetype !== 'string' || typeof template !== 'string') return undefined;
  return {
    harnessFit: harnessFit as number,
    compileConfidence: compileConfidence as number,
    taskCoverage: taskCoverage as number,
    toolSafety: toolSafety as number,
    memoryUsefulness: memoryUsefulness as number,
    estCostPerRunUsd: estCostPerRunUsd as number,
    recommendedMode: recommendedMode as 'CLI' | 'CLI + MCP',
    archetype,
    template,
  };
}

function asGenomeReport(v: unknown): GenomeReportShape | undefined {
  if (!isRecordObject(v)) return undefined;
  if (typeof v.generatedAt !== 'string') return undefined;
  if (!isRecordObject(v.plan)) return undefined;
  const { hosts, agents, skills } = v.plan;
  if (!isStringArray(hosts) || !isStringArray(agents) || !isStringArray(skills)) return undefined;
  if (!isRecordObject(v.genome)) return undefined;
  const { agent_topology, risk_score, test_confidence, publish_readiness } = v.genome;
  if (!isStringArray(agent_topology)) return undefined;
  if (![risk_score, test_confidence, publish_readiness].every(isFiniteNumber)) return undefined;
  return {
    generatedAt: v.generatedAt,
    plan: { hosts, agents, skills },
    genome: {
      agent_topology,
      risk_score: risk_score as number,
      test_confidence: test_confidence as number,
      publish_readiness: publish_readiness as number,
    },
  };
}

function asScanReport(v: unknown): ScanReportShape | undefined {
  if (!isRecordObject(v)) return undefined;
  if (typeof v.mcpEnabled !== 'boolean') return undefined;
  if (!Array.isArray(v.findings)) return undefined;
  const findings: FindingShape[] = [];
  for (const f of v.findings) {
    if (!isRecordObject(f)) return undefined;
    if (typeof f.id !== 'string' || typeof f.title !== 'string') return undefined;
    if (typeof f.severity !== 'string' || !SEVERITIES.has(f.severity)) return undefined;
    findings.push({ id: f.id, severity: f.severity as OasfSecurityScopeSeverity, title: f.title });
  }
  return { mcpEnabled: v.mcpEnabled, findings };
}

// --- pricingMeteringClass: the deliberately-unimplemented field --------------

/**
 * ADR-237 §2.2 fail-closed field. No component in this repo (harness-score /
 * harness-genome / harness-mcp-scan) computes a billing/metering CLASS today
 * — see record.ts's file header for why `estCostPerRunUsd` (an absolute USD
 * estimate) is not evidence of a metering class. Kept as a real function
 * (rather than inlined) so a future producer can be wired in here without
 * touching `projectToOasf`'s control flow.
 */
function derivePricingMeteringClass(
  _score: RepoScorecardShape | undefined,
  _genome: GenomeReportShape | undefined,
  _mcpScan: ScanReportShape | undefined,
): OasfPricingMeteringClass | undefined {
  return undefined;
}

// --- projection ----------------------------------------------------------------

/**
 * Project already-computed `harness score` / `harness genome` / `harness
 * mcp-scan` output into an OasfRecord. Returns `{ incomplete: true,
 * missingFields }` — never a partially-fabricated record — whenever any OASF
 * field cannot be derived from real data. See file header + record.ts for why
 * `pricingMeteringClass` is currently always in `missingFields`.
 */
export function projectToOasf(input: ProjectToOasfInput): OasfProjection {
  const missing: string[] = [];

  // A present-but-malformed input is treated the same as an absent one: the
  // fields that depend on it end up in `missingFields` below. This function
  // never throws on bad input — it fails closed on the affected OASF fields.
  const score = asRepoScorecard(input.score);
  const genome = asGenomeReport(input.genome);
  const mcpScan = asScanReport(input.mcpScan);

  let capabilities: OasfCapability[] | undefined;
  if (genome) {
    capabilities = [
      ...genome.plan.agents.map((id): OasfCapability => ({ id, kind: 'agent' })),
      ...genome.plan.skills.map((id): OasfCapability => ({ id, kind: 'skill' })),
      ...genome.genome.agent_topology.map((id): OasfCapability => ({ id, kind: 'topology' })),
    ];
  } else {
    missing.push('capabilities');
  }

  let supportedProtocols: OasfSupportedProtocol[] | undefined;
  if (genome) {
    supportedProtocols = genome.plan.hosts.map((host) => ({ host }));
  } else {
    missing.push('supportedProtocols');
  }

  let modelRequirements: OasfModelRequirements | undefined;
  if (score) {
    modelRequirements = { recommendedMode: score.recommendedMode, estCostPerRunUsd: score.estCostPerRunUsd };
  } else {
    missing.push('modelRequirements');
  }

  let resourceEnvelope: OasfResourceEnvelope | undefined;
  if (mcpScan) {
    const ids = new Set(mcpScan.findings.map((f) => f.id));
    resourceEnvelope = {
      mcpEnabled: mcpScan.mcpEnabled,
      shellAccess: ids.has('allow-shell'),
      networkAccess: ids.has('allow-network'),
      fileWriteAccess: ids.has('allow-file-write'),
    };
  } else {
    missing.push('resourceEnvelope');
  }

  let securityScopes: OasfSecurityScope[] | undefined;
  if (mcpScan) {
    securityScopes = mcpScan.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title }));
  } else {
    missing.push('securityScopes');
  }

  let evaluationHistory: OasfEvaluationRecord[] | undefined;
  if (score || genome) {
    evaluationHistory = [];
    if (score) {
      evaluationHistory.push(
        { metric: 'harnessFit', value: score.harnessFit, source: 'harness-score' },
        { metric: 'compileConfidence', value: score.compileConfidence, source: 'harness-score' },
        { metric: 'taskCoverage', value: score.taskCoverage, source: 'harness-score' },
        { metric: 'toolSafety', value: score.toolSafety, source: 'harness-score' },
        { metric: 'memoryUsefulness', value: score.memoryUsefulness, source: 'harness-score' },
      );
    }
    if (genome) {
      evaluationHistory.push(
        { metric: 'riskScore', value: genome.genome.risk_score, source: 'harness-genome' },
        { metric: 'testConfidence', value: genome.genome.test_confidence, source: 'harness-genome' },
        { metric: 'publishReadiness', value: genome.genome.publish_readiness, source: 'harness-genome' },
      );
    }
  } else {
    missing.push('evaluationHistory');
  }

  let deploymentOptions: OasfDeploymentOption[] | undefined;
  if (score && genome) {
    deploymentOptions = [
      { mode: score.recommendedMode, hosts: genome.plan.hosts, template: score.template, archetype: score.archetype },
    ];
  } else {
    missing.push('deploymentOptions');
  }

  const pricingMeteringClass = derivePricingMeteringClass(score, genome, mcpScan);
  if (!pricingMeteringClass) {
    // Always true today — see derivePricingMeteringClass above.
    missing.push('pricingMeteringClass');
  }

  if (missing.length > 0) {
    return { incomplete: true, missingFields: missing };
  }

  // Unreachable today (pricingMeteringClass has no producer yet, see above),
  // kept so the function stays honest about what a COMPLETE OasfRecord looks
  // like once one exists, and so the OasfRecord type is actually exercised by
  // this module rather than dead schema.
  return {
    schema: 1,
    generatedAt: genome!.generatedAt,
    capabilities: capabilities!,
    supportedProtocols: supportedProtocols!,
    modelRequirements: modelRequirements!,
    resourceEnvelope: resourceEnvelope!,
    securityScopes: securityScopes!,
    evaluationHistory: evaluationHistory!,
    deploymentOptions: deploymentOptions!,
    pricingMeteringClass: pricingMeteringClass!,
  };
}
