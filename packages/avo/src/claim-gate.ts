// SPDX-License-Identifier: MIT

import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { canonical, sha256 } from './crypto.js';
import {
  evaluateShipGate,
  type ArmMetrics,
  type BenchmarkArm,
  type SWEbenchComparison,
} from './swebench.js';

export type ReleaseClaimClass = 'mechanism' | 'performance' | 'frontier';

export interface ReleaseClaim {
  id: string;
  classification: ReleaseClaimClass;
  statement: string;
  benchmarkId?: string;
  evidenceBundleHash?: string;
}

export interface ReleaseClaimManifest {
  schema: 'metaharness.avo.release-claims/v1';
  claims: ReleaseClaim[];
  /** Complete governed public surfaces inspected by the release CLI. */
  claimSurfaces: string[];
}

export interface EvidenceSignature {
  algorithm: 'ed25519';
  keyId: string;
  /** Canonical base64 Ed25519 signature over canonical(payload). */
  signature: string;
}

export interface SignedEvidence<T> {
  payload: T;
  signature: EvidenceSignature;
}

export interface TrustedAuthority {
  keyId: string;
  /** Canonical base64 SPKI DER Ed25519 public key. */
  publicKey: string;
}

export interface TrustedGrader extends TrustedAuthority {
  organization: string;
}

export interface ClaimGateTrustPolicy {
  schema: 'metaharness.avo.claim-trust/v1';
  registrationAuthorities: TrustedAuthority[];
  runAuthorities: TrustedAuthority[];
  graders: TrustedGrader[];
}

export interface AvoBenchmarkPreregistration {
  schema: 'metaharness.avo.preregistration/v1';
  benchmarkId: string;
  repository: 'ruvnet/metaharness';
  sourceCommitSha: string;
  package: {
    name: '@metaharness/avo';
    version: string;
    artifactHash: string;
  };
  registeredAt: string;
  dataset: {
    name: 'SWE-bench';
    split: 'unseen';
    taskSetHash: string;
    sampleSize: 100;
  };
  protocol: {
    arms: BenchmarkArm[];
    model: string;
    reasoningConfiguration: string;
    tokenBudget: number;
    evaluatorVersion: string;
    minRelativeResolutionLift: 0.2;
    maxCostIncreaseExclusive: 0.5;
    maxTotalCostUsd: number;
    requireZeroPolicyViolations: true;
    requireReplayIntegrity: 1;
  };
  claimPredicates: Array<{
    claimId: string;
    classification: 'performance' | 'frontier';
    statementHash: string;
    predicateId: 'swebench-relative-lift-20-v1';
  }>;
  runSignerKeyId: string;
  graderKeyIds: string[];
}

export interface AvoBenchmarkReceipt {
  schema: 'metaharness.avo.benchmark-receipt/v1';
  benchmarkId: string;
  repository: 'ruvnet/metaharness';
  sourceCommitSha: string;
  packageArtifactHash: string;
  preregistrationHash: string;
  startedAt: string;
  completedAt: string;
  taskSetHash: string;
  sampleSize: 100;
  observationsHash: string;
  claimSetHash: string;
  comparison: SWEbenchComparison;
  cost: {
    currency: 'USD';
    measured: true;
    totalUsd: number;
    providerUsageReceiptHash: string;
  };
  lineage: {
    expectedRuns: number;
    completedRuns: number;
    actionReceiptCount: number;
    checkpointCount: number;
    runManifestHash: string;
    checkpointManifestHash: string;
    actionReceiptsRootHash: string;
    replayReceiptsRootHash: string;
    receiptChainsVerified: true;
    replayVerified: true;
  };
}

export interface IndependentGraderReceipt {
  schema: 'metaharness.avo.independent-grader/v1';
  benchmarkId: string;
  graderId: string;
  organization: string;
  sourceCommitSha: string;
  packageArtifactHash: string;
  preregistrationHash: string;
  benchmarkResultHash: string;
  taskSetHash: string;
  sampleSize: 100;
  graderVersion: string;
  method: 'official-swebench-docker';
  gradedAt: string;
  verdict: 'pass';
  evidenceHash: string;
  claimSetHash: string;
  lineageEvidenceHash: string;
  receiptChainsVerified: true;
  replayVerified: true;
}

export interface AvoClaimEvidenceBundle {
  preregistration: SignedEvidence<AvoBenchmarkPreregistration>;
  benchmark: SignedEvidence<AvoBenchmarkReceipt>;
  graders: SignedEvidence<IndependentGraderReceipt>[];
}

