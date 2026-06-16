// SPDX-License-Identifier: MIT
//
// Intent classifier + algorithm router (ADR-047). The classifier picks a workflow
// path with a softmax over keyword features plus hard rules; the router maps the
// chosen intent to a deterministic strategy — an ordered DAG of step kinds.
//
// This is the *control-plane* router (task type → strategy). It is distinct from
// `@metaharness/router`, which routes a query to the cheapest good-enough MODEL;
// the two compose (this picks the steps, that picks the worker for each step).

import type { Goal, PlanStep } from './types.js';

/** A strategy: a named, ordered set of step kinds with their dependencies. */
export interface Strategy {
  intent: string;
  /** Step kinds in dependency order; each lists the prior kinds it depends on. */
  steps: { kind: string; deps?: string[] }[];
}

/** The default strategy table from ADR-047 §"Algorithm router". */
export const DEFAULT_STRATEGIES: Record<string, Strategy> = {
  coding: {
    intent: 'coding',
    steps: [
      { kind: 'plan' },
      { kind: 'scan-repo', deps: ['plan'] },
      { kind: 'code', deps: ['scan-repo'] },
      { kind: 'test', deps: ['code'] },
      { kind: 'review', deps: ['test'] },
    ],
  },
  research: {
    intent: 'research',
    steps: [
      { kind: 'plan' },
      { kind: 'retrieve', deps: ['plan'] },
      { kind: 'verify-source', deps: ['retrieve'] },
      { kind: 'cite', deps: ['verify-source'] },
      { kind: 'summarize', deps: ['cite'] },
    ],
  },
  security: {
    intent: 'security',
    steps: [
      { kind: 'policy-gate' },
      { kind: 'sandbox', deps: ['policy-gate'] },
      { kind: 'audit', deps: ['sandbox'] },
    ],
  },
  creative: {
    intent: 'creative',
    steps: [
      { kind: 'generate' },
      { kind: 'critique', deps: ['generate'] },
      { kind: 'rank', deps: ['critique'] },
    ],
  },
};

/** Keyword cues per intent for the softmax classifier. */
const CUES: Record<string, string[]> = {
  coding: ['code', 'bug', 'function', 'refactor', 'implement', 'test', 'compile', 'repo'],
  research: ['research', 'find', 'cite', 'source', 'paper', 'evidence', 'summarize', 'investigate'],
  security: ['security', 'exploit', 'vulnerability', 'audit', 'sandbox', 'cve', 'attack', 'permission'],
  creative: ['write', 'story', 'design', 'brainstorm', 'creative', 'draft', 'poem', 'idea'],
};

export interface Classification {
  intent: string;
  /** Softmax probability assigned to the winning intent. */
  confidence: number;
  /** Full distribution over intents. */
  distribution: Record<string, number>;
}

/**
 * Intent classifier: count keyword cue hits per intent, softmax the counts. If a
 * goal carries an explicit `intent`, that rule wins outright (confidence 1).
 */
export function classifyIntent(goal: Goal, intents = Object.keys(CUES)): Classification {
  if (goal.intent && intents.includes(goal.intent)) {
    const distribution = Object.fromEntries(intents.map((i) => [i, i === goal.intent ? 1 : 0]));
    return { intent: goal.intent, confidence: 1, distribution };
  }
  const text = goal.text.toLowerCase();
  const logits = intents.map((intent) => {
    const cues = CUES[intent] ?? [];
    return cues.reduce((n, cue) => (text.includes(cue) ? n + 1 : n), 0);
  });
  const distribution = softmax(logits);
  let bestIdx = 0;
  for (let i = 1; i < distribution.length; i++) if (distribution[i] > distribution[bestIdx]) bestIdx = i;
  return {
    intent: intents[bestIdx],
    confidence: distribution[bestIdx],
    distribution: Object.fromEntries(intents.map((i, idx) => [i, distribution[idx]])),
  };
}

/** Numerically-stable softmax. */
export function softmax(xs: number[]): number[] {
  if (!xs.length) return [];
  const max = Math.max(...xs);
  const exps = xs.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * The algorithm router: pick a strategy for the goal's intent and compile it into
 * a plan DAG (`PlanStep[]`) with stable, unique step ids.
 */
export class AlgorithmRouter {
  private readonly strategies: Record<string, Strategy>;
  constructor(strategies: Record<string, Strategy> = DEFAULT_STRATEGIES) {
    this.strategies = strategies;
  }

  intents(): string[] {
    return Object.keys(this.strategies);
  }

  strategyFor(intent: string): Strategy {
    const s = this.strategies[intent];
    if (!s) throw new Error(`no strategy for intent "${intent}"`);
    return s;
  }

  /** Classify the goal and compile the matching strategy into a plan DAG. */
  plan(goal: Goal): { classification: Classification; steps: PlanStep[] } {
    const classification = classifyIntent(goal, this.intents());
    return { classification, steps: this.compile(classification.intent) };
  }

  /** Compile a strategy into plan steps. Step id = `${intent}:${kind}`. */
  compile(intent: string): PlanStep[] {
    const strat = this.strategyFor(intent);
    return strat.steps.map((s) => ({
      id: `${intent}:${s.kind}`,
      kind: s.kind,
      deps: (s.deps ?? []).map((d) => `${intent}:${d}`),
    }));
  }
}
