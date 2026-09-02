// SPDX-License-Identifier: MIT
//
// ADR-271 — AVO → meta-llm flywheel-gate contract (harness-side producer).
//
// meta-llm's `POST /v1/flywheel/gate` (its `src/evolve/gate.ts`) is a RECEIPT-VERIFIER: it authorizes
// a candidate only from SIGNED RECEIPTS, never from claims. AVO already produces Ed25519-signed,
// hash-chained receipts for its variation run; this module serializes an AVO run's aggregate outcome
// into exactly the five `SignedReceipt`s that gate consumes, so an AVO benchmark result can be
// submitted for a governed promotion verdict WITHOUT porting AVO's runtime into the gateway.
//
// Trust is anchored in TWO layers, and BOTH must hold: (1) the gate re-derives the promotion decision
// (`meetsPromotionRule`) from the holdout evidence and cross-checks the replay receipt, so a forged
// score cannot promote; and (2) meta-llm #118 — the gate authorizes a receipt ONLY when its signer is
// on the gateway's allowlist (`FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON`), because a self-signed receipt under
// a throwaway key is a CLAIM with a signature, exactly what ADR-249 F-P4 rejects. So this contract
// REQUIRES the operator to register the harness signing key (`gateTrustedKey(signer)`) in that
// allowlist, and the run must sign with a STABLE key, not a per-submission one. The two primitives
// below (`canon` + `meetsPromotionRule`) are EXACT mirrors of the gate's — a
// receipt this module signs must verify under the gate's `edVerify(null, canon(payload), pub, sig)`,
// and the decision it stamps into the replay receipt must reproduce the gate's own re-run. They are
// pinned to the gateway definitions by `__tests__/flywheelGate.test.ts`; if the gate changes either,
// that test must be updated in lockstep (the cross-repo contract this ADR governs).
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';

/* ── mirrors of the meta-llm gate primitives (src/evolve/gate.ts + flywheel/genomeRegistry.ts) ── */

/** Canonical JSON — byte-identical to the gate's `canon`. Object keys sorted; used for both the
 *  signed bytes and the manifest hashes, so signatures verify and hashes match cross-repo. */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The five aggregate metrics the gate's holdout rule compares (mirror of `PromotionEvidence`). */
export interface GatePromotionEvidence {
  currentGold: number;
  candidateGold: number;
  currentEmptyPatchRate: number;
  candidateEmptyPatchRate: number;
  currentCostPerResolved: number;
  candidateCostPerResolved: number;
  currentHostHoldoutGold: number;
  candidateHostHoldoutGold: number;
  currentHostHoldoutFailureRate: number;
  candidateHostHoldoutFailureRate: number;
  safetyRegression: boolean;
  /** ADR-239 lagged-truth falsifier — AVO has no lagged telemetry, so this stays null (never fires). */
  laggedFalsifier?: null;
}

export interface GatePromotionDecision {
  promote: boolean;
  reasons: string[];
}

/** EXACT mirror of the gate's `meetsPromotionRule`, including the fixed reason ORDER — the replay
 *  check compares `canon(claimed.reasons) === canon(reDecision.reasons)`, so order is load-bearing.
 *  The lagged-falsifier clause is omitted because this producer only ever supplies `laggedFalsifier:
 *  null` (honest: no lagged telemetry) — matching the gate, whose clause cannot fire on null. */
export function meetsPromotionRule(e: GatePromotionEvidence): GatePromotionDecision {
  const reasons: string[] = [];
  if (e.candidateGold < e.currentGold) reasons.push('gold_regressed');
  if (!(e.candidateEmptyPatchRate < e.currentEmptyPatchRate)) reasons.push('empty_patch_not_improved');
  if (e.candidateCostPerResolved > e.currentCostPerResolved) reasons.push('cost_per_resolved_worsened');
  if (!(e.candidateHostHoldoutGold >= e.currentHostHoldoutGold
      && e.candidateHostHoldoutFailureRate <= e.currentHostHoldoutFailureRate)) {
    reasons.push('host_holdout_not_improved');
  }
  if (e.safetyRegression) reasons.push('safety_regression');
  return { promote: reasons.length === 0, reasons };
}

/* ── the gate's wire types ── */

