// @metaharness/radio — deterministic swarm simulation. This is BOTH the demo and
// the flywheel's real evaluator for AgentRadio-style comms policies
// (arXiv:2607.28430).
//
// The paper's codebase-QnA task is modeled synthetically:
//
//   - A task has K sub-questions (default 4). Each sub-question needs a set of
//     FACTS. Facts live inside N "units" (think: files). An agent discovers all
//     facts in a unit by exploring it — one unit per foreground step.
//   - Units are grouped into K contiguous "home regions", one per sub-question.
//     CRUCIALLY, a configurable fraction of each sub-question's facts
//     (crossFraction, default 0.35; at least one per sub-question is forced)
//     sit in units of ANOTHER sub-question's region — under a negotiated
//     partition those units belong to a teammate. Cross-partition facts are
//     exactly what communication pays for: the discoverer is never the owner.
//   - A sub-question is resolved when its OWNER holds all of its facts.
//
// Five-phase mapping (Explore → Divide → Execute → Review → Submit, with
// assembler-gated transitions — see protocol.ts for the live-pod version):
//
//   Explore/Divide are compressed into task + partition construction. The
//   negotiated partition (modes 'negotiate' and 'passive') models the assembler
//   opening a planning thread where agents pool Explore-phase findings and
//   negotiate until all approve: each agent ends up owning exactly the
//   fact-bearing units of its sub-question's home region (chaff pruned,
//   ownership aligned with the questions). The naive partition (mode 'divide')
//   skips negotiation: units are dealt round-robin, blind to both relevance and
//   ownership. Execute is the step loop below. Review is the final exchange
//   round (where a mode has one). Submit is the resolution check.
//
// The four modes mirror the paper's ladder (single < L1 < L2 < L3):
//
//   'single'    — one agent explores everything alone. Its context saturates:
//                 each exploration costs 1 + floor(unitsExploredSoFar /
//                 contextCap) steps, modeling the paper's observation that a
//                 lone agent degrades as the whole codebase flows through one
//                 context window. Pod agents each stay under the cap.
//   'divide'    — L1: naive round-robin partition, NO mid-Execute sharing.
//                 Findings surface only at the Review broadcast, and because
//                 the partition ignores ownership, almost every fact must cross
//                 agents there, so Review is expensive — and the partition
//                 wastes steps on chaff units a negotiation would have pruned.
//   'negotiate' — L2: negotiated partition, but Execute is SILENT — the
//                 blocking-mode ablation: same visibility into threads, but a
//                 receive costs a foreground step, so agents don't listen
//                 mid-Execute and discoveries stay private until Review, where
//                 every post costs a step and every blockingReceive() costs a
//                 step (counted in stepsToResolve).
//   'passive'   — L3: negotiated partition + passive awareness. A discovered
//                 cross-partition fact bears on a teammate's sub-question, so
//                 it is posted IMMEDIATELY with an @-mention of the owner —
//                 send() is non-blocking and costs nothing — and the owner
//                 folds it in at its next step boundary via Watcher.fold(),
//                 which also costs nothing. That zero-cost path is the entire
//                 measured advantage.
//
// Policy levers (the flywheel evolves these as strings):
//   foldEvery  '1'|'2'|'4' — owners fold mentions only at every k-th of their
//              step boundaries; folding less often delays cross-facts, so
//              teammates burn extra steps while a resolution sits unread.
//   postPolicy 'immediate'|'batched'|'silent' — when discoverers post cross
//              facts in 'passive' mode. 'batched' delays and coalesces posts
//              (fewer messages, later delivery); 'silent' disables live sharing
//              entirely, NEARLY degenerating passive into the negotiate arm:
//              cross facts still surface only at Review and every post still
//              costs a step, but the passive watcher stays on, so the Review
//              broadcast folds in at the next step boundary for free instead
//              of costing one blockingReceive() per agent. (This small edge is
//              what keeps the flywheel's landscape climbable one lever at a
//              time: silent-passive strictly beats negotiate, and switching
//              postPolicy on then unlocks the live-sharing lift.)
//
// Sanity ordering the flywheel relies on (defaults tuned for it, verified over
// seeds 1..10): stepsToResolve orders passive < negotiate <= divide < single,
// mirroring the paper's L3 < L2 < L1 < single direction.
//
// Known failure modes (kept visible on purpose — the sim's scripted agents do
// NOT exhibit them, which is exactly why the flywheel must not over-trust it):
//   - Mentions can DERAIL: in the paper's rubric accounting, passive awareness
//     gained 47 rubrics but LOST 23 — an interrupting mention can pull a
//     recipient off a line of work that would have succeeded. Scripted agents
//     here fold facts in for free with no distraction cost, so the sim only
//     measures the upside of sharing.
//   - Passive awareness cannot surface conclusions NO agent forms: if a fact
//     is never discovered (a unit outside every partition, an insight outside
//     the task model), no comms policy recovers it. Here that appears as
//     resolved:false — more steps of listening never fix it.
//
// Determinism: same seed => bit-identical result. All randomness flows through
// a mulberry32 LCG; no Date.now, no Math.random.

