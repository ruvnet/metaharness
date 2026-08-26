# ADR-272: Evidence-Carrying Termination

## Status

Proposed

## Context

Long-running tool-using agents can declare completion before every required claim is supported by valid execution evidence. Existing halt, command-guard, checkpoint, and witness mechanisms protect execution and continuity, but the `COMPLETE` boundary itself is not evidence-gated.

Recent Evidence-Carrying Termination research evaluates a typed certificate that binds required answer claims to in-scope trace evidence and requires deterministic replay before completion. The reported study found zero unsafe completions in its locked synthetic evaluation while preserving supported completion within a non-inferiority margin. The result certifies trace support under declared assumptions, not external truth or general safety.

## Decision

Add an optional evidence-carrying completion gate to `@metaharness/horizon`.

A completion certificate contains named claims and stable transcript evidence references. When enabled, the driver accepts a final answer only when:

1. every configured required claim appears exactly once,
2. every evidence reference resolves to one unambiguous eligible transcript event,
3. tool evidence is successful and authorized unless the policy explicitly relaxes that requirement,
4. any asserted artifact digest matches the recorded receipt,
5. an injected deterministic replay function reconstructs the claimed value.

Evidence references use stable event IDs rather than transcript array positions. Compaction can change array positions, so positional references would allow stale references to resolve to the wrong event. Tool events emitted by Horizon receive monotonically unique IDs derived from the persisted action counter.

Rejected completion attempts are recorded as structured summary events and fed into the existing repeated-failure and iteration-budget guards so an agent can recover but cannot loop forever.

The feature is opt-in. Existing Horizon users retain existing completion behavior unless a completion policy is configured.

## Interface

```ts
interface CompletionClaim {
  id: string;
  value: string;
  evidence: CompletionEvidenceRef[];
}

interface CompletionEvidenceRef {
  eventId: string;
  artifactDigest?: string;
}

interface CompletionCertificate {
  claims: CompletionClaim[];
}

interface CompletionConfig {
  requiredClaims: string[];
  requireAuthorizedToolEvidence?: boolean;
}
```

`DriverSeams.replayCompletion` is the trust seam that re-executes or deterministically reconstructs one claim from the referenced evidence. It is never model-authored.

## Security invariants

A certificate is evidence, not authority. It cannot grant capabilities, expand command policy, approve gated actions, or mutate the evaluator. Model-authored text cannot mark a failed or denied tool action as valid evidence. Completion fails closed when replay is missing, an event ID is missing or ambiguous, an artifact digest differs, or a required claim is unsupported.

Compaction may remove old evidence. That produces a safe verification failure, never a retargeted reference, because event IDs are stable and never reused.

## Consequences

The completion boundary becomes replayable and auditable without coupling Horizon to a particular task schema. Domain harnesses define required claims and replay logic. RVM or RVF can later sign the resulting completion receipt without changing the core verifier.

The tradeoff is additional task-specific replay work and small deterministic verification overhead. This is intentionally paid only at attempted completion, not on every model token or tool call.

## Rollback

Remove the optional `completion` configuration or revert this ADR and its companion implementation. No persistent data migration is required and existing checkpoints remain valid because the new certificate is not stored in the checkpoint schema.

## Acceptance

The implementation must reject missing claims, missing or ambiguous event IDs, denied tool evidence, digest mismatch, and replay mismatch. A driver test must demonstrate recovery after a rejected premature completion and successful completion only after new valid evidence appears.
