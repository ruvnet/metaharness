// SPDX-License-Identifier: MIT
//
// @metaharness/projects — harness-spec.ts (ADR-159 HarnessSpec).
//
// A declarative, mutatable harness specification borrowed from AgentSPEX's
// explicit graph-spec model. The program thesis is "Darwin Mode mutates
// structured policies, not prompts" — so a harness is a typed object (roles,
// steps, branches, budgets, guards, memory, evaluators, rollback, policy), not a
// prose template. Two guarantees make it evolvable:
//
//   1. Lossless round-trip: a compact HarnessGenomeLite expands to a full
//      HarnessSpec and contracts back to the EXACT same genome. The genome is the
//      mutation surface; the spec is the deterministic phenotype.
//   2. Deterministic replay: "executing" a spec under a fixed seed yields an
//      identical trace + hash every time, so a mutation's effect is observable as
//      a hash delta (proven in bench/harness-spec.bench.mjs).

import type { PolicyObject } from './core.js';
import { defaultPolicy, hashJson, makeRng, round6, validatePolicy } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// The compact genome (mutation surface) and the full spec (phenotype).
// ─────────────────────────────────────────────────────────────────────────────

/** Ordered planner strategies; the genome stores one, the spec expands its steps. */
export type PlannerKind =
  | 'file-first'
  | 'sink-first'
  | 'diff-first'
  | 'callgraph-first'
  | 'risk-first'
  | 'memory-first';

/** Context-assembly policy; expands to a guard + memory configuration. */
export type ContextPolicyKind = 'minimal' | 'semantic' | 'callgraph' | 'hybrid';

/**
 * Autonomous-mode block (ADR-246 §2.2). Optional on both genome and spec;
 * round-trips verbatim. Hosts must project it or explicitly no-op — never
 * silently drop. Hitting a budget or turn ceiling halts deterministically;
 * reaching a limit is NOT success.
 */
export interface AutonomousSpec {
  goal?: { text: string; tokenBudget?: number };
  heartbeat?: { cadence: string; instruction: string };
  gateCommand?: string;
  maxTurns?: number;
}

/** The compact, mutatable harness genome (the thing Darwin Mode evolves). */
export interface HarnessGenomeLite {
  planner: PlannerKind;
  contextPolicy: ContextPolicyKind;
  reviewerCount: number;
  retryBudget: number;
  tools: string[];
  policy: PolicyObject;
  /** ADR-246 §2.2 autonomous fields; copied verbatim through genome ⇄ spec. */
  autonomous?: AutonomousSpec;
}

/** One node in the harness graph. `next` lists successor step ids. */
export interface StepSpec {
  id: string;
  role: string;
  tool?: string;
  next?: string[];
}

/** The full declarative harness (the phenotype expanded from a genome). */
export interface HarnessSpec {
  version: 1;
  roles: string[];
  steps: StepSpec[];
  branches: { on: string; to: string }[];
  budgets: { costUnits: number; timeUnits: number };
  guards: string[];
  memory: string[];
  evaluators: string[];
  rollback: { enabled: boolean; checkpointEvery: number };
  policy: PolicyObject;
  meta: {
    planner: string;
    contextPolicy: string;
    reviewerCount: number;
    retryBudget: number;
    tools: string[];
  };
  /** ADR-246 §2.2 autonomous fields; copied verbatim through genome ⇄ spec. */
  autonomous?: AutonomousSpec;
}

/**
 * Deep-copy an autonomous block (all levels are plain data). Only keys that
 * are actually present are assigned — no `undefined` keys are injected, so
 * `{}` round-trips to an object with zero own keys (toStrictEqual-clean).
 */
