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
//   digest     'full'|'mentions'|'relevant' — WHAT of a folded thread the reader
//              digests, and what that digest costs (see the Digest type). 'full'
//              is faithful to the paper (whole snapshot, a real per-fold context
//              surcharge); 'mentions' is cheap but drops cross-facts bundled into
//              another owner's mention; 'relevant' is a deterministic topic filter
//              that is both cheap and correct — the surface ADR-241 said to evolve
//              rather than hand-design, so the flywheel prices it under the frozen
//              gate. Live cross-posts are CONSOLIDATED (one message per discovery,
//              @-mentioning only the primary owner) so that 'mentions' vs
//              'relevant' is a real distinction and not a no-op.
//   topology   'message-passing'|'blackboard' — the COORDINATION SUBSTRATE
//              (arXiv:2510.01285 / 2507.01701 — shared structured state beats both
//              message-passing and master-slave, and is more token-efficient). See
//              the Topology type. 'message-passing' is everything above, unchanged.
//              'blackboard' replaces per-agent posts+folds with ONE validated
//              shared board: discoverers write validated cross-facts to it (free,
//              no per-pair broadcast), and each owner PULLS only the facts on its
//              still-open sub-questions at every step boundary (fine-grained) for a
//              BOUNDED per-read cost (one step per boardReadCap productive pulls —
//              content-independent, an indexed lookup, unlike 'full's per-fact
//              snapshot wade). It is CORRECT BY CONSTRUCTION: validated mutations
//              are never dropped the way a 'mentions' digest drops a consolidated
//              cross-fact, and every fact-bearing unit is covered by some agent's
//              partition, so no seed is ever left unresolved for lack of delivery.
//              Its relevant-pull SUBSUMES the message-passing delivery levers: under
//              'blackboard' the digest, foldEvery and postPolicy levers have NO
//              effect (the board is the digest — a correct topic filter; the pull is
//              fine-grained every boundary; writes are always immediate validated
//              mutations). Whether that correctness+efficiency actually clears the
//              frozen 2% gate against the tuned message-passing rung is left to the
//              flywheel — it is priced, not hand-declared a winner.
//
// Staleness (arXiv:2502.14321 — async coordination's signature FAILURE MODE):
//   without fine-grained sync, an agent reasons over OUTDATED peer contributions,
//   redoing work. Modeled as an INTRINSIC rework surcharge (not a lever), charged
//   ONLY on LIVE async folds — mode 'passive' with live posting (postPolicy !=
//   'silent') under 'message-passing'. Each cross-fact delivered to its owner is
//   priced by its delivery LATENCY: (postRound - discoveryRound) + (foldEvery - 1)
//   — the rounds the fact sat withheld before it was posted (0 for 'immediate',
//   >0 for 'batched'), plus the fold-cadence lag (0 at foldEvery=1). One rework
//   step accrues per `1/stalenessCost` accumulated fact-rounds. This is EXACTLY 0
//   at the defaults (foldEvery=1 + 'immediate'), so the ablation ordering and every
//   existing result are untouched; it turns fold1+immediate from merely-neutral
//   into genuinely-cheapest and prices lazy folding / batched withholding. The
//   blocking/sync arms carry no live shared state to go stale ('negotiate',
//   'divide', 'single', and silent-'passive' — which shares nothing until Review),
//   and 'blackboard's fine-grained pull is never stale: all incur no staleness,
//   faithfully.
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
import type { RadioMessage } from './bus.js';
import { Watcher } from './watcher.js';

/** Comms-policy ladder position (paper: single < L1 divide < L2 negotiate < L3 passive). */
export type SimMode = 'single' | 'divide' | 'negotiate' | 'passive';

/** Fold cadence lever: fold mentions at every k-th step boundary. */
export type FoldEvery = '1' | '2' | '4';

/** Execute-phase posting lever for 'passive' mode. */
export type PostPolicy = 'immediate' | 'batched' | 'silent';

