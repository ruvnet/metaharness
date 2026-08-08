// @metaharness/radio — the five-phase protocol driver (AgentRadio, arXiv:2607.28430).
//
// Drives a pod of scripted agents through the paper's five phases over ONE
// RadioBus, with one background Watcher per agent:
//
//   1. Explore — watchers are started; agents survey independently. NOTHING is
//      sent on the bus during Explore.
//   2. Divide — the assembler opens the planning thread; agents pool their
//      findings there and negotiate a partition of the task until ALL approve
//      (capped at maxNegotiationRounds).
//   3. Execute — agents solve their partition in round-robin steps. Under
//      PASSIVE awareness, a discovery that bears on a teammate's sub-question,
//      contradicts the plan, or blocks an approach is posted IMMEDIATELY with
//      an @-mention; incoming mentions are folded in at the next step boundary
//      at ZERO step cost. Under BLOCKING mode (the ablation arm), each receive
//      costs a foreground step and Execute produces NO live sharing —
//      discoveries stay silent until Review.
//   4. Review — findings are broadcast with evidence; conflicts can reopen
//      Execute (at most maxReopens times).
//   5. Submit — the assembler drafts the answer and collects unanimous
//      approvals; without unanimity the draft is returned with approved: false.
//
// Phase transitions are ASSEMBLER-GATED, as in the paper: every transition is
// announced by the assembler on the planning thread before the driver enacts
// it. Agents never advance the phase themselves.
//
// KNOWN FAILURE MODES the driver deliberately keeps visible rather than
// papering over (both are load-bearing results in the paper):
//
//   - Mentions can DERAIL as well as help: an @-mention forces a teammate to
//     reinterpret its plan against the mentioning thread, and the paper's
//     rubric-level accounting showed 47 rubrics gained but 23 LOST to exactly
//     this mechanism. The driver therefore never filters or ranks mentions —
//     every folded mention reaches executeStep() verbatim, so a harness (or
//     the flywheel) can measure and evolve the posting policy itself.
//
//   - Passive awareness cannot surface conclusions NO agent forms: the bus
//     only carries what some agent chose to post. If every agent misses an
//     inference, the protocol reviews and submits without it — visibility is
//     not synthesis.
//
// The driver is deterministic and dependency-free: no wall clock, no
// randomness — agent hooks are called in cfg.agents order and the bus's
// logical clock totally orders every message, so runs replay bit-for-bit.

import { RadioBus } from './bus.js';
import { Watcher, FoldedMention } from './watcher.js';

/** The paper's five phases, in protocol order. */
export type PhaseName = 'explore' | 'divide' | 'execute' | 'review' | 'submit';

/** A single Execute-phase discovery reported by an agent. */
export interface Discovery {
  /** What was discovered (posted verbatim when shared). */
  content: string;
  /**
   * Name of the TEAMMATE whose sub-question this bears on (or whose approach
   * it contradicts/blocks). When set — and only in passive mode — the driver
   * posts the discovery IMMEDIATELY to the execute thread with an @-mention
   * of that teammate, per the paper's passive-awareness rule. When unset the
   * discovery stays local to the agent's own results until Review.
   */
  bearsOn?: string;
}

/** What one Execute step of one agent produced. */
export interface ExecuteReport {
  discoveries: Discovery[];
  /** True once the agent considers its partition solved. */
  done: boolean;
}

/** One agent's Review-phase verdict on the pooled results. */
export interface ReviewVerdict {
  approve: boolean;
  /**
   * Conflicts with the plan or with a teammate's findings. ANY non-empty
   * conflict list reopens Execute (up to maxReopens), per the paper's
   * Review-can-reopen-Execute rule.
   */
  conflicts: string[];
}

/**
 * A scripted pod member. Every hook is a pure-looking callback the driver
 * invokes at a fixed point in the protocol; implementations must be
 * deterministic (no Date.now / Math.random) for runs to replay.
 *
 * Step accounting (mirrors the paper's foreground-step metric):
 *   explore()          — 1 step
 *   executeStep()      — 1 step (and each blocking receive costs 1 more)
 *   review()           — 1 step
 *   draft()            — 1 step (assembler only)
 *   proposePartition(), approvePartition(), approveDraft() — 0 steps; the
 *   negotiation's cost is measured in MESSAGES, not steps.
 */
