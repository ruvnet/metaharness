// SPDX-License-Identifier: MIT
//
// The Harness Kernel (ADR-047): owns the run lifecycle and drives the execution
// loop. The model proposes (workers produce outputs); the harness decides
// (utility scoring + four gates + safety); the algorithms verify (verifier layer
// + receipts). Given the same goal, policy, budget and worker outputs, a run
// replays identically and its receipt chain verifies.
//
//   1. Classify goal      2. Retrieve memory     3. Build plan
//   4. Select agents      5. Execute steps       6. Verify outputs
//   7. Retry/repair       8. Merge results       9. Write receipts   10. Update memory

import { AlgorithmRouter, type Classification } from './router.js';
import { AgentPool } from './pool.js';
import { VerifierRegistry } from './verifier.js';
import { PolicyGate, type Action } from './safety.js';
import { CircuitBreaker, RetryBudget } from './recovery.js';
import { checkGates, score, type GateResult, type ScoringWeights, DEFAULT_WEIGHTS } from './score.js';
import { ReceiptLog, type Receipt } from './receipts.js';
import { DEFAULT_BUDGET, type Budget, type Goal, type PlanStep, type WorkerOutput } from './types.js';
import type { Verdict } from './types.js';

export interface KernelOptions {
  router: AlgorithmRouter;
  pool: AgentPool;
  verifiers?: VerifierRegistry;
  policy?: PolicyGate;
  budget?: Budget;
  weights?: ScoringWeights;
  /** Circuit-breaker failure threshold per run (default = budget.retries). */
  breakerThreshold?: number;
  /** Map a step+agent to the safety Action to evaluate (default { tool: step.kind }). */
  actionFor?: (step: PlanStep, agentId: string) => Action;
  /** Optional memory retrieval hook (step 2): returns context merged into the goal. */
  retrieveMemory?: (goal: Goal) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Optional memory write hook (step 10). */
  updateMemory?: (run: RunResult) => void | Promise<void>;
}

export type StepStatus = 'ok' | 'gated' | 'failed';

export interface StepRun {
  step: PlanStep;
  agentId: string;
  model: string;
  output: WorkerOutput;
  verdict: Verdict;
  gate: GateResult;
  utility: number;
  attempts: number;
  status: StepStatus;
  receipt: Receipt;
}

export interface RunResult {
  runId: string;
  classification: Classification;
  steps: StepRun[];
  /** Outputs of every successful step, keyed by step id. */
  outputs: Record<string, unknown>;
  /** Output of the terminal step(s) — the final answer. */
  result: unknown;
  success: boolean;
  totalCostUsd: number;
  receipts: readonly Receipt[];
  /** `verify()` of the receipt chain — proves the run is replayable/untampered. */
  receiptsValid: boolean;
  poolSnapshot: Record<string, { pulls: number; mean: number }>;
}

let RUN_SEQ = 0;

/** The harness kernel. Construct once with the algorithm modules, then `run` goals. */
export class HarnessKernel {
  private readonly o: Required<
    Pick<KernelOptions, 'router' | 'pool'>
  > & KernelOptions;
  private readonly budget: Budget;
  private readonly weights: ScoringWeights;

  constructor(opts: KernelOptions) {
    this.o = opts as HarnessKernel['o'];
    this.budget = opts.budget ?? DEFAULT_BUDGET;
    this.weights = opts.weights ?? DEFAULT_WEIGHTS;
  }

  async run(goal: Goal, runId = `run_${String(++RUN_SEQ).padStart(3, '0')}`): Promise<RunResult> {
    const verifiers = this.o.verifiers ?? new VerifierRegistry();
    const policy = this.o.policy;
    const log = new ReceiptLog();
    const breaker = new CircuitBreaker({
      threshold: this.o.breakerThreshold ?? this.budget.retries,
      cooldownMs: 0,
    });
    const retries = new RetryBudget(this.budget.retries, this.budget.costUsd);

    // 1. Classify + 3. Build plan (the router does both).
    const { classification, steps } = this.o.router.plan(goal);

    // 2. Retrieve memory → fold into the goal context.
    const memory = (await this.o.retrieveMemory?.(goal)) ?? {};
    const enrichedGoal: Goal = { ...goal, context: { ...goal.context, ...memory } };

    const outputs: Record<string, unknown> = {};
    const stepRuns: StepRun[] = [];
    const ordered = topoSort(steps);

    for (const step of ordered) {
      const upstream = Object.fromEntries(step.deps.map((d) => [d, outputs[d]]));
      const run = await this.executeStep({
        runId, step, goal: enrichedGoal, upstream,
        verifiers, policy, log, breaker, retries,
        spentUsd: log.totalCostUsd(),
      });
      stepRuns.push(run);
      // 8. Merge — only successful outputs flow downstream.
      if (run.status === 'ok') outputs[step.id] = run.output.output;
    }

    // Terminal steps = steps no other step depends on.
    const depended = new Set(steps.flatMap((s) => s.deps));
    const terminals = steps.filter((s) => !depended.has(s.id)).map((s) => s.id);
    const okTerminals = terminals.filter((id) => id in outputs);
    const result = okTerminals.length === 1 ? outputs[okTerminals[0]] : okTerminals.map((id) => outputs[id]);

    const runResult: RunResult = {
      runId,
      classification,
      steps: stepRuns,
      outputs,
      result,
      success: stepRuns.every((s) => s.status === 'ok'),
      totalCostUsd: log.totalCostUsd(),
      receipts: log.entries(),
      receiptsValid: log.verify().ok,
      poolSnapshot: this.o.pool.snapshot(),
    };

    // 10. Update memory.
    await this.o.updateMemory?.(runResult);
    return runResult;
  }

