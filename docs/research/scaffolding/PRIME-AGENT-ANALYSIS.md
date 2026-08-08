# Prime Agent (Prime Intellect) — Mechanics, Gap Map, and Integration Verdicts

**Date:** 2026-08-06
**Updated:** 2026-08-06 — corrected goal, heartbeat, prompt, subagent, and MCP
surfaces against Prime Agent 0.7.0 after the initial integration review.
**Purpose:** Ground-truth analysis of Prime Intellect's Prime Agent harness — what it actually does,
verified against its repository docs — and a concept-by-concept gap map against what MetaHarness
already ships, so the integration ADRs ([ADR-246](../../adrs/ADR-246-prime-agent-continual-harness-refine.md),
[ADR-247](../../adrs/ADR-247-host-prime-agent.md)) adopt only what is genuinely new and cite only
what is genuinely measured.
**Sources:**
- Announcement: <https://www.primeintellect.ai/blog/prime-agent>
- Repository (MIT): <https://github.com/PrimeIntellect-ai/prime-agent> — docs under
  `packages/coding-agent/docs/` (`skills.md`, `architecture.md`, `long-running-agents.md`,
  `rlm.md`, `providers.md`)
- Installer: `https://app.primeintellect.ai/prime-agent/install.sh` (npm global package,
  Node ≥ 20.6, optional uv + Python 3.11 + ipykernel bootstrap, SHA-256-verified tarballs)
- RL-training sibling: <https://github.com/PrimeIntellect-ai/rlm-harness>

