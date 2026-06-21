// SPDX-License-Identifier: MIT
//
// Darwin Shield — REAL CodeQL oracle ADAPTER SHELL (ADR-155 Addendum A, Phase 2,
// Tier 3 #10). This mirrors `semgrep-oracle.ts`: a real analyzer behind the
// `DetectorOracle`-shaped contract. CodeQL is GitHub's semantic code-analysis
// engine — heavier than semgrep (it builds a database then runs queries), so the
// present-path is left as a clearly-marked TODO. What ships here is the part that
// matters first: the graceful-skip adapter + availability probe, consistent with
// semgrep-oracle, so the deterministic suite stays green whether or not the
// `codeql` CLI is installed (it usually is NOT, outside CI).
//
// Safety: `codeql` is invoked via `execFileSync` with a bare argv (never a shell
// — no injection surface), exactly like `semgrep-oracle.ts` and `sandbox.ts`.

import { execFileSync } from 'node:child_process';

// Reuse the shared availability contract from the semgrep oracle so all real-tool
// adapters report availability identically.
import type { ToolAvailability, LabeledTarget } from './semgrep-oracle.js';

/** The scored result of running a query through real CodeQL on a labeled target. */
export interface CodeqlOracleResult {
  available: boolean;
  version: string;
  /** Present only on the (not-yet-implemented) success path. */
  findings?: Array<{ path: string; line: number; ruleId: string }>;
  /** A defensive receipt: why we skipped, or what failed. */
  reason?: string;
}

/** Resolve the codeql binary: explicit arg → `CODEQL_BIN` env → PATH. */
function resolveBinary(binary?: string): string {
  return binary || process.env.CODEQL_BIN || 'codeql';
}

/** Probe whether codeql is runnable; never throws. Returns available:false when absent. */
export function codeqlAvailability(binary?: string): ToolAvailability {
  const bin = resolveBinary(binary);
  try {
    // `codeql --version` prints a multi-line banner; the first line carries the version.
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { available: true, version: out.trim().split('\n')[0], binary: bin };
  } catch (e) {
    return { available: false, version: '', binary: bin, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The real CodeQL detection oracle (Phase 2 ADAPTER SHELL). Optional — skips when
 * absent, exactly like `SemgrepDetectorOracle`. The present-path (database build +
 * `codeql database analyze`) is a documented TODO; the contract and the
 * graceful-skip behavior are the shipped surface.
 */
export class CodeqlDetectorOracle {
  readonly name = 'codeql';
  private readonly binary: string;
  private readonly timeoutMs: number;

  constructor(opts: { binary?: string; timeoutMs?: number } = {}) {
    this.binary = resolveBinary(opts.binary);
    this.timeoutMs = opts.timeoutMs ?? 600_000; // CodeQL DB build + analyze is slow.
  }

  availability(): ToolAvailability {
    return codeqlAvailability(this.binary);
  }

  isAvailable(): boolean {
    return this.availability().available;
  }

  /**
   * Run a CodeQL query (pack/suite) against a labeled target and SCORE it.
   *
   * Behavior:
   *  - CodeQL ABSENT (the common case, incl. this environment): gracefully returns
   *    `{ available: false, reason }` so callers/tests skip rather than fail.
   *  - CodeQL PRESENT: structured to run `codeql database create` then
   *    `codeql database analyze --format=sarif-latest`, parse the SARIF results,
   *    and score them file-level against `target.labels` (mirroring
   *    `SemgrepDetectorOracle.evaluate`). This path is NOT yet implemented and
   *    throws — the point of this shell is the availability probe + graceful skip.
   *
   * @param query     a CodeQL query/pack/suite reference (e.g. a `.ql` path).
   * @param target    a real, on-disk labeled target.
   */
  evaluate(query: string, target: LabeledTarget): CodeqlOracleResult {
    const avail = this.availability();
    if (!avail.available) {
      return { available: false, version: '', reason: avail.reason ?? 'codeql not available' };
    }

    // TODO(Tier 3 #10): implement the present-path:
    //   1. const db = mkdtempSync(...);
    //   2. execFileSync(this.binary, ['database', 'create', db, '--language=<lang>',
    //        `--source-root=${target.dir}`], { timeout: this.timeoutMs });
    //   3. execFileSync(this.binary, ['database', 'analyze', db, query,
    //        '--format=sarif-latest', '--output=<sarif>'], { timeout: this.timeoutMs });
    //   4. parse the SARIF, normalize findings, score TP/FP/FN against target.labels
    //      exactly like SemgrepDetectorOracle.evaluate.
    // All invocations use bare-argv execFileSync (no shell), like semgrep-oracle.
    void query;
    void target;
    throw new Error('CodeqlDetectorOracle.evaluate: present-path not yet implemented (Tier 3 #10 shell)');
  }
}
