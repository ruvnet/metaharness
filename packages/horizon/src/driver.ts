// LongHorizonDriver — composes the three cloned primitives (halt control,
// command guard, context compaction) into one resumable turn loop, exactly the
// shape ADK's Runner drives:
//
//   turn_boundary → [ before_model(consume halt) → model step →
//                     guard any shell command → observe(progress/failure) →
//                     append event → maybe compact ] * until final or halt
//
// The model is a pluggable `step` seam and gated commands go through an
// `approve` seam, so the whole loop runs deterministically in tests and demos
// with no live model. Nothing here is ADK- or Gemini-specific.

import type { HorizonCore } from './core.js';
import { HaltController, type HaltConfig, type HaltReason } from './halt.js';
import { CommandGuard, type CommandPolicy, type Classification } from './guard.js';
import {
  CompactionPolicy,
  type CompactionSeams,
  type CompactionConfig,
} from './compaction.js';
import { UnavailableToolExecutor, type ToolExecutionResult, type ToolExecutor } from './executor.js';
import {
  hashCheckpoint,
  verifyCheckpoint,
  type HorizonCheckpoint,
  type HorizonContinuity,
} from './checkpoint.js';

export interface HorizonEvent {
  role: 'model' | 'tool' | 'summary';
  text: string;
  receipt?: ToolExecutionResult;
}

/** What one model step decides to do. */
export type StepResult =
  | { kind: 'final'; output: string }
  | {
      kind: 'tool';
      /** A shell command to run; it is classified by the guard first. */
      command: string;
      /** Signature of forward progress (drives no-progress detection). */
      progress?: string;
      /** Error signature if this step failed (drives repeated-failure). */
      failure?: string | null;
      /** Human-readable note recorded in the transcript. */
      note?: string;
    };

export interface DriverSeams {
  /** The model: given the running transcript, decide the next step. */
  step(ctx: { events: HorizonEvent[]; iteration: number }): Promise<StepResult>;
  /** Approve a GATE-classified command. Default: deny (safe). */
  approve?(command: string, c: Classification): Promise<boolean>;
  /** Real execution seam. Absence is an observed exit-127 failure, never assumed success. */
  executor?: ToolExecutor;
  /** Context compaction seams (token estimate, flush, summarize). */
  compaction: CompactionSeams<HorizonEvent>;
}

export interface DriverConfig {
  halt: HaltConfig;
  policy: CommandPolicy;
  compaction: CompactionConfig;
}

export type TurnOutcome =
  | { kind: 'final'; output: string; iterations: number; events: HorizonEvent[] }
  | { kind: 'halted'; reason: HaltReason; iterations: number; events: HorizonEvent[] };

export class LongHorizonDriver {
  private readonly halt: HaltController;
  private readonly guard: CommandGuard;
  private readonly compaction: CompactionPolicy<HorizonEvent>;
  private readonly executor: ToolExecutor;
  private events: HorizonEvent[] = [];
  private actionCount = 0;
  private continuity: HorizonContinuity = {
    workspaceCommit: null,
    evaluationHistory: [],
    budget: {},
    pendingApprovals: [],
    archiveBranch: null,
    memoryCursor: null,
  };

  constructor(
    private readonly core: HorizonCore,
    private readonly seams: DriverSeams,
    config: DriverConfig,
    checkpoint?: HorizonCheckpoint,
  ) {
    if (checkpoint && !verifyCheckpoint(checkpoint)) {
      throw new Error('horizon: checkpoint state hash mismatch');
    }
    this.halt = checkpoint
      ? HaltController.restore(core, config.halt, checkpoint.halt)
      : new HaltController(core, config.halt);
    this.guard = new CommandGuard(core, config.policy);
    this.compaction = new CompactionPolicy(seams.compaction, config.compaction);
    this.executor = seams.executor ?? new UnavailableToolExecutor();
    if (checkpoint) {
      this.events = structuredClone(checkpoint.transcript);
      this.actionCount = checkpoint.actionCount;
      this.continuity = {
        workspaceCommit: checkpoint.workspaceCommit,
        evaluationHistory: structuredClone(checkpoint.evaluationHistory),
        budget: { ...checkpoint.budget },
        pendingApprovals: [...checkpoint.pendingApprovals],
        archiveBranch: checkpoint.archiveBranch,
        memoryCursor: checkpoint.memoryCursor,
      };
    }
  }