/**
 * Relevance/DIGEST lever — the surface AgentRadio left open (ADR-241): the paper
 * ships FULL thread snapshots to every folding reader and lets the agent sort out
 * relevance itself. That is a real cost the earlier sim never priced: re-reading
 * the whole unread thread at each fold burns the reader's context. This lever
 * makes that cost explicit and lets the flywheel evolve a cheaper delivery:
 *
 *   'full'     — today's AgentRadio behavior: the reader digests the WHOLE unread
 *                thread snapshot at every fold. Correct (it sees every posted
 *                cross-fact, even one bundled into a message that @-mentioned a
 *                different owner) but the most expensive: a per-fold context
 *                surcharge accrues in proportion to how many unread messages the
 *                reader must wade through (one foreground step per `digestCap`
 *                messages digested). Bigger snapshots cost the reader more.
 *   'mentions' — the reader digests ONLY the messages that @-mention it. Cheapest
 *                to read, but LOSSY: a cross-fact consolidated into a message that
 *                mentioned another owner (see the live-post consolidation below)
 *                is never surfaced to this reader — missed, or delayed to a round
 *                that happens to mention it. Under the frozen gate an unresolved
 *                holdout seed is a hard stop, so 'mentions' is blocked by exactly
 *                the failure it models.
 *   'relevant' — a deterministic topic filter: the reader digests only messages
 *                carrying a fact whose owning sub-question is still OPEN for this
 *                reader. It recovers every cross-fact 'mentions' would drop (the
 *                topic matches even when the @-mention did not) while reading far
 *                fewer messages than 'full' — the cheapest CORRECT digest, and the
 *                intended sweet spot the wheel should discover.
 */
export type Digest = 'full' | 'mentions' | 'relevant';

/**
 * Coordination-substrate lever (arXiv:2510.01285 / 2507.01701 — BLACKBOARD /
 * shared structured state beats message-passing AND master-slave, more
 * token-efficient). See the doc block for the full mechanics.
 *
 *   'message-passing' — today's substrate: per-agent posts + boundary folds, the
 *                       digest / foldEvery / postPolicy levers all live here, and
 *                       delivery latency can go stale (see the staleness note).
 *   'blackboard'      — one validated shared board. Discoverers write validated
 *                       cross-facts to it for free (no per-pair broadcast); each
 *                       owner pulls only its still-open sub-questions' facts every
 *                       boundary (fine-grained, so never stale) for a BOUNDED
 *                       per-read cost. CORRECT BY CONSTRUCTION — validated
 *                       mutations are never dropped, so no seed goes unresolved
 *                       for lack of delivery. Its relevant-pull SUBSUMES the
 *                       message-passing levers: digest, foldEvery and postPolicy
 *                       have NO effect under 'blackboard'.
 */
