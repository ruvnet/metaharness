// SPDX-License-Identifier: Apache-2.0

import type { ToolExecutionResult } from './executor.js';

/** Minimal transcript shape accepted by the completion verifier. */
export interface CompletionEvidenceEvent {
  /** Stable event identity. Tool events emitted by Horizon use `tool:<actionCount>`. */
  id?: string;
  role: 'model' | 'tool' | 'summary';
  text: string;
  receipt?: ToolExecutionResult;
}

/** Reference to one immutable transcript event used as evidence for a claim. */
export interface CompletionEvidenceRef {
  /** Stable event ID, never a mutable transcript array position. */
  eventId: string;
  /** Optional binding to the exact workspace artifact digest observed at the event. */
  artifactDigest?: string;
}

/** One answer claim whose value must be reconstructable from referenced evidence. */
export interface CompletionClaim {
  id: string;
  value: string;
  evidence: CompletionEvidenceRef[];
}

/** Model-proposed certificate presented at the COMPLETE boundary. */
export interface CompletionCertificate {
  claims: CompletionClaim[];
}

export interface CompletionConfig {
  /** Claim IDs that must be present exactly once before completion is accepted. */
  requiredClaims: string[];
  /** Eligible transcript roles. Tool evidence is the safe default. */
  allowedEvidenceRoles?: CompletionEvidenceEvent['role'][];
  /** Require referenced tool actions to have been authorized by policy. Default true. */
  requireAuthorizedToolEvidence?: boolean;
  /** Require referenced tool actions to have exited successfully. Default true. */
  requireSuccessfulToolEvidence?: boolean;
  /** Bound verifier work and certificate size. Default 32. */
  maxEvidenceRefsPerClaim?: number;
}

/** Trusted replay seam. It must deterministically reconstruct the claim value from evidence. */
export type CompletionReplay = (
  claim: CompletionClaim,
  evidence: CompletionEvidenceEvent[],
) => string | Promise<string>;

export interface CompletionVerification {
  ok: boolean;
  errors: string[];
  checkedClaims: string[];
}

function normalizedConfig(config: CompletionConfig): Required<CompletionConfig> {
  return {
    requiredClaims: [...config.requiredClaims],
    allowedEvidenceRoles: config.allowedEvidenceRoles ?? ['tool'],
    requireAuthorizedToolEvidence: config.requireAuthorizedToolEvidence ?? true,
    requireSuccessfulToolEvidence: config.requireSuccessfulToolEvidence ?? true,
    maxEvidenceRefsPerClaim: config.maxEvidenceRefsPerClaim ?? 32,
  };
}

/**
 * Verify an evidence-carrying completion certificate against the recorded transcript.
 *
 * This proves only that declared claims are supported by eligible recorded evidence and
 * reconstruct under the caller's deterministic replay function. It does not prove external
 * truth, safety, or alignment and it cannot grant execution authority.
 */
