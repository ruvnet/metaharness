# ADR-241: @metaharness/radio — passive-awareness swarm bus (AgentRadio)

**Status**: Accepted (core + protocol + deterministic sim shipped, $0; live pod wiring deferred)
**Date**: 2026-08-08
**Project**: `ruvnet/metaharness`
**Related**: ADR-004 (host integration), ADR-022 (MCP primitive), ADR-073 (darwin archive & selection), ADR-234/235/236 (flywheel macro-loop + re-executing verifiers), ADR-240 (AGNTCY — the agent NETWORK layer; radio is the intra-pod COMMS layer)
**Source**: *AgentRadio: Passive Awareness for Long-Horizon Multi-Agent Collaboration* — Ren, Zang, Wang, Forder, Deb, Carroll, Guo. [arXiv:2607.28430](https://arxiv.org/abs/2607.28430)

> MetaHarness pods (vertical:agentics — orchestrator → planner → workers → critic
> over a swarm-bus MCP) coordinate today at **phase boundaries**: a worker's
> mid-task discovery reaches its teammates only when its phase ends. AgentRadio
> shows that is the single largest recoverable loss in long-horizon multi-agent
> work, and that recovering it needs no smarter model — only a different
> **communication mode**. Freeze the model, evolve the comms policy.

## Context

The paper's result, on long-horizon codebase QnA (SWE-Atlas, 124 tasks / 1,306
rubrics): four agents at 62.1% vs 32.3% for a single agent of the same model —
and, decisive for us, a clean **ablation of where the lift lives**:

| Layer | Adds | Gain |
|---|---|---|
| L1 — naive division of labor | partition only | +7.2 pts |
| L2 — + negotiated partition | joint exploration, agents approve the split | +12.1 pts (largest single layer) |
| L3 — + passive awareness | mid-execution sharing, folded in at step boundaries | +10.5 pts (p = 0.0023) |

The L3 mechanism is one primitive: **`wait_for_mention` backgrounded as an
OS-level task, not an LLM step**. Under blocking receive, listening consumes a
foreground step — communication and work are mutually exclusive, so nobody
listens mid-task and discoveries stay silent until the next phase. Backgrounded,
an @-mention is surfaced at the next **step boundary** (between tool
invocations, never interrupting a running command) together with a **full
thread snapshot**; sends are non-blocking. An agent's visible set M(t) is every
message sent before step t, at zero step cost.

This maps directly onto surfaces we already ship: the agentics vertical's
swarm-bus, the kernel federation transport (`examples/federation`), and the
Workflow-style pods our own swarm runs use — all of which are phase-barrier
synchronized today.

The paper is equally clear about what passive awareness does NOT do, and this
ADR keeps those bounds visible:

- **Mentions can derail.** The passive layer gained 47 rubrics and *lost* 23 —
  a mid-execution message can pull an agent off a passing line of reasoning.
  Net-positive, not free.
- **No conception → no gain.** Awareness cannot surface a conclusion no agent
  forms (the paper's Grafana case): it moves information, not insight.
- The paper ships **no relevance filter** — full snapshots, agent-interpreted
  relevance. Filtering/digest cadence is therefore an open POLICY surface, which
  is exactly the kind of lever this repo evolves rather than hand-tunes.

## Decision

Ship **`@metaharness/radio`** — a dependency-free, deterministic TypeScript
implementation of the AgentRadio primitives and protocol, plus a measured
flywheel over its policy levers:

1. **`RadioBus`** (`src/bus.ts`) — threads, **non-blocking** `send` with
   @-mentions, total order via a logical `seq` clock (no wall clock → replayable
   bit-for-bit), full-snapshot reads. `create_thread`/`send_message` per the
   paper; a send never blocks or fails on missing setup.
2. **`Watcher`** (`src/watcher.ts`) — passive awareness as pull-at-boundary
   bookkeeping: `fold()` surfaces every mention since the last fold, each with
   its full thread snapshot, and **costs no step**; `blockingReceive()` is the
   same visibility but the caller must account one foreground step — the two
   accounting modes are separate methods so a protocol cannot silently mix
   them. This is the paper's critical distinction made type-visible.
3. **Five-phase protocol driver** (`src/protocol.ts`) — Explore (watchers up,
   nothing sent) → Divide (assembler-gated negotiation to an approved
   partition) → Execute (passive: discoveries that bear on a teammate's
   sub-question / contradict the plan / block an approach are posted
   immediately; blocking: no live sharing) → Review (conflicts can reopen
   Execute) → Submit (unanimous approval), generic over scripted `PodAgent`
   hooks.
4. **Deterministic swarm simulation** (`src/sim.ts`) — a synthetic
   codebase-QnA task family (sub-questions, facts scattered across units,
   a configurable **cross-partition fact fraction** — the thing communication
   pays for) with scripted agents in four modes (`single`/`divide`/
   `negotiate`/`passive`). Seeded, replayable; its headline property is
   reproducing the paper's ablation ORDER: passive < negotiate ≤ divide <
   single in foreground steps-to-resolve.
5. **Flywheel over comms policy** (`scripts/flywheel-radio.mjs`) — evolves
   {mode, foldEvery, postPolicy} from a deliberately bad root
   (divide/fold-every-4/silent) under the frozen conjunctive gate with a
   never-optimized-against anchor topology, Ed25519-signed lineage,
   `verifyReplayBundle` required. Uses `cacheEvaluations` (ADR-235-adjacent
   flywheel feature) since the sim is deterministic. The wheel re-discovering
   passive/immediate/fold-every-1 is the package's measured, replayable
   restatement of the paper's ablation direction — on our own machinery.

### What this is NOT (bounded claims, ADR-236 discipline)

- The sim is a **mechanism testbed**, not a benchmark claim. It demonstrates
  the ordering and gives the flywheel a real, deterministic landscape; it does
  not claim SWE-Atlas numbers. A live pod run (real LLM agents over radio in a
  generated harness) is the deferred next increment, and its cost/beneﬁt gets
  its own measured ADR before any host wiring defaults on.
- Radio is intra-pod comms. It does not replace the swarm-bus MCP surface
  (ADR-022 governs tool exposure) or AGNTCY's network layer (ADR-240); a
  radio thread is a candidate SLIM/transport payload, not a competitor.
- Derailment is real (47/23 gross/net in the paper). The protocol driver keeps
  fold-cadence a lever precisely so the flywheel can price it instead of us
  asserting it.

## Consequences

- Pods gain a tested, deterministic comms layer whose semantics match the
  strongest published result on long-horizon multi-agent collaboration, with
  the blocking arm preserved as an ablation control.
- The comms POLICY joins the genome: darwin/flywheel can evolve fold cadence,
  post policy, and mode per vertical, with promotions gated and replayable
  (ADR-234/235 discipline) instead of hand-tuned.
- Full-snapshot semantics are kept (paper-faithful) even though they will not
  scale to very long threads; digest/relevance filtering is explicitly future
  policy work — to be EVOLVED under the same gate, not designed by fiat.