export interface ClaimDecision {
  claimId: string;
  classification: ReleaseClaimClass;
  allowed: boolean;
  reasons: string[];
  evidenceBundleHash?: string;
}

export interface ReleaseClaimGateVerdict {
  schema: 'metaharness.avo.release-claim-verdict/v1';
  sourceCommitSha: string;
  allowed: boolean;
  decisions: ClaimDecision[];
  reasons: string[];
}

export interface EvaluateReleaseClaimGateInput {
  currentSourceSha: string;
  currentPackageVersion?: string;
  /** SHA-256 of the exact AVO tarball that the release job will publish. */
  currentPackageArtifactHash?: string;
  manifest: unknown;
  evidenceBundles?: unknown;
  trustPolicy?: unknown;
  /** SHA-256 of the protected trust policy, pinned outside the release commit. */
  trustedPolicyHash?: string;
  claimSurfaces?: unknown;
}

const ARMS: BenchmarkArm[] = ['darwin-fixed', 'avo-no-supervisor', 'avo-supervisor-memory'];
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * Mechanism statements are an exact protected registry, not caller labels.
 * Adding one is a reviewed source change. A performance sentence mislabeled as
 * `mechanism` therefore fails instead of silently bypassing evidence.
 */
export const REGISTERED_MECHANISM_CLAIMS: Readonly<Record<string, string>> = Object.freeze({
  'avo-package-surface-v1': 'The AVO package exports an autonomous variation API and versioned evidence schemas.',
});

/**
 * Removing a governed public surface requires a review of this protected
 * source file; editing only the caller-controlled manifest cannot shrink
 * claim coverage.
 */
export const REQUIRED_RELEASE_CLAIM_SURFACES: readonly string[] = Object.freeze([
  'README.md',
  'packages/avo/README.md',
]);

