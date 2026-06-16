// SPDX-License-Identifier: MIT
//
// Agent pool (ADR-047): agents are specialised, replaceable workers — not
// sovereign actors. The pool selects a worker per step via a UCB1 contextual
// bandit and applies an online reward update after verification, so routing
// improves run-over-run (the ADR-014 learning loop, scoped to worker selection).

import type { AgentSpec } from './types.js';

interface Stats {
  /** Times this agent has been pulled. */
  pulls: number;
  /** Running mean reward, 0..1. */
  mean: number;
}

export interface SelectionOptions {
  /** UCB exploration constant; higher explores more (default √2). */
  explore?: number;
  /** Optional RNG for tie-breaking/seeding (default Math.random). */
  rng?: () => number;
}

/**
 * A pool of agents with bandit selection + online learning. Selection is by step
 * kind: only agents that `handle` the kind compete, and the UCB1 score balances
 * exploitation (high mean reward) against exploration (rarely-tried agents).
 */
export class AgentPool {
  private readonly agents = new Map<string, AgentSpec>();
  private readonly stats = new Map<string, Stats>();
  private totalPulls = 0;
  private readonly explore: number;
  private readonly rng: () => number;

  constructor(agents: AgentSpec[] = [], opts: SelectionOptions = {}) {
    for (const a of agents) this.register(a);
    this.explore = opts.explore ?? Math.SQRT2;
    this.rng = opts.rng ?? Math.random;
  }

  register(agent: AgentSpec): this {
    this.agents.set(agent.id, agent);
    if (!this.stats.has(agent.id)) this.stats.set(agent.id, { pulls: 0, mean: 0 });
    return this;
  }

  get(id: string): AgentSpec | undefined {
    return this.agents.get(id);
  }

  /** Agents that can handle a step kind. */
  candidates(kind: string): AgentSpec[] {
    return [...this.agents.values()].filter((a) => a.handles.includes(kind));
  }

  /**
   * Select an agent for a step kind via UCB1. An agent that has never been pulled
   * has infinite UCB, so every candidate is tried once before exploitation begins.
   */
  select(kind: string): AgentSpec {
    const candidates = this.candidates(kind);
    if (!candidates.length) throw new Error(`no agent handles step kind "${kind}"`);
    let best: AgentSpec | undefined;
    let bestScore = -Infinity;
    for (const a of candidates) {
      const s = this.stats.get(a.id)!;
      const ucb = s.pulls === 0
        ? Infinity
        : s.mean + this.explore * Math.sqrt(Math.log(this.totalPulls + 1) / s.pulls);
      // Deterministic-ish tie break with a tiny rng jitter.
      const score = ucb + (ucb === Infinity ? 0 : this.rng() * 1e-9);
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return best!;
  }

  /** Online reward update: fold a 0..1 reward into the agent's running mean. */
  update(agentId: string, reward: number): void {
    const s = this.stats.get(agentId);
    if (!s) return;
    const r = Math.max(0, Math.min(1, reward));
    s.pulls += 1;
    this.totalPulls += 1;
    s.mean += (r - s.mean) / s.pulls;
  }

  /** Snapshot of learned stats (for receipts / debugging). */
  snapshot(): Record<string, Stats> {
    return Object.fromEntries([...this.stats.entries()].map(([k, v]) => [k, { ...v }]));
  }
}