export async function verifyCompletionCertificate(
  certificate: CompletionCertificate | undefined,
  events: CompletionEvidenceEvent[],
  config: CompletionConfig,
  replay: CompletionReplay | undefined,
): Promise<CompletionVerification> {
  const c = normalizedConfig(config);
  const errors: string[] = [];
  const checkedClaims: string[] = [];

  if (!certificate || !Array.isArray(certificate.claims)) {
    return { ok: false, errors: ['completion certificate missing'], checkedClaims };
  }
  if (!replay) {
    return { ok: false, errors: ['completion replay seam missing'], checkedClaims };
  }
  if (!Number.isInteger(c.maxEvidenceRefsPerClaim) || c.maxEvidenceRefsPerClaim < 1) {
    return { ok: false, errors: ['maxEvidenceRefsPerClaim must be a positive integer'], checkedClaims };
  }

  const required = new Set<string>();
  for (const id of c.requiredClaims) {
    if (!id || typeof id !== 'string') errors.push('required claim IDs must be non-empty strings');
    if (required.has(id)) errors.push(`required claim duplicated: ${id}`);
    required.add(id);
  }

  const byId = new Map<string, CompletionClaim>();
  for (const claim of certificate.claims) {
    if (!claim || typeof claim.id !== 'string' || !claim.id) {
      errors.push('certificate contains a claim with an invalid id');
      continue;
    }
    if (byId.has(claim.id)) {
      errors.push(`certificate claim duplicated: ${claim.id}`);
      continue;
    }
    byId.set(claim.id, claim);
  }

  const eventsById = new Map<string, CompletionEvidenceEvent>();
  const duplicateEventIds = new Set<string>();
  for (const event of events) {
    if (!event.id) continue;
    if (eventsById.has(event.id)) duplicateEventIds.add(event.id);
    else eventsById.set(event.id, event);
  }

  for (const id of required) {
    const claim = byId.get(id);
    if (!claim) {
      errors.push(`required claim missing: ${id}`);
      continue;
    }
    checkedClaims.push(id);

    if (typeof claim.value !== 'string') {
      errors.push(`claim ${id}: value must be a string`);
      continue;
    }
    if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
      errors.push(`claim ${id}: no evidence references`);
      continue;
    }
    if (claim.evidence.length > c.maxEvidenceRefsPerClaim) {
      errors.push(`claim ${id}: evidence reference limit exceeded`);
      continue;
    }

    const evidence: CompletionEvidenceEvent[] = [];
    const seenRefs = new Set<string>();
    let invalidEvidence = false;
    for (const ref of claim.evidence) {
      if (!ref || typeof ref.eventId !== 'string' || !ref.eventId) {
        errors.push(`claim ${id}: evidence reference has invalid event id`);
        invalidEvidence = true;
        continue;
      }
      if (seenRefs.has(ref.eventId)) {
        errors.push(`claim ${id}: duplicate evidence reference ${ref.eventId}`);
        invalidEvidence = true;
        continue;
      }
      seenRefs.add(ref.eventId);
      if (duplicateEventIds.has(ref.eventId)) {
        errors.push(`claim ${id}: evidence event id is ambiguous: ${ref.eventId}`);
        invalidEvidence = true;
        continue;
      }

      const event = eventsById.get(ref.eventId);
      if (!event) {
        errors.push(`claim ${id}: evidence event not found: ${ref.eventId}`);
        invalidEvidence = true;
        continue;
      }
      if (!c.allowedEvidenceRoles.includes(event.role)) {
        errors.push(`claim ${id}: event ${ref.eventId} role ${event.role} is not eligible evidence`);
        invalidEvidence = true;
        continue;
      }
      if (event.role === 'tool') {
        if (!event.receipt) {
          errors.push(`claim ${id}: event ${ref.eventId} has no tool receipt`);
          invalidEvidence = true;
          continue;
        }
        if (c.requireAuthorizedToolEvidence && !event.receipt.policyReceipt.authorized) {
          errors.push(`claim ${id}: event ${ref.eventId} was not authorized`);
          invalidEvidence = true;
          continue;
        }
        if (c.requireSuccessfulToolEvidence && event.receipt.exitCode !== 0) {
          errors.push(`claim ${id}: event ${ref.eventId} did not succeed`);
          invalidEvidence = true;
          continue;
        }
        if (ref.artifactDigest !== undefined && ref.artifactDigest !== event.receipt.artifactDigest) {
          errors.push(`claim ${id}: artifact digest mismatch at event ${ref.eventId}`);
          invalidEvidence = true;
          continue;
        }
      }
      evidence.push(event);
    }

    if (invalidEvidence) continue;
    try {
      const reconstructed = await replay(claim, evidence);
      if (reconstructed !== claim.value) {
        errors.push(`claim ${id}: replay mismatch`);
      }
    } catch (error) {
      errors.push(`claim ${id}: replay failed: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
    }
  }

  return { ok: errors.length === 0, errors, checkedClaims };
}
