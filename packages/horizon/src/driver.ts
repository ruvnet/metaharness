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

export interface HorizonEvent {
  role: 'model' | 'tool' | 'summary';
  text: string;
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

  constructor(
    private readonly core: HorizonCore,
    private readonly seams: DriverSeams,
    config: DriverConfig,
  ) {
    this.halt = new HaltController(core, config.halt);
    this.guard = new CommandGuard(core, config.policy);
    this.compaction = new CompactionPolicy(seams.compaction, config.compaction);
  }

  /** Run one user turn to a final answer or a halt. */
  async runTurn(input: string): Promise<TurnOutcome> {
    let events: HorizonEvent[] = [{ role: 'model', text: `user: ${input}` }];
    this.halt.turnBoundary();

    // A generous absolute ceiling; the HaltController is the real limiter.
    for (let guardIter = 0; guardIter < 10_000; guardIter++) {
      const decision = this.halt.beforeModel();
      if (decision.halt) {
        return {
          kind: 'halted',
          reason: decision.reason!,
          iterations: this.halt.snapshot().iteration,
          events,
        };
      }

      const step = await this.seams.step({ events, iteration: this.halt.snapshot().iteration });

      if (step.kind === 'final') {
        events.push({ role: 'model', text: step.output });
        return { kind: 'final', output: step.output, iterations: this.halt.snapshot().iteration, events };
      }

      // Classify the command; enforce the guard before "running" it.
      const c = this.guard.classify(step.command);
      let failure = step.failure ?? null;
      let ran = false;
      if (c.verdict === 'deny') {
        events.push({ role: 'tool', text: `[blocked: ${c.reasons[0] ?? 'denied'}] ${step.command}` });
        failure = failure ?? `blocked:${step.command}`;
      } else if (c.verdict === 'gate') {
        const ok = this.seams.approve ? await this.seams.approve(step.command, c) : false;
        if (!ok) {
          events.push({ role: 'tool', text: `[gated, not approved] ${step.command}` });
          failure = failure ?? `gated:${step.command}`;
        } else {
          events.push({ role: 'tool', text: `[approved] ${step.command}${step.note ? ` — ${step.note}` : ''}` });
          ran = true;
        }
      } else {
        events.push({ role: 'tool', text: `${step.command}${step.note ? ` — ${step.note}` : ''}` });
        ran = true;
      }

      // Record progress/failure for the halt guards.
      this.halt.observe({
        progress: step.progress,
        failure: ran ? null : failure,
      });

      // Compact if the transcript has grown past the threshold.
      const res = await this.compaction.compact(events);
      events = res.events;
    }

    // Unreachable in practice (halt controller stops far sooner).
    return { kind: 'halted', reason: 'iteration-budget', iterations: this.halt.snapshot().iteration, events };
  }

  /** Persist the halt state to resume this driver's turn later. */
  snapshotHalt() {
    return this.halt.snapshot();
  }
}
