// SPDX-License-Identifier: MIT
//
// Recoverable session log — ADR-246 §2.3.
//
// Append-only JSONL event log per session: every event carries a per-branch
// monotonic index and (for the first event of a forked branch) a parent
// reference {branch, index}. Replaying the log reconstructs session state
// deterministically; a state hash over the replayed lineage verifies
// integrity. Fork creates a new branch ID referencing a parent event index;
// branches replay independently (Prime Agent's /tree capability, minus the
// daemon — daemons, socket attach/detach, and kernel snapshots are
// deliberately out of scope per the ADR).
//
// Serialization contract (a Rust mirror must reproduce it byte-for-byte):
// each event is one line, JSON.stringify of an object literal built in
// EXACT key order
//     index, branch, parent, kind, payload
// with `parent` (itself in key order branch, index) omitted entirely when
// absent.
//
// State-hash fold (a Rust mirror must reproduce it byte-for-byte):
//     hexPrev := ''                                  // empty string seed, NOT a digest
//     for each event e in lineage order (root → tip):
//         canonical := canonicalJson(e)              // recursively key-sorted JSON of the event
//         hexPrev   := lowercaseHex(sha256(utf8(hexPrev + canonical)))
//     stateHash := hexPrev
// i.e. digest_i = sha256(hex(digest_{i-1}) + canonicalJson(event_i)) as UTF-8,
// where hex(digest_0) is the empty string for the first event, and every
// digest is rendered as lowercase hex before being folded into the next step.

import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

export interface SessionEvent {
  /** Per-branch 0-based monotonic index. */
  index: number;
  /** Branch ID this event belongs to. */
  branch: string;
  /** Fork point — present only on the first event of a non-root branch. */
  parent?: { branch: string; index: number };
  /** Event kind (free-form discriminator, e.g. "turn", "tool", "note"). */
  kind: string;
  /** Free-form event payload. */
  payload: unknown;
}

/** Canonical JSON: recursively key-sorted objects, arrays in order, no
 * whitespace. `undefined` object values are dropped (matching
 * JSON.stringify). This is the byte input to the state-hash fold.
 *
 * Keys sort by UTF-8 BYTE order (not UTF-16 code-unit order, which the
 * default `.sort()` would use) to match the Rust mirror, whose `&str`
 * ordering is byte-wise. The two orders diverge for keys mixing BMP-high
 * characters (>= U+E000) with astral characters. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(x => canonicalJson(x)).join(',') + ']';
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter(k => rec[k] !== undefined)
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(rec[k])).join(',') + '}';
}

/** A raw unpaired surrogate: a lead surrogate not followed by a trail, or
 * a trail surrogate not preceded by a lead. Rust (serde_json) cannot parse
 * these — they are not valid UTF-8. */
const LONE_SURROGATE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;
/** Well-formed JSON.stringify (ES2019) never emits a raw lone surrogate:
 * it renders one as a `\udXXX` escape (paired surrogates pass through as
 * raw astral characters, so any surrogate escape in stringify output IS a
 * lone surrogate). A genuine escape is preceded by an even number of
 * backslashes; an odd run means the backslash itself is escaped text. */
const LONE_SURROGATE_ESCAPE = /(?<=(?:^|[^\\])(?:\\\\)*)\\u[dD][89abAB]/;

/** Recursively test decoded JSON data (string values AND object keys) for a
 * raw unpaired surrogate. Used on the READ path, where the raw line may
 * legitimately contain paired `\udXXX` escapes (valid JSON that serde_json
 * accepts), so the append-path escape regex cannot be reused: after
 * JSON.parse, a valid pair decodes to an astral character while a lone
 * surrogate stays lone — exactly what serde_json rejects as not-UTF-8. */
function containsLoneSurrogate(v: unknown): boolean {
  if (typeof v === 'string') return LONE_SURROGATE.test(v);
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(containsLoneSurrogate);
  return Object.entries(v).some(
    ([k, val]) => LONE_SURROGATE.test(k) || containsLoneSurrogate(val),
  );
}

/** Serialize one event as a JSONL line in the EXACT wire key order
 * (index, branch, parent, kind, payload; parent omitted when absent). */
function serializeEvent(e: SessionEvent): string {
  return JSON.stringify(
    e.parent === undefined
      ? { index: e.index, branch: e.branch, kind: e.kind, payload: e.payload }
      : {
          index: e.index,
          branch: e.branch,
          parent: { branch: e.parent.branch, index: e.parent.index },
          kind: e.kind,
          payload: e.payload,
        },
  );
}

/** Shared mutable log state — fork() returns a sibling SessionLog over the
 * SAME state (and the same file), differing only in its active branch. */
interface LogState {
  path: string;
  events: SessionEvent[];
  /** branch → next index to assign (== count of events on that branch). */
  nextIndex: Map<string, number>;
  /** branch → its fork point (absent for the root branch). */
  branchParent: Map<string, { branch: string; index: number }>;
  /** The root branch (the one whose first event carries no parent). */
  rootBranch: string;
}

