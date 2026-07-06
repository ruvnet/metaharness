// @metaharness/evals-sql — the SQL VERIFIER STACK.
//
// The verifier returns an AGREEMENT signal used by routing (escalate on disagreement) + calibration. It is
// deliberately NOT a generic "critic says yes" model — ADR-226 measured that read-only strong advice added
// ZERO marginal resolves at 5.4x cost. The useful lever is EXECUTOR policy + real checks: parse validity,
// dry-run (does it plan against the schema), and — the strong one — EXECUTE-AND-COMPARE (run the SQL against
// the DB, compare result sets across sampled candidates). Each check returns [0,1] agreement; the mode
// selects which check(s) run. Executable verification is the domain's strongest lever.
import type { QueryType, VerificationMode } from './genome.js';

export interface VerifyInput {
  queryType: QueryType;
  question: string;
  /** The normalized candidate SQL. */
  sql: string | null;
  /** Additional sampled queries (for executeCompare / self-consistency agreement). */
  samples?: (string | null)[];
}

export interface VerifyResult {
  /** [0,1] — how much the verifier stack agrees the query is sound. */
  agreement: number;
  /** True when the stack actively disagrees (agreement below a floor) → a routing escalation trigger. */
  disagrees: boolean;
  checksRun: string[];
}

/** Injectable executor for the live run (e.g. a sandboxed read-only DB). Given a SQL string it returns a
 *  stable fingerprint of the result set (or undefined if it errors). The default is a structural
 *  approximation so the adapter runs at $0 for replay; a real executor is strictly better. */
export type SqlExecutor = (sql: string) => string | undefined;

export function makeVerifier(opts: { execute?: SqlExecutor } = {}) {
  return function verify(mode: VerificationMode, input: VerifyInput): VerifyResult {
    if (mode === 'none' || input.sql === null) {
      return { agreement: input.sql === null ? 0 : 0.5, disagrees: input.sql === null, checksRun: [] };
    }
    const checks: string[] = [];
    const scores: number[] = [];

    if (mode === 'parse') {
      scores.push(parseValidity(input.sql));
      checks.push('parse');
    }
    if (mode === 'dryRun') {
      const fp = opts.execute?.(input.sql);
      scores.push(opts.execute ? (fp === undefined ? 0.2 : 0.8) : parseValidity(input.sql));
      checks.push(opts.execute ? 'dryRun' : 'dryRun~structural');
    }
    if (mode === 'executeCompare') {
      scores.push(executeAgreement(input.sql, input.samples ?? [], opts.execute));
      checks.push(opts.execute ? 'executeCompare' : 'executeCompare~selfConsistency');
    }
    if (mode === 'selfConsistency') {
      scores.push(selfConsistency(input.sql, input.samples ?? []));
      checks.push('selfConsistency');
    }
    const agreement = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.5;
    return { agreement, disagrees: agreement < 0.34, checksRun: checks };
  };
}

/** Fraction of sampled result-set fingerprints matching the chosen query's — the execute-and-compare signal.
 *  With no executor, falls back to textual self-consistency of the candidate queries. */
function executeAgreement(sql: string, samples: (string | null)[], execute?: SqlExecutor): number {
  if (!execute) return selfConsistency(sql, samples);
  const target = execute(sql);
  if (target === undefined) return 0.2; // the chosen query itself errors → low agreement
  const others = samples.filter((s): s is string => s !== null).map((s) => execute(s));
  const all = [target, ...others];
  if (all.length <= 1) return 0.6;
  const agree = all.filter((f) => f === target).length;
  return agree / all.length;
}

/** Fraction of samples textually matching the chosen query — the self-consistency agreement. */
function selfConsistency(sql: string, samples: (string | null)[]): number {
  const all = [sql, ...samples.filter((s): s is string => s !== null)];
  if (all.length <= 1) return 0.5;
  const agree = all.filter((s) => s === sql).length;
  return agree / all.length;
}

/** Cheap structural parse check — not a truth check, a shape check: a well-formed read query has SELECT and
 *  (except for constant selects) a FROM, balanced parens, and no obviously-degenerate body. */
function parseValidity(sql: string): number {
  const s = sql.trim();
  if (!s) return 0;
  const hasSelect = /\bselect\b/i.test(s);
  const hasFrom = /\bfrom\b/i.test(s);
  const balanced = balancedParens(s);
  if (!hasSelect || !balanced) return 0.2;
  if (!hasFrom) return 0.45; // e.g. `select 1` — valid but rarely the target
  return 0.75;
}

function balancedParens(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}