export const SUPPORTED_RESTRICTED_CLAIMS: Readonly<Record<string, {
  classification: 'performance' | 'frontier';
  statement: string;
  predicateId: 'swebench-relative-lift-20-v1';
}>> = Object.freeze({
  'avo-swebench-lift-20-v1': {
    classification: 'performance',
    statement: 'On the preregistered unseen 100-task SWE-bench protocol, AVO supervisor plus memory achieved at least 20 percent relative verified-resolution lift over fixed Darwin.',
    predicateId: 'swebench-relative-lift-20-v1',
  },
  'avo-class-evidence-threshold-v1': {
    classification: 'frontier',
    statement: 'AVO satisfies the MetaHarness AVO-class evidence threshold on its preregistered unseen 100-task SWE-bench protocol.',
    predicateId: 'swebench-relative-lift-20-v1',
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(left) * 1e-9, Math.abs(right) * 1e-9);
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function decodeCanonicalBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function importEd25519PublicKey(value: unknown): KeyObject | null {
  try {
    const der = decodeCanonicalBase64(value);
    if (!der) return null;
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function verifySignedPayload(
  signed: SignedEvidence<unknown>,
  authorities: TrustedAuthority[],
  expectedKeyId?: string,
): boolean {
  if (!isRecord(signed) || !isRecord(signed.signature)) return false;
  const signature = signed.signature;
  if (signature.algorithm !== 'ed25519' || typeof signature.keyId !== 'string') return false;
  if (expectedKeyId !== undefined && signature.keyId !== expectedKeyId) return false;
  const authority = authorities.find((candidate) => candidate.keyId === signature.keyId);
  if (!authority) return false;
  const publicKey = importEd25519PublicKey(authority.publicKey);
  const signatureBytes = decodeCanonicalBase64(signature.signature);
  if (!publicKey || !signatureBytes || signatureBytes.length !== 64) return false;
  try {
    return verifySignature(null, Buffer.from(canonical(signed.payload)), publicKey, signatureBytes);
  } catch {
    return false;
  }
}

function parseAuthorities(value: unknown, graders: boolean): TrustedAuthority[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed: TrustedAuthority[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.keyId !== 'string' || !ID.test(entry.keyId)) return null;
    if (typeof entry.publicKey !== 'string' || !importEd25519PublicKey(entry.publicKey)) return null;
    if (graders && (typeof entry.organization !== 'string' || entry.organization.trim().length === 0)) return null;
    parsed.push(entry as unknown as TrustedAuthority);
  }
  if (!unique(parsed.map((entry) => entry.keyId)) || !unique(parsed.map((entry) => entry.publicKey))) return null;
  return parsed;
}

function parseTrustPolicy(value: unknown): ClaimGateTrustPolicy | null {
  if (!isRecord(value) || value.schema !== 'metaharness.avo.claim-trust/v1') return null;
  const registrationAuthorities = parseAuthorities(value.registrationAuthorities, false);
  const runAuthorities = parseAuthorities(value.runAuthorities, false);
  const graders = parseAuthorities(value.graders, true) as TrustedGrader[] | null;
  if (!registrationAuthorities || !runAuthorities || !graders) return null;
  const allAuthorities = [...registrationAuthorities, ...runAuthorities, ...graders];
  if (!unique(allAuthorities.map((entry) => entry.keyId))
    || !unique(allAuthorities.map((entry) => entry.publicKey))) return null;
  return { schema: value.schema, registrationAuthorities, runAuthorities, graders };
}

function parseManifest(value: unknown): ReleaseClaimManifest | null {
  if (!isRecord(value) || value.schema !== 'metaharness.avo.release-claims/v1'
    || !Array.isArray(value.claims) || value.claims.length === 0
    || !Array.isArray(value.claimSurfaces) || value.claimSurfaces.length === 0
    || value.claimSurfaces.length > 32
    || !value.claimSurfaces.every((path) => typeof path === 'string' && path.length > 0
      && path.length <= 240 && !path.startsWith('/') && !path.includes('\\')
      && !path.split('/').includes('..'))
    || !unique(value.claimSurfaces as string[])) {
    return null;
  }
  const claimSurfaces = value.claimSurfaces as string[];
  if (claimSurfaces.length !== REQUIRED_RELEASE_CLAIM_SURFACES.length
    || REQUIRED_RELEASE_CLAIM_SURFACES.some((path) => !claimSurfaces.includes(path))) {
    return null;
  }
  const claims: ReleaseClaim[] = [];
  for (const entry of value.claims) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !ID.test(entry.id)) return null;
    if (!['mechanism', 'performance', 'frontier'].includes(String(entry.classification))) return null;
    if (typeof entry.statement !== 'string' || entry.statement.trim().length === 0) return null;
    if (entry.statement.length > 2_000) return null;
    const classification = entry.classification as ReleaseClaimClass;
    if (classification !== 'mechanism'
      && (typeof entry.benchmarkId !== 'string' || !ID.test(entry.benchmarkId)
        || typeof entry.evidenceBundleHash !== 'string' || !HASH.test(entry.evidenceBundleHash))) {
      return null;
    }
    if (classification !== 'mechanism') {
      const supported = SUPPORTED_RESTRICTED_CLAIMS[entry.id];
      if (!supported || supported.classification !== classification || supported.statement !== entry.statement) return null;
    }
    claims.push(entry as unknown as ReleaseClaim);
  }
  if (!unique(claims.map((claim) => claim.id))) return null;
  return { schema: value.schema, claims, claimSurfaces: [...claimSurfaces] };
}

function normalizeProse(value: string): string {
  return value
    // BOTH character classes exclude '[' — the label AND the URL. This is a
    // polynomial-ReDoS shape otherwise (CodeQL js/polynomial-redos), and it has
    // TWO independent backtracking paths, so excluding '[' from only the label
    // is not enough:
    //
    //   payload                     original   label-only fix   both fixed
    //   '[' + N×'[\\'              457 ms     0.2 ms           0.1 ms
    //   '[Z](' + N×'[(]('          1081 ms    734 ms  <-- !     0.1 ms
    //
    // The second path is the URL scan: at every '[' the engine consumes to
    // end-of-string looking for ')', which is O(n) per start position and so
    // O(n^2) overall. Stopping that scan at the next '[' makes it linear.
    // normalizeProse() runs on claim statements and surface text — the untrusted
    // release-claim prose this gate exists to validate — so the slow path is
    // reachable by a malformed claim, i.e. a DoS on the gate itself.
    // Output is unchanged on well-formed markdown (verified identical across
    // labels with spaces, query strings, fragments, and nested-bracket labels);
    // a '[' inside a link target was never matched by this pattern.
    .replace(/\[([^[\]]+)]\(([^)[]+)\)/g, '$1')
    .replace(/[`*_“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateClaimSurfaces(value: unknown, manifest: ReleaseClaimManifest): string[] {
  const reasons: string[] = [];
  if (!Array.isArray(value)) return ['governed release claim surfaces are unavailable'];
  const parsed: Array<{ path: string; text: string }> = [];
  for (const surface of value) {
    if (!isRecord(surface) || typeof surface.path !== 'string' || typeof surface.text !== 'string'
      || surface.text.length > 2 * 1024 * 1024) {
      return ['governed release claim surfaces have an invalid shape or exceed the size limit'];
    }
    parsed.push({ path: surface.path, text: surface.text });
  }
  if (!unique(parsed.map((surface) => surface.path))
    || parsed.length !== manifest.claimSurfaces.length
    || manifest.claimSurfaces.some((path) => !parsed.some((surface) => surface.path === path))) {
    return ['governed release claim surfaces do not exactly match the manifest'];
  }

  const normalizedSurfaces = parsed.map((surface) => ({
    path: surface.path,
    text: normalizeProse(surface.text),
    sentences: surface.text
      .split(/(?<=[.!?])\s+|\n+/)
      .map(normalizeProse)
      .filter(Boolean),
  }));
  for (const claim of manifest.claims) {
    const statement = normalizeProse(claim.statement);
    if (!normalizedSurfaces.some((surface) => surface.text.includes(statement))) {
      reasons.push(`claim ${claim.id} is not present verbatim in a governed release surface`);
    }
  }

  const restrictedTerms = /\b(?:frontier(?:[ -]level)?|state[ -]of[ -]the[ -]art|sota|outperform\w*|beats?|surpass\w*|world[ -]best|best[ -]in[ -]class|performance|benchmark(?:ed|ing)?|accuracy|resolve(?:d|s| rate)?|resolution|improv\w*|lift|gain\w*|faster|cheaper)\b/i;
  const avoContext = /\b(?:avo|@metaharness\/avo|autonomous variation)\b/i;
  const approvedRestrictedStatements = manifest.claims
    .filter((claim) => claim.classification !== 'mechanism')
    .map((claim) => normalizeProse(claim.statement));
  for (const surface of normalizedSurfaces) {
    for (const sentence of surface.sentences) {
      if (!avoContext.test(sentence) || !restrictedTerms.test(sentence)) continue;
      if (approvedRestrictedStatements.some((statement) => sentence.includes(statement))) continue;
      reasons.push(`undeclared restricted AVO claim in ${surface.path}: ${sentence.slice(0, 160)}`);
    }
  }
  return reasons;
}

function armMetricsValid(value: unknown, arm: BenchmarkArm, tasks: number): value is ArmMetrics {
  if (!isRecord(value) || value.arm !== arm || value.tasks !== tasks) return false;
  if (!Number.isSafeInteger(value.resolved) || (value.resolved as number) < 0 || (value.resolved as number) > tasks) return false;
  if (!isFiniteNonnegative(value.resolveRate) || value.resolveRate > 1) return false;
  if (!sameNumber(value.resolveRate, (value.resolved as number) / tasks)) return false;
  if (!isFiniteNonnegative(value.totalCostUsd)) return false;
  if ((value.resolved as number) === 0) {
    if (value.costPerAcceptedUsd !== null) return false;
  } else if (!isFiniteNonnegative(value.costPerAcceptedUsd)
    || !sameNumber(value.costPerAcceptedUsd, value.totalCostUsd / (value.resolved as number))) {
    return false;
  }
  return Number.isSafeInteger(value.wallTimeMs) && (value.wallTimeMs as number) >= 0
    && Number.isSafeInteger(value.policyViolations) && (value.policyViolations as number) >= 0
    && isFiniteNonnegative(value.replayIntegrity) && value.replayIntegrity <= 1
    && isFiniteNonnegative(value.rollbackRate) && value.rollbackRate <= 1
    && isFiniteNonnegative(value.coherenceRetention) && value.coherenceRetention <= 1;
}

function comparisonValid(value: unknown, preregistration: AvoBenchmarkPreregistration): value is SWEbenchComparison {
  if (!isRecord(value) || value.schema !== 1 || value.datasetKind !== 'swe-bench-unseen-preregistered') return false;
  const comparisonArms = value.arms;
  if (value.model !== preregistration.protocol.model
    || value.reasoningConfiguration !== preregistration.protocol.reasoningConfiguration
    || value.tokenBudget !== preregistration.protocol.tokenBudget
    || value.evaluatorVersion !== preregistration.protocol.evaluatorVersion
    || value.taskSetHash !== preregistration.dataset.taskSetHash
    || !isRecord(comparisonArms)) return false;
  return ARMS.every((arm) => armMetricsValid(comparisonArms[arm], arm, preregistration.dataset.sampleSize))
    && (comparisonArms['darwin-fixed'] as ArmMetrics).resolved > 0;
}

function preregistrationValid(value: unknown): value is AvoBenchmarkPreregistration {
  if (!isRecord(value) || value.schema !== 'metaharness.avo.preregistration/v1') return false;
  if (typeof value.benchmarkId !== 'string' || !ID.test(value.benchmarkId)
    || value.repository !== 'ruvnet/metaharness'
    || typeof value.sourceCommitSha !== 'string' || !COMMIT_SHA.test(value.sourceCommitSha)
    || !isRecord(value.package)
    || value.package.name !== '@metaharness/avo'
    || typeof value.package.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.package.version)
    || typeof value.package.artifactHash !== 'string' || !HASH.test(value.package.artifactHash)
    || !isIsoTimestamp(value.registeredAt)
    || !isRecord(value.dataset) || !isRecord(value.protocol)) return false;
  const dataset = value.dataset;
  const protocol = value.protocol;
  const protocolArms = protocol.arms;
  if (dataset.name !== 'SWE-bench' || dataset.split !== 'unseen'
    || typeof dataset.taskSetHash !== 'string' || !HASH.test(dataset.taskSetHash)
    || dataset.sampleSize !== 100) return false;
  if (!Array.isArray(protocolArms) || protocolArms.length !== ARMS.length
    || ARMS.some((arm) => !protocolArms.includes(arm))
    || typeof protocol.model !== 'string' || protocol.model.length === 0
    || typeof protocol.reasoningConfiguration !== 'string' || protocol.reasoningConfiguration.length === 0
    || !isPositiveSafeInteger(protocol.tokenBudget)
    || typeof protocol.evaluatorVersion !== 'string' || protocol.evaluatorVersion.length === 0
    || protocol.minRelativeResolutionLift !== 0.2
    || protocol.maxCostIncreaseExclusive !== 0.5
    || !isFiniteNonnegative(protocol.maxTotalCostUsd) || protocol.maxTotalCostUsd === 0
    || protocol.requireZeroPolicyViolations !== true
    || protocol.requireReplayIntegrity !== 1) return false;
  if (!Array.isArray(value.claimPredicates) || value.claimPredicates.length === 0) return false;
  const claimIds: string[] = [];
  for (const predicate of value.claimPredicates) {
    if (!isRecord(predicate) || typeof predicate.claimId !== 'string') return false;
    const supported = SUPPORTED_RESTRICTED_CLAIMS[predicate.claimId];
    if (!supported || predicate.classification !== supported.classification
      || predicate.predicateId !== supported.predicateId
      || predicate.statementHash !== sha256(supported.statement)) return false;
    claimIds.push(predicate.claimId);
  }
  if (!unique(claimIds)) return false;
  return typeof value.runSignerKeyId === 'string' && ID.test(value.runSignerKeyId)
    && Array.isArray(value.graderKeyIds) && value.graderKeyIds.length >= 2
    && value.graderKeyIds.every((id) => typeof id === 'string' && ID.test(id))
    && unique(value.graderKeyIds as string[]);
}

function lineageValid(value: unknown): value is AvoBenchmarkReceipt['lineage'] {
  if (!isRecord(value)) return false;
  const hashFields = [
    'runManifestHash',
    'checkpointManifestHash',
    'actionReceiptsRootHash',
    'replayReceiptsRootHash',
  ] as const;
  return isPositiveSafeInteger(value.expectedRuns)
    && value.completedRuns === value.expectedRuns
    && isPositiveSafeInteger(value.actionReceiptCount) && value.actionReceiptCount >= value.completedRuns
    && isPositiveSafeInteger(value.checkpointCount) && value.checkpointCount >= value.completedRuns
    && hashFields.every((field) => typeof value[field] === 'string' && HASH.test(value[field] as string))
    && value.receiptChainsVerified === true
    && value.replayVerified === true;
}

function benchmarkValid(value: unknown, preregistration: AvoBenchmarkPreregistration): value is AvoBenchmarkReceipt {
  if (!isRecord(value) || value.schema !== 'metaharness.avo.benchmark-receipt/v1') return false;
  if (value.benchmarkId !== preregistration.benchmarkId
    || value.repository !== preregistration.repository
    || value.sourceCommitSha !== preregistration.sourceCommitSha
    || value.packageArtifactHash !== preregistration.package.artifactHash
    || typeof value.preregistrationHash !== 'string' || !HASH.test(value.preregistrationHash)
    || !isIsoTimestamp(value.startedAt) || !isIsoTimestamp(value.completedAt)
    || Date.parse(value.startedAt) > Date.parse(value.completedAt)
    || value.taskSetHash !== preregistration.dataset.taskSetHash
    || value.sampleSize !== preregistration.dataset.sampleSize
    || typeof value.observationsHash !== 'string' || !HASH.test(value.observationsHash)
    || value.claimSetHash !== sha256(preregistration.claimPredicates)
    || !comparisonValid(value.comparison, preregistration)
    || !isRecord(value.cost) || !lineageValid(value.lineage)) return false;
  const cost = value.cost;
  if (cost.currency !== 'USD' || cost.measured !== true || !isFiniteNonnegative(cost.totalUsd)
    || typeof cost.providerUsageReceiptHash !== 'string' || !HASH.test(cost.providerUsageReceiptHash)) return false;
  const comparison = value.comparison as SWEbenchComparison;
  const lineage = value.lineage as AvoBenchmarkReceipt['lineage'];
  const comparisonCost = ARMS.reduce((sum, arm) => sum + comparison.arms[arm].totalCostUsd, 0);
  return sameNumber(cost.totalUsd, comparisonCost)
    && cost.totalUsd <= preregistration.protocol.maxTotalCostUsd
    && lineage.expectedRuns === preregistration.dataset.sampleSize * ARMS.length;
}

function graderValid(value: unknown): value is IndependentGraderReceipt {
  if (!isRecord(value) || value.schema !== 'metaharness.avo.independent-grader/v1') return false;
  return typeof value.benchmarkId === 'string' && ID.test(value.benchmarkId)
    && typeof value.graderId === 'string' && ID.test(value.graderId)
    && typeof value.organization === 'string' && value.organization.trim().length > 0
    && typeof value.sourceCommitSha === 'string' && COMMIT_SHA.test(value.sourceCommitSha)
    && typeof value.packageArtifactHash === 'string' && HASH.test(value.packageArtifactHash)
    && typeof value.preregistrationHash === 'string' && HASH.test(value.preregistrationHash)
    && typeof value.benchmarkResultHash === 'string' && HASH.test(value.benchmarkResultHash)
    && typeof value.taskSetHash === 'string' && HASH.test(value.taskSetHash)
    && value.sampleSize === 100
    && typeof value.graderVersion === 'string' && value.graderVersion.length > 0
    && value.method === 'official-swebench-docker'
    && isIsoTimestamp(value.gradedAt)
    && value.verdict === 'pass'
    && typeof value.evidenceHash === 'string' && HASH.test(value.evidenceHash)
    && typeof value.claimSetHash === 'string' && HASH.test(value.claimSetHash)
    && typeof value.lineageEvidenceHash === 'string' && HASH.test(value.lineageEvidenceHash)
    && value.receiptChainsVerified === true
    && value.replayVerified === true;
}

function verifyEvidenceBundle(
  value: unknown,
  currentSourceSha: string,
  currentPackageVersion: string | undefined,
  currentPackageArtifactHash: string | undefined,
  trustPolicy: ClaimGateTrustPolicy,
): { allowed: boolean; reasons: string[]; benchmarkId?: string; claimIds?: string[] } {
  const reasons: string[] = [];
  if (!isRecord(value) || !isRecord(value.preregistration) || !isRecord(value.benchmark)
    || !Array.isArray(value.graders)) {
    return { allowed: false, reasons: ['evidence bundle has an invalid shape'] };
  }
  const bundle = value as unknown as AvoClaimEvidenceBundle;
  if (!preregistrationValid(bundle.preregistration.payload)) {
    return { allowed: false, reasons: ['preregistration payload is invalid or weakens the frozen protocol'] };
  }
  const preregistration = bundle.preregistration.payload;
  if (!verifySignedPayload(bundle.preregistration, trustPolicy.registrationAuthorities)) {
    reasons.push('preregistration signature is invalid or untrusted');
  }
  if (preregistration.sourceCommitSha !== currentSourceSha) reasons.push('preregistered source SHA is not the release SHA');
  if (preregistration.package.version !== currentPackageVersion) {
    reasons.push('preregistered package version is not the release package version');
  }
  if (preregistration.package.artifactHash !== currentPackageArtifactHash) {
    reasons.push('preregistered package artifact is not the exact release tarball');
  }
  const runAuthority = trustPolicy.runAuthorities.find((entry) => entry.keyId === preregistration.runSignerKeyId);
  if (!runAuthority) reasons.push('preregistered run signer is not trusted');

  const preregistrationHash = sha256(bundle.preregistration);
  if (!benchmarkValid(bundle.benchmark.payload, preregistration)) {
    reasons.push('benchmark receipt is invalid, incomplete, inconsistent, or over its preregistered cost ceiling');
  } else {
    const benchmark = bundle.benchmark.payload;
    if (benchmark.preregistrationHash !== preregistrationHash) reasons.push('benchmark receipt does not bind the signed preregistration');
    if (Date.parse(preregistration.registeredAt) >= Date.parse(benchmark.startedAt)) {
      reasons.push('preregistration was not sealed before benchmark execution');
    }
    if (!verifySignedPayload(bundle.benchmark, trustPolicy.runAuthorities, preregistration.runSignerKeyId)) {
      reasons.push('benchmark signature is invalid, untrusted, or uses the wrong preregistered signer');
    }
    const shipGate = evaluateShipGate(benchmark.comparison);
    if (!shipGate.ship) reasons.push(...shipGate.reasons.map((reason) => `benchmark gate: ${reason}`));

    const expectedGraderIds = preregistration.graderKeyIds;
    const actualGraderIds: string[] = [];
    const graderOrganizations: string[] = [];
    for (const signedGrader of bundle.graders) {
      if (!isRecord(signedGrader) || !graderValid(signedGrader.payload)) {
        reasons.push('independent grader receipt has an invalid shape');
        continue;
      }
      const grader = signedGrader.payload;
      actualGraderIds.push(grader.graderId);
      graderOrganizations.push(grader.organization);
      const trusted = trustPolicy.graders.find((entry) => entry.keyId === grader.graderId);
      if (!trusted || trusted.organization !== grader.organization) {
        reasons.push(`grader ${grader.graderId} is not pinned to the claimed organization`);
      }
      if (!expectedGraderIds.includes(grader.graderId)) reasons.push(`grader ${grader.graderId} was not preregistered`);
      if (signedGrader.signature.keyId !== grader.graderId
        || !verifySignedPayload(signedGrader, trustPolicy.graders, grader.graderId)) {
        reasons.push(`grader ${grader.graderId} signature is invalid or untrusted`);
      }
      if (grader.benchmarkId !== benchmark.benchmarkId
        || grader.sourceCommitSha !== benchmark.sourceCommitSha
        || grader.packageArtifactHash !== benchmark.packageArtifactHash
        || grader.preregistrationHash !== preregistrationHash
        || grader.benchmarkResultHash !== sha256(benchmark)
        || grader.claimSetHash !== benchmark.claimSetHash
        || grader.taskSetHash !== benchmark.taskSetHash
        || grader.sampleSize !== benchmark.sampleSize
        || grader.lineageEvidenceHash !== sha256(benchmark.lineage)) {
        reasons.push(`grader ${grader.graderId} did not grade this exact benchmark result`);
      }
      if (Date.parse(grader.gradedAt) < Date.parse(benchmark.completedAt)) {
        reasons.push(`grader ${grader.graderId} predates benchmark completion`);
      }
    }
    if (!unique(actualGraderIds)) reasons.push('independent grader IDs must be unique');
    if (!unique(graderOrganizations)) reasons.push('independent graders must belong to distinct organizations');
    if (actualGraderIds.length < 2) reasons.push('at least two independent grader receipts are required');
    if (expectedGraderIds.length !== actualGraderIds.length
      || expectedGraderIds.some((id) => !actualGraderIds.includes(id))) {
      reasons.push('every preregistered independent grader must supply a receipt');
    }
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    benchmarkId: preregistration.benchmarkId,
    claimIds: preregistration.claimPredicates.map((predicate) => predicate.claimId),
  };
}

/**
 * Fail-closed release-claim verifier. Mechanism claims need no benchmark.
 * Performance/frontier claims need exact-SHA, preregistered, signed evidence
 * plus two independently trusted official graders.
 */
export function evaluateReleaseClaimGate(input: EvaluateReleaseClaimGateInput): ReleaseClaimGateVerdict {
  const globalReasons: string[] = [];
  const manifest = parseManifest(input.manifest);
  if (!COMMIT_SHA.test(input.currentSourceSha)) globalReasons.push('current source SHA must be an exact 40-character Git commit SHA');
  if (!manifest) globalReasons.push('release claim manifest is invalid');
  if (!manifest || globalReasons.length > 0) {
    return {
      schema: 'metaharness.avo.release-claim-verdict/v1',
      sourceCommitSha: input.currentSourceSha,
      allowed: false,
      decisions: [],
      reasons: globalReasons,
    };
  }

  globalReasons.push(...validateClaimSurfaces(input.claimSurfaces, manifest));

  const restricted = manifest.claims.some((claim) => claim.classification !== 'mechanism');
  const trustPolicy = restricted ? parseTrustPolicy(input.trustPolicy) : null;
  if (restricted && !trustPolicy) globalReasons.push('performance/frontier claims require a valid pinned trust policy');
  if (restricted && (typeof input.trustedPolicyHash !== 'string' || !HASH.test(input.trustedPolicyHash))) {
    globalReasons.push('performance/frontier claims require a protected trust-policy hash');
  } else if (restricted && trustPolicy && sha256(trustPolicy) !== input.trustedPolicyHash) {
    globalReasons.push('trust policy does not match the protected trust-policy hash');
  }
  if (restricted && (typeof input.currentPackageArtifactHash !== 'string'
    || !HASH.test(input.currentPackageArtifactHash))) {
    globalReasons.push('performance/frontier claims require the exact release-package artifact hash');
  }
  if (restricted && (typeof input.currentPackageVersion !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.currentPackageVersion))) {
    globalReasons.push('performance/frontier claims require the release package version');
  }
  const rawBundles = input.evidenceBundles === undefined ? [] : input.evidenceBundles;
  if (!Array.isArray(rawBundles)) globalReasons.push('evidenceBundles must be an array');
  const bundles = Array.isArray(rawBundles) ? rawBundles : [];
  const bundleByHash = new Map(bundles.map((bundle) => [sha256(bundle), bundle]));

  const decisions = manifest.claims.map((claim): ClaimDecision => {
    if (claim.classification === 'mechanism') {
      const registered = REGISTERED_MECHANISM_CLAIMS[claim.id];
      const reasons = registered === claim.statement
        ? []
        : ['mechanism claim is not an exact entry in the protected mechanism-claim registry'];
      return { claimId: claim.id, classification: claim.classification, allowed: reasons.length === 0, reasons };
    }
    const reasons: string[] = [];
    const bundle = claim.evidenceBundleHash ? bundleByHash.get(claim.evidenceBundleHash) : undefined;
    if (!bundle) reasons.push('referenced signed evidence bundle is absent or its hash does not match');
    if (!trustPolicy) reasons.push('pinned trust policy is unavailable');
    if (bundle && trustPolicy) {
      const verdict = verifyEvidenceBundle(
        bundle,
        input.currentSourceSha,
        input.currentPackageVersion,
        input.currentPackageArtifactHash,
        trustPolicy,
      );
      reasons.push(...verdict.reasons);
      if (verdict.benchmarkId !== claim.benchmarkId) reasons.push('claim references a different benchmark ID');
      if (!verdict.claimIds?.includes(claim.id)) reasons.push('exact claim semantics were not preregistered and graded');
    }
    return {
      claimId: claim.id,
      classification: claim.classification,
      allowed: reasons.length === 0,
      reasons,
      evidenceBundleHash: claim.evidenceBundleHash,
    };
  });

  const reasons = [...globalReasons, ...decisions.flatMap((decision) => decision.reasons.map((reason) => `${decision.claimId}: ${reason}`))];
  return {
    schema: 'metaharness.avo.release-claim-verdict/v1',
    sourceCommitSha: input.currentSourceSha,
    allowed: reasons.length === 0 && decisions.every((decision) => decision.allowed),
    decisions,
    reasons,
  };
}

export function claimEvidenceBundleHash(bundle: AvoClaimEvidenceBundle): string {
  return sha256(bundle);
}

export function preregistrationEvidenceHash(preregistration: SignedEvidence<AvoBenchmarkPreregistration>): string {
  return sha256(preregistration);
}

export function benchmarkResultHash(benchmark: AvoBenchmarkReceipt): string {
  return sha256(benchmark);
}