import { RadioBus } from './bus.js';
import { Watcher } from './watcher.js';

/** Comms-policy ladder position (paper: single < L1 divide < L2 negotiate < L3 passive). */
export type SimMode = 'single' | 'divide' | 'negotiate' | 'passive';

/** Fold cadence lever: fold mentions at every k-th step boundary. */
export type FoldEvery = '1' | '2' | '4';

/** Execute-phase posting lever for 'passive' mode. */
export type PostPolicy = 'immediate' | 'batched' | 'silent';

/** Knobs for makeTask — defaults reproduce the tuned sanity-target shape. */
export interface SimTaskOptions {
  /** K sub-questions, one owner-agent each (default 4). */
  subQuestions?: number;
  /** Facts each sub-question needs (default 6). */
  factsPerSub?: number;
  /** N explorable units; must be >= subQuestions (default 24). */
  unitCount?: number;
  /** Fraction of each sub-question's facts placed in ANOTHER sub-question's
   *  region (default 0.35). When > 0, the first fact of every sub-question is
   *  forced cross so communication always has something to pay for. */
  crossFraction?: number;
}

/** One sub-question: resolved when its owner holds every fact in `facts`. */
export interface SimSubQuestion {
  id: number;
  /** Owning agent index (agent q owns sub-question q; 'single' owns all). */
  owner: number;
  /** Fact ids this sub-question needs. */
  facts: number[];
}

/** A synthetic codebase-QnA task. Fully deterministic in `seed`. */
export interface SimTask {
  seed: number;
  unitCount: number;
  crossFraction: number;
  subQuestions: SimSubQuestion[];
  /** fact id -> unit that contains it. */
  factUnit: number[];
  /** fact id -> owning sub-question index. */
  factOwner: number[];
  /** unit -> fact ids inside it (chaff units have []). */
  unitFacts: number[][];
  /** unit -> home region (sub-question index) it belongs to. */
  regionOf: number[];
  /** Facts whose unit lies outside their owner's home region. */
  crossFactCount: number;
}

export interface SimConfig {
  seed: number;
  mode: SimMode;
  /** Pre-built task; defaults to makeTask(seed, taskOptions). */
  task?: SimTask;
  taskOptions?: SimTaskOptions;
  /** Fold mentions every k-th step boundary (default '1'). */
  foldEvery?: FoldEvery;
  /** Execute-phase posting policy, 'passive' mode only (default 'immediate'). */
  postPolicy?: PostPolicy;
  /** Units an agent digests before each further exploration costs an extra
   *  step per contextCap explored — the single-agent context-saturation model
   *  (default 6 = a pod agent's whole negotiated partition fits). */
  contextCap?: number;
  /** 'batched' postPolicy flushes every this-many explorations (default 4). */
  batchFlushEvery?: number;
  /** Negotiation prunes chaff only imperfectly: each no-fact unit of a region
   *  survives into the negotiated partition with this probability (default
   *  0.5). Surviving chaff is what passive awareness saves you from — the pod
   *  stops digging the moment the last cross-fact folds in, so delivery
   *  latency (foldEvery, batched posting) costs real steps. */
  chaffKeep?: number;
  /** Safety valve: give up (resolved:false) past this many steps (default 10000). */
  maxSteps?: number;
}

