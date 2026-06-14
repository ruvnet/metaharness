# ADR-035: Product naming — MetaHarness

**Status**: Accepted
**Date**: 2026-06-14
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-001 (goals & non-goals — coins "meta-harness"), ADR-019 (release orchestration), ADR-030 (Discovery Loop propagation)
**Supersedes**: implicit naming choices from iter 108 (agentmint), iter 108b (mintagent), iter 118 (openharness)

---

## Context

Between iter 108 and iter 124 the published npm name churned four times in nine days:

| Iter | Name | Outcome |
|---|---|---|
| pre-108 | `create-agent-harness` | Squatted by `neohum/create-agent-harness` on npm (unrelated project). Could not publish under it. |
| 108 | `agentmint` | Rolled out internally on the user's first pick. |
| 108b | `mintagent` | User pivoted to verb-first form (same iter). All docs + tests caught up. |
| 118 | `openharness` (rebrand to **OpenHarness**) | User pivoted the brand to "OpenHarness" (with the in-app heading "Open Harness Studio"). Full mechanical rename across packages, tests, docs, Web UI. |
| 124 | `metaharness` (rebrand to **MetaHarness**) | npm rejected `openharness` at publish time: *"Package name too similar to existing package open-harness"* (npm anti-typosquatting). User suggested `metaharness`; it published cleanly. |

The thrash was painful (~200 source-level rename touches across three iters), but the end-state has three strong properties that the prior names lacked:

1. **`metaharness` is etymologically anchored.** ADR-001 introduced the project as "the **meta-harness** for AI agents" in the first sentence of the first ADR. Every subsequent ADR — including ADR-018 (RVM as deployment target), ADR-023 (repo-to-harness importer), ADR-031 (Bundle JSON Pattern) — uses "meta-harness" in the running text. The published npm name now matches the term the codebase has used since day one.

2. **Defensive name protection emerged for free.** Once `metaharness` was published, npm's similarity rule began rejecting publish attempts for `meta-harness` (dashed) by anyone else. The same rule that blocked us from claiming `openharness` (because `open-harness` already existed) now protects `metaharness` from being typo-squatted in the dashed form.

3. **The CLI invocation reads as a verb of art.** `npx metaharness` parses as "run the meta-harness" — coherent with the project's positioning as "a factory for agent frameworks" (the user's iter-107 directive). `npx mintagent` and `npx openharness` both worked, but neither anchored on a concept the codebase already taught.

The repository slug `ruvnet/agent-harness-generator` stays unchanged. It's the **category** ("agent harness generator"). The npm name is the **brand** ("MetaHarness"). This dual-handle pattern matches the iter-117 user directive that introduced the MintAgent/OpenHarness distinction in the first place.

## Decision

**MetaHarness is the product brand. `metaharness` is the published npm name.**

Concretely:

| Layer | Name | Notes |
|---|---|---|
| GitHub repo (category, SEO) | `ruvnet/agent-harness-generator` | Unchanged. Repository description, README, and badges keep this as the discoverable category. |
| Published CLI (npm) | `metaharness` | One word, all lowercase. `npx metaharness ...` is the user-facing invocation. |
| Published library (npm) | `@ruvnet/agent-harness-generator` | The thin re-export wrapper from iter 116 stays scoped (`@ruvnet/...`) under the category name. |
| Product/brand display | **MetaHarness** | Used in README H1, Web UI heading ("Open Harness Studio" → "MetaHarness Studio" follow-up), marketing copy. |
| Tagline | "Mint a custom AI agent harness from any repo." | Inherited from the iter-107 OpenHarness rebrand; the action verb ("mint") still fits MetaHarness. |
| Repo description | "MetaHarness — the meta-harness for AI agents. Mint a custom agent harness from any repo." | One sentence; brand + category + outcome. |

The CLI surface inside the harness stays `harness <subcommand>` (21 subcommands at iter 122). Only the wrapper binary that scaffolds *new* harnesses changes name. Per the iter-117 rule:

> **Before generation: `metaharness`. Inside generated harness: `harness`.**

### npm naming details

- **`metaharness`** — published. The unscoped CLI binary. Bin entries: `metaharness` (the scaffolder) and `harness` (the per-harness toolkit).
- **`meta-harness`** (dashed) — npm-blocked by similarity; *we cannot register it and neither can anyone else*. This is the intended defensive moat.
- **`@ruvnet/metaharness`** — reserved for future use (e.g. if we ever need to ship an internal pre-release lane separately from the public `metaharness` channel).

### Migration discipline for end users

The published surface flips clean on this iter; no transition period is needed because no end users were on the earlier `openharness` channel (it was never published successfully).

- `npx create-agent-harness ...` (the old name in early docs) — was never reachable, since the npm name was squatted by neohum. Documentation should not advertise it.
- `npx mintagent ...` — was never published to npm. Documentation should not advertise it.
- `npx openharness ...` — was never successfully published to npm (blocked by similarity). Documentation should not advertise it.
- **`npx metaharness ...`** — the canonical invocation as of iter 124.