/** Parse + validate a JSONL log; returns either the reconstructed state or
 * the list of 'session: '-prefixed errors (with 1-based line numbers).
 *
 * NOTE: the ADR-246 lockstep contract with the Rust mirror is the state
 * hash plus the accept/reject decision; validation MESSAGES are
 * per-language diagnostics (TS cites 1-based line numbers, Rust does not)
 * and are not required to match byte-for-byte. */
function parseLog(path: string, raw: string): { state: LogState; errors: string[] } {
  const state: LogState = {
    path,
    events: [],
    nextIndex: new Map(),
    branchParent: new Map(),
    rootBranch: '',
  };
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue; // blank / whitespace-only separators (still counted for line numbers)
    const lineNo = i + 1;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      errors.push(`session: line ${lineNo}: corrupted line (invalid JSON)`);
      continue;
    }
    // Mirror serde_json's accept/reject decision: a lone surrogate (decoded
    // from a `\udXXX` escape — JSON.parse tolerates it, serde_json does not)
    // is not representable as UTF-8, so the Rust mirror rejects the line.
    if (containsLoneSurrogate(obj)) {
      errors.push(
        `session: line ${lineNo}: corrupted line (contains an unpaired surrogate, not valid UTF-8)`,
      );
      continue;
    }
    const e = obj as Partial<SessionEvent>;
    if (
      typeof e !== 'object' || e === null ||
      typeof e.index !== 'number' || typeof e.branch !== 'string' ||
      typeof e.kind !== 'string' || !('payload' in e) ||
      (e.parent !== undefined &&
        (typeof e.parent !== 'object' || e.parent === null ||
          typeof e.parent.branch !== 'string' || typeof e.parent.index !== 'number'))
    ) {
      errors.push(`session: line ${lineNo}: corrupted line (not a valid session event)`);
      continue;
    }
    const ev = e as SessionEvent;
    const key = `${ev.branch}\u0000${ev.index}`;
    if (seen.has(key)) {
      errors.push(`session: line ${lineNo}: duplicate event (${ev.branch}, ${ev.index})`);
      continue;
    }
    const expected = state.nextIndex.get(ev.branch) ?? 0;
    if (ev.index !== expected) {
      errors.push(
        `session: line ${lineNo}: branch "${ev.branch}" index ${ev.index} is not monotonic (expected ${expected})`,
      );
      // Resync like the Rust mirror: after reporting index X, expect X+1
      // next, so a single gap yields exactly ONE error, not a cascade.
      seen.add(key);
      state.nextIndex.set(ev.branch, ev.index + 1);
      continue;
    }
    if (expected === 0) {
      // First event of a branch: the root branch (first branch in the file)
      // carries no parent; every other branch MUST reference an existing
      // (branch, index) already present in the log.
      if (state.events.length === 0) {
        state.rootBranch = ev.branch;
        if (ev.parent !== undefined) {
          errors.push(`session: line ${lineNo}: root branch '${ev.branch}' must not carry a parent`);
          continue;
        }
      } else {
        if (ev.parent === undefined) {
          errors.push(
            `session: line ${lineNo}: first event of branch "${ev.branch}" must carry a parent reference`,
          );
          continue;
        }
        if (!seen.has(`${ev.parent.branch}\u0000${ev.parent.index}`)) {
          errors.push(
            `session: line ${lineNo}: parent (${ev.parent.branch}, ${ev.parent.index}) does not exist`,
          );
          continue;
        }
        state.branchParent.set(ev.branch, { branch: ev.parent.branch, index: ev.parent.index });
      }
    }
    seen.add(key);
    state.events.push(ev);
    state.nextIndex.set(ev.branch, expected + 1);
  }
  return { state, errors };
}

/**
 * Crash-recoverable, forkable session log (ADR-246 §2.3). One JSONL file may
 * carry many branches; each SessionLog instance appends to ONE active branch.
 * `fork()` returns a sibling over the same file/state on a new branch.
 */
export class SessionLog {
  private state: LogState;
  /** Active branch this instance appends to. */
  readonly branch: string;

  constructor(path: string, branch = 'main') {
    this.state = {
      path,
      events: [],
      nextIndex: new Map(),
      branchParent: new Map(),
      rootBranch: branch,
    };
    this.branch = branch;
  }

  /** Internal: build an instance over existing shared state (open/fork). */
  private static over(state: LogState, branch: string): SessionLog {
    const log = new SessionLog(state.path, branch);
    log.state = state;
    return log;
  }

  get path(): string {
    return this.state.path;
  }

