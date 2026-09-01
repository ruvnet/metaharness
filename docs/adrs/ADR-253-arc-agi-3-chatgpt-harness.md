# ADR-253: Experimental ARC-AGI-3 controller and ChatGPT Developer Mode adapter

**Status**: Implemented experimentally (deterministic mechanism tests required; official public scorecard pending)
**Date**: 2026-08-21
**Project**: `ruvnet/metaharness`
**Related**: ADR-022 (MCP boundary), ADR-245 (Horizon), ADR-250 (proof ladder), ADR-251 (`@metaharness/avo`)

## Context

ARC-AGI-3 is an interactive benchmark of unknown 2D games. An agent receives
pixels, the legal action set, progress, and terminal state, but no game
instructions. The benchmark charges environment mutations rather than internal
reasoning calls. Long-lived exact state, falsifiable experiments, and recovery
from a wrong model are therefore harness concerns rather than prompt decoration.

NVIDIA reports a 100.00 RHAE result on the 25-game public set using Claude Opus
5, persistent memory, a supervisor, and an executable world model. The same
article reports 30% for a direct model condition but explicitly says this was
not a controlled ablation. It does not establish a result on the semi-private
or private sets. Separately, Tycho reports 100.00 public RHAE with GPT-5.6 Sol,
showing that an OpenAI model is sufficient when paired with a strong controller.

The requested transport is ChatGPT itself, not the OpenAI API. ChatGPT Developer
Mode can connect to a remote MCP server and render MCP Apps resources. This lets
the user's selected ChatGPT model reason while MetaHarness remains authoritative
for environment state, memory, policy, receipts, and supervision.

## Decision

Add two private experimental packages:

1. `@metaharness/arc-agi-3` is a provider-neutral episode controller.
2. `@metaharness/arc-agi-3-chatgpt` is a remote MCP server and MCP Apps canvas
   for ChatGPT Developer Mode.

The adapter has no OpenAI SDK dependency and never reads `OPENAI_API_KEY`.
ChatGPT invokes tools; the server does not call a model. A later reproducible
runner may use the Responses API, but that is a separate transport and must be
reported as a separate experimental condition.

This work does not modify ADR-251. ARC remains outside the AVO ship gate, the
packages do not import `GovernedVariationOperator`, and no AVO-class claim is
permitted from this implementation.

## Authority and data flow

```text
ChatGPT actor -> MCP policy -> ARC controller -> official ARC Python SDK
                       |              |                  |
                       |              +-> memory/graph   +-> scorecard
                       +-> audit       +-> receipt chain
                                      +-> supervisor
```

The frame returned by the environment is the only authoritative observation.
The canvas is a view, never an observation source. Every data tool returns a
canonical exact state in `structuredContent`.

The official Python SDK is wrapped through a bounded JSON-line subprocess. It
owns scorecard and game session cookies. The TypeScript side never reimplements
the ARC HTTP protocol. Online mode sets `ARC_BASE_URL` to the official API
origin `https://three.arcprize.org`. The bridge accepts only the remote
`online` and `competition` operation modes. It refuses the SDK's local-code
`normal` and `offline` modes,
which can download and execute game source. Before a credential crosses the
process boundary, both sides require an HTTPS origin with no credentials, path,
query, or fragment and an exact operator allowlisted hostname. The evaluated
default follows the official API reference at `https://three.arcprize.org`, and
the default allowlist contains only `three.arcprize.org`.

The official evidence factory is stricter than the general bridge: it forces
`competition` mode and requires the closed upstream scorecard to report
`competition_mode: true`. Online mode remains available for non-claiming
interactive experiments but cannot produce accepted official evidence.

The reproduction dependency pair is pinned in
`packages/arc-agi-3/python/requirements.txt` to `arc-agi==0.9.8` and
`arcengine==0.9.3`, matching the official benchmark lock. A different SDK pair
is a different experimental condition and must receive a distinct environment
adapter version in the frozen run manifest.

