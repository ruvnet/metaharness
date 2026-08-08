// @metaharness/oo-agents — pod.ts: an OO agent AS a radio PodAgent.
//
// WHY THIS MODULE EXISTS
// ADR-241 and ADR-242 both call for composing the two harness models this repo
// keeps deliberately separate:
//   - @metaharness/oo-agents — the agent is a CLASS: fields are state, methods
//     are capabilities, doc strings are prompts, an agentic method hands control
//     to a model that acts by WRITING CODE in the wasm sandbox.
//   - @metaharness/radio — AgentRadio's passive-awareness bus: a POD of scripted
//     agents runs the five-phase protocol over one logical-clock RadioBus, and a
//     teammate's mid-Execute discovery folds into an agent's next step for free.
//
// This module is that composition: it presents an oo-agents `Agent` as a
// first-class radio `PodAgent`, so a POD of OO agents coordinates over the
// passive-awareness bus.
//
// THE LOAD-BEARING DESIGN TENSION, STATED HONESTLY
// radio's PodAgent hooks (explore / proposePartition / approvePartition /
// executeStep / review / draft) are SYNCHRONOUS, and runProtocol drives them
// synchronously — the bus's logical clock totally orders every message, so a
// hook must answer NOW. oo-agents' AGENTIC seam is the opposite: the model
// writes code cells that the wasm Runtime executes, awaiting a ModelDriver. You
// cannot run that async loop inside a synchronous PodAgent hook.
//
// So the pod hooks map onto the agent's synchronous CAPABILITIES — the exact
// same prototype methods the sandbox reaches through `self.method()` — selected
// by a small synchronous scripted PodDriver (the "scripted/mock driver"). The
// async agentic seam is NOT discarded: `PodMemberAgent.summarize` is a genuine
// agentic method a model can drive with the real oo-agents ScriptedDriver
// (exercised in pod.test.ts); it simply sits off the per-step critical path,
// where the bus needs a synchronous answer, and is available for model-written
// work (e.g. composing the final answer, digesting a worklog).
//
// THE PAYOFF IS CONCRETE
// When agent2 explores a unit and finds a fact that bears on agent1's
// sub-question, executeStep returns it as Discovery{ bearsOn: 'agent1' };
// runProtocol posts it @agent1 on the execute thread (send() is non-blocking —
// zero step cost); agent1's background Watcher folds it in at its NEXT step
// boundary and its `absorb` capability integrates it. A teammate's mid-execute
// discovery folds into an agent's next step — exactly the primitive AgentRadio
// measures. The no-sharing control (radio's 'blocking' ablation) gets the same
// fact only at Review and pays one foreground blockingReceive per agent, so it
// resolves strictly LATER / costlier; and a hard silo (sharing switched off)
// never surfaces the cross fact at all and simply fails — "visibility is not
// synthesis; the bus only carries what some agent chose to post."
//
// Deterministic and dependency-free: no Date.now / Math.random. The one place
// that could want randomness (scattering a generated task) uses a seeded
// mulberry32 LCG; the default worked task is built by explicit construction.

import { runProtocol } from '@metaharness/radio';
import type { PodAgent, ProtocolConfig, ProtocolResult, FoldedMention } from '@metaharness/radio';
import { Agent, agentic } from './agent.js';

// ---------------------------------------------------------------- task model --

/**
 * A decomposed pod task: K sub-questions, one per agent. Each agent owns a
 * REGION of explorable units (think: files), and its sub-question is resolved
 * only when the agent HOLDS every fact the sub-question needs. Some needed facts
 * live in a TEAMMATE's region (cross facts) — those are exactly what
 * communication pays for: the discoverer is never the owner.
 */
