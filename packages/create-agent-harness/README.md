# metaharness

Scaffold your own focused AI agent harness — like [ruflo](https://github.com/ruvnet/ruflo), uniquely yours.

> **Proven at the cost-Pareto frontier.** Same "evolve the harness" thesis, measured: the Darwin harness resolves
> real **SWE-bench Lite** issues at **34.0%** single-trajectory (~$0.005/inst) and **39.7%** Best-of-3
> (~$0.015/inst) — conformant, official harness. Live
> **[Cost–Performance leaderboard](https://ruvnet.github.io/agent-harness-generator/cost-pareto.html)** ·
> [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin).

> Published as **`metaharness`** (the `metaharness` and `harness` CLIs). Earlier versions were published as `create-agent-harness`.

## Quick start

```bash
npx metaharness my-bot
```

You'll be prompted for template, host, description. Out comes a complete npm package ready to `npm publish`.

## Non-interactive

```bash
npx metaharness my-legal-bot \
  --template vertical:legal \
  --host claude-code \
  --description "Contract redline + risk rating"
```

Add the forthcoming field-memory package only when the harness needs shared,
history-dependent routing:

```bash
npx metaharness my-bot --field-memory
```

`--field-memory` is opt-in and currently depends on the upstream
`@metaharness/field-memory@^0.1.0` package PR. It adds
`src/field-memory.ts`, the runtime dependency, and a machine-readable
`manifest.field_memory` block. The generated bootstrap uses packed storage,
requires three distinct verifier-derived principals, disables hysteresis,
enables a bounded drift window, and fails closed until the deployment supplies an
absolute storage path, storage adapter, and principal verifier backed by
deployment authentication. It also requires a deployment-secret
`identityHashKey` of at least 32 bytes, reused after state restore. No database
path, identity, secret, credential, or principal proof is generated.
For RuVector-backed storage, the package adapter requires a
configuration-verified FlatIndex with in-place mutation and cosine distance;
HNSW and unverified legacy stores are rejected.

Principal independence is only as strong as the verifier's identity and trust
domain controls. Also inspect `storage.writerScope`: `process` requires one
writer service per field, while multi-process or fleet-wide writers require a
`distributed` adapter.

The package influence caps are centroid-local. Fleet-wide admission,
revocation, and rate limits belong in the deployment-owned verifier.
`minimumSupport` is routing quarantine, not confidentiality: authorized state
exports and registry storage can include singleton aggregate embeddings and
rewards, so protect both as sensitive deployment data.

The draft accepts only the exact runtime dependency range `^0.1.0`. A missing
or malformed generated `package.json`, another dependency range or section, or
an existing `src/field-memory.ts` causes scaffolding to stop before any write.
`harness upgrade` validates every manifest field against the exact current
contract, then reapplies the same manifest-selected overlay so it cannot
orphan the module or silently remove its dependency and documentation.
The block carries `contract_schema: 1`; unsupported schemas fail closed and
require an explicit migration instead of being reinterpreted.

Use `--no-field-memory` to force the default off state in shared scripts.

## Templates

| Template | Best for |
|---|---|
| `minimal` | Custom starter — kernel only |
| `vertical:devops` | Incident response, on-call workflows |
| `vertical:support` | Customer support, KB-RAG, escalation |
| `vertical:trading` | Quant trading (paper-default, circuit breakers) |
| `vertical:legal` | Contract review with citation checking |
| `vertical:research` | Multi-source dossier with evidence grading |

## Hosts

`--host` selects which host adapter ships with your harness:

| Host | What you get |
|---|---|
| `claude-code` | `.claude/settings.json` with MCP + hooks |
| `codex` | `~/.codex/config.toml` with `[mcp_servers.*]` |
| `pi-dev` | Pi extension (TypeScript, no MCP by design) |
| `hermes` | `cli-config.yaml` + `optional-mcps/*.yaml` |
| `openclaw` | `~/.openclaw/openclaw.json` + workspace SKILL.md + install runbook |
| `rvm` | RVM partition manifest + capability table + wasm-guest + install runbook (hardware-isolated) |
| `prime-agent` | `.prime/agent/skills/` Python-backed skill per tool (no MCP by design) + `install-prime-agent.md` runbook; deny-lists emit `SANDBOX-REQUIRED.md` (ADR-247) |

Multi-host: pass `--host` multiple times.

## Also ships the `harness` CLI

```bash
harness sign      # produce/update the witness manifest
harness verify    # check signature
harness doctor    # smoke-check a scaffolded harness
harness score     # runtime-readiness badges for a local repo
harness help
```

### `harness score` vs `metaharness score` — two different scorecards (#15)

The two CLIs both accept `score` but emit **different, purpose-specific JSON** — so check the schema
discriminator before parsing:

| Command | Purpose | JSON discriminator |
|---|---|---|
| `harness score <dir> --json` | Runtime-readiness **badges** (score + mcpRisk / releaseReady / testsDetected / sbom / witnessSigned) | `"schema": "harness-quickcheck-v1"` (string) |
| `metaharness score <dir> --json` | 5-dimension harness-fit **scorecard** (harnessFit / compileConfidence / …) | `"schema": 1` (number) |

They are **not interchangeable**. A consumer wiring one into a pipeline expecting the other should
branch on `schema` (`typeof out.schema === 'string'` ⇒ harness badges; `=== 1` ⇒ metaharness
scorecard) and refuse the wrong shape rather than silently defaulting missing fields to `0`.

## Optional Cognitum Meta-Proxy sidecar

Meta-Proxy is an optional local Rust sidecar, not an npm dependency and not part
of normal harness scaffolding. Install it only when you want a locally bound,
Claude-compatible routing endpoint with Meta-Proxy's own Cognitum OAuth flow:

```bash
npx metaharness proxy install --yes   # pinned signed download; checksum + Ed25519 verified
npx metaharness proxy run -- claude   # starts the sidecar and routes this Claude session through it
npx metaharness proxy run --policy critical -- claude -p "review this migration"
```

`proxy run` is the activation path: it supplies `ANTHROPIC_BASE_URL` and the
local proxy bearer token only to the child process. It does not modify global
Claude settings, project files, or persisted client configuration. With the
Meta-Proxy automatic-failover release installed, ordinary requests use the
user's Claude Passthrough identity; trusted rate-limit telemetry can then
select consented Cloud or Sponsored capacity per request. Cognitum login is
needed only for Cloud routing, not for installation or normal Passthrough.

Use `npx metaharness proxy login` to authorize Cognitum Cloud routing, and
`npx metaharness proxy status` to inspect the managed sidecar. Use `proxy enable`
to configure login start, `proxy stop` for a stop that survives crash-restart
policy in the current session, `proxy start` to resume it, `proxy logs` for the
managed log, `proxy disable` to remove login start, and `proxy uninstall --yes`
to remove the managed runtime. Uninstall intentionally preserves credentials;
run `proxy logout` first when credential removal is required.

On Windows this is a least-privilege per-user Scheduled Task. Status comes from
locale-neutral ScheduledTasks API enum state and reports registration, task
enablement, and running state separately. Disable and ambiguous-start cleanup
require a stable stopped state. A failed enable restores a pre-existing absent
or disabled task exactly; it deletes the task/XML only when both were created by
that attempt. A registered task without its owned XML is never overwritten or
deleted by label alone, and
an owned disabled task removed by an ambiguous create is recreated from that XML
and returned to disabled after an authoritative re-read, even if the compensating
create response is also lost. On Linux, ambiguous `disable --now` and later `daemon-reload`
failures re-read manager state and restore the prior login and running state,
or fail closed with the owned definition preserved when restoration cannot be
proved.

### Per-worktree routing policy

`proxy run` attaches a short-lived, HMAC-signed local capability to the
launched process. The policy is scoped to a one-way fingerprint of the current
worktree; neither its path nor repository metadata leaves the machine.

- `critical` — suppress automatic Power Saver and Sponsored failover for this
  worktree. Explicit manual controls still apply.
- `standard` — the normal automatic policy: Power Saver at 80% utilization,
  Sponsored only after exhaustion and only with consent.
- `economy` — Power Saver may start at 60% utilization; it retains all consent
  gates and the Sponsored-at-exhaustion limit.

The capability is verified by Meta-Proxy, not inferred from `.claude`, a Git
branch name, or any repository-controlled file. Meta-Proxy v0.4.0 or later is
required for per-worktree policies; older releases reject the scoped token.

`proxy install` downloads the platform archive from the public
[`meta-proxy-dist`](https://github.com/cognitum-one/meta-proxy-dist) release
channel only after explicit `--yes` consent. The CLI verifies the signed
`SHA256SUMS` manifest against a public key pinned in MetaHarness before it
extracts or replaces a binary. The sidecar is installed under
`~/.metaharness/meta-proxy/`; credentials remain in Meta-Proxy's own storage.

Other commands: `proxy stop`, `proxy path`, and `proxy logout`.

## Eject from ruflo

If you've been using ruflo and want your own focused harness from it:

```bash
npx metaharness --from-existing ./
```

Lifts agents/skills/commands, rewrites every `ruflo` / `claude-flow` reference, preserves attribution blocks marked with `<!-- ruflo-attribution-block -->`.

## Full walkthrough

See [USAGE.md](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/USAGE.md).

## License

MIT
