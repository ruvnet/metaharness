# Using agent-harness-generator (the meta-harness)

A plain-language walkthrough from "I want my own AI agent harness" to "I just published one to npm."

> **agent-harness-generator is a meta-harness** — a harness whose product is other harnesses. You operate it once; the harness you produce is what your users install. They never see the meta-harness layer.

## What you'll have at the end

A self-contained npm package — let's call it `my-bot` — with:

- Its own `npx my-bot` CLI
- Its own MCP server registration
- Its own memory namespace
- Its own selection of agents, skills, plugins
- Branding that's yours, not "ruflo"
- An Ed25519-signed witness manifest so users can verify what they installed

You'll be able to `npm publish` it and your users will do `npx my-bot init` in their project.

---

## 1. Install

`metaharness` is published to npm (v0.1.x beta) — run:

```bash
npx metaharness my-bot                       # arg-driven (default template + claude-code)
npx metaharness --wizard                     # iter 100 — interactive picker
npx metaharness --list                       # browse all 19 templates
```

No global install required. The package downloads itself on use.

**Don't know what to pick?** Run `--wizard` — 4-question form (name → template → host → description), with the equivalent `npx metaharness …` command printed afterwards so you can skip the wizard next time.

If you're working from the repo directly:

```bash
git clone https://github.com/ruvnet/metaharness
cd metaharness
npm install
npm run build
node packages/create-agent-harness/dist/bin.js my-bot
```

---

## 2. Pick a template

The generator ships with six templates:

| Template | Best for |
|---|---|
| `minimal` | Custom starter — kernel only |
| `vertical:devops` | Incident response, on-call workflows |
| `vertical:support` | Customer support, KB-RAG, escalation |
| `vertical:trading` | Quant trading with paper-default + circuit breakers |
| `vertical:legal` | Contract review with citation checking |
| `vertical:research` | Multi-source dossier with evidence grading |

Pick one with `--template`:

```bash
npx metaharness my-bot --template vertical:devops
```

Or run interactively (no `--template` flag) to be prompted.

---

## 3. Pick host(s)

Generated harnesses run on four hosts. You can target one or more:

| Host | What it looks like in your harness |
|---|---|
| `claude-code` | `.claude/settings.json` with MCP + hooks |
| `codex` | `~/.codex/config.toml` with `[mcp_servers.*]` table |
| `pi-dev` | Pi extension (TypeScript module, no MCP) |
| `hermes` | `cli-config.yaml` + `optional-mcps/*.yaml` |
| `openclaw` | `~/.openclaw/openclaw.json` snippet + workspace SKILL.md + install runbook |
| `rvm` | RVM partition manifest (TOML) + capability table (JSON) + wasm-guest descriptor + install runbook |

```bash
npx metaharness my-bot \
  --template vertical:devops \
  --host claude-code \
  --host codex
```

---

## 4. Customise

After scaffolding, you have a complete project. Open it and customise:

```
my-bot/
├── package.json              # name + deps
├── CLAUDE.md                 # what Claude reads first
├── src/
│   ├── init.ts               # bootstraps the kernel
│   └── agents/               # your selected agents
├── .claude/
│   └── settings.json         # hooks + MCP servers
├── .harness/
│   ├── manifest.json         # drift-detection source of truth
│   └── manifest.sha256       # corruption check
└── runbooks/ or kb/ ...      # template-specific
```

Edit anything. The kernel and host adapter come from `@metaharness/kernel` and `@metaharness/host-<n>` packages — you depend on them as published npm packages, not vendored copies.

---

## 5. Test locally

```bash
cd my-bot
npm install
npm run build
npm test
```

Then try the CLI:

```bash
node ./dist/init.js
# Or after npm link:
my-bot init
```

**Sanity-check before you ship** — run the release-readiness umbrella:

```bash
harness validate                # doctor + verify + path-guard + mcp + secrets + diag
harness diag                    # kernel-version skew check
harness audit                   # npm audit per-harness
harness sbom > sbom.json        # SPDX-2.3 bill of materials
harness mcp-scan                # security-scan the MCP surface (perms + deps)
```

A `harness validate` HEALTHY verdict means publish.yml's gates would all pass — no surprises in CI.

---

## 6. Publish to npm

When you're ready to ship:

```bash
npm publish --provenance
```

That's it. Your harness is now on npm. Users do:

```bash
npx my-bot init
```

---

## 7. Get updates (drift detection)

When `@metaharness/kernel` or your template ships an update, you don't have to start over. Run:

```bash
harness upgrade
```

It does a three-way diff:

- **Clean changes** — your local file matches what was originally generated → overwrite with the new template version
- **Conflicts** — your local file diverged from the generated state AND upstream changed too → Git-style `<<<<<<<` markers inline, or `.rej` files if you prefer

You review and resolve, then commit. Same model copier uses.

---

## 8. Eject from ruflo (if you started with ruflo)

If you've been using ruflo and want to ship your own focused harness from it:

```bash
npx metaharness --from-existing ./
```

This detects your ruflo install (`.claude/`, `CLAUDE.md`, `.mcp.json`), lifts the agents/skills/commands you've customised into a new harness, and renames every `ruflo` / `claude-flow` reference. **`.claude-flow/`** local state is left behind by design — eject starts with a fresh memory.

You can preserve attribution by marking specific markdown blocks:

```html
<!-- ruflo-attribution-block -->
This harness is powered by ruflo and built on @metaharness/kernel.
<!-- /ruflo-attribution-block -->
```

These blocks are left untouched during the rewrite.

---

## 9. Marketplace publish (optional)

If you want your harness in the ruflo plugin marketplace (so it's discoverable):

```bash
# 1. Sign your harness's witness manifest
harness sign

# 2. Pin to IPFS via Pinata + emit a registry entry
harness publish --confirm
```

The publish gate:

1. Verifies the witness signature (tampered = rejected)
2. Pins your manifest to IPFS via Pinata
3. Returns the CID + a registry entry JSON
4. You submit a PR to the ruflo plugin registry adding the entry

The Pinata JWT comes from environment or GCP Secret Manager — never from a file in your repo. See [`docs/setup/gcp-secrets.md`](setup/gcp-secrets.md).

---

## 10. Self-evolving routing (advanced, opt-in)

If you want your harness to ADAPT its routing decisions over time:

```typescript
import { SelfEvolvingRouter } from '@metaharness/kernel/self-evolution';

const router = new SelfEvolvingRouter({
  enabled: true,
  smallTierBias: 1.2,  // prefer Haiku-class by default
});

// After every call, feed back the outcome:
await router.recordOutcome({
  tier: 'small',
  success: true,
  latencyMs: 480,
  costUsd: 0.00018,
});

// Then use the learned weights to re-rank tier candidates:
const order = router.reRank(['frontier', 'small', 'codemod']);
// -> ['small', 'codemod', 'frontier'] if Haiku has been winning
```

Honesty caveat from the underlying `@ruvector/emergent-time` package: the SDK is a diagnostic signal, not a proven early-warning lead vs a fair baseline. Bench it for your workload before relying on it in production.

---

## 11. Troubleshooting

| Symptom | Most likely fix |
|---|---|
| `Error: target exists` | Pass `--force` or pick a new directory name |
| `invalid harness name` | Must be kebab-case, lowercase, no leading number, no consecutive hyphens, no trailing hyphen, ≤ 214 chars (npm rule) |
| `unknown template` | Check `npx metaharness --list` for the current template list (19 verticals at iter 96) |
| `witness verification failed` on publish | Your `.harness/witness.json` was tampered with OR `harness sign` was never run |
| `npm publish: 403` | Token expired — rotate via `gcloud secrets versions add NPM_TOKEN --data-file=-` |
| `harness doctor` reports issues you don't understand | Run `harness diag <path> --bundle > bundle.json` and attach to an issue at <https://github.com/ruvnet/metaharness/issues>. The bundle is sanitised (secret/token/key/password fields redacted). |
| `harness diag` says `MAJOR skew — APIs may have changed; expect breakage` | Your local `@metaharness/kernel` is on a different major than the version your harness was scaffolded against. Run `npm install @metaharness/kernel@<manifest-version>` (the diag output names the version). See [ADR-028](adrs/ADR-028-skew-detection-and-liveness.md). |
| Want to share your MCP/Bash/claims config for a security review without zipping the whole harness | `harness export-config <path> > config.json` (iter 97) — emits a single sanitised JSON. |
| Want to share npm-audit findings (machine-parseable, for grep / CI / vuln review) | `harness audit <path> --bundle > audit.json` (iter 102) — emits `{ schema, level, total, counts, offenders, failCount, exitCode }`. Error paths (no-package-json / no-lockfile / unknown-level) are also JSON. |

---

## When to use which subcommand

| You're trying to … | Subcommand |
|---|---|
| Smoke-check a fresh scaffold | `harness doctor` (iter 8) |
| Run every release-readiness gate at once | `harness validate` (iter 20) — 6-check umbrella |
| Check that your local kernel matches the harness | `harness diag` (iter 66) |
| File a useful support ticket | `harness diag --bundle` (iter 90) |
| Share MCP/Bash/claims config for an audit | `harness export-config` (iter 97) |
| Diff two harnesses (e.g. yours vs an upstream baseline) | `harness compare a/ b/` (iter 105) |
| Pre-scaffold: is this REPO ready for an agent? | `harness genome <repo>` (iter 110) |
| Score the harness 0–100 with badges (grade A/B/C/F) | `harness score <path>` (iter 111) |
| MCP threat-model artifact for a PR / compliance review | `harness threat-model <path>` (iter 112) |
| Emit OIA v0.1 cross-cutting manifest (ADR-034) | `harness oia-manifest <path>` (iter 121) |
| Drift-detect against the latest template | `harness upgrade` (iter 47) |
| Sign a release manifest | `harness sign` (iter 8) |
| Verify the witness signature | `harness verify` (iter 8) |
| Pin the manifest to IPFS | `harness publish --confirm` (iter 46) |
| List / invoke MCP tools | `harness mcp ls` / `harness mcp invoke` (iter 45) |
| Security-scan the MCP surface | `harness mcp-scan` (iter 55) |
| Recommend a harness from an existing repo | `harness analyze-repo` (iter 55) |
| Emit SPDX-2.3 SBOM for the harness | `harness sbom` (iter 51) |
| Run npm audit per-harness | `harness audit` (iter 51) |
| Manage federation peers | `harness federate` (iter 9) |
| GCP Secret Manager helpers | `harness secrets` (iter 18) |
| Emit shell completion (bash/zsh/fish) | `harness completions` (iter 48) |

20 subcommands total as of iter 112. Every subcommand respects `--help` / `-h`.

### `harness genome <repo>` — pre-scaffold readiness

The "is this REPO ready for an agent harness?" question. 7-section report
(repo profile · agent topology · MCP risk model · test confidence · release
readiness · recommended plan · scorecard) computed deterministically from a
LOCAL repo path — never executes repo code. Modes: text (default) · `--json`
(6-field scorecard: `repo_type`, `agent_topology`, `risk_score`,
`mcp_surface`, `test_confidence`, `publish_readiness`) · `--bundle` (ADR-031
schema-1 envelope) · `--out <file>`. Verdict + exit: `ready` (0) when
publish_readiness ≥ 0.75 && risk < 0.35 · `needs-work` (1) · `blocked` (2)
when risk ≥ 0.7.

### `harness score <path>` — post-scaffold harness scorecard

A 0-100 score across 5 dimensions, with the 6-field badge block ready to
drop into the generated harness README:

| Dimension | Weight | Reads |
|---|---|---|
| Repo understanding | 25% | `.harness/manifest.json` (surface + kernel + host) |
| Agent usefulness | 25% | `src/agents/*` + `.claude/skills/*` + commands counts |
| MCP safety | 20% | `.harness/mcp-policy.json` (default-deny + audit + perms) |
| Test coverage | 15% | `__tests__/` + `npm test` + `.github/workflows/` |
| Publish readiness | 15% | `witness.json` + `sbom.json` + `package.json#bin` |

Grade: A (≥85, exit 0) · B (≥70, exit 0) · C (≥50, exit 1, needs work) ·
F (exit 2, blocked). The user roadmap target: A without manual edits.

### `harness threat-model <path>` — MCP threat-model artifact ("enterprise gold")

Renders the existing `mcp-scan` findings as a clean PR / compliance review
artifact — allowed/denied tools count, dangerous permissions count, secrets
reachability, network/shell/file-write grants, default-deny posture, audit
log status. Same envelope shape across `--json` / `--bundle` modes per
ADR-031.

Verdict + exit: `clean` (0) — no dangerous perms · `medium` (1) — network OR
file-write granted, OR no audit log · `high` (2) — shell granted OR
default-deny OFF OR secrets reachable.

### `harness compare a/ b/`

Two-harness diff: useful when you've forked an upstream template, or when a
support ticket says "mine and theirs scaffolded different things". Reports:

- **manifest meta** — same name? same kernel? same surface?
- **hosts** — which adapters each side ships
- **files** — added / removed / changed (per-file SHA-256 fingerprints; the
  cheapest possible byte-equality test)

Exit codes: `0` IDENTICAL · `1` DRIFT · `2` missing manifest in one or both
sides. `--bundle` emits the schema-1 envelope (ADR-031) so CI or a support
script can json-parse the verdict.

---

## See also

- [`docs/adrs/INDEX.md`](adrs/INDEX.md) — the design docs (21 ADRs)
- [`docs/setup/gcp-secrets.md`](setup/gcp-secrets.md) — publish-token wiring
- [`SECURITY.md`](../SECURITY.md) — vulnerability disclosure
- [`CHANGELOG.md`](../CHANGELOG.md) — what landed when