export type Topology = 'message-passing' | 'blackboard';

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
  /** Relevance/digest policy for folds (default 'full' = legacy AgentRadio
   *  behavior: ship the whole snapshot, and now PRICE it). See the Digest type. */
  digest?: Digest;
  /** Coordination substrate (default 'message-passing' = every existing behavior,
   *  byte-for-byte). 'blackboard' is the shared-structured-state arm: correct by
   *  construction, fine-grained pull, bounded read cost; it SUBSUMES the digest /
   *  foldEvery / postPolicy levers (they have no effect). See the Topology type. */
  topology?: Topology;
  /** Staleness rework coefficient (arXiv:2502.14321). One rework step accrues per
   *  `1/stalenessCost` accumulated fact-rounds of delivery latency on LIVE async
   *  folds (passive + postPolicy != 'silent', message-passing). Default 0.1. The
   *  surcharge is ZERO at the defaults (foldEvery=1 + 'immediate' => 0 latency)
   *  regardless of this value, so it never disturbs the ablation ordering; set to
   *  0 to disable the effect entirely. Larger = staler folding costs more. */
  stalenessCost?: number;
  /** 'blackboard' board-read surcharge: one foreground step per this-many
   *  PRODUCTIVE board pulls (a boundary where >=1 new relevant fact was pulled).
   *  Bounded and content-independent — the structured board is an indexed lookup,
   *  not a snapshot wade (default 6, the digestCap scale). */
  boardReadCap?: number;
  /** The digest context surcharge is one foreground step per this-many FACTS
   *  digested, cumulatively across a run (default 6). Priced by fact content, not
   *  message envelopes, so 'batched' posting cannot coalesce the cost away.
   *  'full' wades through every posted fact, 'relevant' only its open-topic
   *  slice, 'mentions' only the facts in messages that @-mention it. */
  digestCap?: number;
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
  /** Foreground steps charged as the DIGEST context surcharge — the cost of
   *  reading folded thread traffic under the active digest policy. 'relevant'
   *  and 'mentions' drive this below 'full'; part of stepsToResolve. */
  digestSteps: number;
  /** Foreground steps charged as the STALENESS rework surcharge (arXiv:2502.14321)
   *  — the cost of a live async fold delivering a peer cross-fact LATE. Zero for
   *  the blocking/sync arms, for silent-'passive', for 'blackboard', and for the
   *  default foldEvery=1 + 'immediate' passive config; part of stepsToResolve. */
  stalenessSteps: number;
  /** Foreground steps charged as the 'blackboard' BOARD-READ surcharge — the
   *  bounded, content-independent cost of pulling from the shared structured
   *  board. Zero under 'message-passing'; part of stepsToResolve. */
  boardReadSteps: number;
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
  const digest = cfg.digest ?? 'full';
  const topology = cfg.topology ?? 'message-passing';
  const stalenessCost = Math.max(0, cfg.stalenessCost ?? 0.1);
  const boardReadCap = Math.max(1, cfg.boardReadCap ?? 6);
  const digestCap = Math.max(1, cfg.digestCap ?? 6);
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
  /** Per-agent digest cursor over the EXEC thread: the seq up to which this agent
   *  has already folded. 'full'/'relevant' scan the thread beyond it; the cost is
   *  paid once per message, never re-charged. */
  const digestCursor = new Array<number>(agentCount).fill(0);
  /** Cumulative messages this agent has digested — the context surcharge is one
   *  step per digestCap of these, so partial reads carry over instead of rounding
   *  to free on a fine fold cadence. */
  const digestedTotal = new Array<number>(agentCount).fill(0);
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
  let digestSteps = 0;
  let stalenessSteps = 0;
  let boardReadSteps = 0;
  const subResolvedAtStep = new Array<number>(K).fill(-1);

  // ---- F6 blackboard substrate + F9 staleness state ------------------------
  const blackboard = topology === 'blackboard' && agentCount > 1;
  /** Staleness (F9) is charged ONLY on LIVE async folds: message-passing +
   *  'passive' + live posting. Silent-'passive' shares nothing until Review (no
   *  live state to go stale), the blocking/sync arms share nothing live, and
   *  'blackboard' pulls fine-grained — all faithfully carry no staleness. */
  const stalenessOn =
    !blackboard && mode === 'passive' && postPolicy !== 'silent' && stalenessCost > 0;
  const nFacts = task.factUnit.length;
  /** Round a cross-fact was first discovered by a NON-owner (became a pending
   *  cross-delivery), and the round it was actually posted to the bus. Their gap
   *  is the withhold latency ('immediate' => 0, 'batched'/late flush => >0). */
  const discoveryRound = new Array<number>(nFacts).fill(-1);
  const postRound = new Array<number>(nFacts).fill(-1);
  let staleAccum = 0; // accumulated fact-rounds of delivery latency
  /** The shared validated board (blackboard topology): appended cross-facts, plus
   *  a per-agent cursor over it and the accumulated productive-pull count. */
  const board: number[] = [];
  const boardCursor = new Array<number>(agentCount).fill(0);
  let boardPullAccum = 0;

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

  /** A message is RELEVANT to agent a iff it carries a fact whose owning
   *  sub-question is still OPEN for a — the deterministic topic filter that makes
   *  'relevant' both cheap (few messages) and correct (it matches even when the
   *  @-mention pointed at another owner). */
  const relevantToAgent = (a: number, msg: RadioMessage): boolean => {
    for (const f of decodeFacts(msg.content)) {
      if (f >= task.factUnit.length) continue;
      const q = task.factOwner[f];
      if (ownerAgent(q) === a && subResolvedAtStep[q] < 0) return true;
    }
    return false;
  };

  /** Fold at a step boundary under the active DIGEST policy. Advances the passive
   *  watcher (keeping its cursor and the blocking-receive ledger coherent), then
   *  selects which folded messages the reader actually digests:
   *    'full'     — every unread message in the thread snapshot (paper-faithful,
   *                 priciest). It alone always sees a fact bundled into a message
   *                 that @-mentioned a different owner.
   *    'mentions' — only the messages that @-mention this reader; a consolidated
   *                 cross-post that named another owner is invisible here.
   *    'relevant' — only messages whose fact-topic is one of the reader's open
   *                 sub-questions.
   *  Harvests the reader's OWN facts from the selected messages, charges the
   *  context surcharge (one step per digestCap messages digested, cumulative),
   *  and returns the newly-gained fact count. Idle folds select nothing and cost
   *  nothing — waiting under passive awareness stays free. */
  const applyFold = (a: number, blocking: boolean): number => {
    const folded = blocking ? watchers[a].blockingReceive() : watchers[a].fold();
    const horizon = bus.clock;
    let selected: RadioMessage[];
    if (digest === 'mentions') {
      // Exactly what the passive watcher wakes on — nothing more.
      selected = folded.map((f) => f.mention);
    } else {
      const fresh = bus
        .snapshot(EXEC_THREAD, horizon)
        .filter((m) => m.seq >= digestCursor[a]);
      selected = digest === 'full' ? fresh : fresh.filter((m) => relevantToAgent(a, m));
    }
    digestCursor[a] = horizon;

    // Context surcharge, priced by FACT CONTENT the reader must wade through —
    // NOT message envelopes. That is deliberate: 'batched' posting coalesces the
    // same facts into fewer messages, so an envelope-count surcharge would let a
    // reader dodge the whole snapshot cost by batching. Content is what actually
    // burns context, so the cost is the number of facts digested:
    //   'full'     — every fact in the whole unread snapshot (it wades through
    //                cross-facts bound for other owners too).
    //   'mentions' — every fact in the messages that @-mention it.
    //   'relevant' — only the facts on the reader's OPEN topics — the precise
    //                slice the topic filter delivers, nothing wasted.
    let read = 0;
    let gained = 0;
    for (const m of selected) {
      for (const f of decodeFacts(m.content)) {
        if (f >= task.factUnit.length) continue;
        const q = task.factOwner[f];
        const mine = ownerAgent(q) === a;
        // Relevant is charged only for the on-topic slice it actually delivers;
        // full/mentions pay for the whole envelope they read.
        if (digest !== 'relevant' || (mine && subResolvedAtStep[q] < 0)) read++;
        if (mine && !known[a].has(f)) {
          known[a].add(f);
          gained++;
          // F9 staleness: this cross-fact reached its owner LATE. Its delivery
          // latency is the rounds it sat withheld before posting plus the
          // fold-cadence lag — zero at foldEvery=1 + 'immediate'.
          if (stalenessOn) {
            const dr = discoveryRound[f];
            const pr = postRound[f];
            if (dr >= 0) {
              const withhold = pr >= 0 && pr > dr ? pr - dr : 0;
              staleAccum += withhold + (foldK - 1);
            }
          }
        }
      }
    }
    // One foreground step per digestCap facts digested, accumulated so a fine
    // fold cadence cannot round the cost away to zero.
    const before = Math.floor(digestedTotal[a] / digestCap);
    digestedTotal[a] += read;
    const surcharge = Math.floor(digestedTotal[a] / digestCap) - before;
    if (surcharge > 0) {
      totalSteps += surcharge;
      perAgentSteps[a] += surcharge;
      digestSteps += surcharge;
    }
    // Convert accumulated latency into rework steps: one per 1/stalenessCost
    // fact-rounds, charged incrementally to the folding agent.
    if (stalenessOn) {
      const staleBefore = stalenessSteps;
      const staleNow = Math.floor(staleAccum * stalenessCost);
      const delta = staleNow - staleBefore;
      if (delta > 0) {
        totalSteps += delta;
        perAgentSteps[a] += delta;
        stalenessSteps = staleNow;
      }
    }
    return gained;
  };

  /** Blackboard pull (F6): the owner reads the shared board for facts on its
   *  still-open sub-questions since its last pull — correct by construction (no
   *  drops), fine-grained (never stale), at a BOUNDED per-read cost: one step per
   *  boardReadCap PRODUCTIVE pulls, content-independent (an indexed lookup, not a
   *  snapshot wade). Returns the newly-gained fact count. */
  const pullBoard = (a: number): number => {
    let gained = 0;
    const end = board.length;
    for (let i = boardCursor[a]; i < end; i++) {
      const f = board[i];
      const q = task.factOwner[f];
      if (ownerAgent(q) === a && subResolvedAtStep[q] < 0 && !known[a].has(f)) {
        known[a].add(f);
        gained++;
      }
    }
    boardCursor[a] = end;
    if (gained > 0) {
      const readBefore = Math.floor(boardPullAccum / boardReadCap);
      boardPullAccum += 1;
      const sur = Math.floor(boardPullAccum / boardReadCap) - readBefore;
      if (sur > 0) {
        totalSteps += sur;
        perAgentSteps[a] += sur;
        boardReadSteps += sur;
      }
    }
    return gained;
  };

  /** Write a validated cross-fact to the shared board (blackboard topology).
   *  Free, like a non-blocking send, and never dropped. */
  const writeBoard = (f: number): void => {
    board.push(f);
  };

  /** Consolidate a discovery's cross-facts into ONE non-blocking post that
   *  @-mentions only the PRIMARY owner (the one with the most facts here; ties go
   *  to the lowest agent index). Every fact still rides in the content, so 'full'
   *  and 'relevant' readers recover a secondary owner's fact from the snapshot —
   *  but a 'mentions' reader who was not the primary never sees it. This single
   *  imperfection is what turns digest into a real lever instead of a no-op. */
  const postConsolidated = (from: number, byOwner: Map<number, number[]>): void => {
    let primary = -1;
    let best = -1;
    const all: number[] = [];
    for (const [owner, facts] of byOwner) {
      all.push(...facts);
      if (facts.length > best || (facts.length === best && owner < primary)) {
        best = facts.length;
        primary = owner;
      }
    }
    if (primary < 0) return;
    for (const f of all) if (postRound[f] < 0) postRound[f] = rounds;
    bus.send(EXEC_THREAD, names[from], encodeFacts(all), [names[primary]]);
  };

  const sendFactsTo = (from: number, owner: number, facts: number[]): void => {
    for (const f of facts) if (postRound[f] < 0) postRound[f] = rounds;
    bus.send(EXEC_THREAD, names[from], encodeFacts(facts), [names[owner]]);
  };

  const flushOutbox = (a: number): void => {
    const byOwner = new Map<number, number[]>();
    for (const [owner, facts] of outbox[a]) {
      if (facts.size > 0) byOwner.set(owner, [...facts]);
    }
    if (byOwner.size > 0) postConsolidated(a, byOwner);
    outbox[a].clear();
  };

  const passiveLive = mode === 'passive' && postPolicy !== 'silent' && !blackboard;

  outer: while (!resolvedAll() && totalSteps < maxSteps) {
    if (!queues.some((q) => q.length > 0)) break; // Execute exhausted
    rounds++;
    for (let a = 0; a < agentCount; a++) {
      // Step boundary: passive fold-in, every foldK-th boundary, zero cost.
      // Idle agents still hit boundaries — waiting costs nothing under
      // passive awareness; that is the whole point.
      if (blackboard) {
        // F6 blackboard: fine-grained pull EVERY boundary (never stale). The
        // bounded board-read cost is charged inside pullBoard.
        crossFactsDelivered += pullBoard(a);
        updateResolution();
        if (resolvedAll()) break outer;
      } else if (passiveLive) {
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
          // Record when this cross-fact first became a pending delivery — the
          // clock the F9 staleness latency measures from.
          if (discoveryRound[f] < 0) discoveryRound[f] = rounds;
          const list = byOwner.get(owner);
          if (list) list.push(f);
          else byOwner.set(owner, [f]);
        }
      }
      if (!newAny) redundantExplorations++;

      // Deliver a discovery that bears on a teammate's sub-question. Under
      // 'blackboard' it is a free validated write to the shared board; under
      // message-passing passive it is an immediate/queued @-mention post.
      if (byOwner.size > 0 && agentCount > 1) {
        if (blackboard) {
          for (const [, facts] of byOwner) for (const f of facts) writeBoard(f);
        } else if (passiveLive && postPolicy === 'immediate') {
          postConsolidated(a, byOwner);
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
    if (blackboard) {
      // Final fine-grained board drain: deliver the last validated writes.
      // Correct by construction — every cross-fact was written, so this closes
      // out every open sub-question no in-loop pull had reached yet.
      for (let a = 0; a < agentCount; a++) crossFactsDelivered += pullBoard(a);
      updateResolution();
    } else if (passiveLive) {
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
    digestSteps,
    stalenessSteps,
    boardReadSteps,
    perAgentSteps,
    subResolvedAtStep,
  };
}
