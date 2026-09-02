# `@metaharness/arc-agi-3-chatgpt`

Experimental ChatGPT Developer Mode interface for the provider-neutral `@metaharness/arc-agi-3` controller. ChatGPT supplies the OpenAI reasoning model and invokes the harness through remote MCP. This package does not call the OpenAI API, does not depend on the OpenAI SDK, and does not require `OPENAI_API_KEY`.

This package is private and experimental. It does not amend the ARC deferral or benchmark-claim boundary in ADR-251. A successful interactive run is not a reproducible benchmark score without a frozen task set, model configuration, budgets, prompts, receipts, and independent replay.

## Surfaces

| Route | ChatGPT conversation | Capabilities |
|---|---|---|
| `/mcp` | Actor | Legacy tools, or the opt-in AVO candidate/context surface, plus checkpointing, receipt verification, and canvas |
| `/mcp/boss` | Boss supervisor | Evidence case read and typed directive commit only |

The boss route does not register `arc_act`, `arc_start`, `arc_resume`, or the guarded-plan tool. Its runtime authority is a frozen wrapper without environment action methods.

### Opt-in AVO actor mode

Pass `avo: { arm: 'AVO_FULL' }` to `startArcMcpServer`, or set `ARC_MCP_AVO_ARM=AVO_FULL` when using the CLI. The server resolves and freezes the selected core profile before accepting requests. In this mode, the actor route registers only:

* `arc_start`
* `arc_avo_context`
* `arc_avo_step`
* `arc_checkpoint` and `arc_resume`
* `arc_status` and `arc_receipts_verify`
* `arc_render`

It does not register `arc_act`, `arc_observe`, `arc_supervise`, `arc_execute_guarded_plan`, or direct memory mutation/query tools. Memory, frontier, lineage, outcomes, and optional retrodictions are read through `arc_avo_context`. `arc_avo_step` accepts at most eight strict candidate plans and never accepts a model-supplied numeric utility. The core snapshots untrusted candidate input before asynchronous work, validates its current observation and lineage bindings, computes utility from evidence, selects a candidate, and dispatches guarded actions. Candidate order is retained as an auditable ordinal preference and is used only after an exact tie in evidence-derived utility and plan length.

`AVO_FULL` is the NVIDIA-inspired structural profile for memory, lineage, selection, and blocking supervision. It is an independent implementation, not NVIDIA's AVO code or a claim of behavioral equivalence. `AVO_FULL_RETRODICTION` is a separate experimental extension with automated evidence retrodiction; results from those arms must not be conflated. Named profiles cannot override individual feature flags.

Only `arc_render` links to the MCP Apps resource. Every data tool returns authoritative JSON in `structuredContent`; the responsive Canvas widget draws exact `hex_rows_v1` cells and never calculates state or score. It uses the standard MCP Apps `ui/*` postMessage protocol, supports inline, fullscreen, and picture-in-picture display modes, and loads no external scripts.

## Hidden assignment boundary

`arc_start` accepts only an idempotency key. It accepts and returns no game identifier, title, version, or assignment selector. The injected `ArcControllerFactory` closes over the operator-selected assignment and receives only:

```ts
{
  principalId: string;
  episodeId: string;
  runId: string;
  requestedSupervisionGate?: 'OFF' | 'BLOCKING';
}
```

The optional gate is a frozen public policy request, not game identity. The model sees only the controller's opaque game scope and exact visible observation. Tool errors, audit entries, checkpoint paths, and principal directories are sanitized or hashed so a bridge or factory error cannot reveal the hidden assignment.

## Official controller factory

Create an operator-owned module. Keep the frozen assignment queue, ARC credential, and external evidence anchor inside this module, never in MCP arguments:

```ts
import { createOfficialArcControllerFactory } from '@metaharness/arc-agi-3-chatgpt';
import { evidenceAnchor } from './operator-worm-anchor.js';
import { frozenAssignments } from './private-assignments.js';

export const controllerFactory = createOfficialArcControllerFactory({
  assignments: frozenAssignments,
  // Must match startArcMcpServer({ avo }) or ARC_MCP_AVO_ARM exactly.
  avo: { arm: 'AVO_FULL' },
  evidenceRoot: '/absolute/path/to/private-arc-evidence',
  evidenceAnchor,
  bridgeOptions: {
    pythonExecutable: '/absolute/path/to/arc-agi-3-venv/bin/python',
    allowedArcHosts: ['three.arcprize.org'],
    env: { ARC_OPERATION_MODE: 'competition' },
  },
  runManifest: {
    visibleModelLabel: 'OpenAI model selected in ChatGPT',
    promptSnapshotHash: 'replace-with-frozen-prompt-hash',
    toolSchemaHash: 'replace-with-frozen-tool-schema-hash',
    environmentAdapterVersion: '@metaharness/arc-agi-3/python-bridge@0.1.0;arc-agi==0.9.8;arcengine==0.9.3',
  },
  budget: { maxActions: 10_000, maxWallTimeMs: 14_400_000 },
  acceptanceGate: { expectedGames: 25, expectedLevels: 183, requiredScore: 100 },
  scorecard: { tags: ['chatgpt-ui-frozen-condition'] },
});
```