**Ground state (what MetaHarness already has, so this doc doesn't re-invent it):** Darwin Mode
population evolution behind a frozen promotion gate (ADR-070…081; pluggable `CodeGenerator` mutator
in `packages/darwin-mode/src/mutator.ts` that already receives `failedTraces`); the flywheel
promotion loop with signed lineage, receipts, and replay (`packages/flywheel`); HarnessSpec
declarative policy with budgets/guards/rollback (ADR-159, `packages/projects/src/harness-spec.ts`);
the algorithmic control plane (ADR-047); ten host adapters incl. `host-pi-dev`
(ADR-004/032/033/036/044); AGNTCY identity + A2A-adjacent federation (ADR-240); the manual
autonomous-loop practice in `docs/LOOP_WORKER.md`; and two load-bearing measured nulls — ADR-226
(read-only advisor produced zero marginal lift at 5.4× cost: *advice does not transfer; standing
policy does*) and ADR-234/237 (random-perturbation compounding produced honest nulls).

A repo-wide search finds **zero existing references** to Prime Agent or RLM-as-designed here —
this is greenfield analysis, the same situation ADR-240 faced with AGNTCY.

---

## 1. What Prime Agent is

Prime Agent is an open-source (MIT) coding and long-running-autonomy harness from Prime Intellect,
a TypeScript/Node multi-package monorepo built **atop the `pi` framework** (badlogic `pi-mono` —
the same coding-agent lineage MetaHarness already targets with `packages/host-pi-dev`; Prime Agent
even honors `pi.skills` entries in `package.json`). It runs each root session in a recoverable
worker process under a background daemon, and executes model-generated Python in a persistent
IPython kernel at user permission level.

Its self-description rests on two abstractions:

1. **RLM (Recursive Language Model)** — the harness exposes exactly one tool: a persistent
   IPython kernel. Everything else — file edits, shell, sub-agents — is Python the model writes.
2. **Continual Harness** — prompts, memories, skills, and sub-agent specifications are durable,
   on-disk state the agent itself can create, read, update, and delete during execution, and that
   a dedicated `/refine` pipeline edits from trajectory evidence.

## 2. RLM / Programmatic Tool Calling (PTC)

- The IPython kernel is the **only** tool schema the model sees. Tool use is "write Python",
  not "emit a JSON tool call". The blog calls this Programmatic Tool Calling.
- **Context as a variable**: the model can programmatically address its own history, tools, and
  sub-agents as Python objects rather than re-reading them through the prompt.
- **Sub-agents as function calls**: `await rlm(...)` spawns a child agent as a full independent
  session; results return as Python values. Parallel spawning and mid-flight steering are
  supported. Compaction summarizes conversational context while **preserving IPython kernel
  state**, so long tasks keep their working variables even as the transcript shrinks.
- Claimed payoff: token efficiency (intermediate results stay in the kernel instead of
  round-tripping through the context window) and expressiveness (control flow in Python, not in
  the model's head).

## 3. The Continual Harness (verified on-disk surface)

Verified from `packages/coding-agent/docs/skills.md`:

- **Skill discovery order** (highest precedence first): user (`~/.prime/agent/skills/`,
  `~/.agents/skills/`) → project (`.prime/agent/skills/`, `.agents/skills/`) → package
  (`skills/` dirs and `pi.skills` entries in `package.json`) → CLI (repeatable `--skill <path>`)
  → built-in. A settings-level `skills` array also exists.
- **A skill is a directory with a `SKILL.md`** carrying YAML frontmatter:
  - `name` — lowercase, `a-z`, `0-9`, hyphens only
  - `description` — ≤ 1024 chars
  - optional `license`, `compatibility`, `disable-model-invocation`
- **Python-backed skills** add `pyproject.toml` + `src/<pkg>/__init__.py` and are importable
  inside the kernel — skills are executable packages, not prompt snippets.
- Supplemental prompts, memories, and reusable sub-agent specs live alongside as durable state
  the agent can CRUD; a built-in creator converts recurring workflows into new skills.

## 4. Daemon, sessions, and recovery

Verified from `architecture.md` / `long-running-agents.md`:

- A background **daemon** manages all live sessions over a local socket; terminals detach and
  reattach (`prime-agent agents`, `prime-agent attach <agent>`, `prime-agent status`,
  `prime-agent doctor [--fix]`, `prime-agent shutdown [--force]`).
- Each root session is a **recoverable worker**: transcripts persist as **append-only JSONL**
  plus feature-specific state under a session artifact directory, and workers restore from JSONL
  logs + kernel snapshots after crashes.
- Session history supports **branching, forking, and cloning** (`/tree`); `--resume <path|id>`
  restores saved sessions.

## 5. `/refine` — evidence-backed self-improvement

- The refinement pipeline analyzes agent **trajectories** and applies **small, targeted CRUD
  edits** to prompts, skills, or memories — explicitly *not* wholesale rewrites and *not*
  population-based search.
- Edits are **evidence-backed** (justified from specific trajectory observations) and
  **rollback-capable**: refinement history is recorded so changes can be reverted.

## 6. Autonomous mode, goals, and scheduling

- `prime-agent --autonomous --autonomous-gate "npm run check" --autonomous-max-turns 20 --goal "<objective>" --goal-token-budget 200000`
  — unattended execution bounded by **turn, token, and time budgets**, with a user-defined
  **quality gate** command that must pass. Reaching a limit does not imply success.
- Persistent goals use `--goal` plus the optional `--goal-token-budget`; goals are separate from autonomous continuation policy.
- Current scheduling surfaces include:

  | Surface | Owner | Purpose |
  |---|---|---|
  | `prime-agent schedule` | CLI | cron/one-shot timed execution |

## 7. A2A messaging and persistent sub-agents

- Agent-to-agent messaging goes through an `agent_message` Python skill with delivery modes
  `auto` / `steer` / `follow_up`; parents, siblings, and children coordinate without user routing.
- Sub-agents can be **persistent**: a stable identifier keeps a sub-agent's session directory,
  context, kernel, and history alive after the spawning call returns, and retained sub-agents can
  discover and message one another across sessions.

## 8. Results and caveats (honest reading)

- **ARC-AGI-3**: 95.5% RHAE Best@1 with Opus 5 — above the 95.4% human-expert baseline — using
  fewer tokens than competing harnesses. Competitive-or-better on OOLONG, OBLIQ-Bench,
  LongBenchPro, ManyIH vs. Claude Code and Codex; strong showings on EmulatorBench, PMPP-Hard,
  MazeBench.
- **Reward hacking observed**: on Factorio the agent found scoring exploits — the harness gives
  capability, not alignment of the metric.
- **No sandbox**: the repo's own security note says worker/kernel processes "aren't sandboxes";
  untrusted code requires external sandboxing. This matters directly for ADR-247's fail-closed
  posture (MetaHarness's MCP layer is default-deny per ADR-022).
- **Co-training headroom is speculative**: "currently no model has been trained around Prime
  Agent" — reported numbers are with off-the-shelf models; the projected further gains are a
  forecast, not a measurement.

## 9. Gap map: Prime Agent concept → MetaHarness state → verdict

| Prime Agent concept | What MetaHarness already has | Verdict | Why |
|---|---|---|---|
| `/refine` — trajectory-driven, evidence-backed CRUD edits with rollback | Darwin population mutation (ADR-070…081) behind a frozen gate; pluggable `CodeGenerator` already fed `failedTraces`; GEPA reflective offline evolution (ADR-228); flywheel lineage/receipts | **Adopt — headline** (ADR-246 §2.1) | It is precisely the lever our own nulls point at: ADR-226 proved *standing policy*, not advice, transfers; ADR-234/237 showed blind perturbation compounding at ~zero. A refine-style proposer targets the parent's actual failures with a minimal, evidenced, reversible edit — a **proposer** upgrade that leaves the frozen promotion gate untouched. |
| Autonomous mode: goals, heartbeats, gates, budgets | `docs/LOOP_WORKER.md` — the same practice done **by hand**; HarnessSpec already has `budgets` + `guards` (ADR-159) | **Adopt** (ADR-246 §2.2) | Codify the manual practice as first-class HarnessSpec fields (`goal`, `heartbeat`, `gateCommand`, `maxTurns`) that every host adapter can project. |
| Recoverable JSONL sessions, branch/fork/resume | flywheel `replay.ts`/receipts (loop-level), HarnessSpec `rollback`, jujutsu dual-state (ADR-202) | **Adapt — narrow** (ADR-246 §2.3) | The new piece is a crash-recoverable, forkable **session log as a generated-harness scaffold primitive**; everything else exists at other layers. |
| Prime Agent as a runtime for generated harnesses | 10 host adapters; `host-pi-dev` is the direct sibling (shared pi lineage, `pi.skills` compat) | **Adopt — own ADR** (ADR-247) | Cheapest, most concrete win; config surface verified in §3. Per-host ADR precedent: ADR-032/033/036. Must fail closed on `permissions.deny` (§8: no sandbox). |
| RLM / PTC — kernel as the only tool | JSON-schema tool model across kernel + MCP gating (ADR-002/022) and the algorithmic control plane (ADR-047) | **Defer — experiment-gated** (ADR-246 §2.4) | An architectural inversion. The token-efficiency claim is credible but third-party; pre-register an A/B on `packages/evals-toolcall` and adopt only on a measured win. Reward-hacking + no-sandbox caveats reinforce caution. |
| A2A messaging, persistent sub-agent IDs | ADR-240 (AGNTCY identity, DIDs, directory) + companion ruflo ADR-380 (runtime coordination) | **Decline — cross-reference** (ADR-246 §2.5) | Already an owned decision; Prime Agent's stable sub-agent IDs map onto ADR-240 identity subjects. Duplicating it would fork a live decision. |

## 10. Recommendations

Proceed per the two ADRs this analysis feeds:

- **[ADR-246](../../adrs/ADR-246-prime-agent-continual-harness-refine.md)** — RefineMutator for
  Darwin/flywheel; autonomous fields on HarnessSpec; recoverable-session scaffold primitive; PTC
  deferred behind a pre-registered experiment; A2A declined.
- **[ADR-247](../../adrs/ADR-247-host-prime-agent.md)** — `@metaharness/host-prime-agent`, the
  11th host adapter, fail-closed on permissions.

Both ADRs shipped 2026-08-06 on this branch (ADR-246 §2.4 PTC remains deferred by design).
