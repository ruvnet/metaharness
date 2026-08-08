// @metaharness/radio — vitest suite for the LOCKED core (bus.ts + watcher.ts).
//
// Verifies the AgentRadio (arXiv:2607.28430) semantics the rest of the package
// stands on, and ONLY those — protocol.ts / sim.ts get their own suites. This
// file imports nothing beyond the frozen core, so it passes with only
// bus.ts + watcher.ts present:
//
//   - send() is NON-BLOCKING: it appends and returns the message immediately,
//     auto-creating a missing thread — a discovery post never stalls or fails.
//   - Visibility is a LOGICAL clock: a message sent at seq s is visible exactly
//     in reads whose horizon > s. No wall clock, no listening step.
//   - mentionsFor(agent, from, horizon) is the half-open window [from, horizon).
//   - Watcher.fold() — passive awareness — surfaces each mention EXACTLY once,
//     each with a FULL snapshot of the mentioning thread (the paper ships no
//     relevance filter), advances the cursor, and costs NO step. An idle fold
//     returns []. blockingReceive() is the same visibility; the STEP cost is
//     the caller's to account — that split is what the sim's ablation measures.
//   - Two watchers on one bus are independent cursors: passive awareness is
//     per-agent bookkeeping, not consumption from a shared queue.
//   - Determinism: the same operation sequence yields the same seqs, so
//     simulations (and the flywheel's cached evaluations) replay bit-for-bit.
import { describe, expect, it } from 'vitest';
import { RadioBus } from '../src/bus.js';
import type { RadioMessage } from '../src/bus.js';
import { Watcher } from '../src/watcher.js';

describe('RadioBus — non-blocking sends', () => {
  it('send() returns the appended message immediately with a monotonically increasing seq', () => {
    const bus = new RadioBus();
    bus.createThread('plan', ['a', 'b']);
    const m0 = bus.send('plan', 'a', 'first');
    const m1 = bus.send('plan', 'b', 'second', ['a']);
    // Fire-and-forget: the return value IS the appended record — no ack, no wait.
    expect(m0).toMatchObject({ seq: 0, thread: 'plan', sender: 'a', content: 'first', mentions: [] });
    expect(m1).toMatchObject({ seq: 1, sender: 'b', mentions: ['a'] });
    expect(bus.messageCount).toBe(2);
    expect(bus.clock).toBe(2); // clock = the seq the NEXT message will get
  });

  it('send() to a missing thread auto-creates it with the sender as sole participant', () => {
    const bus = new RadioBus();
    expect(bus.thread('scratch')).toBeUndefined();
    const m = bus.send('scratch', 'scout', 'found the auth flow in gateway/');
    expect(m.seq).toBe(0);
    // A send must never block or fail on missing setup (paper: fire-and-forget).
    expect(bus.thread('scratch')).toEqual({ name: 'scratch', participants: ['scout'] });
  });

  it('createThread() is idempotent on the name — a re-create returns the existing thread', () => {
    const bus = new RadioBus();
    const first = bus.createThread('plan', ['a', 'b']);
    const again = bus.createThread('plan', ['c']);
    expect(again).toBe(first);
    expect(again.participants).toEqual(['a', 'b']);
  });
});

describe('RadioBus — logical-clock visibility', () => {
  it('a message at seq s appears in snapshots with horizon > s only', () => {
    const bus = new RadioBus();
    bus.createThread('t', ['a']);
    const m = bus.send('t', 'a', 'at seq 0'); // s = 0
    expect(m.seq).toBe(0);
    // horizon <= s: invisible. horizon > s: visible. Exactly the M(t) rule.
    expect(bus.snapshot('t', 0)).toEqual([]);
    expect(bus.snapshot('t', 1).map((x) => x.seq)).toEqual([0]);
    const later = bus.send('t', 'a', 'at seq 1');
    expect(later.seq).toBe(1);
    expect(bus.snapshot('t', 1).map((x) => x.seq)).toEqual([0]); // still horizon-bounded
    expect(bus.snapshot('t', 2).map((x) => x.seq)).toEqual([0, 1]);
    expect(bus.snapshot('t').map((x) => x.seq)).toEqual([0, 1]); // default horizon = everything
  });

  it('snapshot() is per-thread — other threads never leak in', () => {
    const bus = new RadioBus();
    bus.send('alpha', 'a', 'alpha msg'); // seq 0
    bus.send('beta', 'b', 'beta msg'); // seq 1
    expect(bus.snapshot('alpha').map((x) => x.seq)).toEqual([0]);
    expect(bus.snapshot('beta').map((x) => x.seq)).toEqual([1]);
  });
});

describe('RadioBus — mentionsFor windows', () => {
  it('returns exactly the mentions of the agent with seq in [from, horizon)', () => {
    const bus = new RadioBus();
    bus.createThread('t', ['a', 'b', 'c']);
    bus.send('t', 'b', 'mentions a (seq 0)', ['a']);
    bus.send('t', 'b', 'mentions c (seq 1)', ['c']);
    bus.send('t', 'c', 'mentions a (seq 2)', ['a']);
    bus.send('t', 'a', 'mentions a+c (seq 3)', ['a', 'c']);

    // Full window: every message that @-mentions 'a'.
    expect(bus.mentionsFor('a', 0).map((m) => m.seq)).toEqual([0, 2, 3]);
    // from is inclusive, horizon exclusive.
    expect(bus.mentionsFor('a', 1, 3).map((m) => m.seq)).toEqual([2]);
    expect(bus.mentionsFor('a', 2, 2)).toEqual([]); // empty half-open window
    expect(bus.mentionsFor('a', 3).map((m) => m.seq)).toEqual([3]);
    // An agent nobody mentioned sees nothing.
    expect(bus.mentionsFor('b', 0)).toEqual([]);
  });
});

