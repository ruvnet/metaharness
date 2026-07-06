// @metaharness/evals-hle — the SUBJECT-SPECIFIC VERIFIER STACK.
//
// The verifier returns an AGREEMENT signal used by routing (escalate on disagreement) + calibration. It is
// deliberately NOT a generic "critic says yes" model — ADR-226 measured that read-only strong advice added
// ZERO marginal resolves at 5.4x cost on top of cand-6. The useful lever is EXECUTOR policy + real checks:
// symbolic recomputation, unit/dimension consistency, multi-solver agreement — mostly deterministic, cheap,
// and subject-appropriate. Each check returns [0,1] agreement; the mode selects which check(s) run.
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

/** Injectable symbolic/tool verifier for the live run (e.g. a sandboxed CAS). The default is a structural
 *  approximation so the adapter runs at $0 for replay; a real check is strictly better. */
export type SymbolicChecker = (question: string, answer: string) => number | undefined;

export function makeVerifier(opts: { symbolic?: SymbolicChecker } = {}) {
  return function verify(mode: VerificationMode, input: VerifyInput): VerifyResult {
    if (mode === 'none' || input.answer === null) {
      return { agreement: input.answer === null ? 0 : 0.5, disagrees: input.answer === null, checksRun: [] };
    }
    const checks: string[] = [];
    const scores: number[] = [];

    if (mode === 'multiSolver' || mode === 'retrievalFreeCritic') {
      scores.push(selfConsistency(input.answer, input.samples ?? []));
      checks.push('multiSolver');
    }
    if (mode === 'symbolic') {
      const s = opts.symbolic?.(input.question, input.answer);
      scores.push(s ?? structuralPlausibility(input.subject, input.answer));
      checks.push(opts.symbolic ? 'symbolic' : 'symbolic~structural');
    }
    if (mode === 'unitCheck') {
      scores.push(unitConsistency(input.subject, input.answer));
      checks.push('unitCheck');
    }
    if (mode === 'retrievalFreeCritic') {
      scores.push(structuralPlausibility(input.subject, input.answer));
      checks.push('critic~structural');
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

/** Cheap dimensional sanity: physics/chem answers should carry or imply units when numeric-with-context. */
function unitConsistency(subject: Subject, answer: string): number {
  if (subject !== 'physics' && subject !== 'chemistry') return 0.5;
  const hasNumber = /\d/.test(answer);
  const hasUnit = /\b(m|s|kg|mol|J|K|Hz|V|A|W|N|Pa|eV|nm|°C|g\/mol)\b/.test(answer);
  if (!hasNumber) return 0.5;
  return hasUnit ? 0.75 : 0.35;
}

/** Structural plausibility floor — not a truth check, a shape check (non-empty, not obviously degenerate). */
function structuralPlausibility(subject: Subject, answer: string): number {
  const a = answer.trim();
  if (!a) return 0;
  if (/^(i don'?t know|unknown|n\/?a|none)$/i.test(a)) return 0.1;
  if (subject === 'math' && /^-?\d+(\.\d+)?$/.test(a)) return 0.6;
  return 0.5;
}