export interface SimResult {
  mode: SimMode;
  seed: number;
  /** True iff every sub-question's owner ended up holding all its facts. */
  resolved: boolean;
  /** Total FOREGROUND steps consumed across all agents until all sub-questions
   *  resolved: explorations (with context surcharge), Review posts, and
   *  blocking receives. Passive sends and folds cost nothing by construction.
   *  If unresolved, the total consumed before giving up. */
  stepsToResolve: number;
  /** Parallel rounds elapsed (makespan-flavored diagnostic; fold delay from
   *  foldEvery shows up here even when idle waiting is free). */
  rounds: number;
  /** Messages sent on the bus (planning chatter + Execute mentions + Review). */
  messages: number;
  /** Review-phase blockingReceive() calls — each cost one foreground step. */
  blockingReceives: number;
  /** Total unit explorations performed. */
  explorations: number;
  /** Explorations that discovered nothing new to the explorer (chaff units and
   *  re-covered ground) — the waste a good partition avoids. */
  redundantExplorations: number;
  /** Facts that reached their owner via comms (fold or blocking receive). */
  crossFactsDelivered: number;
  /** Foreground steps spent in the Review exchange (posts + receives). */
  exchangeSteps: number;
  /** Foreground steps per agent (index = agent; single mode has one entry). */
  perAgentSteps: number[];
  /** stepsToResolve reading at the moment each sub-question resolved (-1 = never). */
  subResolvedAtStep: number[];
}

/** mulberry32 — tiny seeded PRNG; the package's only randomness source. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher–Yates driven by the given PRNG. */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Build a synthetic codebase-QnA task: K sub-questions whose facts are strewn
 * across N units, with a controlled fraction landing cross-region. Same seed
 * (and options) => identical task, always.
 */
export function makeTask(seed: number, opts: SimTaskOptions = {}): SimTask {
  const K = opts.subQuestions ?? 4;
  const F = opts.factsPerSub ?? 6;
  const N = opts.unitCount ?? 24;
  const crossFraction = Math.min(1, Math.max(0, opts.crossFraction ?? 0.35));
  if (K < 1 || F < 1) throw new Error('makeTask: need at least 1 sub-question and 1 fact');
  if (N < K) throw new Error(`makeTask: unitCount (${N}) must be >= subQuestions (${K})`);

  const rng = mulberry32(seed >>> 0);
  const regionSize = Math.floor(N / K);
  const regionOf: number[] = [];
  const regionUnits: number[][] = Array.from({ length: K }, () => []);
  for (let u = 0; u < N; u++) {
    const r = Math.min(K - 1, Math.floor(u / regionSize));
    regionOf.push(r);
    regionUnits[r].push(u);
  }

  const factUnit: number[] = [];
  const factOwner: number[] = [];
  const unitFacts: number[][] = Array.from({ length: N }, () => []);
  const subQuestions: SimSubQuestion[] = [];
  let crossFactCount = 0;

  for (let q = 0; q < K; q++) {
    const facts: number[] = [];
    for (let f = 0; f < F; f++) {
      const draw = rng();
      // Force >=1 cross fact per sub-question so comms always matters.
      const isCross = K > 1 && crossFraction > 0 && (f === 0 || draw < crossFraction);
      let region = q;
      if (isCross) {
        let r = Math.floor(rng() * (K - 1));
        if (r >= q) r++;
        region = r;
      }
      const units = regionUnits[region];
      const unit = units[Math.floor(rng() * units.length)];
      const id = factUnit.length;
      factUnit.push(unit);
      factOwner.push(q);
      unitFacts[unit].push(id);
      if (regionOf[unit] !== q) crossFactCount++;
      facts.push(id);
    }
    subQuestions.push({ id: q, owner: q, facts });
  }

  return {
    seed,
    unitCount: N,
    crossFraction,
    subQuestions,
    factUnit,
    factOwner,
    unitFacts,
    regionOf,
    crossFactCount,
  };
}