export interface PodTask {
  /** Agent names in deterministic turn order; names[0] is the assembler. */
  names: string[];
  /** region[a] = unit ids agent `a` may explore, in exploration order. */
  region: number[][];
  /** unit id -> fact ids present in that unit. */
  unitFacts: Record<number, number[]>;
  /** needs[a] = fact ids agent `a`'s sub-question requires to resolve. */
  needs: number[][];
  /** fact id -> index of the agent whose sub-question needs it (the owner). */
  factNeededBy: Record<number, number>;
}

/** mulberry32 — the module's only randomness source (used solely by the
 *  optional task scatter). Same seed => identical stream; no wall clock. */
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

/** In-place Fisher–Yates over the given PRNG (deterministic in the seed). */
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
 * Build the canonical 3-agent worked task: a decomposition in which ONE agent's
 * discovery is needed by ANOTHER, so passive awareness has something real to
 * pay for. Fully deterministic.
 *
 * Layout (unit -> facts, and who needs each fact):
 *   agent0 (assembler): region [u0]  u0=[f0]                needs f0            — self-contained
 *   agent1            : region [u1,u2] u1=[f1] u2=[f2]      needs f1,f2,f3      — f3 lives in agent2's region (CROSS)
 *   agent2            : region [u3]   u3=[f4,f3]            needs f4            — discovers f3, which bears on agent1
 *
 * agent2 cannot resolve f3 for agent1; agent1 cannot reach u3. Only sharing the
 * discovery closes the gap — the whole point of the pod.
 *
 * @param scatterSeed  When provided, deterministically shuffles each agent's
 *                     exploration order (a seeded LCG) to prove the result does
 *                     not depend on a lucky unit ordering; omit for the canonical
 *                     order used in docs.
 */
export function makePodTask(scatterSeed?: number): PodTask {
  const task: PodTask = {
    names: ['agent0', 'agent1', 'agent2'],
    region: [[0], [1, 2], [3]],
    unitFacts: { 0: [0], 1: [1], 2: [2], 3: [4, 3] },
    needs: [[0], [1, 2, 3], [4]],
    factNeededBy: { 0: 0, 1: 1, 2: 1, 3: 1, 4: 2 },
  };
  if (scatterSeed !== undefined) {
    const rng = mulberry32(scatterSeed);
    task.region = task.region.map((units) => shuffle([...units], rng));
  }
  return task;
}

// ------------------------------------------------------------- fact encoding --

const FACT_TAG = 'fact:';

/** A discovery's wire form: the fact id, tagged so any teammate can parse it
 *  out of a folded mention or a Review broadcast without a schema handshake. */
function encodeFact(id: number): string {
  return `${FACT_TAG}${id}`;
}

/** Pull every `fact:<id>` id out of a message body. The bus ships NO relevance
 *  filter, so a recipient parses the raw content and decides for itself. */
