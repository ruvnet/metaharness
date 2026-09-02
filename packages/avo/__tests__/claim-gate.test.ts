import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  benchmarkResultHash,
  canonical,
  claimEvidenceBundleHash,
  compareSWEbench,
  evaluateReleaseClaimGate,
  preregistrationEvidenceHash,
  sha256,
  SUPPORTED_RESTRICTED_CLAIMS,
  type AvoBenchmarkPreregistration,
  type AvoBenchmarkReceipt,
  type AvoClaimEvidenceBundle,
  type BenchmarkArm,
  type ClaimGateTrustPolicy,
  type IndependentGraderReceipt,
  type ReleaseClaimManifest,
  type SWEbenchObservation,
  type SignedEvidence,
} from '../src/index.js';

const SHA = '19ab3046b504b7d4cf1cafd338d7f096a4251b86';
const ARTIFACT_HASH = sha256('exact-avo-release-tarball');
const ARMS: BenchmarkArm[] = ['darwin-fixed', 'avo-no-supervisor', 'avo-supervisor-memory'];

function governedSurfaces(manifest: ReleaseClaimManifest, extra = ''): Array<{ path: string; text: string }> {
  const text = `${manifest.claims.map((claim) => claim.statement).join('\n')}\n${extra}`;
  return manifest.claimSurfaces.map((path) => ({ path, text }));
}

interface Identity {
  keyId: string;
  organization?: string;
  privateKey: KeyObject;
  publicKey: string;
}

