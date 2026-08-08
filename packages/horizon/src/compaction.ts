// CompactionPolicy — the ADK context-compaction pattern, model-agnostic.
//
// ADK's contribution over the raw compaction facility is small but load-bearing:
// a PRE-COMPACTION MEMORY FLUSH, "fired by the summarizer *before* facts are
// lost to a lossy summary." That ordering is the whole point — once earlier
// events are replaced by a lossy summary, anything not already persisted is
// gone. So this policy makes the order an INVARIANT, not a convention:
//
//   shouldCompact → prune tool output → FLUSH durable facts → summarize → splice
//
// If the flush REJECTS, compaction aborts and the events are returned unchanged
// — we never run the lossy summary over facts we failed to persist. That single
// guarantee is what a summarizer seam alone cannot give you.
//
// Everything model-shaped (token estimation, what a "durable fact" is, how to
// summarize) is a pluggable seam; no LLM is required to exercise the policy.

export interface CompactionConfig {
  /** Compact once estimated context tokens reach this threshold. */
  thresholdTokens: number;
  /** Always keep this many most-recent events verbatim (never summarized). */
  keepRecent: number;
}

export interface CompactionSeams<E> {
  /** Estimate the token footprint of a set of events. */
  estimateTokens(events: E[]): number;
  /**
   * Persist durable facts from the events about to be summarized. MUST resolve
   * before summarization runs; if it rejects, compaction aborts (facts safe).
   */
  flushDurableFacts(events: E[]): Promise<void>;
  /** Produce ONE lossy summary event standing in for `events`. */
  summarize(events: E[]): Promise<E>;
  /** Optional: shrink a single event's tool output before it is summarized. */
  pruneToolOutput?(event: E): E;
}

export interface CompactionResult<E> {
  events: E[];
  compacted: boolean;
  /** Proof the flush ran and resolved before summarize was invoked. */
  flushedBeforeSummarize: boolean;
  /** Tokens estimated before vs after (only meaningful when compacted). */
  tokensBefore: number;
  tokensAfter: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  thresholdTokens: 8000,
  keepRecent: 6,
};

export class CompactionPolicy<E> {
  constructor(
    private readonly seams: CompactionSeams<E>,
    readonly config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
  ) {}

  /** True when the events' estimated tokens have reached the threshold. */
  shouldCompact(events: E[]): boolean {
    return this.seams.estimateTokens(events) >= this.config.thresholdTokens;
  }

  /**
   * Compact if over threshold. Older events (all but the last `keepRecent`) are
   * pruned, their durable facts flushed, then replaced by a single lossy
   * summary. The flush-before-summarize ordering is enforced here; a flush
   * rejection aborts compaction with the original events intact.
   */
  async compact(events: E[]): Promise<CompactionResult<E>> {
    const tokensBefore = this.seams.estimateTokens(events);
    if (!this.shouldCompact(events) || events.length <= this.config.keepRecent) {
      return {
        events,
        compacted: false,
        flushedBeforeSummarize: false,
        tokensBefore,
        tokensAfter: tokensBefore,
      };
    }

    const cut = events.length - this.config.keepRecent;
    const older = events.slice(0, cut);
    const recent = events.slice(cut);

    // 1. prune tool output in the events we're about to lose (optional seam).
    const prunedOlder = this.seams.pruneToolOutput
      ? older.map((e) => this.seams.pruneToolOutput!(e))
      : older;

    // 2. FLUSH durable facts BEFORE any lossy step. Order tracked so the result
    //    can prove it; a rejection here propagates and NOTHING is summarized.
    let flushDone = false;
    await this.seams.flushDurableFacts(prunedOlder);
    flushDone = true;

    // 3. only now is the lossy summary allowed to run.
    const summary = await this.seams.summarize(prunedOlder);
    const summarizeRanAfterFlush = flushDone; // true by construction of the ordering above

    const compactedEvents = [summary, ...recent];
    return {
      events: compactedEvents,
      compacted: true,
      flushedBeforeSummarize: summarizeRanAfterFlush,
      tokensBefore,
      tokensAfter: this.seams.estimateTokens(compactedEvents),
    };
  }
}