function decodeFacts(content: string): number[] {
  const out: number[] = [];
  const re = /fact:(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push(Number(m[1]));
  return out;
}

// --------------------------------------------------------------- the OO agent --

/** Everything a PodMemberAgent needs to know at construction. */
export interface PodMemberConfig {
  name: string;
  /** Agent's own index in the pod (its sub-question id / owner id). */
  index: number;
  /** All agent names, so the discoverer can @-mention the fact's owner. */
  names: string[];
  /** Unit ids this agent may explore (its negotiated region), in order. */
  region: number[];
  /** unit id -> fact ids, restricted to this agent's region. */
  unitFacts: Record<number, number[]>;
  /** Fact ids this agent's sub-question must hold to resolve. */
  needs: number[];
  /** fact id -> owner agent index (shared plan knowledge from Divide). */
  factNeededBy: Record<number, number>;
  /** When false, the agent WITHHOLDS cross discoveries — the hard silo control
   *  that proves passive awareness is load-bearing (the fact is discovered but
   *  never posted, so no teammate can ever fold it in). */
  shareCrossFacts?: boolean;
}

/**
 * A pod member as an oo-agents class. Domain STATE lives in public fields
 * (visible in `manifest().fields`); CAPABILITIES are the prototype methods the
 * pod hooks (and, identically, the wasm sandbox via `self.x()`) call; the one
 * AGENTIC method (`summarize`) is model-driven and demonstrates the async seam.
 * Orchestration wiring the sandbox has no business reading (names, ownership
 * map, share flag) lives in private #fields, which `manifest()` never exposes.
 */
export class PodMemberAgent extends Agent {
  static override doc =
    'You are a pod member: explore your region, hold the facts your sub-question ' +
    'needs, and share any discovery that bears on a teammate.';

  // ---- domain state (manifest fields) ----
  name: string;
  region: number[];
  unitFacts: Record<number, number[]>;
  needs: number[];
  /** Facts currently held (from own exploration or from absorbing a teammate's
   *  addressed discovery). Superset of `needs` is fine; resolution checks needs. */
  held: number[] = [];
  /** Units already explored (each exploration is one foreground step). */
  explored: number[] = [];
  /** The OO agent's worklog — pod hooks post here as they act, mirroring the
   *  bus activity so the run is auditable capability-call by capability-call. */
  worklog: string[] = [];

  // ---- private orchestration wiring (never sandbox-visible) ----
  readonly #index: number;
  readonly #names: string[];
  readonly #factNeededBy: Record<number, number>;
  #shareCrossFacts: boolean;

  constructor(cfg: PodMemberConfig) {
    super();
    this.name = cfg.name;
    this.region = [...cfg.region];
    this.unitFacts = cfg.unitFacts;
    this.needs = [...cfg.needs];
    this.#index = cfg.index;
    this.#names = cfg.names;
    this.#factNeededBy = cfg.factNeededBy;
    this.#shareCrossFacts = cfg.shareCrossFacts ?? true;
  }

  // ---- capabilities (called by the pod hooks AND by the sandbox) ----

  /** EXPLORE-phase survey: a cheap description of the region. No bus traffic —
   *  nothing is sent during Explore. */
  survey(): string[] {
    return [`region units [${this.region.join(', ')}]; needs [${this.needs.join(', ')}]`];
  }

  /** Region units not yet explored, in order. */
  unexplored(): number[] {
    return this.region.filter((u) => !this.explored.includes(u));
  }

  /** Explore one unit: record it, hold every fact it contains, return them.
   *  Throws if the unit is outside this agent's region (a capability contract
   *  violation the caller — pod hook or sandbox — must respect). */
  exploreUnit(unit: number): number[] {
    if (!this.region.includes(unit)) throw new Error(`unit ${unit} not in ${this.name}'s region`);
    if (!this.explored.includes(unit)) this.explored.push(unit);
    const facts = this.unitFacts[unit] ?? [];
    for (const f of facts) if (!this.held.includes(f)) this.held.push(f);
    return [...facts];
  }

  /** The NAME of the agent whose sub-question needs `fact` — the @-mention
   *  target when the fact is not this agent's own. '' if no one needs it. */
  classify(fact: number): string {
    const owner = this.#factNeededBy[fact];
    return owner === undefined ? '' : (this.#names[owner] ?? '');
  }

  /** Whether this agent shares cross discoveries (false = silo control). */
  shares(): boolean {
    return this.#shareCrossFacts;
  }

  /**
   * Integrate addressed discoveries: parse fact ids out of the given message
   * bodies and hold any this agent NEEDS and does not already have. Returns the
   * newly held ids. This is the single integration path for BOTH channels —
   * passive folds during Execute and the Review broadcast — so "visibility is
   * not synthesis": an agent only adopts a fact it recognizes as its own need.
   */
  absorb(contents: string[]): number[] {
    const gained: number[] = [];
    for (const c of contents) {
      for (const f of decodeFacts(c)) {
        if (this.needs.includes(f) && !this.held.includes(f)) {
          this.held.push(f);
          gained.push(f);
        }
      }
    }
    return gained;
  }

  /** Resolved iff every fact the sub-question needs is held. */
  resolved(): boolean {
    return this.needs.every((f) => this.held.includes(f));
  }

  /** Append a worklog entry (a "worklog post"). */
  logWork(entry: string): void {
    this.worklog.push(entry);
  }

  /** Read a copy of the worklog. */
  worklogEntries(): string[] {
    return [...this.worklog];
  }

  /** A one-line status string — the capability the `summarize` agentic method
   *  composes from inside the sandbox (`return_result(self.status())`). */
  status(): string {
    return `${this.name}: ${this.worklog.length} worklog entries; resolved=${this.resolved()}`;
  }

  /** DIVIDE (assembler): propose a partition — each agent owns its own
   *  sub-question. The pod is pre-decomposed, so this is a stable one-shot
   *  proposal every member approves. */
  proposePlan(_findings: Record<string, string[]>): Record<string, string[]> {
    const partition: Record<string, string[]> = {};
    for (let i = 0; i < this.#names.length; i++) partition[this.#names[i]] = [`Q${i}`];
    return partition;
  }

  /** DIVIDE (every agent): accept a partition that assigns this agent its own
   *  sub-question label. */
  votePlan(partition: Record<string, string[]>): boolean {
    return (partition[this.name] ?? []).includes(`Q${this.#index}`);
  }

  /** SUBMIT (assembler): compose the final answer from the pooled results plus
   *  each agent's own resolution status. */
  composeAnswer(results: Record<string, string[]>): string {
    const shared = Object.entries(results)
      .map(([n, rs]) => `${n}->[${rs.join(', ')}]`)
      .join(' ');
    return `pod answer: resolved via shared discoveries ${shared}`;
  }

  /**
   * AGENTIC method (the async oo-agents seam, NOT on the pod's synchronous
   * critical path): a model condenses this agent's worklog into a one-line
   * status by WRITING CODE against `self` in the wasm sandbox. Present so the
   * composition is real in both directions — the OO agent keeps its code-as-
   * action capability while also serving as a radio PodAgent. Driven by the
   * usual Runtime + ScriptedDriver (see pod.test.ts).
   */
  summarize = agentic({
    doc: 'Return a one-line status: the agent name and how many worklog entries it posted.',
    params: {},
    returns: { type: 'string' },
  });
}

// ----------------------------------------------------------- the pod driver --

/**
 * The scripted/mock driver: the synchronous decision seam that mirrors, on the
 * pod's critical path, what a ModelDriver does on the agentic path — it CHOOSES
 * which capability to invoke. Here the only Execute-time choice is which unit to
 * explore next; keeping it a pluggable object lets a harness (or the flywheel)
 * evolve the exploration policy without touching the adapter or the agent.
 */
export interface PodDriver {
  /**
   * Choose the next unit for `agent` to explore, given its remaining units and
   * the mentions folded in at this step boundary. Return null to do no
   * exploration this step (e.g. nothing left, or a policy that yields).
   */
  chooseUnit(agent: string, remaining: number[], folded: FoldedMention[]): number | null;
}

/** Default driver: explore the region in order. Deterministic. */
export class SequentialPodDriver implements PodDriver {
  chooseUnit(_agent: string, remaining: number[], _folded: FoldedMention[]): number | null {
    return remaining.length > 0 ? remaining[0] : null;
  }
}

// -------------------------------------------------------------- the adapter --

/**
 * THE ADAPTER. Present an oo-agents `PodMemberAgent` as a radio `PodAgent`,
 * mapping each pod hook onto capability calls and worklog posts.
 *
 * Host-side note on WHY the hooks call capabilities directly: these hooks are
 * synchronous orchestration glue, invoked by runProtocol — the same layer the
 * Runtime itself occupies when it applies a capability. They reach the exact
 * methods the sandbox would reach via `self.method()`; the difference is only
 * that the host calls them directly instead of through a model-written cell.
 */
export function asPodAgent(member: PodMemberAgent, driver: PodDriver = new SequentialPodDriver()): PodAgent {
  const pod: PodAgent = {
    name: member.name,

    explore(step: number): string[] {
      member.logWork(`explore@step${step}`);
      return member.survey();
    },

    proposePartition(findings: Record<string, string[]>): Record<string, string[]> {
      return member.proposePlan(findings);
    },

    approvePartition(partition: Record<string, string[]>): boolean {
      return member.votePlan(partition);
    },

    executeStep(_sub: string[], folded: FoldedMention[]) {
      // 1) Passive awareness: fold teammate discoveries in FIRST (zero step
      //    cost in passive mode). A cross fact posted last round lands here.
      const gained = member.absorb(folded.map((f) => f.mention.content));
      if (gained.length > 0) member.logWork(`folded ${gained.length} fact(s): [${gained.join(', ')}]`);

      // 2) One unit of work — which unit is the driver's (scriptable) call.
      const unit = driver.chooseUnit(member.name, member.unexplored(), folded);
      const discoveries: { content: string; bearsOn?: string }[] = [];
      if (unit !== null) {
        const found = member.exploreUnit(unit);
        for (const f of found) {
          const owner = member.classify(f);
          // Own fact (or nobody's): held locally, nothing to share.
          if (owner === '' || owner === member.name) continue;
          // Silo control: the discovery exists but the agent withholds it.
          if (!member.shares()) continue;
          // Cross fact: emit it addressed to the owner. runProtocol posts it
          // @owner immediately in passive mode (non-blocking, zero step cost),
          // and records it into results for the Review broadcast in every mode.
          discoveries.push({ content: encodeFact(f), bearsOn: owner });
          member.logWork(`discovered fact ${f}; share @${owner}`);
        }
      }

      // Done once the region is fully explored — the agent has produced every
      // discovery it can. (Its OWN resolution may still await a teammate's fold,
      // which arrives at a later step boundary or the Review broadcast.)
      const done = member.unexplored().length === 0;
      return { discoveries, done };
    },

    review(results: Record<string, string[]>) {
      // Review is where withheld / cross discoveries surface (the blocking arm's
      // first delivery; in passive mode this is a free re-confirmation). Absorb
      // anything addressed to my sub-question, THEN judge — non-empty conflicts
      // reopen Execute per the protocol's rule.
      const all: string[] = [];
      for (const rs of Object.values(results)) all.push(...rs);
      const gained = member.absorb(all);
      if (gained.length > 0) member.logWork(`review folded ${gained.length} fact(s): [${gained.join(', ')}]`);
      const ok = member.resolved();
      return { approve: ok, conflicts: ok ? [] : [`${member.name}: unresolved (missing ${member.needs.filter((f) => !member.held.includes(f)).join(', ')})`] };
    },

    approveDraft(_draft: string): boolean {
      return member.resolved();
    },

    draft(results: Record<string, string[]>): string {
      return member.composeAnswer(results);
    },
  };
  return pod;
}

// ------------------------------------------------------------- pod assembly --

export interface BuildPodOptions {
  /** Per-agent share flag override (index-keyed); default all true. Set an
   *  entry false to silo that agent's cross discoveries (the failure control). */
  shareCrossFacts?: Record<number, boolean>;
  /** Driver shared by every member (default SequentialPodDriver). */
  driver?: PodDriver;
}

/** Materialize a pod from a task: one PodMemberAgent per sub-question, each
 *  wrapped as a radio PodAgent. Returns both views so tests can inspect the
 *  underlying agents' held facts and worklogs after a run. */
export function buildPod(
  task: PodTask,
  opts: BuildPodOptions = {},
): { pod: PodAgent[]; members: PodMemberAgent[] } {
  const driver = opts.driver ?? new SequentialPodDriver();
  const members: PodMemberAgent[] = task.names.map((name, i) => {
    const region = task.region[i];
    const unitFacts: Record<number, number[]> = {};
    for (const u of region) unitFacts[u] = task.unitFacts[u] ?? [];
    return new PodMemberAgent({
      name,
      index: i,
      names: task.names,
      region,
      unitFacts,
      needs: task.needs[i],
      factNeededBy: task.factNeededBy,
      shareCrossFacts: opts.shareCrossFacts?.[i] ?? true,
    });
  });
  const pod = members.map((m) => asPodAgent(m, driver));
  return { pod, members };
}

// ------------------------------------------------------------- run + example --

export interface RunPodOptions {
  /** 'passive' (default) or 'blocking' (the no-sharing ablation). */
  mode?: 'passive' | 'blocking';
  /** Per-agent silo overrides (see BuildPodOptions.shareCrossFacts). */
  shareCrossFacts?: Record<number, boolean>;
  /** Optional deterministic scatter of exploration order. */
  scatterSeed?: number;
}

export interface PodRun {
  result: ProtocolResult;
  /** True iff every sub-question's owner ended up holding all its facts. */
  resolved: boolean;
  /** The underlying agents, for inspecting held facts / worklogs. */
  members: PodMemberAgent[];
}

/**
 * Run one full pod episode over the passive-awareness bus and report both the
 * protocol result and whether the pod actually resolved (every member holds all
 * the facts its sub-question needs). Deterministic in its inputs.
 */
export function runPod(opts: RunPodOptions = {}): PodRun {
  const task = makePodTask(opts.scatterSeed);
  const { pod, members } = buildPod(task, { shareCrossFacts: opts.shareCrossFacts });
  const cfg: ProtocolConfig = {
    agents: pod,
    assembler: task.names[0],
    mode: opts.mode ?? 'passive',
  };
  const result = runProtocol(cfg);
  const resolved = members.every((m) => m.resolved());
  return { result, resolved, members };
}

/**
 * Worked example for docs (ADR-241/242): run the SAME 3-agent decomposition
 * under passive awareness and under the blocking no-sharing ablation, and
 * return a compact comparison. Passive resolves and spends strictly FEWER
 * foreground steps than blocking, which only receives the cross fact at Review
 * and pays one blockingReceive per agent.
 *
 * Returned shape is plain data so a docs page can render it directly.
 */
export function runPodExample(): {
  passive: { resolved: boolean; approved: boolean; steps: number; messages: number };
  blocking: { resolved: boolean; approved: boolean; steps: number; messages: number };
  silo: { resolved: boolean; approved: boolean; steps: number; messages: number };
  narrative: string;
} {
  const total = (r: ProtocolResult): number => Object.values(r.steps).reduce((n, s) => n + s, 0);

  const passive = runPod({ mode: 'passive' });
  const blocking = runPod({ mode: 'blocking' });
  // Silo: agent2 discovers the cross fact but withholds it — no channel ever
  // delivers it, so agent1 cannot resolve. "Visibility is not synthesis."
  const silo = runPod({ mode: 'passive', shareCrossFacts: { 2: false } });

  const summarize = (r: PodRun) => ({
    resolved: r.resolved,
    approved: r.result.approved,
    steps: total(r.result),
    messages: r.result.messages,
  });

  const p = summarize(passive);
  const b = summarize(blocking);
  const s = summarize(silo);
  const narrative =
    `Passive awareness resolves the pod in ${p.steps} steps (approved=${p.approved}): agent2's ` +
    `discovery of fact 3 folds into agent1's next execute step for free. The blocking ablation ` +
    `also resolves but in ${b.steps} steps (+${b.steps - p.steps}) — the cross fact surfaces only ` +
    `at Review, after each agent pays one foreground blockingReceive. With sharing switched off ` +
    `the silo fails (approved=${s.approved}): the fact is discovered but never posted, so no ` +
    `teammate can fold it in.`;

  return { passive: p, blocking: b, silo: s, narrative };
}