export interface PodAgent {
  /** Unique agent name — the @-mention target and steps/results key. */
  name: string;

  /**
   * EXPLORE: called once with the agent's global step index at that moment.
   * Returns raw findings. Watchers are already running, but nothing may be
   * (and nothing is) sent during Explore.
   */
  explore(step: number): string[];

  /**
   * DIVIDE (assembler only): given the pooled findings of the whole pod
   * (agent name → findings), propose a partition (agent name → sub-questions).
   * Called once per negotiation round; a rejected proposal round feeds the
   * same pooled findings back, so stateful assemblers can revise.
   */
  proposePartition(findings: Record<string, string[]>): Record<string, string[]>;

  /**
   * DIVIDE (every agent, assembler included): vote on a proposed partition.
   * The partition is adopted only when ALL agents approve; after
   * maxNegotiationRounds the assembler gates the pod forward on the last
   * proposal anyway (logged in phaseLog).
   */
  approvePartition(partition: Record<string, string[]>): boolean;

  /**
   * EXECUTE: one round-robin work step on the agent's sub-questions.
   * `folded` carries the mentions surfaced at this step boundary — folded
   * for free in passive mode, paid for (one step per receive) in blocking
   * mode. Mentions arrive UNFILTERED (see derailment note above).
   */
  executeStep(sub: string[], folded: FoldedMention[]): ExecuteReport;

  /**
   * REVIEW: judge the pooled results (agent name → discovery contents).
   * Non-empty `conflicts` reopens Execute if reopens remain.
   */
  review(results: Record<string, string[]>): ReviewVerdict;

  /**
   * SUBMIT (optional): vote on the assembler's draft. When absent, the
   * agent's final Review verdict stands in as its approval.
   */
  approveDraft?(draft: string): boolean;

  /**
   * SUBMIT (assembler only, optional): compose the final answer from the
   * pooled results. When absent the driver concatenates results
   * deterministically in cfg.agents order.
   */
  draft?(results: Record<string, string[]>): string;
}

export interface ProtocolConfig {
  /** The pod, in deterministic turn order. Must be non-empty. */
  agents: PodAgent[];
  /** Name of the assembler; defaults to agents[0]. */
  assembler?: string;
  /**
   * 'passive' (default): background watchers fold mentions in at every step
   * boundary for free, and discoveries are shared live during Execute.
   * 'blocking': same visibility, but each receive costs a foreground step
   * (charged against the Execute budget — listening gives up a unit of work)
   * and Execute produces NO live sharing; discoveries surface only at Review.
   */
  mode?: 'passive' | 'blocking';
  /** Divide-phase proposal rounds before the assembler gates forward. Default 4. */
  maxNegotiationRounds?: number;
  /** Per-agent Execute step budget per Execute run (receives included). Default 8. */
  maxSteps?: number;
  /** How many times Review conflicts may reopen Execute. Default 1. */
  maxReopens?: number;
}

export interface ProtocolResult {
  /** The assembler's draft (final answer candidate). */
  answer: string;
  /** True iff every agent approved the draft (unanimity, per the paper). */
  approved: boolean;
  /** Foreground steps spent, per agent — the paper's efficiency metric. */
  steps: Record<string, number>;
  /** Total messages sent on the bus — the comms-cost metric. */
  messages: number;
  /** One entry per phase (re)entered, in order, with a summary detail. */
  phaseLog: { phase: PhaseName; detail: string }[];
}

const PLANNING_THREAD = 'planning';
const EXECUTE_THREAD = 'execute';
const REVIEW_THREAD = 'review';
const SUBMIT_THREAD = 'submit';

/**
 * Run the full five-phase AgentRadio protocol over one bus.
 * See the module doc comment for phase semantics and failure modes.
 */
