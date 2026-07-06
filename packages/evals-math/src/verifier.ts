// @metaharness/evals-math — the SUBTOPIC-SPECIFIC VERIFIER STACK.
//
// The verifier returns an AGREEMENT signal used by routing (escalate on disagreement) + calibration. It is
// deliberately NOT a generic "critic says yes" model — ADR-226 measured that read-only strong advice added
// ZERO marginal resolves at 5.4x cost. The useful lever for math is EXECUTOR policy + real checks: SYMBOLIC
// RECOMPUTATION (re-evaluate the arithmetic and compare), unit/dimension consistency, multi-solver
// self-consistency, and range sanity — mostly deterministic, cheap, subject-appropriate. Each check returns
// [0,1] agreement; the mode selects which check(s) run.
import type { Subject, VerificationMode } from './genome.js';

export interface VerifyInput {
  subject: Subject;
  question: string;
  /** The normalized candidate answer. */
  answer: string | null;
  /** Additional sampled answers (for multiSolver / self-consistency agreement). */
  samples?: (string | null)[];
}

export interface VerifyResult {
  /** [0,1] — how much the verifier stack agrees the answer is sound. */
  agreement: number;
  /** True when the stack actively disagrees (agreement below a floor) → a routing escalation trigger. */
  disagrees: boolean;
  checksRun: string[];
}

/** Injectable symbolic recompute for the live run (e.g. a sandboxed CAS or Python exec that re-derives the
 *  arithmetic and returns agreement in [0,1]). The default is a structural approximation so the adapter runs
 *  at $0 for replay; a real recompute is strictly better. */
export type SymbolicChecker = (question: string, answer: string) => number | undefined;

export function makeVerifier(opts: { symbolic?: SymbolicChecker } = {}) {
  return function verify(mode: VerificationMode, input: VerifyInput): VerifyResult {
    if (mode === 'none' || input.answer === null) {
      return { agreement: input.answer === null ? 0 : 0.5, disagrees: input.answer === null, checksRun: [] };
    }
    const checks: string[] = [];
    const scores: number[] = [];

    if (mode === 'multiSolver') {
      scores.push(selfConsistency(input.answer, input.samples ?? []));
      checks.push('multiSolver');
    }
    if (mode === 'symbolicRecompute') {
      const s = opts.symbolic?.(input.question, input.answer);
      scores.push(s ?? numericPlausibility(input.answer));
      checks.push(opts.symbolic ? 'symbolicRecompute' : 'symbolicRecompute~structural');
    }
    if (mode === 'unitCheck') {
      scores.push(unitConsistency(input.subject, input.answer));
      checks.push('unitCheck');
    }
    if (mode === 'rangeSanity') {
      scores.push(rangeSanity(input.answer));
      checks.push('rangeSanity');
    }
    const agreement = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.5;
    return { agreement, disagrees: agreement < 0.34, checksRun: checks };
  };
}

/** Fraction of samples matching the chosen answer — the multi-solver / self-consistency agreement. */
function selfConsistency(answer: string, samples: (string | null)[]): number {
  const all = [answer, ...samples.filter((s): s is string => s !== null)];
  if (all.length <= 1) return 0.5;
  const agree = all.filter((s) => s === answer).length;
  return agree / all.length;
}

/** A well-formed GSM8K answer is a finite number. Non-numeric or non-finite outputs are implausible. */
function numericPlausibility(answer: string): number {
  const v = valueOf(answer);
  if (v === null) return 0.15;
  if (!Number.isFinite(v)) return 0.05;
  return 0.7;
}

/** Cheap dimensional sanity: geometry / word-problem answers that carry a unit read as more sound. */
function unitConsistency(subject: Subject, answer: string): number {
  if (subject !== 'geometry' && subject !== 'wordproblem') return 0.5;
  const hasNumber = /\d/.test(answer);
  const hasUnit = /\b(cm|mm|m|km|in|ft|yd|mi|s|min|h|kg|g|lb|oz|mol|degrees?|°|dollars?|cents?|units?)\b/i.test(answer);
  if (!hasNumber) return 0.35;
  return hasUnit ? 0.75 : 0.5;
}

/** Range sanity — a plausible word-problem answer is finite and not absurdly large; obvious garbage floors. */
function rangeSanity(answer: string): number {
  const a = answer.trim();
  if (!a) return 0;
  if (/^(i don'?t know|unknown|n\/?a|none|undefined|nan|infinity)$/i.test(a)) return 0.1;
  const v = valueOf(a);
  if (v === null) return 0.35;
  if (!Number.isFinite(v)) return 0.05;
  if (Math.abs(v) > 1e12) return 0.25; // GSM8K answers are grade-school scale
  return 0.6;
}

/** Numeric value of a canonical answer ("3", "3/4", "12 cm" → 12). null when no number present. */
function valueOf(s: string): number | null {
  const f = s.match(/(-?\d+)\/(\d+)/);
  if (f) { const d = Number(f[2]); return d === 0 ? null : Number(f[1]) / d; }
  const n = s.replace(/[,$%]/g, '').match(/-?\d+(?:\.\d+)?/);
  return n ? Number(n[0]) : null;
}