The Discovery Loop (ADR-030) will propagate the rename across: README H1, USAGE.md commands, USERGUIDE.md, marketplace plugin.json `displayName`, Codex skills set, Web UI in-app heading, every test that asserts on a name string.

## Consequences

### Required follow-on work (mechanical, this iter and the next)

1. **Source-level rename** across all 14+ files that still reference `mintagent` or `openharness`. Bulk sed; verify with `grep -rln 'mintagent\|openharness\|MintAgent\|OpenHarness' --include='*.ts' --include='*.md' --include='*.json'` returning empty.
2. **Wrapper dependency**: `@ruvnet/agent-harness-generator` re-exports from `metaharness` (was `openharness` after iter 118, was `mintagent` before iter 118).
3. **Web UI in-app heading**: "Open Harness Studio" → "MetaHarness Studio". The iter-118 rename to "Open Harness Studio" was made specifically because the user wrote it in lowercase ("the web ui is Open Harness Studio") — that directive is now superseded by this ADR.
4. **Marketplace plugin.json `displayName`**: "OpenHarness" → "MetaHarness".
5. **Test files referencing the bin name**: `__tests__/openharness-subcommands.test.ts` → `__tests__/metaharness-subcommands.test.ts` (file rename + body update).
6. **`scripts/healthcheck.mjs --probe-pages`** and Pages e2e tests that assert on the Studio H1.
7. **`apps/web-ui/index.html`** title + meta tags + Open Graph (the SEO catch-up from iter 117).

### Risk

- **README/SEO churn.** Search rankings for "OpenHarness" (briefly indexed by Google between iters 118 and 124) will drop. Acceptable cost — the indexed window was hours, not weeks, and the brand was never widely shared.
- **Documentation drift between published npm pages and source.** Minimised by landing all the propagation in one ADR-030 sweep (iter 124 + iter 125).

### Benefit

- **Conceptual integrity.** Every ADR from #001 to #034 already says "meta-harness" in the running text. The npm name finally matches.
- **Defensive moat from npm's own rules.** No one can typo-squat us with `meta-harness` (dashed).
- **No transition cost for end users** — the name was never widely advertised under prior monikers because nothing was ever successfully published as `mintagent` or `openharness`.

## Alternatives Considered

1. **Stay on `@ruvnet/openharness`** (the scoped fallback from iter 124 step 1). Rejected: scoped names read awkwardly in the user-facing `npx <name>` invocation (`npx @ruvnet/openharness ...`), and the iter-117 user directive explicitly preferred unscoped one-word CLIs (the `vercel/vite/pnpm` style).

2. **Pick another available unscoped name** (e.g. `harnessgen`, `agentforge`, `mintforge`). Rejected: every candidate either had the same similarity-rule risk or carried less conceptual weight than `metaharness`. The repo has been talking about itself as a *meta-harness* for two months; choosing anything else would have been a brand reset, not a brand consolidation.

3. **Sunset the published CLI entirely, ship only the library `@ruvnet/agent-harness-generator`.** Rejected: the user's iter-107 directive ("Paste any GitHub repo. Get a custom agent harness.") and the entire Studio onboarding flow are built around an `npx`-runnable CLI. The library wrapper exists for embedding; the CLI exists for hands.

## Test Contract

| # | File | Assertion |
|---|---|---|
| 1 | `__tests__/metaharness-subcommands.test.ts` | The `main()` router exists and the subcommand verbs (`new`, `from-repo`, `analyze`, `genome`) all route correctly. |
| 2 | `__tests__/agent-harness-generator-lib.test.ts` | `@ruvnet/agent-harness-generator` re-exports `scaffold`, `HOSTS`, `TEMPLATES` (no asserting on what package they live in — re-exports are opaque to the consumer). |
| 3 | grep gate | `grep -rln 'mintagent\|openharness\|MintAgent\|OpenHarness' --include='*.ts' --include='*.json' --include='*.md' --include='*.mjs' \| grep -v node_modules \| grep -v dist/` returns empty. (Run by CI to catch a future regression.) |
| 4 | `apps/web-ui/e2e/generator.spec.ts` | The H1 matcher reads `/MetaHarness Studio/i`. |
| 5 | npm publish surface | `npm view metaharness version` returns the current published version. |

## References

- ADR-001 — *Goals and non-goals* (introduces the term "meta-harness").
- iter-108 commit `88540a0` — original `agentmint` rename (npm name conflict resolution).
- iter-108b commit `b74098e` — `agentmint → mintagent` (user verb-first preference).
- iter-117 commit `76914f5` — MintAgent → "Open Harness Studio" Web UI rename + Getting Started action launcher.
- iter-118 commit `1432ed8` — `mintagent → openharness` brand rename.
- iter-124 publish — `metaharness@0.1.0` claimed on npm.
- [npm anti-typosquatting policy](https://docs.npmjs.com/policies/abuse-prevention) — the similarity rule that drove this iter.
- iter-117 "Suggested command model" user directive (in-conversation, not in any committed ADR before this one) — "Before generation: mintagent. Inside generated harness: harness."