The official factory validates and freezes the manifest, complete budget, acceptance gate, queue, AVO profile, and evidence path before it spawns Python or opens a scorecard. Its attested actor profile must exactly match the MCP server's legacy or AVO tool surface or server startup fails. The default gate is the public 25-game, 183-level, score-100 condition. `finalizeEvidence()` takes no threshold argument, and its evidence exposes the frozen gate. The factory forces the Python bridge into official `competition` mode, owns one bridge and one scorecard, admits one assignment at a time, rejects duplicate episode binding, and advances only after `WIN` or an explicit operator approval. A direct factory caller can use `approveRetry()` for diagnostic continuation on the same assignment. An unpublished MCP start failure is automatically released to the same queue index because its opaque episode handle never reached ChatGPT. Any failed attempt makes that factory and scorecard ineligible for accepted evidence, so an accepted rerun needs a new factory and scorecard. Final evidence also requires `competition_mode: true` in the closed upstream scorecard. Official bridge controllers advertise `supportsResume = false` because the online SDK cannot rehydrate its private cookie and GUID session after process loss.

Every action intent and transition is written to a mode `0600` append-only session journal. For an accepted result, `evidenceAnchor` must independently retain a cryptographic commitment for each event in append-only or WORM storage and return a final proof. `finalizeEvidence()` compares that external receipt head, journal state hash, and event count with the closed official scorecard and controller receipts. Supplying the controller's own head at finalization is deliberately insufficient.

## Local inspection

```bash
npm run build --workspace @metaharness/arc-agi-3
npm run build --workspace @metaharness/arc-agi-3-chatgpt

export ARC_CONTROLLER_FACTORY_MODULE=/absolute/path/to/controller-factory.js
export ARC_MCP_STATE_ROOT=/absolute/path/to/private-arc-state
export ARC_MCP_ALLOWED_HOSTS='localhost,127.0.0.1'
export ARC_MCP_AVO_ARM=AVO_FULL
npm start --workspace @metaharness/arc-agi-3-chatgpt
```

This anonymous mode is only for a single-user loopback session with the MCP Inspector. A strong scoped bearer can also be used locally or behind a trusted reverse proxy that injects the header. ChatGPT cannot be configured with an arbitrary API key for a custom remote MCP connection, so bearer configuration is not the ChatGPT production path.

## Connect ChatGPT with OAuth

The process always binds loopback. Put a reviewed HTTPS tunnel or reverse proxy in front of it, and configure an established OAuth 2.1 authorization server. The harness is an OAuth resource server, not an authorization server. The provider must support authorization code flow with PKCE `S256`, the OAuth resource parameter, and authorization server metadata.

Create an operator module and point `ARC_MCP_OAUTH_MODULE` at it:

```ts
export const oauth = {
  resource: 'https://your-mcp.example',
  authorizationServers: ['https://identity.example/tenant'],
  actorScope: 'arc.actor',
  bossScope: 'arc.boss',
  verificationTimeoutMs: 5_000,
  maxConcurrentVerifications: 16,
  async verifyAccessToken(token, { resource, requiredScopes, signal }) {
    return verifyWithYourIdentityProvider(token, {
      audience: resource,
      requiredScopes,
      signal,
      requireSignature: true,
      requireIssuer: true,
      requireExpiration: true,
      rejectBeforeNbf: true,
      checkRevocation: true,
    });
  },
};
```

The verifier deadline aborts its signal. A verifier that ignores cancellation continues occupying one of the bounded global slots until it settles. Authentication attempts are rate limited before verification. Run with:

```bash
export ARC_CONTROLLER_FACTORY_MODULE=/absolute/path/to/controller-factory.js
export ARC_MCP_OAUTH_MODULE=/absolute/path/to/oauth-resource.js
export ARC_MCP_STATE_ROOT=/absolute/path/to/private-arc-state
export ARC_MCP_ALLOWED_HOSTS='localhost,127.0.0.1,your-mcp.example'
npm start --workspace @metaharness/arc-agi-3-chatgpt
```

Add two Developer Mode connections in ChatGPT:

1. Actor connection: `https://your-tunnel.example/mcp`
2. Boss connection: `https://your-tunnel.example/mcp/boss`

