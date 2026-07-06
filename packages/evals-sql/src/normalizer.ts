// @metaharness/evals-sql — the SQL NORMALIZER + the (deterministic) EXECUTION-MATCH comparator.
//
// Extracts + canonicalizes the SQL statement from a solver's raw output so matching is fair (a correct query
// buried in prose or a ```sql fence, or `SELECT  Name` vs `select name`, should not be scored wrong).
// Dialect-aware canonicalization. Returns null when no SQL statement can be extracted — that null is the
// SQL-INVALID signal (a no-op) the routing + scoring layers act on.
//
// The primary metric is EXECUTION-MATCH (run predicted + gold on the DB, compare result sets); the injectable
// executor does that on the live run. For the $0 SYNTHETIC replay we fall back to CANONICAL EXACT-MATCH —
// never a fabricated execution verdict.
import type { SqlDialect } from './genome.js';

export interface NormalizedSql {
  /** Canonical SQL string, or null if none could be extracted (SQL-invalid → no-op). */
  value: string | null;
  /** True if the raw output actually presented a SQL statement. */
  formatValid: boolean;
}

// Pull the SQL statement starting at the first WITH/SELECT keyword, greedily to end. No lazy quantifier and
// no catastrophic alternation → strictly linear (no polynomial-ReDoS backtracking).
const STMT_RE = /\b(?:with|select)\b[\s\S]*/i;
// A fenced ```sql ... ``` block, if present.
const FENCE_RE = /```(?:sql)?([\s\S]*?)```/i;

/** Extract the SQL statement, then canonicalize per dialect. */
export function normalizeSql(raw: string, dialect: SqlDialect, normalize: boolean): NormalizedSql {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { value: null, formatValid: false };

  // Prefer a fenced ```sql block; otherwise scan the whole text for the first statement.
  const fence = trimmed.match(FENCE_RE);
  const body = fence && fence[1].trim() ? fence[1].trim() : trimmed;
  const m = body.match(STMT_RE);
  if (!m) return { value: null, formatValid: false };
  const candidate = m[0].trim();
  if (!candidate) return { value: null, formatValid: false };

  if (!normalize) return { value: candidate, formatValid: true };
  return { value: canonSql(candidate, dialect), formatValid: true };
}

/** Canonicalize a SQL string so cosmetically-different-but-equivalent queries compare equal. Deterministic,
 *  dialect-aware on quoting only (semantics are left to execution-match on the live run). */
export function canonSql(sql: string, _dialect: SqlDialect): string {
  return sql
    // drop a single trailing statement terminator
    .replace(/;\s*$/, '')
    // strip identifier quoting (backticks, double-quotes, square brackets) — dialect-neutral compare
    .replace(/[`"\[\]]/g, '')
    .toLowerCase()
    // collapse all whitespace runs to a single space
    .replace(/\s+/g, ' ')
    // tighten spacing around punctuation/operators so `a , b` == `a,b`
    .replace(/ ?([(),]) ?/g, '$1')
    .replace(/ ?([=<>]) ?/g, '$1')
    .trim();
}

/** EXECUTION-MATCH scorer. On the live run the caller injects a real executor that runs both queries and
 *  compares result sets; here (and for $0 replay) we fall back to canonical exact-match — never fabricate an
 *  execution verdict. */
export function executionMatch(predicted: string | null, gold: string, dialect: SqlDialect): boolean {
  if (predicted === null) return false;
  const g = normalizeSql(gold, dialect, true).value;
  if (g === null) return predicted.trim() === gold.trim();
  return predicted === g;
}
