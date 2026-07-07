// SPDX-License-Identifier: MIT
//
// Public types for @metaharness/workspace-lens. The package is a RUNTIME measurement primitive: given a
// pre-fitted Jacobian lens artifact + captured hidden activations, it reads the model's "verbalizable
// workspace" (Anthropic, 2026-07-06) and emits a signable interpretability receipt. It does not fit the
// lens (that needs the model's backward pass — external, GPU) and it does not run the model.

/** A fitted per-layer Jacobian operator J_l ∈ ℝ^{dModel×dModel}, plus the shared decode path. */
export interface LensLayer {
  /** Transformer layer index this operator was fitted for. */
  layer: number;
  /** Row-major J_l (dModel×dModel): the average input→output Jacobian for this layer. */
  jacobian: readonly (readonly number[])[];
}

/**
 * A fitted lens artifact for ONE model. Model-agnostic by construction: the vocabulary and the
 * unembedding live in the artifact, so scoring never touches a tokenizer at runtime. Fitted OUT OF BAND
 * (open-weight model + backward pass; see the reference `anthropics/jacobian-lens` + Neuronpedia), then
 * serialized and loaded here.
 */
export interface LensArtifact {
  /** Stable id for this fitted lens (e.g. "jlens-qwen2.5-7b-v2") — recorded in every receipt. */
  lensId: string;
  /** The model the lens was fitted on (e.g. "qwen2.5-7b-instruct"). */
  modelId: string;
  /** Residual-stream width. */
  dModel: number;
  /** Decoded vocabulary — token strings aligned to the unembed rows. */
  vocab: readonly string[];
  /** Unembedding U ∈ ℝ^{vocab×dModel}. lens_l(h) = U · (J_l · h). */
  unembed: readonly (readonly number[])[];
  /** The fitted per-layer operators, keyed by layer index. */
  layers: readonly LensLayer[];
}

/** A captured residual-stream activation at a specific (layer, position). Supplied by the caller. */
export interface HiddenState {
  layer: number;
  /** Token position in the sequence the activation was captured at. */
  position: number;
  /** The residual vector h_l ∈ ℝ^{dModel}. */
  h: readonly number[];
}

/** One decoded workspace token: what the activation is DISPOSED to make the model say later. */
export interface WorkspaceToken {
  token: string;
  /** 0-based rank in the lens readout (0 = most probable). */
  rank: number;
  /** The lens logit for this token (pre-softmax). */
  logit: number;
  /** The softmax probability for this token within the readout. */
  prob: number;
}

/** A per-(layer,position) readout of the workspace. */
export interface WorkspaceReadout {
  layer: number;
  position: number;
  tokens: WorkspaceToken[];
  /** Shannon entropy (nats) of the full readout distribution — how diffuse the workspace is here. */
  entropy: number;
}

/**
 * A concept represented as a DIRECTION in a given model's J-space (NOT a token string). This is how the
 * package aligns concepts across architectural families with different tokenizers (Qwen vs Gemma): a
 * canonical concept name maps to a per-model unit vector fitted from example activations, so the safety
 * trigger is a dot-product in activation space, tokenizer-agnostic. `modelId` guards against applying a
 * Qwen concept vector to a Gemma activation.
 */
export interface ConceptVector {
  /** Canonical concept name, aligned across models (e.g. "hidden_objective", "exfiltration"). */
  concept: string;
  /** The model this vector lives in — MUST match the lens/activation model. */
  modelId: string;
  /** Unit (or arbitrary) direction in J-space, length dModel. */
  vector: readonly number[];
  /** Optional: treat concept as CRITICAL — a trigger fails the decision rule closed. */
  critical?: boolean;
}

/** A fired concept trigger. */
export interface ConceptTrigger {
  concept: string;
  layer: number;
  position: number;
  /** Cosine similarity of the J-projected activation to the concept direction. */
  score: number;
  critical: boolean;
}

/** The four headline safety flags (Anthropic's workspace examples: eval-awareness, manipulation, …). */
export interface SafetyFlags {
  promptInjection: boolean;
  evalAwareness: boolean;
  hiddenObjective: boolean;
  refusalConflict: boolean;
}

/**
 * The signable interpretability receipt — the audit artifact. "correctness first, cost second, receipts
 * always": it records WHAT concepts were active in the workspace when a decision was made, with the
 * layer-by-layer trajectory so an auditor can see WHERE a decision formed, not just the final answer.
 */
export interface WorkspaceLensReceipt {
  promptHash: string;
  modelId: string;
  lensId: string;
  layerRange: [number, number];
  positions: number[];
  topTokens: Array<{
    layer: number;
    position: number;
    tokens: Array<{ token: string; rank: number; logit: number }>;
  }>;
  flags: SafetyFlags;
  triggers: ConceptTrigger[];
  /** Aggregate J-space distribution stability across the readouts (mean JS-divergence between steps). */
  workspaceDrift: number;
  /** Per-readout entropy — is the internal workspace converging (falling) or dissolving (rising)? */
  entropyTrajectory: number[];
  createdAt: string;
}

/** Inputs to the accept/reject decision rule. */
export interface DecisionInput {
  taskResolved: boolean;
  workspaceDrift: number;
  driftThreshold: number;
  triggers: ConceptTrigger[];
  /** Fraction of monitored decisions that produced a receipt (1 = full coverage). */
  receiptCoverage: number;
}

export interface DecisionResult {
  accepted: boolean;
  reasons: string[];
}