  /** Steps 4–7 + 9 for a single plan step. */
  private async executeStep(ctx: {
    runId: string; step: PlanStep; goal: Goal; upstream: Record<string, unknown>;
    verifiers: VerifierRegistry; policy?: PolicyGate; log: ReceiptLog;
    breaker: CircuitBreaker; retries: RetryBudget; spentUsd: number;
  }): Promise<StepRun> {
    const { step, goal, upstream, verifiers, policy, log, breaker, retries } = ctx;

    // 4. Select agent.
    const agent = this.o.pool.select(step.kind);

    // Safety: evaluate the action BEFORE running the worker.
    const action = (this.o.actionFor?.(step, agent.id)) ?? { tool: step.kind };
    const policyDecision = policy?.evaluate(action) ?? { allow: true, risk: 0, reasons: [] };

    const fail = (output: WorkerOutput, verdict: Verdict, status: StepStatus, gate: GateResult): StepRun => {
      const receipt = log.append({
        runId: ctx.runId, step: step.id, input: { step, action }, output: output.output,
        agent: agent.id, model: agent.model, costUsd: output.costUsd, latencyMs: output.latencyMs,
        verdict: status === 'ok' ? 'pass' : status === 'gated' ? 'gated' : 'fail',
      });
      this.o.pool.update(agent.id, status === 'ok' ? clamp01(output.quality) : 0);
      return { step, agentId: agent.id, model: agent.model, output, verdict, gate, utility: score(output, this.weights), attempts: 0, status, receipt };
    };

    const ZERO: WorkerOutput = { output: null, quality: 0, confidence: 0, risk: policyDecision.risk, costUsd: 0, latencyMs: 0 };

    if (!policyDecision.allow) {
      const verdict: Verdict = { pass: false, score: 0, reasons: policyDecision.reasons };
      return fail({ ...ZERO, risk: policyDecision.risk }, verdict, 'gated', {
        ok: false, confidenceOk: false, riskOk: false, costOk: true, verificationOk: false, reasons: policyDecision.reasons,
      });
    }

    // 5–7. Execute → verify → retry/repair, bounded by breaker + retry budget.
    let attempts = 0;
    let output: WorkerOutput = ZERO;
    let verdict: Verdict = { pass: false, score: 0, reasons: ['not run'] };

    while (true) {
      if (!breaker.canProceed()) {
        verdict = { pass: false, score: 0, reasons: ['circuit breaker open'] };
        break;
      }
      output = await agent.run({ goal, step, upstream });
      // Risk is the max of the worker's self-reported risk and the policy risk.
      output = { ...output, risk: Math.max(output.risk, policyDecision.risk) };

      // 6. Verify (adversarial — verifiers are independent of the worker).
      verdict = await ctx.verifiers.run(output.output, { goal, step, ...goal.context }, undefined);

      if (verdict.pass) {
        breaker.recordSuccess();
        break;
      }
      breaker.recordFailure();
      // 7. Retry/repair only if the budget allows (no runaway loops).
      if (!retries.tryConsume(output.costUsd)) {
        verdict = { ...verdict, reasons: [...verdict.reasons, 'retry budget exhausted'] };
        break;
      }
      attempts += 1;
    }

    // The four-gate guard (confidence ∧ risk ∧ cost ∧ verification).
    const gate = checkGates(output, this.budget, verdict.pass, ctx.spentUsd);
    const status: StepStatus = gate.ok ? 'ok' : (verdict.pass ? 'gated' : 'failed');
    const run = fail(output, verdict, status, gate);
    return { ...run, attempts };
  }
}

/** Kahn's algorithm — topological order of the plan DAG (throws on a cycle). */
export function topoSort(steps: PlanStep[]): PlanStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const indeg = new Map(steps.map((s) => [s.id, s.deps.filter((d) => byId.has(d)).length]));
  const queue = steps.filter((s) => (indeg.get(s.id) ?? 0) === 0);
  const out: PlanStep[] = [];
  while (queue.length) {
    const s = queue.shift()!;
    out.push(s);
    for (const t of steps) {
      if (t.deps.includes(s.id)) {
        const d = (indeg.get(t.id) ?? 0) - 1;
        indeg.set(t.id, d);
        if (d === 0) queue.push(t);
      }
    }
  }
  if (out.length !== steps.length) throw new Error('plan DAG has a cycle');
  return out;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
