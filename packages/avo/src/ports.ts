// SPDX-License-Identifier: MIT

import type {
  ActionObservation,
  Candidate,
  EvaluationResult,
  PolicyDecision,
  StructuredMemoryRecord,
  SupervisorIntervention,
  VariationAction,
  VariationCheckpoint,
  VariationContext,
  VariationState,
} from './types.js';

export interface VariationAgent {
  chooseAction(context: VariationContext): Promise<VariationAction | AgentActionDecision>;
}

export interface AgentActionDecision {
  action: VariationAction;
  costUsd: number;
  durationMs: number;
  /** Provider/model usage metadata only; raw private reasoning is prohibited. */
  receipt?: Record<string, unknown>;
}

export interface EnvironmentAdapter {
  readonly version: string;
  fork(parent: Candidate): Promise<{ branchId: string; workspaceDigest: string }>;
  execute(action: VariationAction, state: Readonly<VariationState>): Promise<ActionObservation>;
  quarantine(branchId: string, reason: string): Promise<void>;
}

export interface EvaluatorSuite {
  readonly version: string;
  evaluate(branchId: string, parent?: EvaluationResult): Promise<EvaluationResult>;
}

export interface CapabilityPolicy {
  readonly version: string;
  authorize(action: VariationAction, state: Readonly<VariationState>): PolicyDecision;
}

export interface ApprovalGate {
  approve(action: VariationAction, decision: PolicyDecision): Promise<boolean>;
}

export interface GovernedMemory {
  readonly cursor: string | null;
  branch(label: string): Promise<void>;
  retrieve(query: string, limit: number): Promise<StructuredMemoryRecord[]>;
  buffer(record: StructuredMemoryRecord): Promise<void>;
  checkpoint(label: string): Promise<string>;
  rollback(checkpointId?: string): Promise<void>;
  consolidate(): Promise<void>;
  verify(records: StructuredMemoryRecord[]): Promise<boolean>;
  packageCheckpoint(checkpoint: VariationCheckpoint): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface KnowledgeBase {
  retrieve(task: string, limit: number): Promise<unknown[]>;
}

export interface Supervisor {
  observe(state: Readonly<VariationState>): Promise<SupervisorIntervention | null>;
}

export interface ReceiptSigner {
  readonly id: string;
  sign(payloadHash: string): string;
  verify(payloadHash: string, signature: string): boolean;
}

export interface CheckpointStore {
  save(checkpoint: VariationCheckpoint): Promise<void>;
  load(): Promise<VariationCheckpoint | null>;
}