function copyAutonomous(a: AutonomousSpec): AutonomousSpec {
  return {
    ...(a.goal !== undefined ? { goal: a.goal && { ...a.goal } } : {}),
    ...(a.heartbeat !== undefined ? { heartbeat: a.heartbeat && { ...a.heartbeat } } : {}),
    ...(a.gateCommand !== undefined ? { gateCommand: a.gateCommand } : {}),
    ...(a.maxTurns !== undefined ? { maxTurns: a.maxTurns } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic expansion tables. These are the ONLY place planner/contextPolicy
// names are mapped to graph shape, so the inverse (specToGenome) just reads meta.
// ─────────────────────────────────────────────────────────────────────────────

/** Guards + memory contributed by each context policy (deterministic, sorted). */
const CONTEXT_EXPANSION: Record<ContextPolicyKind, { guards: string[]; memory: string[] }> = {
  minimal: { guards: ['budget'], memory: ['scratch'] },
  semantic: { guards: ['budget', 'relevance'], memory: ['scratch', 'semantic'] },
  callgraph: { guards: ['budget', 'reachability'], memory: ['scratch', 'callgraph'] },
  hybrid: { guards: ['budget', 'relevance', 'reachability'], memory: ['scratch', 'semantic', 'callgraph'] },
};

/** Role of the first (planning) step for each planner strategy. */
const PLANNER_ROLE: Record<PlannerKind, string> = {
  'file-first': 'plan-files',
  'sink-first': 'plan-sinks',
  'diff-first': 'plan-diff',
  'callgraph-first': 'plan-callgraph',
  'risk-first': 'plan-risk',
  'memory-first': 'plan-memory',
};

// ─────────────────────────────────────────────────────────────────────────────
// genome ⇄ spec (lossless round-trip).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expand a compact genome into a full, deterministic harness spec. The pipeline is
 * always plan → code → review*(reviewerCount) → evaluate, wired as a linear graph.
 * All decisions are recorded in `meta` so specToGenome is an exact inverse.
 */
export function genomeToSpec(g: HarnessGenomeLite): HarnessSpec {
  const ctx = CONTEXT_EXPANSION[g.contextPolicy];
  const reviewers = Math.max(0, Math.floor(g.reviewerCount));

  // Build the linear step chain: plan → code → review-1..N → evaluate.
  const steps: StepSpec[] = [];
  const planId = 'plan';
  const codeId = 'code';
  steps.push({ id: planId, role: PLANNER_ROLE[g.planner], next: [codeId] });
  const reviewIds = Array.from({ length: reviewers }, (_, i) => `review-${i + 1}`);
  const afterCode = reviewIds[0] ?? 'evaluate';
  steps.push({ id: codeId, role: 'coder', tool: g.tools[0], next: [afterCode] });
  reviewIds.forEach((rid, i) => {
    const next = reviewIds[i + 1] ?? 'evaluate';
    steps.push({ id: rid, role: 'reviewer', next: [next] });
  });
  steps.push({ id: 'evaluate', role: 'evaluator', next: [] });

  const roles = Array.from(new Set(steps.map((s) => s.role)));

  // Budgets scale with retry budget + reviewer count (deterministic, observable).
  const budgets = {
    costUnits: round6(10 + reviewers * 4 + g.retryBudget * 2),
    timeUnits: round6(3 + reviewers + g.retryBudget),
  };

  return {
    version: 1,
    roles,
    steps,
    branches: [{ on: 'review-fail', to: codeId }],
    budgets,
    guards: ctx.guards.slice(),
    memory: ctx.memory.slice(),
    evaluators: ['tests', 'security'],
    rollback: { enabled: g.retryBudget > 0, checkpointEvery: 1 },
    policy: { ...g.policy },
    meta: {
      planner: g.planner,
      contextPolicy: g.contextPolicy,
      reviewerCount: reviewers,
      retryBudget: g.retryBudget,
      tools: g.tools.slice(),
    },
    // ADR-246 §2.2: copied verbatim; key omitted entirely when absent.
    ...(g.autonomous ? { autonomous: copyAutonomous(g.autonomous) } : {}),
  };
}

/**
 * Contract a spec back to its genome. The inverse of genomeToSpec: every field is
 * recovered from `meta` + `policy`, so specToGenome(genomeToSpec(g)) deep-equals g
 * (assuming g already used integer reviewerCount, the only normalized field).
 */
export function specToGenome(s: HarnessSpec): HarnessGenomeLite {
  return {
    planner: s.meta.planner as PlannerKind,
    contextPolicy: s.meta.contextPolicy as ContextPolicyKind,
    reviewerCount: s.meta.reviewerCount,
    retryBudget: s.meta.retryBudget,
    tools: s.meta.tools.slice(),
    policy: { ...s.policy },
    // ADR-246 §2.2: mirrored back verbatim; key omitted entirely when absent.
    ...(s.autonomous ? { autonomous: copyAutonomous(s.autonomous) } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation + defaults.
// ─────────────────────────────────────────────────────────────────────────────

/** Structural + policy validation. Returns {ok, errors[]}. */
export function validateSpec(s: HarnessSpec): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (s.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(s.roles) || s.roles.length === 0) errors.push('roles must be non-empty');
  if (!Array.isArray(s.steps) || s.steps.length === 0) errors.push('steps must be non-empty');

  // Every step.next target must reference an existing step id.
  const ids = new Set(s.steps.map((st) => st.id));
  for (const st of s.steps) {
    for (const n of st.next ?? []) {
      if (!ids.has(n)) errors.push(`step "${st.id}" references unknown next "${n}"`);
    }
  }

  if (!(s.budgets.costUnits > 0)) errors.push('budgets.costUnits must be > 0');
  if (!(s.budgets.timeUnits > 0)) errors.push('budgets.timeUnits must be > 0');

  for (const e of validatePolicy(s.policy)) errors.push(`policy: ${e}`);

  // ADR-246 §2.2 autonomous block. Only sub-fields of present objects are
  // validated; JSON `null` for any field is treated as absent (valid, never a
  // throw); whitespace-only strings count as empty. maxTurns/tokenBudget must
  // be integers — Number.isSafeInteger mirrors Rust's `as_i64()`, which is
  // None for non-integers (1.5) and i64 overflow (1e20). Error strings are in
  // byte-for-byte lockstep with the Rust validator — do not reword.
  const a = s.autonomous;
  if (a != null) {
    if (a.goal != null) {
      // Rust's Goal.text is a required String: serde REJECTS a goal whose
      // text is missing, null, or a non-string. Mirror that accept/reject
      // decision here (missing/null/non-string counts as empty) so a block
      // Rust cannot deserialize never validates clean on the TS side.
      if (typeof a.goal.text !== 'string' || a.goal.text.trim().length === 0) {
        errors.push('autonomous.goal.text must be non-empty');
      }
      if (
        a.goal.tokenBudget != null &&
        !(Number.isSafeInteger(a.goal.tokenBudget) && a.goal.tokenBudget > 0)
      ) {
        errors.push('autonomous.goal.tokenBudget must be > 0');
      }
    }
    if (a.heartbeat != null) {
      // Rust's Heartbeat.cadence/instruction are required Strings — same
      // missing/null/non-string handling as goal.text above.
      if (typeof a.heartbeat.cadence !== 'string' || a.heartbeat.cadence.trim().length === 0) {
        errors.push('autonomous.heartbeat.cadence must be non-empty');
      }
      if (
        typeof a.heartbeat.instruction !== 'string' ||
        a.heartbeat.instruction.trim().length === 0
      ) {
        errors.push('autonomous.heartbeat.instruction must be non-empty');
      }
    }
    if (a.gateCommand != null && (typeof a.gateCommand !== 'string' || a.gateCommand.trim().length === 0)) {
      errors.push('autonomous.gateCommand must be non-empty');
    }
    if (a.maxTurns != null && !(Number.isSafeInteger(a.maxTurns) && a.maxTurns >= 1)) {
      errors.push('autonomous.maxTurns must be >= 1');
    }
  }

  return { ok: errors.length === 0, errors };
}

/** The canonical baseline spec (matches the core defaultPolicy). */
export function defaultSpec(): HarnessSpec {
  return genomeToSpec({
    planner: 'file-first',
    contextPolicy: 'hybrid',
    reviewerCount: 1,
    retryBudget: 2,
    tools: ['read', 'edit', 'test'],
    policy: defaultPolicy(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic replay. "Executing" a spec under a fixed seed yields an identical
// trace + hash, so a policy/structure mutation is observable as a hash delta.
// ─────────────────────────────────────────────────────────────────────────────

// Per-step content-hash cache. A step's hash depends only on its (immutable)
// content, so it is identical across every seed/replay of the same spec. The bench
// re-replays one spec across many seeds; memoizing keyed by the step object avoids
// re-hashing each step on every call. WeakMap so entries vanish with the step.
const STEP_HASH_CACHE = new WeakMap<StepSpec, string>();

/** hashJson(step), cached per step object (content is immutable post-genomeToSpec). */
function stepHashOf(step: StepSpec): string {
  let h = STEP_HASH_CACHE.get(step);
  if (h === undefined) {
    h = hashJson(step);
    STEP_HASH_CACHE.set(step, h);
  }
  return h;
}

/**
 * Deterministically "run" a spec. For each step the output is fixedOutputs[id] when
 * provided, else a value derived purely from makeRng(seed) advanced per-step plus
 * the step's content hash. Identical (spec, seed, fixedOutputs) → identical result.
 * The final hash folds in the per-step trace AND the policy, so policy mutations
 * change the hash even when fixedOutputs pin every step output.
 */
export function replaySpec(
  s: HarnessSpec,
  opts: { seed: number; fixedOutputs?: Record<string, unknown> },
): { hash: string; trace: { stepId: string; output: unknown }[]; halt?: { reason: 'maxTurns' | 'tokenBudget' } } {
  const rng = makeRng(opts.seed);
  const fixed = opts.fixedOutputs ?? {};
  const trace: { stepId: string; output: unknown }[] = [];

  // ADR-246 §2.2: deterministic halt. maxTurns is a hard ceiling on replayed
  // steps; tokenBudget is charged a deterministic pseudo-cost of 1 unit per
  // step. Hitting either stops the replay (a limit is NOT success). Absent an
  // autonomous block, behavior is byte-identical and no `halt` key is emitted.
  const maxTurns = s.autonomous?.maxTurns;
  const tokenBudget = s.autonomous?.goal?.tokenBudget;
  let halt: { reason: 'maxTurns' | 'tokenBudget' } | undefined;
  let cost = 0;

  for (const step of s.steps) {
    if (maxTurns != null && trace.length >= maxTurns) {
      halt = { reason: 'maxTurns' };
      break;
    }
    if (tokenBudget != null && cost + 1 > tokenBudget) {
      halt = { reason: 'tokenBudget' };
      break;
    }
    let output: unknown;
    if (Object.prototype.hasOwnProperty.call(fixed, step.id)) {
      output = fixed[step.id];
    } else {
      // Derive a stable value from the seeded stream + the step's content hash.
      // Advancing rng once per step keeps it order-sensitive yet fully deterministic.
      const draw = rng();
      const stepHash = stepHashOf(step);
      output = { v: round6(draw), h: stepHash, role: step.role };
    }
    trace.push({ stepId: step.id, output });
    cost += 1;
  }

  const hash = hashJson({ trace, policy: s.policy });
  return { hash, trace, ...(halt ? { halt } : {}) };
}