function identity(keyId: string, organization?: string): Identity {
  const keys = generateKeyPairSync('ed25519');
  return {
    keyId,
    organization,
    privateKey: keys.privateKey,
    publicKey: (keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
  };
}

function signed<T>(payload: T, signer: Identity): SignedEvidence<T> {
  return {
    payload,
    signature: {
      algorithm: 'ed25519',
      keyId: signer.keyId,
      signature: sign(null, Buffer.from(canonical(payload)), signer.privateKey).toString('base64'),
    },
  };
}

function observations(autonomousResolved = 49): SWEbenchObservation[] {
  return ARMS.flatMap((arm) => Array.from({ length: 100 }, (_, index) => ({
    instanceId: `task-${index}`,
    arm,
    resolved: index < (arm === 'darwin-fixed' ? 40 : arm === 'avo-no-supervisor' ? 45 : autonomousResolved),
    costUsd: arm === 'darwin-fixed' ? 0.4 : arm === 'avo-no-supervisor' ? 0.5 : 0.56,
    wallTimeMs: arm === 'darwin-fixed' ? 100 : 300,
    policyViolations: 0,
    expectedReplayHash: sha256(`expected-${arm}-${index}`),
    actualReplayHash: sha256(`expected-${arm}-${index}`),
    rollbackCount: arm === 'darwin-fixed' ? 0 : index % 10 === 0 ? 1 : 0,
    coherenceRetention: arm === 'darwin-fixed' ? 0.7 : 0.9,
  })));
}

interface Fixture {
  manifest: ReleaseClaimManifest;
  bundle: AvoClaimEvidenceBundle;
  trustPolicy: ClaimGateTrustPolicy;
  identities: {
    registration: Identity;
    run: Identity;
    graderA: Identity;
    graderB: Identity;
  };
}

function makeFixture(options: { sourceSha?: string; autonomousResolved?: number; graderOrganizations?: [string, string] } = {}): Fixture {
  const sourceSha = options.sourceSha ?? SHA;
  const registration = identity('registration-authority');
  const run = identity('benchmark-runner');
  const organizations = options.graderOrganizations ?? ['grader-labs-a', 'grader-labs-b'];
  const graderA = identity('grader-a', organizations[0]);
  const graderB = identity('grader-b', organizations[1]);
  const taskSetHash = sha256('sealed-unseen-task-set');
  const preregistrationPayload: AvoBenchmarkPreregistration = {
    schema: 'metaharness.avo.preregistration/v1',
    benchmarkId: 'avo-swebench-100-v1',
    repository: 'ruvnet/metaharness',
    sourceCommitSha: sourceSha,
    package: { name: '@metaharness/avo', version: '0.2.0', artifactHash: ARTIFACT_HASH },
    registeredAt: '2026-08-20T00:00:00.000Z',
    dataset: { name: 'SWE-bench', split: 'unseen', taskSetHash, sampleSize: 100 },
    protocol: {
      arms: ARMS,
      model: 'fixed-model',
      reasoningConfiguration: 'fixed-reasoning',
      tokenBudget: 1_000_000,
      evaluatorVersion: 'official-swebench-docker-v1',
      minRelativeResolutionLift: 0.2,
      maxCostIncreaseExclusive: 0.5,
      maxTotalCostUsd: 200,
      requireZeroPolicyViolations: true,
      requireReplayIntegrity: 1,
    },
    claimPredicates: [
      {
        claimId: 'avo-swebench-lift-20-v1',
        classification: 'performance',
        statementHash: sha256(SUPPORTED_RESTRICTED_CLAIMS['avo-swebench-lift-20-v1'].statement),
        predicateId: 'swebench-relative-lift-20-v1',
      },
      {
        claimId: 'avo-class-evidence-threshold-v1',
        classification: 'frontier',
        statementHash: sha256(SUPPORTED_RESTRICTED_CLAIMS['avo-class-evidence-threshold-v1'].statement),
        predicateId: 'swebench-relative-lift-20-v1',
      },
    ],
    runSignerKeyId: run.keyId,
    graderKeyIds: [graderA.keyId, graderB.keyId],
  };
  const preregistration = signed(preregistrationPayload, registration);
  const comparison = compareSWEbench({
    datasetKind: 'swe-bench-unseen-preregistered',
    model: preregistrationPayload.protocol.model,
    reasoningConfiguration: preregistrationPayload.protocol.reasoningConfiguration,
    tokenBudget: preregistrationPayload.protocol.tokenBudget,
    evaluatorVersion: preregistrationPayload.protocol.evaluatorVersion,
    taskSetHash,
    observations: observations(options.autonomousResolved),
  });
  const totalUsd = ARMS.reduce((sum, arm) => sum + comparison.arms[arm].totalCostUsd, 0);
  const benchmarkPayload: AvoBenchmarkReceipt = {
    schema: 'metaharness.avo.benchmark-receipt/v1',
    benchmarkId: preregistrationPayload.benchmarkId,
    repository: 'ruvnet/metaharness',
    sourceCommitSha: sourceSha,
    packageArtifactHash: ARTIFACT_HASH,
    preregistrationHash: preregistrationEvidenceHash(preregistration),
    startedAt: '2026-08-20T01:00:00.000Z',
    completedAt: '2026-08-20T02:00:00.000Z',
    taskSetHash,
    sampleSize: 100,
    observationsHash: sha256('raw-observations'),
    claimSetHash: sha256(preregistrationPayload.claimPredicates),
    comparison,
    cost: {
      currency: 'USD', measured: true, totalUsd,
      providerUsageReceiptHash: sha256('provider-usage-ledger'),
    },
    lineage: {
      expectedRuns: 300,
      completedRuns: 300,
      actionReceiptCount: 1_200,
      checkpointCount: 600,
      runManifestHash: sha256('run-manifest'),
      checkpointManifestHash: sha256('checkpoint-manifest'),
      actionReceiptsRootHash: sha256('action-receipts-root'),
      replayReceiptsRootHash: sha256('replay-receipts-root'),
      receiptChainsVerified: true,
      replayVerified: true,
    },
  };
  const benchmark = signed(benchmarkPayload, run);
  const graderPayload = (grader: Identity): IndependentGraderReceipt => ({
    schema: 'metaharness.avo.independent-grader/v1',
    benchmarkId: benchmarkPayload.benchmarkId,
    graderId: grader.keyId,
    organization: grader.organization!,
    sourceCommitSha: sourceSha,
    packageArtifactHash: ARTIFACT_HASH,
    preregistrationHash: preregistrationEvidenceHash(preregistration),
    benchmarkResultHash: benchmarkResultHash(benchmarkPayload),
    taskSetHash,
    sampleSize: 100,
    graderVersion: 'official-grader-v1',
    method: 'official-swebench-docker',
    gradedAt: '2026-08-20T03:00:00.000Z',
    verdict: 'pass',
    evidenceHash: sha256(`grader-evidence-${grader.keyId}`),
    claimSetHash: sha256(preregistrationPayload.claimPredicates),
    lineageEvidenceHash: sha256(benchmarkPayload.lineage),
    receiptChainsVerified: true,
    replayVerified: true,
  });
  const bundle: AvoClaimEvidenceBundle = {
    preregistration,
    benchmark,
    graders: [signed(graderPayload(graderA), graderA), signed(graderPayload(graderB), graderB)],
  };
  const manifest: ReleaseClaimManifest = {
    schema: 'metaharness.avo.release-claims/v1',
    claims: [
      {
        id: 'avo-swebench-lift-20-v1', classification: 'performance',
        statement: SUPPORTED_RESTRICTED_CLAIMS['avo-swebench-lift-20-v1'].statement,
        benchmarkId: preregistrationPayload.benchmarkId,
        evidenceBundleHash: claimEvidenceBundleHash(bundle),
      },
      {
        id: 'avo-class-evidence-threshold-v1', classification: 'frontier',
        statement: SUPPORTED_RESTRICTED_CLAIMS['avo-class-evidence-threshold-v1'].statement,
        benchmarkId: preregistrationPayload.benchmarkId,
        evidenceBundleHash: claimEvidenceBundleHash(bundle),
      },
    ],
    claimSurfaces: ['README.md', 'packages/avo/README.md'],
  };
  const trustPolicy: ClaimGateTrustPolicy = {
    schema: 'metaharness.avo.claim-trust/v1',
    registrationAuthorities: [{ keyId: registration.keyId, publicKey: registration.publicKey }],
    runAuthorities: [{ keyId: run.keyId, publicKey: run.publicKey }],
    graders: [
      { keyId: graderA.keyId, publicKey: graderA.publicKey, organization: graderA.organization! },
      { keyId: graderB.keyId, publicKey: graderB.publicKey, organization: graderB.organization! },
    ],
  };
  return { manifest, bundle, trustPolicy, identities: { registration, run, graderA, graderB } };
}

describe('AVO release claim gate', () => {
  it('allows explicitly bounded mechanism claims without benchmark evidence', () => {
    const manifest: ReleaseClaimManifest = {
      schema: 'metaharness.avo.release-claims/v1',
      claims: [{
        id: 'avo-package-surface-v1',
        classification: 'mechanism',
        statement: 'The AVO package exports an autonomous variation API and versioned evidence schemas.',
      }],
      claimSurfaces: ['README.md', 'packages/avo/README.md'],
    };
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      manifest,
      claimSurfaces: governedSurfaces(manifest),
    });
    expect(verdict).toMatchObject({ allowed: true, reasons: [] });
  });

  it('rejects a performance sentence mislabeled as a mechanism claim', () => {
    const manifest = {
      schema: 'metaharness.avo.release-claims/v1',
      claims: [{ id: 'avo-package-surface-v1', classification: 'mechanism', statement: 'AVO is frontier level.' }],
      claimSurfaces: ['README.md', 'packages/avo/README.md'],
    };
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      manifest,
      claimSurfaces: [
        { path: 'README.md', text: 'AVO is frontier level.' },
        { path: 'packages/avo/README.md', text: 'AVO is frontier level.' },
      ],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join('\n')).toMatch(/protected mechanism-claim registry/);
  });

  it('rejects an empty declaration list', () => {
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      manifest: {
        schema: 'metaharness.avo.release-claims/v1',
        claims: [],
        claimSurfaces: ['README.md', 'packages/avo/README.md'],
      },
      claimSurfaces: [{ path: 'README.md', text: '' }, { path: 'packages/avo/README.md', text: '' }],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons).toContain('release claim manifest is invalid');
  });

  it('allows performance and frontier claims only with the complete exact-SHA evidence chain', () => {
    const fixture = makeFixture();
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      currentPackageVersion: '0.2.0',
      currentPackageArtifactHash: ARTIFACT_HASH,
      manifest: fixture.manifest,
      evidenceBundles: [fixture.bundle],
      trustPolicy: fixture.trustPolicy,
      trustedPolicyHash: sha256(fixture.trustPolicy),
      claimSurfaces: governedSurfaces(fixture.manifest),
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.decisions).toHaveLength(2);
    expect(verdict.decisions.every((decision) => decision.allowed)).toBe(true);
  });

  it('rejects evidence for a different package tarball even at the same release SHA', () => {
    const fixture = makeFixture();
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      currentPackageVersion: '0.2.0',
      currentPackageArtifactHash: sha256('repacked-or-substituted-tarball'),
      manifest: fixture.manifest,
      evidenceBundles: [fixture.bundle],
      trustPolicy: fixture.trustPolicy,
      trustedPolicyHash: sha256(fixture.trustPolicy),
      claimSurfaces: governedSurfaces(fixture.manifest),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join('\n')).toMatch(/not the exact release tarball/);
  });

  it('rejects a manifest that removes a protected release surface', () => {
    const manifest = {
      schema: 'metaharness.avo.release-claims/v1',
      claims: [{
        id: 'avo-package-surface-v1',
        classification: 'mechanism',
        statement: 'The AVO package exports an autonomous variation API and versioned evidence schemas.',
      }],
      claimSurfaces: ['packages/avo/README.md'],
    };
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      manifest,
      claimSurfaces: [{ path: 'packages/avo/README.md', text: manifest.claims[0].statement }],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons).toContain('release claim manifest is invalid');
  });

  it('rejects semantic substitution of an exaggerated frontier statement onto valid generic evidence', () => {
    const fixture = makeFixture();
    fixture.manifest.claims[1].statement = 'AVO is the world-best frontier agent with 100 percent accuracy.';
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      currentPackageVersion: '0.2.0',
      currentPackageArtifactHash: ARTIFACT_HASH,
      manifest: fixture.manifest,
      evidenceBundles: [fixture.bundle],
      trustPolicy: fixture.trustPolicy,
      trustedPolicyHash: sha256(fixture.trustPolicy),
      claimSurfaces: governedSurfaces(fixture.manifest),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons).toContain('release claim manifest is invalid');
  });

  it('rejects an unlisted restricted claim in a governed release surface', () => {
    const fixture = makeFixture();
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      currentPackageVersion: '0.2.0',
      currentPackageArtifactHash: ARTIFACT_HASH,
      manifest: fixture.manifest,
      evidenceBundles: [fixture.bundle],
      trustPolicy: fixture.trustPolicy,
      trustedPolicyHash: sha256(fixture.trustPolicy),
      claimSurfaces: governedSurfaces(fixture.manifest, 'AVO beats every competing agent.'),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join('\n')).toMatch(/undeclared restricted AVO claim/);
  });

  it('rejects a valid bundle replayed against a different release SHA', () => {
    const fixture = makeFixture({ sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      currentPackageVersion: '0.2.0',
      currentPackageArtifactHash: ARTIFACT_HASH,
      manifest: fixture.manifest,
      evidenceBundles: [fixture.bundle],
      trustPolicy: fixture.trustPolicy,
      trustedPolicyHash: sha256(fixture.trustPolicy),
      claimSurfaces: governedSurfaces(fixture.manifest),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join('\n')).toMatch(/source SHA is not the release SHA/);
  });

  it('rejects a caller-replaced trust policy that does not match the protected digest', () => {
    const fixture = makeFixture();
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      currentPackageVersion: '0.2.0',
      currentPackageArtifactHash: ARTIFACT_HASH,
      manifest: fixture.manifest,
      evidenceBundles: [fixture.bundle],
      trustPolicy: fixture.trustPolicy,
      trustedPolicyHash: sha256('different-protected-policy'),
      claimSurfaces: governedSurfaces(fixture.manifest),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons).toContain('trust policy does not match the protected trust-policy hash');
  });

  it('rejects tampering even when the manifest is changed to the tampered bundle hash', () => {
    const fixture = makeFixture();
    fixture.bundle.benchmark.payload.cost.providerUsageReceiptHash = sha256('tampered-usage-ledger');
    fixture.manifest.claims.forEach((claim) => { claim.evidenceBundleHash = claimEvidenceBundleHash(fixture.bundle); });
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      currentPackageVersion: '0.2.0',
      currentPackageArtifactHash: ARTIFACT_HASH,
      manifest: fixture.manifest,
      evidenceBundles: [fixture.bundle],
      trustPolicy: fixture.trustPolicy,
      trustedPolicyHash: sha256(fixture.trustPolicy),
      claimSurfaces: governedSurfaces(fixture.manifest),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join('\n')).toMatch(/benchmark signature is invalid/);
  });

  it('rejects graders that are not organizationally independent', () => {
    const fixture = makeFixture({ graderOrganizations: ['same-grader-org', 'same-grader-org'] });
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      currentPackageVersion: '0.2.0',
      currentPackageArtifactHash: ARTIFACT_HASH,
      manifest: fixture.manifest,
      evidenceBundles: [fixture.bundle],
      trustPolicy: fixture.trustPolicy,
      trustedPolicyHash: sha256(fixture.trustPolicy),
      claimSurfaces: governedSurfaces(fixture.manifest),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join('\n')).toMatch(/distinct organizations/);
  });

  it('rejects an untrusted self-signed grader', () => {
    const fixture = makeFixture();
    const attacker = identity('grader-b', 'grader-labs-b');
    fixture.bundle.graders[1] = signed(fixture.bundle.graders[1].payload, attacker);
    fixture.manifest.claims.forEach((claim) => { claim.evidenceBundleHash = claimEvidenceBundleHash(fixture.bundle); });
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      currentPackageVersion: '0.2.0',
      currentPackageArtifactHash: ARTIFACT_HASH,
      manifest: fixture.manifest,
      evidenceBundles: [fixture.bundle],
      trustPolicy: fixture.trustPolicy,
      trustedPolicyHash: sha256(fixture.trustPolicy),
      claimSurfaces: governedSurfaces(fixture.manifest),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join('\n')).toMatch(/grader grader-b signature is invalid or untrusted/);
  });

  it('rejects a signed result that misses the preregistered performance threshold', () => {
    const fixture = makeFixture({ autonomousResolved: 47 });
    const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      currentPackageVersion: '0.2.0',
      currentPackageArtifactHash: ARTIFACT_HASH,
      manifest: fixture.manifest,
      evidenceBundles: [fixture.bundle],
      trustPolicy: fixture.trustPolicy,
      trustedPolicyHash: sha256(fixture.trustPolicy),
      claimSurfaces: governedSurfaces(fixture.manifest),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join('\n')).toMatch(/resolution lift is below 20%/);
  });

  it('rejects missing cost, lineage, sample, and independent-grader evidence fail closed', () => {
    for (const mutation of ['cost', 'lineage', 'sample', 'grader'] as const) {
      const fixture = makeFixture();
      if (mutation === 'cost') (fixture.bundle.benchmark.payload.cost as { measured?: boolean }).measured = false;
      if (mutation === 'lineage') fixture.bundle.benchmark.payload.lineage.actionReceiptCount = 0;
      if (mutation === 'sample') (fixture.bundle.benchmark.payload as { sampleSize: number }).sampleSize = 99;
      if (mutation === 'grader') fixture.bundle.graders.pop();
      fixture.manifest.claims.forEach((claim) => { claim.evidenceBundleHash = claimEvidenceBundleHash(fixture.bundle); });
      const verdict = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      currentPackageVersion: '0.2.0',
      currentPackageArtifactHash: ARTIFACT_HASH,
      manifest: fixture.manifest,
        evidenceBundles: [fixture.bundle],
        trustPolicy: fixture.trustPolicy,
        trustedPolicyHash: sha256(fixture.trustPolicy),
        claimSurfaces: governedSurfaces(fixture.manifest),
      });
      expect(verdict.allowed, mutation).toBe(false);
    }
  });

  it('rejects malformed manifests and absent evidence instead of treating them as mechanism claims', () => {
    const malformed = evaluateReleaseClaimGate({
      currentSourceSha: SHA,
      manifest: { schema: 'metaharness.avo.release-claims/v1', claims: [{ id: 'x', classification: 'frontier', statement: 'claim' }] },
    });
    expect(malformed.allowed).toBe(false);
    expect(malformed.reasons).toContain('release claim manifest is invalid');
  });
});
