// SPDX-License-Identifier: MIT
//
// Verifier layer (ADR-047): property tests + critique loop. Verification is
// adversarial by construction — the verifier is never the agent that produced the
// output, which is how the harness resists agents colluding on a bad answer.

import type { Verdict } from './types.js';

/** A named verifier: a pure check over an output, returning a verdict. */
export interface Verifier {
  id: string;
  /** Verifier kinds: syntax | unit | schema | citation | policy | cost | regression | custom. */
  kind: string;
  check: (output: unknown, context?: Record<string, unknown>) => Verdict | Promise<Verdict>;
}

/** Build a pass/fail verifier from a boolean predicate. */
export function predicateVerifier(
  id: string,
  kind: string,
  predicate: (output: unknown, ctx?: Record<string, unknown>) => boolean,
  failReason = 'predicate failed',
): Verifier {
  return {
    id,
    kind,
    check: (output, ctx) => {
      const pass = predicate(output, ctx);
      return { pass, score: pass ? 1 : 0, reasons: pass ? [] : [`${id}: ${failReason}`] };
    },
  };
}

/**
 * A registry of verifiers. `run` executes ALL of them and ANDs the result — the
 * output passes only if every verifier passes (any failure surfaces its reasons,
 * which feed the critique loop). The aggregate score is the mean.
 */
export class VerifierRegistry {
  private readonly verifiers: Verifier[] = [];

  register(...v: Verifier[]): this {
    this.verifiers.push(...v);
    return this;
  }

  /** Verifiers applicable to a step kind (or all, if no `kinds` filter). */
  forKinds(kinds?: string[]): Verifier[] {
    if (!kinds?.length) return this.verifiers;
    const set = new Set(kinds);
    return this.verifiers.filter((v) => set.has(v.kind));
  }

  async run(output: unknown, context?: Record<string, unknown>, kinds?: string[]): Promise<Verdict> {
    const applicable = this.forKinds(kinds);
    if (!applicable.length) return { pass: true, score: 1, reasons: ['no verifiers registered'] };
    const verdicts = await Promise.all(applicable.map((v) => v.check(output, context)));
    const pass = verdicts.every((v) => v.pass);
    const score = verdicts.reduce((s, v) => s + v.score, 0) / verdicts.length;
    const reasons = verdicts.flatMap((v) => v.reasons);
    return { pass, score, reasons };
  }
}

/** A repair function: given a failed output + reasons, propose a fixed output. */
export type Repair = (output: unknown, verdict: Verdict) => Promise<unknown> | unknown;

export interface CritiqueResult {
  output: unknown;
  verdict: Verdict;
  /** How many repair attempts were made. */
  attempts: number;
}

/**
 * The critique loop: verify → if fail, repair → re-verify, up to `maxAttempts`.
 * Returns the last output and verdict (passing or exhausted). The repair budget
 * is the caller's to enforce (see RetryBudget); this just bounds attempts.
 */
export async function critiqueLoop(
  registry: VerifierRegistry,
  initial: unknown,
  repair: Repair,
  opts: { maxAttempts?: number; context?: Record<string, unknown>; kinds?: string[] } = {},
): Promise<CritiqueResult> {
  const maxAttempts = Math.max(0, opts.maxAttempts ?? 2);
  let output = initial;
  let verdict = await registry.run(output, opts.context, opts.kinds);
  let attempts = 0;
  while (!verdict.pass && attempts < maxAttempts) {
    output = await repair(output, verdict);
    verdict = await registry.run(output, opts.context, opts.kinds);
    attempts += 1;
  }
  return { output, verdict, attempts };
}