  /**
   * Resume a session: read the JSONL log, validate it, and reconstruct state.
   * Throws with the first 'session: '-prefixed error on an invalid log.
   * `branch` selects the active branch (default 'main').
   */
  static async open(path: string, branch = 'main'): Promise<SessionLog> {
    if (!existsSync(path)) return new SessionLog(path, branch);
    const raw = await readFile(path, 'utf-8');
    const { state, errors } = parseLog(path, raw);
    if (errors.length > 0) throw new Error(errors[0]);
    if (state.events.length === 0) return new SessionLog(path, branch);
    return SessionLog.over(state, branch);
  }

  /** Append an event on the active branch, assigning the next monotonic
   * index. The first event of a forked branch carries the fork's parent ref. */
  async append(
    kind: string,
    payload: unknown,
    opts?: { parent?: { branch: string; index: number } },
  ): Promise<SessionEvent> {
    const index = this.state.nextIndex.get(this.branch) ?? 0;
    const parent = opts?.parent;
    const isRoot = this.state.events.length === 0 || this.branch === this.state.rootBranch;
    if (index === 0 && !isRoot && parent === undefined) {
      throw new Error(
        `session: first event of branch "${this.branch}" must carry a parent reference`,
      );
    }
    const event: SessionEvent =
      parent === undefined
        ? { index, branch: this.branch, kind, payload }
        : { index, branch: this.branch, parent, kind, payload };
    const line = serializeEvent(event);
    // Reject events the Rust mirror cannot parse: a lone surrogate is not
    // valid UTF-8 (raw form), and serde_json also rejects its `\udXXX`
    // escaped form, which well-formed JSON.stringify emits for it.
    if (LONE_SURROGATE.test(line) || LONE_SURROGATE_ESCAPE.test(line)) {
      throw new Error('session: event contains an unpaired surrogate (not valid UTF-8)');
    }
    await appendFile(this.state.path, line + '\n', 'utf-8');
    if (this.state.events.length === 0) this.state.rootBranch = this.branch;
    if (index === 0 && parent !== undefined) {
      this.state.branchParent.set(this.branch, parent);
    }
    this.state.events.push(event);
    this.state.nextIndex.set(this.branch, index + 1);
    return event;
  }

  /**
   * Fork at `atIndex` on THIS instance's active branch: returns a SessionLog
   * over the same file (and shared state) whose active branch is `newBranch`.
   * Immediately appends the new branch's synthetic first event (matching the
   * Rust mirror's `fork`): index 0, parent {branch: this.branch, index:
   * atIndex}, kind 'fork', payload null.
   */
  async fork(atIndex: number, newBranch: string): Promise<SessionLog> {
    const count = this.state.nextIndex.get(this.branch) ?? 0;
    if (atIndex < 0 || atIndex >= count) {
      throw new Error(
        `session: cannot fork branch "${this.branch}" at index ${atIndex} (has ${count} events)`,
      );
    }
    if ((this.state.nextIndex.get(newBranch) ?? 0) > 0 || newBranch === this.branch) {
      throw new Error(`session: branch "${newBranch}" already exists`);
    }
    const forked = SessionLog.over(this.state, newBranch);
    await forked.append('fork', null, { parent: { branch: this.branch, index: atIndex } });
    return forked;
  }

  /** The lineage of a branch, root → tip: the branch's own events preceded by
   * its parent lineage truncated at the fork point, recursively. */
  private lineage(branch: string): SessionEvent[] {
    const own = this.state.events
      .filter(e => e.branch === branch)
      .sort((a, b) => a.index - b.index);
    const parent = this.state.branchParent.get(branch);
    if (!parent) return own;
    const upstream = this.lineage(parent.branch).filter(
      e => e.branch !== parent.branch || e.index <= parent.index,
    );
    return [...upstream, ...own];
  }

  /**
   * State hash over the branch lineage (root → tip). Exact fold (mirrored in
   * the file-header comment; a Rust mirror must reproduce it):
   *     hexPrev = ''; for each event: hexPrev = hex(sha256(utf8(hexPrev + canonicalJson(event))))
   * Returns lowercase hex; the hash of an empty lineage is ''.
   */
  stateHash(branch: string = this.branch): string {
    let hexPrev = '';
    for (const e of this.lineage(branch)) {
      hexPrev = createHash('sha256')
        .update(hexPrev + canonicalJson(e), 'utf-8')
        .digest('hex');
    }
    return hexPrev;
  }

  /** Deterministic replay of a branch lineage: event count + state hash. */
  replay(branch: string = this.branch): { eventCount: number; stateHash: string } {
    return { eventCount: this.lineage(branch).length, stateHash: this.stateHash(branch) };
  }

  /** Re-read the file from disk and report every validation error
   * ('session: '-prefixed, corrupted lines cited by 1-based line number).
   * An empty array means the on-disk log is valid. */
  async validate(): Promise<string[]> {
    if (!existsSync(this.state.path)) return [];
    const raw = await readFile(this.state.path, 'utf-8');
    return parseLog(this.state.path, raw).errors;
  }
}