  /** Run one user turn to a final answer or a halt. */
  async runTurn(input: string): Promise<TurnOutcome> {
    this.events.push({ role: 'model', text: `user: ${input}` });
    this.halt.turnBoundary();
    return this.runLoop();
  }

  /** Continue an interrupted turn from a verified full-state checkpoint. */
  async resumeTurn(): Promise<TurnOutcome> {
    return this.runLoop();
  }

  private async runLoop(): Promise<TurnOutcome> {

    // A generous absolute ceiling; the HaltController is the real limiter.
    for (let guardIter = 0; guardIter < 10_000; guardIter++) {
      const decision = this.halt.beforeModel();
      if (decision.halt) {
        return {
          kind: 'halted',
          reason: decision.reason!,
          iterations: this.halt.snapshot().iteration,
          events: this.events,
        };
      }

      const step = await this.seams.step({ events: this.events, iteration: this.halt.snapshot().iteration });

      if (step.kind === 'final') {
        this.events.push({ role: 'model', text: step.output });
        return { kind: 'final', output: step.output, iterations: this.halt.snapshot().iteration, events: this.events };
      }

      // Classify, authorize, then execute. Every action yields observed evidence.
      const c = this.guard.classify(step.command);
      const approved = c.verdict === 'allow'
        ? true
        : c.verdict === 'gate' && this.seams.approve
          ? await this.seams.approve(step.command, c)
          : false;
      const observed = await this.executor.execute({
        command: step.command,
        classification: c,
        approved,
      });
      this.actionCount += 1;
      const label = observed.policyReceipt.authorized ? 'executed' : 'blocked';
      this.events.push({
        role: 'tool',
        text: `[${label} exit=${observed.exitCode} duration=${observed.durationMs}ms digest=${observed.artifactDigest}] ${step.command}\nstdout:\n${observed.stdout}\nstderr:\n${observed.stderr}${step.note ? `\nnote: ${step.note}` : ''}`,
        receipt: observed,
      });
      const failure = step.failure ?? (observed.exitCode === 0
        ? null
        : `exit:${observed.exitCode}:${observed.stderr.trim().slice(-160)}`);

      // Record progress/failure for the halt guards.
      this.halt.observe({
        progress: observed.exitCode === 0 ? (step.progress ?? observed.artifactDigest) : undefined,
        failure,
      });

      // Compact if the transcript has grown past the threshold.
      const res = await this.compaction.compact(this.events);
      this.events = res.events;
    }

    // Unreachable in practice (halt controller stops far sooner).
    return { kind: 'halted', reason: 'iteration-budget', iterations: this.halt.snapshot().iteration, events: this.events };
  }

  /** Persist the halt state to resume this driver's turn later. */
  snapshotHalt() {
    return this.halt.snapshot();
  }

  updateContinuity(patch: Partial<HorizonContinuity>): void {
    this.continuity = { ...this.continuity, ...structuredClone(patch) };
  }

  /** Persist transcript + receipts + semantic continuity, not only halt counters. */
  snapshot(): HorizonCheckpoint {
    const body: Omit<HorizonCheckpoint, 'stateHash'> = {
      schema: 1,
      transcript: structuredClone(this.events),
      halt: this.halt.snapshot(),
      actionCount: this.actionCount,
      ...structuredClone(this.continuity),
    };
    return { ...body, stateHash: hashCheckpoint(body) };
  }
}
