# @metaharness/example-github

**AI-agent harness for GitHub — PR review, issue triage, and release notes, read-only by default.**

> **Illustrative output.** Transcripts and sample output shown in this README are representative examples, not captured from a specific run. Actual output depends on your environment, models, token scopes, and repository content. Run the commands to see real results.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-github?label=%40metaharness%2Fexample-github)](https://www.npmjs.com/package/@metaharness/example-github)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-github)](https://www.npmjs.com/package/@metaharness/example-github)
[![license](https://img.shields.io/npm/l/@metaharness/example-github)](https://github.com/ruvnet/agent-harness-generator/blob/main/LICENSE)
[![node >=20](https://img.shields.io/node/v/@metaharness/example-github)](https://nodejs.org/)
[![built with metaharness](https://img.shields.io/badge/built%20with-metaharness-6e40c9)](https://github.com/ruvnet/agent-harness-generator)

---

## What it is

`@metaharness/example-github` is a one-command scaffold that generates a multi-agent harness pre-wired to the GitHub REST and GraphQL APIs via `@octokit/rest` (v22) and `@octokit/graphql` (v8). The harness ships three specialised agents — a PR analyst, an issue triager, and a release drafter — a `/review-pr` slash command, tiered model routing, a default-deny MCP policy, and a read-back verification gate. It runs on all nine supported hosts (Claude Code, Codex, GitHub Copilot, GitHub Actions, Hermes, OpenClaw, OpenCode, pi-dev, RVM) via the `--host` flag.

**What it is NOT.** This is not a certified GitHub App, an automated merge bot, or a production CI/CD pipeline. It is an illustrative starting point. The `ALLOW_WRITES` flag is absent by default, meaning no mutations reach GitHub unless you explicitly enable them. Do not use the write-enabled path against production repositories without independently reviewing every agent output.

---

## Features

| Capability | What the harness does |
|---|---|
| **PR review** | Reads PR metadata, diff summary, and prior review comments via `octokit.rest.pulls.*`; synthesises a structured code-review report with concern flags |
| **Issue triage** | Lists open issues, scores priority, suggests label assignments; reads full issue context and comment threads via `@octokit/graphql` |
| **Release notes** | Calls `octokit.rest.repos.generateReleaseNotes()` and synthesises a curated human-readable changelog from a tag range or milestone |
| **Tiered routing** | Haiku for data extraction and fan-out reads; Sonnet for review summaries, triage decisions, and editorial synthesis |
| **MCP default-deny** | `.harness/mcp-policy.json` grants only the 7 read tools needed; all 4 write tools are blocked unless `ALLOW_WRITES=true` is set |
| **`/review-pr` command** | Slash command: `/review-pr <owner>/<repo>#<number>` — triggers the full analyst + verify pipeline for one PR |
| **Three agents** | `pr-analyst`, `issue-triager`, `release-drafter` — each scoped to its domain |
| **Verification gate** | After every proposed write, the verifier re-fetches the resource and confirms the mutation matches intent before reporting success |
| **Cross-host** | `--host claude-code` (default), `--host codex`, `--host copilot`, `--host github-actions`, `--host hermes`, `--host openclaw`, `--host opencode`, `--host pi-dev`, `--host rvm`, `--host all` |

---

## Quickstart

```bash
npx @metaharness/example-github@latest my-bot
cd my-bot && npm install && npm run doctor
```

`npm run doctor` verifies that your `GITHUB_TOKEN` is valid, confirms read access to the configured repo, logs the detected token scopes, and confirms that `ALLOW_WRITES` is absent (read-only mode is active).

To scaffold for a different host:

```bash
npx @metaharness/example-github@latest my-bot --host github-actions
npx @metaharness/example-github@latest my-bot --host all
```

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | Personal access token (classic or fine-grained). Never commit this. |
| `GITHUB_OWNER` | Yes | GitHub username or organisation name (e.g. `ruvnet`) |
| `GITHUB_REPO` | Yes | Repository name (e.g. `agent-harness-generator`) |
| `ALLOW_WRITES` | No (opt-in) | Set to `true` to enable PR review posting, label application, and release creation. Default: absent (read-only). |
| `GITHUB_API_URL` | No | Override for GitHub Enterprise Server (`https://github.example.com/api/v3`). Defaults to `https://api.github.com`. |

Set these in your shell or a `.env` file that is **gitignored** (the scaffold adds `.env` to `.gitignore` automatically):

```bash
export GITHUB_TOKEN="github_pat_..."
export GITHUB_OWNER="ruvnet"
export GITHUB_REPO="agent-harness-generator"
```

### Getting a token

Create a fine-grained PAT at [github.com/settings/tokens](https://github.com/settings/tokens). For read-only mode, grant these repository permissions:

- **Metadata**: read
- **Pull requests**: read
- **Issues**: read
- **Contents**: read

For write mode (`ALLOW_WRITES=true`), additionally grant:

- **Pull requests**: write
- **Issues**: write
- **Contents**: write

Classic PATs with `repo` scope also work but grant broader access than needed. Prefer fine-grained tokens scoped to the specific repository.

### No GitHub sandbox

GitHub does not provide a sandbox API endpoint or test-key mechanism. The safe-by-default posture here is:

1. Keep `ALLOW_WRITES` absent (the default). All agent output is read-only and local.
2. Point `GITHUB_OWNER`/`GITHUB_REPO` at a personal test repository you control before enabling writes.
3. Review agent output in the terminal before granting `ALLOW_WRITES=true`.

---

## Usage

### Slash command

```
/review-pr ruvnet/agent-harness-generator#142
```

Triggers the full pipeline: pr-analyst reads the PR and its diff, produces a structured review report, issue-triager cross-references any linked issues, and the verification gate re-fetches the PR to confirm the summary is consistent with live state.

### Natural-language prompts

```
Triage all open issues in ruvnet/agent-harness-generator. Suggest a label and priority (P0/P1/P2) for each. Do not post anything — show me the triage plan first.
```

```
Draft release notes for the next tag after v0.3.2 in ruvnet/agent-harness-generator. Use the generateReleaseNotes API and then produce an editorial summary grouped by feature, fix, and chore.
```

### Enable writes (explicit opt-in)

```bash
ALLOW_WRITES=true claude -p --plugin-dir my-bot \
  "/review-pr ruvnet/agent-harness-generator#142 --post-comment"
```

With `ALLOW_WRITES=true`, the pr-analyst will post its review comment to GitHub after the verification gate passes. Without it, the review is printed locally only.

---

## Safety

- **Read-only by default.** `ALLOW_WRITES` is absent from the scaffold's `.claude/settings.json` and all host configs. No label, comment, review, or release is posted unless the operator sets `ALLOW_WRITES=true` in their own environment.
- **Verification gate.** Before any write is submitted, the `verify` step re-fetches the PR or issue and asserts the intended mutation is safe and correct. The agent is not marked "done" until the gate passes.
- **MCP default-deny.** Only the 11 tools explicitly listed in `.harness/mcp-policy.json` are accessible. All others — including shell, file-write, and network outside the GitHub API — are denied. Run `harness mcp-scan` for a static audit.
- **Rate-limit protection.** `@octokit/plugin-throttling` is wired automatically. The harness backs off at GitHub's secondary rate limit threshold and retries with exponential backoff.
- **No secrets in scaffolded files.** `GITHUB_TOKEN` is read exclusively from `process.env.GITHUB_TOKEN`. The scaffold checks for and refuses to start if the token appears in any tracked file.
- **Not a certified GitHub App.** This harness is illustrative. It has not been submitted to the GitHub Marketplace, does not implement webhook signature verification, and is not suitable for use as an automated merge bot or CI gate without significant additional hardening.

---

## How it works

### Agents

**`pr-analyst`** (Tier 2 → Tier 3)
Fetches PR metadata and the review list via `octokit.rest.pulls.get()` and `octokit.rest.pulls.listReviews()`. A Haiku-tier pass extracts structured data (files changed, review states, author). A Sonnet-tier pass produces the final review summary with concern flags. If `ALLOW_WRITES=true`, the agent calls `octokit.rest.pulls.createReview()` after the verification gate approves.

**`issue-triager`** (Tier 2 → Tier 3)
Uses `octokit.rest.issues.listForRepo()` to page through open issues, then fires a `@octokit/graphql` query to retrieve comment threads and linked PRs for context-rich issues. Haiku scores each issue on a priority rubric; Sonnet produces the final triage plan. With `ALLOW_WRITES=true`, applies labels via `octokit.rest.issues.addLabels()` and posts triage comments via `octokit.rest.issues.createComment()`.

**`release-drafter`** (Tier 2 → Tier 3)
Calls `octokit.rest.repos.generateReleaseNotes()` to get GitHub's auto-generated change list from a tag range. Haiku structures the raw JSON into a categorised list (features, fixes, chores, contributors). Sonnet writes the editorial summary. With `ALLOW_WRITES=true`, creates a draft release via `octokit.rest.repos.createRelease({ draft: true })`.

### Routing tiers

| Tier | Model | Used for |
|---|---|---|
| 2 | Haiku | Fetching and structuring raw API data; fan-out reads across many issues/PRs; JSON extraction |
| 3 | Sonnet | Review summaries, triage priority decisions, editorial changelog synthesis, verification assertions |

### MCP policy — granted tools

The `.harness/mcp-policy.json` grants exactly these tools (all others are denied):

**Read (always available)**
- `github.rest.pulls.get`
- `github.rest.pulls.list`
- `github.rest.pulls.listReviews`
- `github.rest.issues.listForRepo`
- `github.rest.issues.get`
- `github.rest.repos.generateReleaseNotes`
- `github.graphql`

**Write (blocked unless `ALLOW_WRITES=true`)**
- `github.rest.pulls.createReview`
- `github.rest.issues.addLabels`
- `github.rest.issues.createComment`
- `github.rest.repos.createRelease`

The audit log (`ALLOW_WRITES=true` sessions) records each tool call, its arguments, and the verification-gate outcome.

---

## Links

- SDK reference: [octokit.github.io/rest.js](https://octokit.github.io/rest.js/) | [github.com/octokit/graphql.js](https://github.com/octokit/graphql.js)
- `@octokit/rest` on npm: [npmjs.com/package/@octokit/rest](https://www.npmjs.com/package/@octokit/rest)
- `@octokit/graphql` on npm: [npmjs.com/package/@octokit/graphql](https://www.npmjs.com/package/@octokit/graphql)
- GitHub fine-grained PAT permissions: [docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- ADR-057 (this design): [docs/adrs/ADR-057-example-github.md](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-057-example-github.md)
- ADR-051 (examples program): [docs/adrs/ADR-051-third-party-sdk-showcase-examples.md](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md)
- metaharness: [github.com/ruvnet/agent-harness-generator](https://github.com/ruvnet/agent-harness-generator)
