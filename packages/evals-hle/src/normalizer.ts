// @metaharness/evals-hle — the FINAL ANSWER NORMALIZER.
//
// Extracts + canonicalizes the answer from a solver's raw output so exact-match scoring is fair (a correct
// answer buried in prose, or "0.50" vs ".5", should not be scored wrong). Format-aware. Returns null when no
// answer of the expected shape can be extracted — that null is the FORMAT-INVALID signal (a no-op) the
// routing + scoring layers act on.
import type { AnswerFormat } from './genome.js';

export interface NormalizedAnswer {
  /** Canonical answer string, or null if none could be extracted (format-invalid → no-op). */
  value: string | null;
  /** True if the raw output actually presented an answer in the expected shape. */
  formatValid: boolean;
}

// Match an explicit final-answer marker on a SINGLE line, capturing greedily to the first '.' or end. No
// trailing `\s*$` anchor and no lazy quantifier → strictly linear (no polynomial-ReDoS backtracking).
const FINAL_RE = /(?:final answer|answer is|answer|therefore|=)[\s:\-]*([^.]*)/i;

/** Pull the last "answer-like" span, then canonicalize per format. */
export function normalizeAnswer(raw: string, format: AnswerFormat, normalize: boolean): NormalizedAnswer {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { value: null, formatValid: false };

  // Prefer an explicit "final answer: X" tail; else take the last non-empty line.
  // Take the last non-empty line, then pull an explicit final-answer marker from THAT line (single-line
  // match keeps FINAL_RE linear); fall back to the whole last line.
  const lastLine = trimmed.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const m = lastLine.match(FINAL_RE);
  const candidate = m && m[1].trim() ? m[1].trim() : lastLine;
  if (!candidate) return { value: null, formatValid: false };

  if (!normalize) return { value: candidate, formatValid: true };

  switch (format) {
    case 'numeric': {
      const n = candidate.replace(/[, $]/g, '').match(/-?\d+(?:\.\d+)?(?:[eE]-?\d+)?/);
      if (!n) return { value: null, formatValid: false };
      return { value: canonNumber(n[0]), formatValid: true };
    }
    case 'choice': {
      const c = candidate.match(/\b([A-E])\b/);
      if (!c) return { value: null, formatValid: false };
      return { value: c[1].toUpperCase(), formatValid: true };
    }
    case 'equation':
      return { value: candidate.replace(/\s+/g, '').toLowerCase(), formatValid: true };
    case 'proof':
      // proofs are graded on the final claim, not the prose — keep the canonical tail
      return { value: candidate.replace(/\s+/g, ' ').toLowerCase(), formatValid: true };
    case 'short':
    default:
      return { value: canonShort(candidate), formatValid: true };
  }
}

function canonNumber(s: string): string {
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  // strip trailing zeros / normalize -0
  return String(n === 0 ? 0 : n);
}

function canonShort(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,;:!?"']/g, '')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Exact-match scorer over normalized answers (the deterministic HLE grader for closed-form answers). For
 *  open-ended answers the caller injects an LLM judge instead — never fabricate a judge verdict. */
export function exactMatch(predicted: string | null, gold: string, format: AnswerFormat): boolean {
  if (predicted === null) return false;
  const g = normalizeAnswer(gold, format, true).value;
  if (g === null) return predicted.trim() === gold.trim();
  return predicted === g;
}
