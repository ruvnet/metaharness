// SPDX-License-Identifier: MIT
//
// Trajectory persistence — JSONL append-only store for the intel pipeline's
// RETRIEVE → JUDGE → DISTILL → CONSOLIDATE phases.
//
// Append-only: each record is one line of JSON. Reading is a streaming
// line-by-line parse so unbounded growth doesn't blow up memory. Optional
// rotation cap (records-old-than-N or file-size-greater-than-M) keeps
// the store bounded.

import { appendFile, readFile, stat, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface TrajectoryRecord {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Pipeline phase. */
  phase: 'Retrieve' | 'Judge' | 'Distill' | 'Consolidate';
  /** Outcome — Success/Skip/Fail in lowercase for JSONL compactness. */
  outcome: 'success' | 'skip' | 'fail';
  /** Free-form output. */
  output?: unknown;
}

export class TrajectoryStore {
  constructor(private path: string) {}

  async append(record: TrajectoryRecord): Promise<void> {
    await appendFile(this.path, JSON.stringify(record) + '\n', 'utf-8');
  }

  /**
   * A corrupted line (see `readAllWithDiagnostics`) is skipped silently: this
   * method reports only the surviving records, with no way to tell "empty
   * file" from "N records lost to corruption". Callers that need to know
   * whether the read was complete should call `readAllWithDiagnostics()`
   * instead and check `corruptLines`.
   *
   * Only a corrupted line's own JSON syntax is caught. A line that parses
   * but has the wrong shape (e.g. `{}` or `42`) is NOT detected — it is
   * pushed through as a `TrajectoryRecord` with `phase`/`outcome` `undefined`
   * at runtime despite the type assertion.
   *
   * Only recovers a corrupted line that is its OWN line (terminated by a
   * newline before the corruption, e.g. read some time after the crash with
   * no further writes). If a crash tears a write mid-line and a *later*
   * `append()` call lands directly after the torn bytes with no repair
   * step in between, the torn tail and that next record merge into one
   * unparseable line and BOTH are lost — see
   * `__tests__/trajectory.test.ts`'s "torn write immediately followed by a
   * same-session append" test for a documented reproduction of this
   * residual gap.
   */
  async readAll(): Promise<TrajectoryRecord[]> {
    return (await this.readAllWithDiagnostics()).records;
  }

  /**
   * Like `readAll()`, but never throws on a corrupted line: a truncated or
   * malformed record (e.g. from a crash mid-`append()`, or manual editing)
   * is skipped and its 1-based line number reported instead, so one bad
   * line doesn't discard the rest of the trajectory history. Byte-identical
   * `records` to `readAll()` when every line parses; `corruptLines` is empty
   * in that case too. See `readAll()`'s doc comment for this method's two
   * known limits (shape validation, torn-write-then-immediate-append).
   */
  async readAllWithDiagnostics(): Promise<{ records: TrajectoryRecord[]; corruptLines: number[] }> {
    if (!existsSync(this.path)) return { records: [], corruptLines: [] };
    const raw = await readFile(this.path, 'utf-8');
    const records: TrajectoryRecord[] = [];
    const corruptLines: number[] = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length === 0) continue;
      try {
        records.push(JSON.parse(line) as TrajectoryRecord);
      } catch {
        corruptLines.push(i + 1);
      }
    }
    return { records, corruptLines };
  }

  /** Rotate the file if it exceeds maxBytes. Old data goes to `<path>.1`. */
  async rotateIfLarger(maxBytes: number): Promise<boolean> {
    if (!existsSync(this.path)) return false;
    const s = await stat(this.path);
    if (s.size <= maxBytes) return false;
    await rename(this.path, this.path + '.1');
    await writeFile(this.path, '', 'utf-8');
    return true;
  }

  async size(): Promise<number> {
    if (!existsSync(this.path)) return 0;
    return (await stat(this.path)).size;
  }
}