export function runProtocol(cfg: ProtocolConfig): ProtocolResult {
  const agents = cfg.agents;
  if (agents.length === 0) {
    throw new Error('runProtocol: cfg.agents must be non-empty');
  }
  const mode = cfg.mode ?? 'passive';
  const maxNegotiationRounds = cfg.maxNegotiationRounds ?? 4;
  const maxSteps = cfg.maxSteps ?? 8;
  const maxReopens = cfg.maxReopens ?? 1;

  const assembler =
    (cfg.assembler !== undefined
      ? agents.find((a) => a.name === cfg.assembler)
      : undefined) ?? agents[0];
  const names = agents.map((a) => a.name);
  const othersOf = (name: string) => names.filter((n) => n !== name);

  const bus = new RadioBus();
  const steps: Record<string, number> = {};
  for (const a of agents) steps[a.name] = 0;
  const phaseLog: { phase: PhaseName; detail: string }[] = [];

  // Assembler-gated transition: announced on the planning thread before the
  // driver enacts the phase. (The very first announcement auto-creates the
  // planning thread via the bus's fire-and-forget send.)
  const gate = (phase: PhaseName, note: string) => {
    bus.send(PLANNING_THREAD, assembler.name, `PHASE:${phase} — ${note}`);
    phaseLog.push({ phase, detail: note });
  };

  // ---- Phase 1: EXPLORE -------------------------------------------------
  // Watchers start here (cursor = current clock); nothing is sent.
  const watchers = new Map<string, Watcher>();
  for (const a of agents) watchers.set(a.name, new Watcher(bus, a.name));

  const findings: Record<string, string[]> = {};
  for (const a of agents) {
    findings[a.name] = a.explore(steps[a.name]);
    steps[a.name] += 1;
  }
  phaseLog.push({
    phase: 'explore',
    detail: `watchers started for ${names.join(', ')}; ${Object.values(findings).reduce((n, f) => n + f.length, 0)} finding(s) gathered, nothing sent`,
  });

  // ---- Phase 2: DIVIDE --------------------------------------------------
  // Assembler opens the planning thread; agents pool findings; the partition
  // is negotiated until unanimous (capped at maxNegotiationRounds).
  bus.createThread(PLANNING_THREAD, names);
  gate('divide', `assembler ${assembler.name} opened ${PLANNING_THREAD}`);
  for (const a of agents) {
    bus.send(PLANNING_THREAD, a.name, `findings: ${findings[a.name].join('; ')}`);
  }

  let partition: Record<string, string[]> = {};
  let partitionApproved = false;
  let rounds = 0;
  while (rounds < maxNegotiationRounds && !partitionApproved) {
    rounds += 1;
    partition = assembler.proposePartition(findings);
    bus.send(
      PLANNING_THREAD,
      assembler.name,
      `partition proposal r${rounds}: ${JSON.stringify(partition)}`,
      othersOf(assembler.name),
    );
    const votes = agents.map((a) => a.approvePartition(partition));
    for (let i = 0; i < agents.length; i++) {
      bus.send(PLANNING_THREAD, agents[i].name, votes[i] ? `approve r${rounds}` : `reject r${rounds}`);
    }
    partitionApproved = votes.every(Boolean);
  }
  phaseLog.push({
    phase: 'divide',
    detail: partitionApproved
      ? `partition approved unanimously in ${rounds} round(s)`
      : `no consensus after ${rounds} round(s); assembler gated forward on last proposal`,
  });

  const results: Record<string, string[]> = {};
  for (const a of agents) results[a.name] = [];

  // ---- Phase 3: EXECUTE (re-enterable from Review) ----------------------
  bus.createThread(EXECUTE_THREAD, names);

  const runExecute = (label: string) => {
    gate('execute', label);
    const done = new Map<string, boolean>();
    const budget = new Map<string, number>(); // steps spent this run, receives included
    const received = new Map<string, boolean>(); // blocking mode: one receive per run
    for (const a of agents) {
      done.set(a.name, false);
      budget.set(a.name, 0);
      received.set(a.name, false);
    }
    let posted = 0;
    // Round-robin until every agent reports done or exhausts its budget.
    let progress = true;
    while (progress) {
      progress = false;
      for (const a of agents) {
        if (done.get(a.name) || budget.get(a.name)! >= maxSteps) continue;
        progress = true;
        const watcher = watchers.get(a.name)!;

        let folded: FoldedMention[] = [];
        if (mode === 'passive') {
          // Passive awareness: fold at the step boundary, ZERO step cost.
          folded = watcher.fold();
        } else if (!received.get(a.name)) {
          // Blocking ablation: one receive at the start of the run picks up
          // everything pending (e.g. the Divide negotiation) and COSTS a
          // foreground step out of the work budget. No further receives are
          // scheduled because blocking Execute has no live sharing — nothing
          // new can arrive mid-run.
          folded = watcher.blockingReceive();
          received.set(a.name, true);
          steps[a.name] += 1;
          budget.set(a.name, budget.get(a.name)! + 1);
          if (budget.get(a.name)! >= maxSteps) continue; // listening ate the last unit of work
        }

        const report = a.executeStep(partition[a.name] ?? [], folded);
        steps[a.name] += 1;
        budget.set(a.name, budget.get(a.name)! + 1);
        for (const d of report.discoveries) {
          results[a.name].push(d.content);
          if (mode === 'passive' && d.bearsOn !== undefined && d.bearsOn !== a.name) {
            // Passive awareness: a discovery bearing on a teammate is posted
            // IMMEDIATELY with an @-mention — it will reach them at their
            // next step boundary. (This is also the derailment vector: the
            // paper counted 47 rubrics gained vs 23 lost to mentions.)
            bus.send(EXECUTE_THREAD, a.name, d.content, [d.bearsOn]);
            posted += 1;
          }
          // Blocking mode: discoveries stay SILENT until Review.
        }
        if (report.done) done.set(a.name, true);
      }
    }
    const finished = names.filter((n) => done.get(n));
    phaseLog.push({
      phase: 'execute',
      detail: `${finished.length}/${names.length} agent(s) done; ${posted} discover${posted === 1 ? 'y' : 'ies'} shared live (${mode} mode)`,
    });
  };

  // ---- Phases 3–4: EXECUTE + REVIEW loop --------------------------------
  bus.createThread(REVIEW_THREAD, names);
  const lastVerdict = new Map<string, ReviewVerdict>();
  let reopens = 0;
  let executeLabel = partitionApproved ? 'partition adopted' : 'gated forward without consensus';
  for (;;) {
    runExecute(executeLabel);

    // Review: broadcast findings with evidence, then judge the pool.
    // In blocking mode this is where withheld discoveries finally surface.
    gate('review', `broadcasting results${reopens > 0 ? ` (after reopen ${reopens})` : ''}`);
    for (const a of agents) {
      bus.send(REVIEW_THREAD, a.name, `results: ${results[a.name].join('; ')}`, othersOf(a.name));
    }
    const conflicts: string[] = [];
    for (const a of agents) {
      const verdict = a.review(results);
      steps[a.name] += 1;
      lastVerdict.set(a.name, verdict);
      conflicts.push(...verdict.conflicts);
    }
    if (conflicts.length === 0) {
      phaseLog.push({ phase: 'review', detail: 'no conflicts' });
      break;
    }
    if (reopens >= maxReopens) {
      phaseLog.push({
        phase: 'review',
        detail: `${conflicts.length} conflict(s) unresolved; reopen budget exhausted (${maxReopens})`,
      });
      break;
    }
    // Conflicts reopen Execute (paper rule), assembler-gated like any transition.
    reopens += 1;
    phaseLog.push({
      phase: 'review',
      detail: `${conflicts.length} conflict(s) — reopening execute (${reopens}/${maxReopens})`,
    });
    bus.send(EXECUTE_THREAD, assembler.name, `conflicts: ${conflicts.join('; ')}`, othersOf(assembler.name));
    executeLabel = `reopened by review conflicts (${reopens}/${maxReopens})`;
  }

  // ---- Phase 5: SUBMIT --------------------------------------------------
  // Assembler drafts; unanimity required, else the draft ships approved:false.
  bus.createThread(SUBMIT_THREAD, names);
  gate('submit', `assembler ${assembler.name} drafting`);
  const answer =
    assembler.draft !== undefined
      ? assembler.draft(results)
      : agents.map((a) => `${a.name}: ${results[a.name].join('; ')}`).join('\n');
  steps[assembler.name] += 1;
  bus.send(SUBMIT_THREAD, assembler.name, answer, othersOf(assembler.name));

  const approvals = agents.map((a) => {
    const vote =
      a.approveDraft !== undefined
        ? a.approveDraft(answer)
        : (lastVerdict.get(a.name)?.approve ?? true);
    bus.send(SUBMIT_THREAD, a.name, vote ? 'approve draft' : 'reject draft');
    return vote;
  });
  const approved = approvals.every(Boolean);
  phaseLog.push({
    phase: 'submit',
    detail: approved
      ? 'draft approved unanimously'
      : `draft rejected by ${approvals.filter((v) => !v).length} agent(s)`,
  });

  return { answer, approved, steps, messages: bus.messageCount, phaseLog };
}