The official factory freezes a private assignment queue before it creates the
bridge or scorecard. It validates configuration first, admits exactly one active
assignment, and advances only after a win or explicit operator approval. A
failed remote start cannot silently consume or skip an assignment. A direct
factory caller must approve a diagnostic retry. In the MCP path, a failure
before `arc_start` returns is automatically released to the same queue index
because its generated episode handle was never exposed. Any failed attempt
makes that factory and scorecard ineligible for accepted evidence; an accepted
rerun requires a new factory and scorecard. The model can neither select nor
observe a game identifier.

## Environment contract

Each observation preserves:

* every animation frame, in order;
* the exact grid values from 0 through 15;
* `guid`, `full_reset`, state, level progress, and win level count;
* every offered action, including `ACTION7`;
* the action input that produced the observation.

The current frame is encoded as exact hexadecimal rows. Its `frameHash` binds
the encoding, dimensions, and rows, while `frameRef` also names the frame
index. The enclosing `observationHash` binds the opaque game scope, state,
completed and winning level counts, offered action set, and current frame hash.
An action must carry that hash as a compare-and-swap guard. Stale calls fail
without touching the environment.

Only offered actions are legal. `ACTION6` requires integer `x` and `y` values
from 0 through 63. After `GAME_OVER`, only `RESET` is legal. Malformed model
output never selects a random fallback action. Reasoning metadata is structured,
contains no private chain of thought, and is capped at 16,000 JSON bytes.

## Memory and belief state

Controller checkpoints retain only structured evidence:

* episodes linked to immutable transition receipts;
* versioned semantic rules with supporting and contradicting evidence;
* belief nodes and observed outcome partitions;
* supervisor cases and committed directives;
* the exact observation, budgets, idempotency ledger, and adapter checkpoint.

Guarded plans execute transiently and require a postcondition after every
action. Their transitions persist through receipts and episodes; this version
does not claim a stored macro library or a separate continuation-capsule type.

States are not merged solely because their grids match. A belief key includes
the exact observation hash, level progress, offered actions, and recent relevant
action-effect context. If one action from an apparently identical state yields
different outcomes, the controller splits the belief state.

Every environment transition is chained by including the preceding receipt hash
inside the canonical receipt body:

```text
receiptBody[t].previousReceiptHash = h[t-1]
h[t] = SHA256(canonicalJSON(receiptBody[t]))
```

The receipt binds the pre- and post-frame hashes, request, action, every returned
frame reference, exact delta, progress, prediction error, idempotency key, model
label reported by the UI, prompt snapshot, and memory snapshot.

Hash-chain integrity does not prove completeness. The official controller writes
an action intent before each mutation and a transition event after it to a mode
`0600` append-only SessionLog. An accepted official result also requires an
operator-supplied append-only or WORM evidence service to anchor every event.
Finalization independently reads that service and requires its receipt head,
event count, and durable SessionLog state hash to match the closed scorecard and
controller. A head copied from the controller at finalization is not accepted as
independent evidence. Any failed transition journal or anchor write increments
the uncertain-mutation count and makes reconciliation fail closed.

## Supervisor

The supervisor cannot call environment actions. It returns a typed directive
that constrains the actor. Initial deterministic triggers are:

| Trigger | Threshold | Intervention |
|---|---:|---|
| No progress or new belief node | 8 actions | Require a discriminating test |
| Same belief and action | 2 occurrences | Prohibit the repeated edge |
| No-effect actions | 3 of the last 6 | Reconstruct action semantics |
| Mean prediction error | Greater than 0.35 across 5 actions | Demote contradicted rules |
| Cycle in one component | More than 6 actions | Select an unvisited frontier |
| Ineffective coordinate probes | 8 actions | Switch to component or quadtree candidates |
| Guarded plan mismatch | First divergence | Stop the plan immediately |
| Game over | Immediate | Consolidate failure before reset |

Long verified sequences are not stagnation when each expected guard passes.

## MCP surface

The ChatGPT adapter exposes:

| Tool | Effect |
|---|---|
| `arc_start` | Create a principal-scoped episode and return its exact initial observation |
| `arc_observe` | Read the authoritative current observation, status, and active directive |
| `arc_act` | Apply one legal compare-and-swap action with an idempotency key |
| `arc_supervise` | Open a deterministic case for separate boss-lane diagnosis and directive commit |
| `arc_checkpoint` | Persist the current canonical state |
| `arc_resume` | Resume an explicit checkpoint whose expected hash also matches |
| `arc_status` | Read budgets, progress, and terminal state |
| `arc_receipts_verify` | Replay the transition receipt chain |
| `arc_render` | Render the current state in the MCP Apps canvas |