export interface SignedReceipt {
  payload: Record<string, unknown>;
  signature: string; // base64 Ed25519 over canon(payload)
  publicKey: string; // base64 SPKI DER
  alg: 'ed25519';
}

export interface GatePolicyManifest {
  host: string;
  cheap_model: string;
  task_class: string | null;
  tenant_id?: string;
  generation?: number;
  parent_lineage_id?: string;
  mutation_class?: string;
  mutation_summary?: string;
  [k: string]: unknown;
}

export interface GateInput {
  baseline_manifest: GatePolicyManifest;
  candidate_manifest: GatePolicyManifest;
  holdout_receipt: SignedReceipt;
  security_receipt: SignedReceipt;
  drift_receipt: SignedReceipt;
  replay_receipt: SignedReceipt;
  cost_receipt: SignedReceipt;
}

/* ── signing ── */

/** An Ed25519 keypair used to sign the gate receipts. Reuse the same keypair that backs the AVO
 *  run's `Ed25519ReceiptSigner` to tie the gate submission to the run's signing identity. */
export interface GateSigner {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** Generate a fresh Ed25519 gate signer. Under meta-llm #118 the gate authorizes only ALLOWLISTED
 *  signers, so a freshly generated key is useless until its `gateTrustedKey(signer)` is registered in
 *  the gateway's `FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON`. Prefer a STABLE key reused across a run's
 *  submissions (ideally the same keypair that backs the AVO run's `Ed25519ReceiptSigner`). */
export function generateGateSigner(): GateSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
}

/** The signer's public key as base64 SPKI DER — the exact string an operator adds to the gateway's
 *  `FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON` allowlist so this harness's receipts are authorized (#118).
 *  Without this registration every submission fails `FAIL_INSUFFICIENT_RECEIPTS` (untrusted signer). */
export function gateTrustedKey(signer: GateSigner): string {
  return (signer.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
}

/** Sign one receipt payload the way the gate verifies it: Ed25519 over `canon(payload)`, with the
 *  SPKI-DER public key embedded so `receiptValid` can verify without any out-of-band key exchange. */
export function signGateReceipt(payload: Record<string, unknown>, signer: GateSigner): SignedReceipt {
  return {
    payload,
    signature: edSign(null, Buffer.from(canon(payload)), signer.privateKey).toString('base64'),
    publicKey: (signer.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
    alg: 'ed25519',
  };
}

/* ── the run summary → the input the gate reads ── */

/** One arm's aggregate benchmark metrics (baseline = the frozen-model/seed arm; candidate = the AVO
 *  variation arm). These are the numbers an AVO benchmark run already produces per arm. */
export interface AvoArmMetrics {
  /** Resolved count on the dev/benchmark set (the gate's "gold"). */
  gold: number;
  /** Fraction of tasks that produced an empty/blank patch, in [0,1]. */
  emptyPatchRate: number;
  /** USD spent per resolved instance. */
  costPerResolved: number;
  /** Resolved count on the host-specific holdout slice. */
  hostHoldoutGold: number;
  /** Failure rate on the host holdout slice, in [0,1]. */
  hostHoldoutFailureRate: number;
}

/** Everything the adapter needs from an AVO run to build a gate submission. `manifest` names the
 *  governance scope (host / cheap_model / task_class) shared by every receipt; `candidateCheckpointHash`
 *  anchors the submission to AVO's signed checkpoint chain. */
export interface AvoRunSummary {
  host: string;
  /** The model under test (the gate's `cheap_model` scope key). */
  cheapModel: string;
  taskClass: string | null;
  baseline: AvoArmMetrics;
  candidate: AvoArmMetrics;
  /** True iff the AVO gate flagged any policy/safety/conformance violation on the candidate
   *  (i.e. `zeroViolations` was false). A hard block. */
  safetyRegression: boolean;
  /** The signed AVO `VariationCheckpoint.checkpointHash` for the promoted candidate — carried on the
   *  candidate manifest so the gate receipts are provably bound to the AVO run that produced them. */
  candidateCheckpointHash?: string;
  /** Optional tenant binding. Must equal the submitting account or the gate's governance check
   *  (`declaredTenant === caller`) fails. Omit to let any authenticated caller submit. */
  tenantId?: string;
  generation?: number;
  parentLineageId?: string;
  mutationClass?: string;
  mutationSummary?: string;
}

function evidenceOf(s: AvoRunSummary): GatePromotionEvidence {
  return {
    currentGold: s.baseline.gold,
    candidateGold: s.candidate.gold,
    currentEmptyPatchRate: s.baseline.emptyPatchRate,
    candidateEmptyPatchRate: s.candidate.emptyPatchRate,
    currentCostPerResolved: s.baseline.costPerResolved,
    candidateCostPerResolved: s.candidate.costPerResolved,
    currentHostHoldoutGold: s.baseline.hostHoldoutGold,
    candidateHostHoldoutGold: s.candidate.hostHoldoutGold,
    currentHostHoldoutFailureRate: s.baseline.hostHoldoutFailureRate,
    candidateHostHoldoutFailureRate: s.candidate.hostHoldoutFailureRate,
    safetyRegression: s.safetyRegression,
    laggedFalsifier: null,
  };
}

/**
 * Serialize an AVO run summary into the gate's `GateInput`: two manifests + the five signed receipts,
 * every scope-bearing payload agreeing on `{host, cheap_model, task_class}`, the replay receipt
 * carrying the re-derivable decision + manifest hashes, and every receipt Ed25519-signed so the gate's
 * receipt-validity check passes. The gate then runs its 5 VERIFY checks unchanged.
 */
export function receiptsToGateInput(summary: AvoRunSummary, signer: GateSigner): GateInput {
  const scope = { host: summary.host, cheap_model: summary.cheapModel, task_class: summary.taskClass };
  const evidence = evidenceOf(summary);
  const decision = meetsPromotionRule(evidence);

  const baseline_manifest: GatePolicyManifest = { ...scope };
  const candidate_manifest: GatePolicyManifest = {
    ...scope,
    ...(summary.tenantId !== undefined ? { tenant_id: summary.tenantId } : {}),
    ...(summary.generation !== undefined ? { generation: summary.generation } : {}),
    ...(summary.parentLineageId !== undefined ? { parent_lineage_id: summary.parentLineageId } : {}),
    ...(summary.mutationClass !== undefined ? { mutation_class: summary.mutationClass } : {}),
    ...(summary.mutationSummary !== undefined ? { mutation_summary: summary.mutationSummary } : {}),
    ...(summary.candidateCheckpointHash !== undefined ? { candidate_checkpoint_hash: summary.candidateCheckpointHash } : {}),
  };

  return {
    baseline_manifest,
    candidate_manifest,
    holdout_receipt: signGateReceipt({ ...scope, evidence: evidence as unknown as Record<string, unknown> }, signer),
    security_receipt: signGateReceipt({ ...scope, security_regression: summary.safetyRegression }, signer),
    drift_receipt: signGateReceipt({ ...scope, laggedFalsifier: null }, signer),
    replay_receipt: signGateReceipt({
      baseline_manifest_hash: sha256hex(canon(baseline_manifest)),
      candidate_manifest_hash: sha256hex(canon(candidate_manifest)),
      decision,
    }, signer),
    cost_receipt: signGateReceipt({ ...scope, cost_per_resolved: summary.candidate.costPerResolved }, signer),
  };
}

/* ── submission ── */

export interface FlywheelGateResult {
  verdict: string;
  reasons: string[];
  checks?: Record<string, boolean>;
  decision_receipt?: SignedReceipt;
  [k: string]: unknown;
}

export interface SubmitOptions {
  /** meta-llm base URL, e.g. `https://api.cognitum.one`. `/v1/flywheel/gate` is appended. */
  baseUrl: string;
  /** A `cog_` key holding the `flywheel:gate` scope; sent as `X-API-Key`. */
  apiKey: string;
  /** Injectable fetch (defaults to global fetch) for testing/non-browser runtimes. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms (default 30_000). */
  timeoutMs?: number;
}

/** POST a `GateInput` to meta-llm's flywheel gate and return its verdict. Never throws on a gate
 *  FAIL verdict — that is a normal 200 response; it throws only on transport/auth failure. */
export async function submitToFlywheelGate(input: GateInput, opts: SubmitOptions): Promise<FlywheelGateResult> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/$/, '')}/v1/flywheel/gate`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': opts.apiKey },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`flywheel gate ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text) as FlywheelGateResult;
  } finally {
    clearTimeout(timer);
  }
}
