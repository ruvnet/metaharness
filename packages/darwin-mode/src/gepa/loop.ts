// SPDX-License-Identifier: MIT
//
// ADR-228 §9.3 — a faithful minimal implementation of the GEPA loop (arXiv 2507.19457) over the
// executor genome: reflective mutation (an LLM reads per-instance ASI and proposes a targeted TEXT
// mutation to ONE component) + Pareto selection over per-instance score vectors.
//
// TypeScript port of bench/swebench/gepa/gepa-loop.mjs — behavior-preserving. The load-bearing
// design point: the EVALUATOR is an injected async callback (`GepaEvaluator`), so this module has
// zero SWE-bench/Docker/solve-advisor coupling. The in-repo bench evaluator (evaluate-genome.mjs)
// is the reference wiring and intentionally does not ship.
//
// Verified reference-implementation contracts mirrored here (ADR-228 §9.3):
//   1. never raise for individual instance failures (evaluator's job; the loop treats missing
//      instances as score 0)
//   2. SUM(scores) drives accept/reject of a mutation vs its parent; per-instance vectors drive
//      the Pareto frontier ("the set of candidates which achieve the highest score on at least one
//      evaluation instance")
//   3. candidates are never mutated in place (mutateComponent returns fresh objects)
//   4. metric-call accounting: one genome evaluation = N instances = N metric calls, tracked
//      against maxMetricCalls alongside the dollar budget (BudgetTracker pattern)

import { mutateComponent, type Genome } from './genome.js';

/** A candidate's per-instance score vector (instanceId → score). */
export type ScoreVector = Record<string, number>;

/** Per-instance ASI feedback texts (instanceId → prose). */
export type FeedbackMap = Record<string, string>;

/** What the injected evaluator returns for one genome over the evaluation slice. */
export interface GepaEvalResult {
  scores: ScoreVector;
  feedbacks?: FeedbackMap;
  /** Dollar cost of the evaluation (0 for offline/stub evaluators). */
  cost?: number;
  /** Metric calls consumed (defaults to the number of scored instances — contract 4). */
  metricCalls?: number;
}

/** The injected evaluator: run one genome over the slice, return scores + ASI. */
export type GepaEvaluator = (genome: Genome) => Promise<GepaEvalResult>;

/** The injected reflection LM call: prompt in, raw proposal text (+ cost) out. */
export type GepaReflector = (prompt: string) => Promise<{ raw: string; cost?: number }>;

/** A pool entry: a candidate genome + its evaluation results + lineage. */
export interface GepaCandidate {
  id: string;
  genome: Genome;
  scores: ScoreVector;
  feedbacks: FeedbackMap;
  accepted?: boolean;
  parent?: string | null;
}

export interface ParetoResult {
  /** Candidates that are (tied-)best on ≥1 instance. */
  frontier: string[];
  /** instanceId → ids tied-best on that instance. */
  winners: Record<string, string[]>;
  /** id → number of instances won. */
  wins: Record<string, number>;
  /** Highest MEAN score (mean drives tracking, per verified contract 2). */
  best: string | null;
  bestMean: number;
}

/**
 * GEPA Pareto frontier over per-instance score vectors.
 *   candidates: [{ id, scores: { instId: number } }]
 */
export function paretoFrontier(candidates: Array<Pick<GepaCandidate, 'id' | 'scores'>>): ParetoResult {
  const instIds = [...new Set(candidates.flatMap((c) => Object.keys(c.scores || {})))];
  const winners: Record<string, string[]> = {}; const wins: Record<string, number> = {};
  for (const inst of instIds) {
    let bestScore = -Infinity;
    for (const c of candidates) bestScore = Math.max(bestScore, c.scores?.[inst] ?? -Infinity);
    winners[inst] = candidates.filter((c) => (c.scores?.[inst] ?? -Infinity) === bestScore).map((c) => c.id);
    for (const id of winners[inst]) wins[id] = (wins[id] || 0) + 1;
  }
  const frontier = candidates.filter((c) => wins[c.id] > 0).map((c) => c.id);
  const mean = (c: Pick<GepaCandidate, 'scores'>) => { const v = Object.values(c.scores || {}); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : -Infinity; };
  let best: string | null = null; let bestMean = -Infinity;
  for (const c of candidates) { const m = mean(c); if (m > bestMean) { bestMean = m; best = c.id; } }
  return { frontier, winners, wins, best, bestMean };
}

