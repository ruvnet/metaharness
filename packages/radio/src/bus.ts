// @metaharness/radio — the message bus: threads + non-blocking sends + mentions.
//
// Semantics follow AgentRadio (arXiv:2607.28430) exactly where the paper is
// load-bearing:
//   - send() is NON-BLOCKING: it appends and returns immediately, regardless of
//     listener availability. Posting a discovery never stalls execution.
//   - Visibility is a logical clock: an agent reading at step t sees every
//     message with seq < its read horizon — no dedicated listening step needed.
//   - @-mentions target agents; a mention is what a background watcher wakes on.
//   - Watchers receive the mention PLUS a full thread snapshot (the paper ships
//     no relevance filter — agents interpret relevance themselves; a digest
//     policy is exactly the kind of lever the flywheel evolves later).
//
// The bus is deterministic and dependency-free: a logical `seq` orders messages
// totally (no wall clock), so simulations replay bit-for-bit.

export interface RadioMessage {
  seq: number;
  thread: string;
  sender: string;
  content: string;
  mentions: string[];
}

export interface ThreadInfo {
  name: string;
  participants: string[];
}

export class RadioBus {
  private threads = new Map<string, ThreadInfo>();
  private messages: RadioMessage[] = [];
  private nextSeq = 0;

  /** create_thread(name, participants) — idempotent on the name. */
  createThread(name: string, participants: string[]): ThreadInfo {
    const existing = this.threads.get(name);
    if (existing) return existing;
    const info: ThreadInfo = { name, participants: [...participants] };
    this.threads.set(name, info);
    return info;
  }

  thread(name: string): ThreadInfo | undefined {
    return this.threads.get(name);
  }

  /** send_message(thread, content, mentions) — appends and returns at once. */
  send(thread: string, sender: string, content: string, mentions: string[] = []): RadioMessage {
    if (!this.threads.has(thread)) {
      // Auto-create with the sender as sole participant — a send must never
      // block or fail on missing setup; the paper's sends are fire-and-forget.
      this.createThread(thread, [sender]);
    }
    const msg: RadioMessage = {
      seq: this.nextSeq++,
      thread,
      sender,
      content,
      mentions: [...mentions],
    };
    this.messages.push(msg);
    return msg;
  }

  /** Every message in a thread with seq < horizon (the FULL snapshot). */
  snapshot(thread: string, horizon: number = Number.MAX_SAFE_INTEGER): RadioMessage[] {
    return this.messages.filter((m) => m.thread === thread && m.seq < horizon);
  }

  /** All messages mentioning `agent` with seq in [from, horizon). */
  mentionsFor(agent: string, from: number, horizon: number = Number.MAX_SAFE_INTEGER): RadioMessage[] {
    return this.messages.filter(
      (m) => m.seq >= from && m.seq < horizon && m.mentions.includes(agent),
    );
  }

  /** The current logical clock — the seq the NEXT message will get. */
  get clock(): number {
    return this.nextSeq;
  }

  /** Total messages sent (diagnostics; the sim's comms-cost metric). */
  get messageCount(): number {
    return this.messages.length;
  }
}
