// @metaharness/evals-math — the FINAL ANSWER NORMALIZER.
//
// Extracts + canonicalizes the numeric answer from a solver's raw output so exact-match scoring is fair (a
// correct answer buried in a chain-of-thought, or "1,000" vs "1000", "0.50" vs ".5", "$12" vs "12", should
// not be scored wrong). Format-aware and numeric-first (GSM8K answers are numbers). Returns null when no
// answer of the expected shape can be extracted — that null is the FORMAT-INVALID signal (a no-op) the
// routing + scoring layers act on.
import type { AnswerFormat } from './genome.js';

export interface NormalizedAnswer {
  /** Canonical answer string, or null if none could be extracted (format-invalid → no-op). */
  value: string | null;
  /** True if the raw output actually presented an answer in the expected shape. */
  formatValid: boolean;
}

// Match an explicit final-answer marker on a SINGLE line, capturing greedily to end. No trailing `\s*$`
// anchor and no lazy quantifier → strictly linear (no polynomial-ReDoS backtracking). GSM8K's own gold
// answers use a `#### N` marker; we accept that plus the usual natural-language markers.
const FINAL_RE = /(?:####|final answer|the answer is|answer is|answer|therefore|=)[\s:$\-]*([^\n]*)/i;

/** Pull the last "answer-like" span, then canonicalize per format. */
export function normalizeAnswer(raw: string, format: AnswerFormat, normalize: boolean): NormalizedAnswer {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { value: null, formatValid: false };

  // Prefer an explicit "final answer: X" / "#### X" tail; else take the last non-empty line, then pull an
  // explicit final-answer marker from THAT line (single-line match keeps FINAL_RE linear).
  const lastLine = trimmed.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const m = lastLine.match(FINAL_RE);
  const candidate = m && m[1].trim() ? m[1].trim() : lastLine;
  if (!candidate) return { value: null, formatValid: false };

  if (!normalize) return { value: candidate, formatValid: true };

  switch (format) {
    case 'integer': {
      const n = stripNumeric(candidate).match(/-?\d+/);
      if (!n) return { value: null, formatValid: false };
      return { value: canonNumber(n[0]), formatValid: true };
    }
    case 'decimal': {
      const n = stripNumeric(candidate).match(/-?\d+(?:\.\d+)?(?:[eE]-?\d+)?/);
      if (!n) return { value: null, formatValid: false };
      return { value: canonNumber(n[0]), formatValid: true };
    }
    case 'fraction': {
      const f = candidate.replace(/\s+/g, '').match(/(-?\d{1,15})\/(\d{1,15})/);
      if (f) return { value: canonFraction(f[1], f[2]), formatValid: true };
      // a bare number is a valid fraction with denominator 1
      const n = stripNumeric(candidate).match(/-?\d+(?:\.\d+)?/);
      if (!n) return { value: null, formatValid: false };
      return { value: canonNumber(n[0]), formatValid: true };
    }
    case 'expression':
      return { value: candidate.replace(/\s+/g, '').toLowerCase(), formatValid: true };
    case 'units': {
      // extract the numeric magnitude AND the trailing unit token, canonicalize the number.
      const n = stripNumeric(candidate).match(/-?\d+(?:\.\d+)?/);
      if (!n) return { value: null, formatValid: false };
      const unit = candidate.replace(/[\d.,$\s-]/g, '').toLowerCase();
      return { value: unit ? `${canonNumber(n[0])} ${unit}` : canonNumber(n[0]), formatValid: true };
    }
    default:
      return { value: candidate.trim(), formatValid: true };
  }
}

/** Strip grouping commas, currency, and percent signs so "1,000", "$12", "50%" parse cleanly. */
function stripNumeric(s: string): string {
  return s.replace(/[,$%]/g, '');
}

function canonNumber(s: string): string {
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  // strip trailing zeros / normalize -0
  return String(n === 0 ? 0 : n);
}

/** Reduce a fraction to lowest terms; collapse to an integer when the denominator divides evenly. */
function canonFraction(numStr: string, denStr: string): string {
  const num = Number(numStr);
  const den = Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return `${numStr}/${denStr}`;
  const g = gcd(Math.abs(num), Math.abs(den)) || 1;
  const rn = num / g;
  const rd = den / g;
  return rd === 1 ? String(rn) : `${rn}/${rd}`;
}

function gcd(a: number, b: number): number {
  a = Math.round(a); b = Math.round(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

/** Exact-match scorer over normalized answers (the deterministic GSM8K grader). Numeric formats compare by
 *  VALUE (so "1/2" == "0.5", "3.0" == "3"); other formats compare canonical strings. For any answer that is
 *  genuinely open-ended the caller injects an LLM judge instead — never fabricate a judge verdict. */
export function exactMatch(predicted: string | null, gold: string, format: AnswerFormat): boolean {
  if (predicted === null) return false;
  const g = normalizeAnswer(gold, format, true).value;
  if (g === null) return predicted.trim() === gold.trim();
  if (format === 'integer' || format === 'decimal' || format === 'fraction') {
    const pv = numericValueOf(predicted);
    const gv = numericValueOf(g);
    if (pv !== null && gv !== null) return Math.abs(pv - gv) < 1e-9;
  }
  return predicted === g;
}

/** Best-effort numeric value of a canonical answer string ("3", "3/4", "-2.5"). null when not numeric. */
function numericValueOf(s: string): number | null {
  const f = s.match(/^(-?\d+)\/(\d+)$/);
  if (f) { const d = Number(f[2]); return d === 0 ? null : Number(f[1]) / d; }
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}