/** Sample the next parent from the frontier, frequency-weighted by instances won (GEPA §parent sampling). */
export function sampleParent(candidates: Array<Pick<GepaCandidate, 'id' | 'scores'>>, rng: () => number = Math.random): string | null {
  const { frontier, wins } = paretoFrontier(candidates);
  if (!frontier.length) return candidates[candidates.length - 1]?.id ?? null;
  const total = frontier.reduce((s, id) => s + wins[id], 0);
  let roll = rng() * total;
  for (const id of frontier) { roll -= wins[id]; if (roll <= 0) return id; }
  return frontier[frontier.length - 1];
}

/** Count 'mutation target:' votes in ASI feedback texts → { componentName: votes } (only names the genome knows). */
export function mutationTargetVotes(feedbacks: FeedbackMap | undefined, componentNames: string[]): Record<string, number> {
  const votes: Record<string, number> = {};
  for (const fb of Object.values(feedbacks || {})) {
    const m = String(fb).match(/mutation target:[^\n]*/gi) || [];
    for (const line of m) for (const name of componentNames) {
      if (line.includes(name)) votes[name] = (votes[name] || 0) + 1;
    }
  }
  return votes;
}

/** Pick the component to mutate: ASI-vote-ranked, falling back to round-robin over `mutable`. */
export function pickTargetComponent({ feedbacks, mutable, step = 0, lastMutated = null }: {
  feedbacks?: FeedbackMap; mutable: string[]; step?: number; lastMutated?: string | null;
}): string {
  const votes = mutationTargetVotes(feedbacks, mutable);
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]).map(([k]) => k).filter((k) => k !== lastMutated);
  if (ranked.length) return ranked[0];
  const rr = mutable.filter((k) => k !== lastMutated);
  return rr[step % rr.length] ?? mutable[0];
}

/** Build the reflection prompt: current component text + the worst instances' ASI → propose new text. */
export function buildReflectionPrompt({ genome, targetComponent, feedbacks, maxFeedbacks = 8 }: {
  genome: Genome; targetComponent: string; feedbacks?: FeedbackMap; maxFeedbacks?: number;
}): string {
  const worst = Object.entries(feedbacks || {})
    .sort((a, b) => {
      const score = (t: [string, string]) => { const m = String(t[1]).match(/score (-?[\d.]+)/); return m ? +m[1] : 0; };
      return score(a) - score(b);
    })
    .slice(0, maxFeedbacks);
  return [
    'You are optimizing ONE text component of an autonomous bug-fixing agent\'s operating policy (its "genome").',
    'The component is injected verbatim into the agent\'s system prompt. Below: the current component text, then',
    'per-instance execution feedback from runs using this policy (worst instances first). Diagnose the recurring',
    'failure pattern and rewrite the component to fix it. Rules: keep any {{ext}}/{{glob}} placeholders; keep JSON',
    'tool-call example syntax intact if present; stay concise (the agent is a small model — short imperative rules',
    'beat essays); do NOT mention specific benchmark instances or repos. Output ONLY the new component text inside',
    'a fenced block:\n```component\n<new text>\n```',
    '',
    `--- component: ${targetComponent} ---`,
    genome.components[targetComponent],
    '',
    '--- execution feedback (ASI) ---',
    ...worst.map(([id, fb]) => `[${id}]\n${fb}`),
  ].join('\n');
}

