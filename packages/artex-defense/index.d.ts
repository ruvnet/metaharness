// SPDX-License-Identifier: MIT
/// <reference types="node" />
// Hand-written declarations for the JavaScript sources. Evidence bundles, policy
// results and receipts are deliberately typed as opaque records: their exact
// shape is defined and validated by the runtime, see README "Accepted evidence".

/** Output of one CLI subcommand. `lines` belong on stdout, `errors` on stderr. */
export interface DispatchResult {
  code: number;
  lines: string[];
  errors: string[];
}

/** Run `replay`, `verify`, `benchmark` or `help`. Never calls process.exit. */
export function dispatch(action: string | undefined, args?: string[]): Promise<DispatchResult>;

export interface ImportManifest {
  format: 'csv' | 'json';
  tenant: string;
  caseId: string;
  expectedSha256: string;
}

export type EvidenceBundle = Record<string, unknown>;
export type PolicyResult = Record<string, unknown>;
export type ReplayMode = 'monitor' | 'simulate';

export const MAX_INPUT_BYTES: number;
export const MAX_EVENTS: number;
export function parseEvidenceJSON(text: string): unknown;
export function importEvidence(input: string | Uint8Array, manifest: ImportManifest): EvidenceBundle;
export function evaluateCase(bundle: EvidenceBundle, mode?: ReplayMode, policy?: 'baseline' | 'candidate'): PolicyResult;
export function evaluatePolicies(bundle: EvidenceBundle, mode?: ReplayMode): { baseline: PolicyResult; candidate: PolicyResult };
export function verifyReplay(receipt: unknown, bundle: EvidenceBundle, trustedDigest: string): boolean;
export function simulateResponse(result: PolicyResult, options?: { rollbacks?: unknown[] }): Record<string, unknown>;
export function createReplayReceipt(bundle: EvidenceBundle, result: Record<string, unknown>): Record<string, unknown> & { tailSha256: string };
export function verifyReplayReceipt(artifact: unknown, bundle: EvidenceBundle, result: Record<string, unknown>, expectedTailSha256: string): boolean;
export function verifyReplayReport(raw: Buffer, bundle: EvidenceBundle, result: Record<string, unknown>, expectedTailSha256: string): boolean;
