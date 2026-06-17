# ADR-057: example-github — GitHub SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

GitHub is the central coordination surface for virtually every software team that would adopt metaharness. Pull request review, issue triage, and release-notes generation are not hypothetical use cases — they are the day-to-day operations of the same developers who will evaluate this scaffold. This makes `example-github` the canonical "dogfood" example in the ADR-051 catalog: an AI harness that does real work on the platform that hosts the harness generator itself.

The Octokit family (`@octokit/rest` v22, `@octokit/graphql` v8) is the official, first-party JavaScript SDK published by GitHub. It maps directly to GitHub's REST and GraphQL APIs, is actively maintained, ships native ESM, and has no meaningful competitors for this API surface — choosing an alternative (e.g., raw `fetch` or a thin wrapper) would sacrifice type-safety and the plugin ecosystem (pagination, throttling, retry) with no benefit.

Agents driving GitHub need to do three things convincingly: (1) understand and summarise pull requests from their diff and review history, (2) triage issues by reading their content and existing labels, and (3) draft release notes from a milestone or tag range. All three are safely read-dominant; write operations (posting a review comment, applying a label, publishing a release) are the minority surface and must be gated.

GitHub provides no "sandbox" API endpoint or test-key mechanism analogous to Stripe. Safe-by-default for a GitHub harness therefore means: read-only by default, mutations require an explicit `--allow-writes` opt-in flag, and all agent actions against real repos are prefixed with a read-back verification step before any write is submitted. The conventional best practice in the Octokit ecosystem for safe testing is to point the harness at a dedicated personal test repository (not the organisation's production repos) and rely on the `--dry-run` path until the operator removes the guard.

## Decision

### Chosen SDK

Use `@octokit/rest` (v22, ESM) for REST endpoint access and `@octokit/graphql` (v8, ESM) for complex relationship traversal (PR review threads, issue timelines, release milestones). Both are imported as:

```js
import { Octokit } from "@octokit/rest";
import { graphql }  from "@octokit/graphql";
```

The umbrella `octokit` package (which bundles both plus GitHub App support) is an acceptable alternative but is heavier; `@octokit/rest` + `@octokit/graphql` are preferred to keep the scaffold's dependency footprint minimal and auditable.

### Headline capability

Three tightly coupled capabilities form the showcase: **PR review** (read a pull request, its diff, and prior review comments; produce a structured code-review summary); **issue triage** (read open issues, suggest label assignments and priority scores, draft triage comments); and **release notes** (call `octokit.rest.repos.generateReleaseNotes()` and synthesise a human-readable changelog from a tag range). These three are sufficient to demonstrate the full tiered-routing, multi-agent, and verification-gate contract.

### Agent and skill design

Three specialised agents are scaffolded:

| Agent | File | Role | Routing tier |
|---|---|---|---|
| `pr-analyst` | `agents/pr-analyst.md` | Reads PR metadata, diff, and review history via REST; summarises findings and flags concerns | Tier 2 (Haiku) for data extraction; Tier 3 (Sonnet) for the final review summary |
| `issue-triager` | `agents/issue-triager.md` | Lists open issues via REST, scores priority, suggests labels; reads issue body + comments via GraphQL for context | Tier 2 (Haiku) for fan-out reads; Tier 3 (Sonnet) for prioritisation decisions |
| `release-drafter` | `agents/release-drafter.md` | Calls `generateReleaseNotes` REST endpoint, then synthesises a curated changelog; reads milestone issues via GraphQL | Tier 2 (Haiku) for raw data; Tier 3 (Sonnet) for editorial synthesis |

One slash command is scaffolded: `/review-pr <owner>/<repo>#<number>` — triggers the full pr-analyst + verification-gate pipeline for a single PR.

A `verify` step runs after each agent output: the verifier re-fetches the PR/issue/release from the API and checks that any proposed labels or comments match the live state before presenting output as done (read-back verification per ADR-050). If the harness is operating in write mode, the verifier confirms the mutation was applied and matches the intent before marking the task complete.

### Routing tiers

| Tier | Handler | When used |
|---|---|---|
| 1 (WASM booster) | Agent booster | Not used — all tasks require network I/O |
| 2 (Haiku) | Fan-out data extraction | Fetching PR lists, issue lists, diff chunks, raw release note JSON |
| 3 (Sonnet) | Reasoning and synthesis | Producing review summaries, triage decisions, editorial changelogs, final verification assertions |

### MCP policy — granted tools only

The scaffolded `.harness/mcp-policy.json` is default-deny with the following explicit grants:

```json
{
  "version": 1,
  "default": "deny",
  "audit": true,
  "grants": [
    { "tool": "github.rest.pulls.get",            "access": "read" },
    { "tool": "github.rest.pulls.list",           "access": "read" },
    { "tool": "github.rest.pulls.listReviews",    "access": "read" },
    { "tool": "github.rest.issues.listForRepo",   "access": "read" },
    { "tool": "github.rest.issues.get",           "access": "read" },
    { "tool": "github.rest.repos.generateReleaseNotes", "access": "read" },
    { "tool": "github.graphql",                   "access": "read" },
    { "tool": "github.rest.pulls.createReview",   "access": "write", "requires": "ALLOW_WRITES=true" },
    { "tool": "github.rest.issues.addLabels",     "access": "write", "requires": "ALLOW_WRITES=true" },
    { "tool": "github.rest.issues.createComment", "access": "write", "requires": "ALLOW_WRITES=true" },
    { "tool": "github.rest.repos.createRelease",  "access": "write", "requires": "ALLOW_WRITES=true" }
  ]
}
```

All write-access grants are blocked unless the operator sets `ALLOW_WRITES=true` in their shell environment and explicitly re-runs with that flag. The MCP policy is scannable via `harness mcp-scan` (static-only, flags any shell/network grants not on the allowlist).

### Auth model

Authentication uses a **Personal Access Token (PAT)** passed via the `GITHUB_TOKEN` environment variable, never written to any scaffolded file.

```js
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
```

The fine-grained PAT scopes required are:

- **Read-only mode** (default): `Pull requests: read`, `Issues: read`, `Metadata: read`, `Contents: read`
- **Write mode** (`ALLOW_WRITES=true`): additionally `Pull requests: write`, `Issues: write`, `Contents: write`

Classic PATs with `repo` scope also work but are broader than necessary. The scaffolded `README.md` links to `https://github.com/settings/tokens/new` with the exact scopes pre-checked in the URL where feasible.

GitHub Apps authentication (`createAppAuth` from `@octokit/auth-app`) is documented as an upgrade path but is not scaffolded by default — it requires private-key management that adds friction for a first-run experience.

### Safety gates

1. **Read-only by default.** The MCP policy blocks all write tools unless `ALLOW_WRITES=true` is present in the environment. The scaffold's `.claude/settings.json` ships with `ALLOW_WRITES` absent (not set to `false` — absent, so there is no accidental `"true"` string that could be misread).
2. **No sandbox endpoint.** GitHub has no test API. The recommended safe posture is to point `GITHUB_OWNER` and `GITHUB_REPO` at a personal test repository that the operator controls, and keep `ALLOW_WRITES=false` (the default) until they are confident in the output.
3. **Read-back verification gate.** After any proposed write (comment, label, review), the `verify` step re-fetches the resource and asserts the mutation matches intent before the agent reports success. This applies even in write mode.
4. **Rate-limit awareness.** The scaffold wires `@octokit/plugin-throttling` to automatically back off at GitHub's secondary rate limit threshold. This prevents the harness from burning the operator's API quota during a large triage sweep.
5. **Token scope check.** On `harness doctor`, the scaffold calls `octokit.rest.users.getAuthenticated()` to confirm the token is valid and logs the token's `X-OAuth-Scopes` header (for classic PATs) or a sentinel-accessible-endpoint check (for fine-grained PATs) so the operator knows their permissions before the harness runs.

## Consequences

### Positive

- Provides a one-command, immediately runnable demonstration that a metaharness-generated agent can drive real GitHub operations safely and verifiably.
- The three showcased capabilities (PR review, issue triage, release notes) cover the full read-to-write spectrum and demonstrate both REST and GraphQL surfaces.
- Read-only default means a first-time operator can run `npx @metaharness/example-github@latest my-bot` against their own repo with no risk of unintended mutations.
- Serves as the dogfood test: this scaffold can be run against `ruvnet/agent-harness-generator` itself to validate each release.
- The verification gate (read-back after any write) satisfies ADR-050 without requiring a separate sandbox infrastructure.

### Limitations

- GitHub has no sandbox or test-key mode; safety is achieved by policy and by pointing at a test repo, not by an API-level guarantee.
- Fine-grained PAT scope introspection is limited — GitHub does not expose the full permission set of a fine-grained token in response headers, so the `doctor` check is a best-effort sentinel call rather than an authoritative scope audit.
- `generateReleaseNotes` requires a pre-existing tag in the target repo; the agent cannot generate notes for an unreleased HEAD without creating a draft release first (which is a write operation).
- GraphQL queries against large repos (thousands of issues) require pagination; the scaffold wires `octokit.paginate` for REST but GraphQL cursor pagination must be handled explicitly in agent prompts.
- `@octokit/rest` v22 dropped Node 18 support; the scaffold requires Node >=20, consistent with the harness-wide engine floor.

### Not-for-production disclaimer

This example is illustrative. It is not a certified GitHub App, does not implement GitHub's rate-limit retry guarantees beyond the throttling plugin defaults, and has not been audited for use in regulated CI/CD pipelines or automated merge workflows. Do not run with `ALLOW_WRITES=true` against production repositories without independently reviewing the agent output.