/**
 * Linear-time fenced-block scan (CodeQL js/polynomial-redos: the equivalent
 * /```component\s*\n([\s\S]*?)```/ backtracks polynomially on adversarial
 * whitespace). Semantics preserved: an opener counts only when nothing but
 * whitespace sits between it and a newline; invalid openers are skipped and
 * the scan continues forward, exactly like regex .match would.
 */
function extractFence(s: string, opener: string): string | null {
  let from = 0;
  for (;;) {
    const start = s.indexOf(opener, from);
    if (start < 0) return null;
    const nl = s.indexOf('\n', start + opener.length);
    if (nl >= 0 && s.slice(start + opener.length, nl).trim() === '') {
      const close = s.indexOf('```', nl + 1);
      if (close >= 0) return s.slice(nl + 1, close);
    }
    from = start + opener.length;
  }
}

/** Extract the proposed component text from the reflection LM's reply. null = unusable proposal. */
export function parseReflection(raw: unknown): string | null {
  const s = String(raw ?? '');
  const fence = extractFence(s, '```component') ?? extractFence(s, '```');
  const text = (fence ?? s).trim();
  return text.length >= 8 ? text : null; // degenerate/empty proposals are rejected
}

export interface GepaHistoryEvent {
  event: string;
  step?: number;
  id?: string;
  target?: string;
  parent?: string | null;
  reason?: string;
  error?: string;
  after?: number;
  sumChild?: number;
  sumParent?: number;
}

export interface GepaBudget {
  metricCalls: number;
  evalCost: number;
  reflectionCost: number;
  totalCost: number;
}

export interface GepaOptimizeResult {
  /** Evaluated candidates kept in the pool (feedbacks stripped — they can be large). */
  pool: Array<Omit<GepaCandidate, 'feedbacks'>>;
  frontier: string[];
  winners: Record<string, string[]>;
  best: string | null;
  bestMean: number;
  budget: GepaBudget;
  history: GepaHistoryEvent[];
}

