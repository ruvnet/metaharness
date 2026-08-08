// @metaharness/radio — passive awareness: the backgrounded wait_for_mention.
//
// The paper's core primitive, and its critical distinction:
//
//   BLOCKING receive: listening consumes a FOREGROUND step — the agent gives up
//   a unit of work to check for messages.
//
//   PASSIVE awareness: a background watcher monitors for mentions while the
//   agent keeps working. An arriving mention is surfaced at the NEXT STEP
//   BOUNDARY — between tool invocations, never interrupting a running command —
//   together with a full snapshot of the mentioning thread.
//
// In-process, "backgrounded as an OS-level task" reduces to pull-at-boundary
// bookkeeping over the bus's logical clock: fold() is called by the agent loop
// between steps and costs NO step; blockingReceive() is the ablation arm and
// costs one. Step accounting is explicit so simulations and harness pods can
// measure exactly what the paper measured.

import { RadioBus, RadioMessage } from './bus.js';

export interface FoldedMention {
  /** The message that mentioned this agent. */
  mention: RadioMessage;
  /** Full snapshot of the mentioning thread up to the fold horizon — the paper
   *  ships NO relevance filter; the agent interprets relevance itself. */
  snapshot: RadioMessage[];
}

export class Watcher {
  private cursor: number;

  constructor(
    private readonly bus: RadioBus,
    readonly agent: string,
    /** Start watching from `from` (default: only messages after creation). */
    from?: number,
  ) {
    this.cursor = from ?? bus.clock;
  }

  /** Passive fold-in at a step boundary. Returns every mention that arrived
   *  since the last fold, each with its thread snapshot, and advances the
   *  cursor. Costs NO step — that is the whole point. */
  fold(): FoldedMention[] {
    const horizon = this.bus.clock;
    const pending = this.bus.mentionsFor(this.agent, this.cursor, horizon);
    this.cursor = horizon;
    return pending.map((mention) => ({
      mention,
      snapshot: this.bus.snapshot(mention.thread, horizon),
    }));
  }

  /** The blocking ablation arm: identical visibility, but the CALLER must
   *  account one foreground step for the check (the sim enforces this).
   *  Kept deliberately as a separate method so a protocol cannot silently
   *  mix the two accounting modes. */
  blockingReceive(): FoldedMention[] {
    return this.fold();
  }

  /** Messages the agent could see at the current clock without folding —
   *  M(t) in the paper: everything sent before now. Diagnostic only. */
  visible(thread: string): RadioMessage[] {
    return this.bus.snapshot(thread, this.bus.clock);
  }
}