Authorize the same operator identity for both connections while granting only `arc.actor` to the actor connection and only `arc.boss` to the boss connection. The protected-resource metadata and every OAuth tool advertise those scopes. Start a legacy actor conversation with [`prompts/actor.md`](prompts/actor.md), or an AVO actor conversation with [`prompts/actor-avo.md`](prompts/actor-avo.md). When the AVO context reports an open case, use a separate ChatGPT conversation with [`prompts/supervisor.md`](prompts/supervisor.md). The supervisor must bind its directive to both the current case hash and observation hash and supply exactly three causal, falsifiable hypotheses.

## Memory and plans

ChatGPT conversation state is not durable. Use:

* `arc_memory_query` to restore evidence-backed episodes and rules
* `arc_memory_commit` to version a rule with supporting and contradicting receipt hashes
* `arc_graph_frontier` to find novel untested edges
* `arc_execute_guarded_plan` for short plans whose every step carries a compare-and-set observation hash and a postcondition
* `arc_checkpoint`, retaining both its opaque ID and returned checkpoint hash

The guarded-plan controller stops on the first postcondition mismatch. `arc_start`, `arc_act`, guarded plans, and `arc_resume` are declared destructive and open-world in MCP metadata because they consume official budget or mutate remote environment state. `arc_observe` and `arc_checkpoint` are also open-world, non-read-only operations because they call the remote environment and can update controller fault or checkpoint state. ChatGPT may surface a confirmation from those annotations, but the server does not claim a mandatory human-approval mechanism. Server-side compare-and-set, reset, postcondition, and idempotency guards remain authoritative. `arc_resume` requires both `checkpointId` and `expectedCheckpointHash`; the store compares the caller's durable hash before replacing live state. The official online factory disables resume entirely.

In AVO mode, `arc_avo_step` is the only actor tool that can dispatch an action. A blocking supervisor check runs before every irreversible step, including between steps of one selected plan. A case opened by step N prevents step N+1 until the boss commits a bound directive. Partial plan results are idempotently retained so a transport retry cannot repeat an already-dispatched step. The requested immutable supervision gate is also passed into the injected factory; the official factory applies it to both preflight and live controllers.

Every mutating MCP tool requires a principal-scoped idempotency key. A repeated key with identical canonical input returns the prior result; a repeated key with different input fails. The default in-process ledger holds 50,000 entries per principal so long public reproductions do not hit the former 2,048-entry ceiling. Results include exact observations, so operators should budget tens to hundreds of megabytes for a long run and set a tighter bound only when the action budget is also lower.

## Durability boundary

`ARC_MCP_STATE_ROOT` is mandatory and probed for atomic-write capability before the server starts. A checkpoint descriptor (bounded at 64 MiB) stores ordered hashes while deduplicated frame blobs and compact receipts live in SHA-256-named CAS objects. Every object is re-hashed during load, counts are bounded by the controller action budget, and descriptor updates are atomic. Actual storage depends on how many distinct animation frames the game returns. Checkpoints and extended boss directives use opaque validated filenames beneath a hashed principal directory, bounded file sizes, mode `0600`, and directories created with mode `0700`. The audit sink also uses directory mode `0700` and file mode `0600`.

Durable checkpoint files restart a controller only when the injected environment implements checkpoint resume. The official online Python bridge cannot reconstruct its remote cookie and GUID session after that remote process dies. ChatGPT tab and context rotation are supported while the MCP server and bridge remain alive. Full live process crash recovery is not claimed.

AVO checkpoints wrap the verified core checkpoint with the resolved feature configuration, plan archive, lineage/outcome hashes, and world-model snapshot. The same CAS storage holds the embedded core receipts and frames. Resume verifies the outer hash, feature configuration, archive chains, world-model references, and embedded core checkpoint before replacing the live controller.

## Security properties

* Default-deny actor and boss tool registries
* Loopback-only bind with an HTTPS boundary supplied by a tunnel or reverse proxy
* Optional local anonymous mode and strong scoped bearer mode for local inspection or header-injecting trusted proxies
* OAuth 2.1 resource-server metadata and distinct actor and boss scopes for ChatGPT remote use
* Bounded OAuth verification deadline, cancellation signal, unresolved-verifier concurrency, and pre-authentication request rate
* Bearer tokens contain at least 32 random bytes and duplicate tokens are rejected
* Principal plus unpredictable episode-id isolation
* Request body size and receive deadlines before tool dispatch
* Pre-execution mandatory audit; an audit write failure blocks mutation
* Read-only tool deadlines only; mutations are never abandoned by `Promise.race`
* Bounded idempotency, checkpoints, directives, tool calls, and episode counts
* No shell capability
* Network limited to the injected official ARC environment bridge
* File writes limited to the configured state root, audit log, and official evidence root

## Verify

```bash
npm run lint --workspace @metaharness/arc-agi-3-chatgpt
npm test --workspace @metaharness/arc-agi-3-chatgpt
npm pack --dry-run --workspace @metaharness/arc-agi-3-chatgpt
npx @modelcontextprotocol/inspector@latest
```