const EXEC_THREAD = 'exec';
const PLAN_THREAD = 'plan';
const FACT_PREFIX = 'facts:';

function encodeFacts(facts: number[]): string {
  return FACT_PREFIX + facts.join(',');
}

function decodeFacts(content: string): number[] {
  if (!content.startsWith(FACT_PREFIX)) return [];
  return content
    .slice(FACT_PREFIX.length)
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

/**
 * Run one deterministic swarm episode and account every foreground step,
 * message, and delivered cross-fact. Same SimConfig => identical SimResult.
 */
export function runSim(cfg: SimConfig): SimResult {
  const task = cfg.task ?? makeTask(cfg.seed, cfg.taskOptions);
  const mode = cfg.mode;
  const foldK = Math.max(1, Number(cfg.foldEvery ?? '1') || 1);
  const postPolicy = cfg.postPolicy ?? 'immediate';
  const contextCap = Math.max(1, cfg.contextCap ?? 6);
  const batchFlushEvery = Math.max(1, cfg.batchFlushEvery ?? 4);
  const chaffKeep = Math.min(1, Math.max(0, cfg.chaffKeep ?? 0.5));
  const maxSteps = cfg.maxSteps ?? 10_000;

  const K = task.subQuestions.length;
  const N = task.unitCount;
  const agentCount = mode === 'single' ? 1 : K;
  const names = Array.from({ length: agentCount }, (_, a) =>
    mode === 'single' ? 'solo' : `agent${a}`,
  );
  /** Owner AGENT of sub-question q (the solo agent owns everything). */
  const ownerAgent = (q: number): number => (mode === 'single' ? 0 : task.subQuestions[q].owner);

  // Sim-local RNG stream, decoupled from the task-construction stream.
  const rng = mulberry32(((cfg.seed >>> 0) ^ 0x9e3779b9) >>> 0);

  const bus = new RadioBus();
  const watchers = names.map((n) => new Watcher(bus, n, 0));
  bus.createThread(PLAN_THREAD, names); // assembler (agent0) opens planning thread
  bus.createThread(EXEC_THREAD, names);

  // ---- Partition construction (the compressed Explore/Divide phases) -------
  const queues: number[][] = [];
  if (mode === 'single') {
    queues.push(shuffle(Array.from({ length: N }, (_, u) => u), rng));
  } else if (mode === 'divide') {
    // L1: naive round-robin — blind to relevance and ownership, chaff included.
    for (let a = 0; a < K; a++) {
      const mine: number[] = [];
      for (let u = 0; u < N; u++) if (u % K === a) mine.push(u);
      queues.push(shuffle(mine, rng));
    }
  } else {
    // L2/L3: negotiated partition — Explore-phase findings pooled on the
    // planning thread let the pod prune most chaff and align ownership: agent
    // q takes the fact-bearing units of its home region, plus whatever chaff
    // the negotiation failed to rule out (chaffKeep). The negotiation itself
    // is message traffic (proposal + unanimous approvals, assembler-gated),
    // not foreground steps: posts are non-blocking and the plan is folded in
    // for free. Both 'negotiate' and 'passive' build the identical partition
    // for a given seed — same partition quality, different comms policy.
    for (let a = 0; a < K; a++) {
      const mine: number[] = [];
      for (let u = 0; u < N; u++) {
        if (task.regionOf[u] !== a) continue;
        if (task.unitFacts[u].length > 0 || rng() < chaffKeep) mine.push(u);
      }
      queues.push(shuffle(mine, rng));
    }
    bus.send(PLAN_THREAD, names[0], 'partition-proposal', names.slice(1));
    for (let a = 0; a < K; a++) bus.send(PLAN_THREAD, names[a], 'approve', [names[0]]);
  }

  // ---- Execute loop --------------------------------------------------------
  const known: Set<number>[] = Array.from({ length: agentCount }, () => new Set());
  const explored = new Array<number>(agentCount).fill(0);
  const boundaries = new Array<number>(agentCount).fill(0);
  const perAgentSteps = new Array<number>(agentCount).fill(0);
  /** Undelivered foreign facts, per agent, grouped by owner (batched/silent). */
  const outbox: Map<number, Set<number>>[] = Array.from(
    { length: agentCount },
    () => new Map(),
  );

  let totalSteps = 0;
  let rounds = 0;
  let explorations = 0;
  let redundantExplorations = 0;
  let blockingReceives = 0;
  let crossFactsDelivered = 0;
  let exchangeSteps = 0;
  const subResolvedAtStep = new Array<number>(K).fill(-1);

  const resolvedAll = (): boolean => subResolvedAtStep.every((s) => s >= 0);
  const updateResolution = (): void => {
    for (let q = 0; q < K; q++) {
      if (subResolvedAtStep[q] >= 0) continue;
      const holder = known[ownerAgent(q)];
      if (task.subQuestions[q].facts.every((f) => holder.has(f))) {
        subResolvedAtStep[q] = totalSteps;
      }
    }
  };

  /** Apply a fold's fact payloads to agent a; returns newly-gained fact count. */
  const applyFold = (a: number, blocking: boolean): number => {
    const folded = blocking ? watchers[a].blockingReceive() : watchers[a].fold();
    let gained = 0;
    for (const { mention } of folded) {
      for (const f of decodeFacts(mention.content)) {
        if (f < task.factUnit.length && !known[a].has(f)) {
          known[a].add(f);
          gained++;
        }
      }
    }
    return gained;
  };

  const sendFactsTo = (from: number, owner: number, facts: number[]): void => {
    bus.send(EXEC_THREAD, names[from], encodeFacts(facts), [names[owner]]);
  };

  const flushOutbox = (a: number): void => {
    for (const [owner, facts] of outbox[a]) {
      if (facts.size > 0) sendFactsTo(a, owner, [...facts]);
    }
    outbox[a].clear();
  };

  const passiveLive = mode === 'passive' && postPolicy !== 'silent';

  outer: while (!resolvedAll() && totalSteps < maxSteps) {
    if (!queues.some((q) => q.length > 0)) break; // Execute exhausted
    rounds++;
    for (let a = 0; a < agentCount; a++) {
      // Step boundary: passive fold-in, every foldK-th boundary, zero cost.
      // Idle agents still hit boundaries — waiting costs nothing under
      // passive awareness; that is the whole point.
      if (passiveLive) {
        if (boundaries[a] % foldK === 0) {
          crossFactsDelivered += applyFold(a, false);
          updateResolution();
          if (resolvedAll()) break outer;
        }
        boundaries[a]++;
      }
      const queue = queues[a];
      if (queue.length === 0) continue;

      // Explore one unit: one foreground step, plus the context surcharge.
      const unit = queue.shift() as number;
      const cost = 1 + Math.floor(explored[a] / contextCap);
      explored[a]++;
      explorations++;
      totalSteps += cost;
      perAgentSteps[a] += cost;

      const factsHere = task.unitFacts[unit];
      let newAny = false;
      const byOwner = new Map<number, number[]>();
      for (const f of factsHere) {
        if (!known[a].has(f)) {
          known[a].add(f);
          newAny = true;
        }
        const owner = ownerAgent(task.factOwner[f]);
        if (owner !== a) {
          const list = byOwner.get(owner);
          if (list) list.push(f);
          else byOwner.set(owner, [f]);
        }
      }
      if (!newAny) redundantExplorations++;

      // Passive awareness: a discovery that bears on a teammate's
      // sub-question is posted IMMEDIATELY with an @-mention of the owner.
      // send() is non-blocking — no step is consumed.
      if (byOwner.size > 0 && agentCount > 1) {
        if (passiveLive && postPolicy === 'immediate') {
          for (const [owner, facts] of byOwner) sendFactsTo(a, owner, facts);
        } else {
          for (const [owner, facts] of byOwner) {
            let set = outbox[a].get(owner);
            if (!set) outbox[a].set(owner, (set = new Set()));
            for (const f of facts) set.add(f);
          }
          if (
            passiveLive &&
            postPolicy === 'batched' &&
            (explored[a] % batchFlushEvery === 0 || queue.length === 0)
          ) {
            flushOutbox(a);
          }
        }
      }

      updateResolution();
      if (resolvedAll()) break outer;
      if (totalSteps >= maxSteps) break outer;
    }
  }

  // ---- Post-Execute delivery ----------------------------------------------
  if (!resolvedAll() && totalSteps < maxSteps) {
    if (passiveLive) {
      // Drain in-flight mentions: remaining boundary folds are still free.
      for (let a = 0; a < agentCount; a++) flushOutbox(a); // batched leftovers
      for (let extra = 0; extra <= foldK && !resolvedAll(); extra++) {
        for (let a = 0; a < agentCount; a++) {
          if (boundaries[a] % foldK === 0) crossFactsDelivered += applyFold(a, false);
          boundaries[a]++;
        }
        rounds++;
        updateResolution();
      }
    } else if (mode !== 'single') {
      // Review: findings broadcast with evidence. Without passive awareness
      // this is where cross facts FIRST surface (paper: blocking mode's
      // Execute produces no live sharing — discoveries stay silent until
      // Review). Every post costs a foreground step; every agent then pays
      // one blocking receive — same visibility, but listening is work.
      for (let a = 0; a < agentCount; a++) {
        const byOwner = new Map<number, number[]>();
        for (const f of known[a]) {
          const owner = ownerAgent(task.factOwner[f]);
          if (owner === a) continue;
          const list = byOwner.get(owner);
          if (list) list.push(f);
          else byOwner.set(owner, [f]);
        }
        for (const [owner, facts] of byOwner) {
          sendFactsTo(a, owner, facts);
          totalSteps++;
          perAgentSteps[a]++;
          exchangeSteps++;
        }
      }
      for (let a = 0; a < agentCount; a++) {
        if (mode === 'passive') {
          // 'silent' passive: live posting was suppressed, but the watcher
          // never turned off — the Review broadcast folds in at the next step
          // boundary at zero cost. Listening stays free; only posting paid.
          crossFactsDelivered += applyFold(a, false);
        } else {
          // One blocking receive drains all pending mentions but costs a step.
          totalSteps++;
          perAgentSteps[a]++;
          exchangeSteps++;
          blockingReceives++;
          crossFactsDelivered += applyFold(a, true);
        }
      }
      updateResolution();
    }
  }

  // What no agent ever concluded, no exchange round can deliver: if a fact
  // was never discovered, the pod stays unresolved no matter the policy.
  return {
    mode,
    seed: cfg.seed,
    resolved: resolvedAll(),
    stepsToResolve: totalSteps,
    rounds,
    messages: bus.messageCount,
    blockingReceives,
    explorations,
    redundantExplorations,
    crossFactsDelivered,
    exchangeSteps,
    perAgentSteps,
    subResolvedAtStep,
  };
}