describe('Watcher — passive awareness (fold at step boundaries)', () => {
  it('fold() returns each mention exactly once, with a FULL thread snapshot, and advances the cursor', () => {
    const bus = new RadioBus();
    bus.createThread('exec', ['a', 'b']);
    const watcher = new Watcher(bus, 'a');

    bus.send('exec', 'b', 'context, no mention'); // seq 0 — snapshot material
    bus.send('exec', 'b', 'this bears on your sub-question', ['a']); // seq 1 — the mention

    const folded = watcher.fold();
    expect(folded).toHaveLength(1);
    expect(folded[0].mention.seq).toBe(1);
    // FULL thread snapshot, mention included — no relevance filter (the paper
    // ships none; the agent interprets relevance itself).
    expect(folded[0].snapshot.map((m: RadioMessage) => m.seq)).toEqual([0, 1]);

    // Exactly once: the cursor advanced past the fold horizon.
    expect(watcher.fold()).toEqual([]);

    // New traffic after the fold is picked up by the next fold — and only that.
    bus.send('exec', 'b', 'a later discovery', ['a']); // seq 2
    const next = watcher.fold();
    expect(next.map((f) => f.mention.seq)).toEqual([2]);
    expect(next[0].snapshot.map((m: RadioMessage) => m.seq)).toEqual([0, 1, 2]);
  });

  it('fold() after no traffic returns [] — an idle boundary check is free AND empty', () => {
    const bus = new RadioBus();
    const watcher = new Watcher(bus, 'a');
    expect(watcher.fold()).toEqual([]);
    expect(watcher.fold()).toEqual([]); // still nothing, still no error
  });

  it('only watches from creation onward by default; an explicit `from` widens the window', () => {
    const bus = new RadioBus();
    bus.createThread('t', ['a', 'b']);
    bus.send('t', 'b', 'before the watcher existed', ['a']); // seq 0
    const late = new Watcher(bus, 'a');
    expect(late.fold()).toEqual([]); // pre-creation mention is NOT replayed

    const backfill = new Watcher(bus, 'a', 0);
    expect(backfill.fold().map((f) => f.mention.seq)).toEqual([0]);
  });

  it('two watchers on the same bus are independent — one folding does not consume for the other', () => {
    const bus = new RadioBus();
    bus.createThread('t', ['a', 'b', 'c']);
    const wa = new Watcher(bus, 'a');
    const wb = new Watcher(bus, 'b');

    bus.send('t', 'c', 'for both', ['a', 'b']); // seq 0

    // a folds first — b's pending mention must be untouched.
    expect(wa.fold().map((f) => f.mention.seq)).toEqual([0]);
    expect(wb.fold().map((f) => f.mention.seq)).toEqual([0]);

    // Cursors advance per-watcher, not per-bus.
    bus.send('t', 'c', 'only for a this time', ['a']); // seq 1
    expect(wb.fold()).toEqual([]); // nothing new for b
    expect(wa.fold().map((f) => f.mention.seq)).toEqual([1]);
  });

  it('blockingReceive() has identical visibility to fold() — the step COST is the caller\'s ledger', () => {
    // The paper's ablation arm: same messages, but each receive burns a
    // foreground step. The bus/watcher expose the same data either way; the
    // accounting difference lives in the protocol/sim, so here we only pin
    // that visibility is identical.
    const bus = new RadioBus();
    bus.createThread('t', ['a', 'b']);
    const passive = new Watcher(bus, 'a');
    const blocking = new Watcher(bus, 'a');
    bus.send('t', 'b', 'discovery', ['a']);
    const viaFold = passive.fold();
    const viaBlocking = blocking.blockingReceive();
    expect(viaBlocking).toEqual(viaFold);
    expect(blocking.blockingReceive()).toEqual([]); // consumes its own cursor too
  });

  it('visible() reports M(t) — everything sent before now — without moving the cursor', () => {
    const bus = new RadioBus();
    bus.createThread('t', ['a', 'b']);
    const w = new Watcher(bus, 'a');
    bus.send('t', 'b', 'ambient context'); // seq 0, no mention
    bus.send('t', 'b', 'a mention', ['a']); // seq 1
    expect(w.visible('t').map((m) => m.seq)).toEqual([0, 1]);
    // Diagnostic only: visible() did not advance the fold cursor.
    expect(w.fold().map((f) => f.mention.seq)).toEqual([1]);
  });
});

describe('Determinism — same operations, same seqs', () => {
  it('two buses driven by the same operation sequence produce identical message logs', () => {
    const drive = (bus: RadioBus): RadioMessage[] => {
      bus.createThread('plan', ['a', 'b', 'c']);
      const log: RadioMessage[] = [];
      log.push(bus.send('plan', 'a', 'partition proposal'));
      log.push(bus.send('plan', 'b', 'counter-proposal', ['a']));
      log.push(bus.send('exec-b', 'b', 'blocking discovery', ['a', 'c']));
      log.push(bus.send('plan', 'c', 'approve', ['a', 'b']));
      return log;
    };
    const one = drive(new RadioBus());
    const two = drive(new RadioBus());
    // No wall clock, no randomness: seq assignment is a pure function of the
    // operation order, so replays are bit-for-bit (what the sim + flywheel
    // evaluation cache both rely on).
    expect(two).toEqual(one);
    expect(one.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });
});