export interface GepaOptimizeOptions {
  /** Seed genome object (dict[str,str] components). */
  seed: Genome;
  /** Injected evaluator: async (genome) => { scores, feedbacks, cost, metricCalls }. */
  evaluate: GepaEvaluator;
  /** Injected reflection LM: async (prompt) => { raw, cost }. */
  reflect: GepaReflector;
  rng?: () => number;
  /** Component names GEPA may touch (ADR-228 §6 optimize-first order). */
  mutable?: string[];
  maxCandidates?: number;
  maxMetricCalls?: number;
  maxCost?: number;
  maxStall?: number;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * The budgeted GEPA loop.
 * Stops when maxCandidates genomes have been EVALUATED (seed included — discarded candidates still
 * consume evaluations, which is what costs money), maxMetricCalls spent, maxCost ($) hit, or the
 * loop stalls (maxStall consecutive iterations without a successful evaluation).
 * Returns { pool, frontier, best, budget, history } — the FULL frontier is reported, not one winner
 * (ADR-228 §8 mitigation: keep Pareto candidates).
 */
export async function gepaOptimize({
  seed, evaluate, reflect, rng = Math.random,
  mutable = ['retrieval_policy', 'executor_preamble', 'edit_policy', 'tool_grep', 'tool_read', 'tool_edit', 'tool_line_edit', 'test_policy', 'protocol_reminder'],
  maxCandidates = 15, maxMetricCalls = Infinity, maxCost = Infinity, maxStall = 10,
  onEvent = () => {},
}: GepaOptimizeOptions): Promise<GepaOptimizeResult> {
  const budget = { metricCalls: 0, evalCost: 0, reflectionCost: 0, get totalCost() { return this.evalCost + this.reflectionCost; } };
  const history: GepaHistoryEvent[] = [];
  const pool: GepaCandidate[] = []; // { id, genome, scores, feedbacks, accepted, parent }

  async function runEval(genome: Genome, id: string, parent: string | null = null): Promise<GepaCandidate> {
    const r = await evaluate(genome);
    budget.metricCalls += r.metricCalls ?? Object.keys(r.scores || {}).length; // contract 4
    budget.evalCost += r.cost || 0;
    const entry: GepaCandidate = { id, genome, scores: r.scores || {}, feedbacks: r.feedbacks || {}, parent };
    onEvent('evaluated', { id, sum: Object.values(entry.scores).reduce((s, x) => s + x, 0), parent });
    return entry;
  }

  const seedEntry = await runEval(seed, seed.meta?.id || 'seed');
  seedEntry.accepted = true;
  pool.push(seedEntry);
  history.push({ event: 'seed', id: seedEntry.id });

  let step = 0;
  let candN = 0;
  let evaluated = 1; // the seed
  let stalled = 0;   // consecutive iterations that produced no evaluation (reflection errors / rejects)
  while (evaluated < maxCandidates && budget.metricCalls < maxMetricCalls && budget.totalCost < maxCost) {
    step++;
    if (stalled >= maxStall) { history.push({ event: 'stalled', step, after: stalled }); break; }
    const parentId = sampleParent(pool, rng);
    const parent = pool.find((c) => c.id === parentId)!;
    const target = pickTargetComponent({ feedbacks: parent.feedbacks, mutable, step, lastMutated: parent.genome.meta?.mutated ?? null });
    const prompt = buildReflectionPrompt({ genome: parent.genome, targetComponent: target, feedbacks: parent.feedbacks });
    let proposal: string | null = null;
    try { const r = await reflect(prompt); budget.reflectionCost += r.cost || 0; proposal = parseReflection(r.raw); }
    catch (e) { history.push({ event: 'reflection-error', step, error: String((e as Error)?.message || e) }); stalled++; continue; }
    if (!proposal || proposal === parent.genome.components[target]) {
      history.push({ event: 'proposal-rejected', step, target, reason: !proposal ? 'unparseable/degenerate' : 'no-change' });
      stalled++;
      continue;
    }
    stalled = 0;
    candN++;
    const child = mutateComponent(parent.genome, target, proposal, { id: `cand-${candN}` });
    const childEntry = await runEval(child, child.meta!.id!, parentId);
    evaluated++;
    // Verified contract 2: SUM over the shared instance set drives accept/reject…
    const shared = Object.keys(parent.scores).filter((k) => k in childEntry.scores);
    const sum = (e: GepaCandidate) => shared.reduce((s, k) => s + (e.scores[k] ?? 0), 0);
    const accepted = sum(childEntry) > sum(parent);
    // …but a rejected child still joins the pool if it sets a new per-instance best (Pareto-add):
    // that is what keeps candidates that win on DIFFERENT task subsets alive.
    const beforeBest: Record<string, number> = {}; for (const k of shared) beforeBest[k] = Math.max(...pool.map((c) => c.scores[k] ?? -Infinity));
    const paretoAdds = shared.some((k) => (childEntry.scores[k] ?? -Infinity) > beforeBest[k]);
    childEntry.accepted = accepted;
    if (accepted || paretoAdds) pool.push(childEntry);
    history.push({ event: accepted ? 'accepted' : paretoAdds ? 'pareto-added' : 'discarded', step, id: childEntry.id, target, parent: parentId, sumChild: sum(childEntry), sumParent: sum(parent) });
    onEvent(accepted ? 'accepted' : 'rejected', { id: childEntry.id, target });
  }

  const front = paretoFrontier(pool);
  return {
    pool: pool.map(({ id, genome, scores, accepted, parent }) => ({ id, genome, scores, accepted, parent })),
    frontier: front.frontier, winners: front.winners, best: front.best, bestMean: front.bestMean,
    budget: { metricCalls: budget.metricCalls, evalCost: budget.evalCost, reflectionCost: budget.reflectionCost, totalCost: budget.totalCost },
    history,
  };
}