Only `arc_render` is linked to the UI resource. Mutating tools do not claim the
MCP `readOnlyHint`. Episode IDs are unpredictable and scoped to an authenticated
principal.

## Security boundary

The server permits loopback binds only. Remote deployment places an HTTPS
tunnel or reverse proxy in front of that loopback listener and requires an
authenticated principal. ChatGPT remote deployment uses OAuth 2.1 authorization
code flow with PKCE `S256`, a resource parameter, protected-resource metadata,
and separate `arc.actor` and `arc.boss` scopes. An external authorization server
owns login and consent. The injected access-token verifier must validate
signature or introspection, issuer, resource audience, expiry, not-before time,
revocation policy, and scope. It receives an AbortSignal and runs behind a hard
deadline, a global cap that retains slots for verifiers that ignore cancellation,
and a bounded pre-authentication rate limiter. The development bearer mode is
limited to local inspection or a trusted proxy that securely injects headers.

The MCP boundary is default-deny, request-size bounded, timeout bounded, and
audited. Environment actions serialize per episode. The Python executable and
bridge path are passed to `spawn` without a shell. Game IDs, paths, coordinates,
reasoning metadata, and checkpoint identifiers are validated before use.

The main residual risks are session theft, prompt injection through untrusted
metadata, subprocess drift from the pinned SDK, accidental transfer of
game-specific memory, and UI model routing changes. Mitigations are principal
isolation, opaque game scopes, exact SDK model validation, game-version memory
namespaces, fixed prompts, and explicit reporting of the visible UI model label.

## Measurement and claim boundary

ARC level scoring is:

```text
level_score = min(1.15, (human_actions / agent_actions)^2)
```

Later levels receive more weight and incomplete levels score zero. Internal
ChatGPT turns, memory operations, and supervisor deliberation do not count as
environment actions.

The public reproduction gate is frozen by the official factory before a run,
included explicitly in final evidence, and cannot be weakened at finalization.
It requires one frozen configuration, one official closed competition-mode
scorecard, all 25 public games, all 183 levels, 100.00 RHAE, zero unreceipted
actions, no per-game prompt edits, a valid receipt chain, balanced durable action
intents and transitions, zero uncertain mutations, and matching independently
anchored evidence. The official SDK's per-run action total includes RESET, so
reconciliation subtracts RESET before comparing non-reset receipts and then
compares RESET separately. Until that gate passes, the implementation is a
custom community harness with no score claim. Generalization requires the same
frozen controller on an unseen evaluation set.

The ablation sequence is direct actor, lossless history, episodic memory,
semantic memory, belief graph, supervisor, guarded plans, and optional world
model. Report paired per-game score, completion, actions, resets, repeated
edges, no-effect actions, model turns, wall time, supervisor yield, and receipt
completeness. ChatGPT UI and API transports are never combined in one result.

The largest reproducibility limitation is that the MCP server cannot prove or
pin the exact ChatGPT model selected by the user interface. The UI model label
and prompt hash are evidence, not cryptographic attestation. A fixed-model
benchmark requires a separate pinned API runner.

There is also a narrower recovery boundary. Controller memory, receipts, and
checkpoint files survive ChatGPT context rotation and MCP reconnection. The
current official online SDK does not expose a supported way to recreate a live
remote `guid` plus cookie session after the owning Python process dies. Exact
environment resume therefore requires the bridge process to remain alive or an
environment adapter that implements `resume`; full online process-crash recovery
is not claimed. A normal shutdown still closes every owned scorecard.

## References

* [ARC-AGI-3 methodology](https://docs.arcprize.org/methodology)
* [ARC-AGI-3 game API](https://docs.arcprize.org/api-reference/games/list-available-games)
* [ARC-AGI Toolkit](https://github.com/arcprize/ARC-AGI)
* [NVIDIA public-set AVO result](https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/)
* [Tycho public-set results](https://github.com/NIMI-research/Tycho)
* [ChatGPT Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode)
* [MCP Apps UI resources](https://developers.openai.com/plugins/build/chatgpt-ui)
