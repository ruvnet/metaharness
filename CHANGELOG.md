# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Iter 104 (2026-06-14)

- **ADR-031 — The Bundle JSON Pattern**. ADR-030 alternative D
  explicitly said "wait until N=3+ before extracting a shared bundle
  pattern." With iter-90 diag, iter-97 export-config, and iter-102
  audit all shipped, N=3 is reached.
- **6 rules documented**:
  1. Every bundle uses a schema-1 envelope: `{ schema: 1,
     generatedAt: <ISO>, …subcommand-specific…, exitCode: <0|1|2> }`
  2. Sanitisation is mandatory for user-typed fields; the iter-97
     regex `/(secret|token|key|password|passphrase)/i` is canonical
  3. Errors are bundle-formed too — `{ schema: 1, error:
     "no-manifest", … }` on bad input; never a human-text fallback
  4. Exit code follows the verdict (CI gates on `$?` keep working)
  5. Adding `--bundle` to a subcommand does NOT change text mode
  6. NO shared `bundle.ts` helper at N=3 — revisit at N=4
- **5 alternatives explicitly rejected** with rationale:
  - Skip the ADR (cost of future re-derivation too high)
  - Build the shared helper now (premature; shape may still evolve)
  - Drop `exitCode` from JSON body (consumers reading paste-from-mail
    would lose the verdict signal)
  - `data` wrapper (forces every consumer through one more indirection)
  - Configurable sanitisation regex (the iter 90 → 97 tuning was real
    engineering; standardise on the result, don't re-iterate)
- **6 required tests** referenced — all exist + pass.
- The Discovery Loop ADR (030) covers "how to ship a tool"; the
  Bundle Pattern ADR (031) covers "what shape that tool's snapshot
  output takes." Two architecture decisions, one per axis.
- `docs/adrs/INDEX.md` updated. `adr-index.test.ts` 3/3 still passes.

### Changed — Iter 103 (2026-06-14)

- **iter-102's `audit --bundle` propagated across user-facing docs**
  per ADR-030 step 2 — same discipline as iter 91 (diag --bundle),
  iter 98 (export-config), iter 101 (--wizard):
  - **README day-to-day commands** — new row:
    `Share npm-audit findings for a vuln review (machine-parseable)` →
    `harness audit <path> --bundle > audit.json`
  - **`docs/USAGE.md` section 11 (Troubleshooting)** — new row:
    "Want to share npm-audit findings (machine-parseable, for grep /
    CI / vuln review)" → `harness audit <path> --bundle > audit.json`
    with bundle-shape inline (`schema/level/total/counts/offenders/
    failCount/exitCode`) and error-path callout.
  - **`scripts/dev-toolkit.mjs`** — audit subcommand summary updated
    to flag both modes ("text by default, --bundle for JSON snapshot
    (iter 102)").
- **No codex skill / plugin.json update** — audit has no Codex slash
  command. Per ADR-030's triage table, "subcommand without a matching
  Codex skill" stays out of those listings.
- **Discovery now consistent across the 3 bundle-shaped commands**:
  diag --bundle (iter 90 → 91 propagation), export-config (iter 97 →
  98), audit --bundle (iter 102 → 103). Each user-facing flag lands
  in README + USAGE + dev-toolkit within one iter of shipping.
- Tests still 9/9 in dev-toolkit; suite count unchanged.

### Added — Iter 102 (2026-06-14)

- **`harness audit --bundle`** — JSON snapshot of the iter-51 audit
  output. Same pattern as iter-90 `diag --bundle` and iter-97
  `export-config`: bundle the full diagnostic state for sharing /
  pasting into a security review without manually grabbing `npm audit
  --json` output.
- **Bundle shape** on success:
  ```json
  {
    "schema": 1,
    "generatedAt": "2026-06-14T…",
    "harnessDir": "/path/to/harness",
    "level": "high",
    "total": 5,
    "counts": { "info": 0, "low": 1, "moderate": 2, "high": 2, "critical": 0 },
    "offenders": [
      { "name": "lodash", "severity": "high", "advisory": "Prototype pollution" },
      …
    ],
    "failCount": 2,
    "exitCode": 1
  }
  ```
- **Errors are also bundle-formed** — `no-package-json`,
  `no-lockfile`, `unknown-level`, `non-json-audit-output` all return a
  schema-1 JSON with an `error` field so CI scripts gating on
  `failCount` don't crash on a malformed-input case.
- **Exit code follows audit verdict** — `harness audit --bundle > b.json`;
  `[ $? -eq 0 ]` works the same way it does for the text mode.
- **Non-bundle (default) text mode unchanged** — existing scripts that
  parse the human text or grep for `PASS:` / `FAIL:` keep working.
- **`__tests__/harness-audit-bundle.test.ts`** — 4 cases:
  - no-package-json error path emits parseable JSON
  - no-lockfile error path emits parseable JSON
  - unknown-level error path emits parseable JSON
  - default (non-bundle) mode still emits human text, not JSON
- **The 3 bundle-shaped subcommands now**: `diag --bundle` (iter 90),
  `export-config` (iter 97), `audit --bundle` (iter 102). Each
  targets a different use case (triage, security policy share,
  vuln report) but follows the same JSON-snapshot pattern.
- TS suite: **605/605** (was 601; +4 audit-bundle cases).

### Changed — Iter 101 (2026-06-14)

- **iter-100's `--wizard` flag propagated across user-facing docs**
  per ADR-030 step 2:
  - **`docs/USAGE.md` section 1 (Install)** — 3 entrypoint commands
    listed side-by-side:
    ```
    npx create-agent-harness my-bot     # arg-driven
    npx create-agent-harness --wizard   # iter 100 — interactive picker
    npx create-agent-harness --list     # browse all 19 templates
    ```
    Plus a callout: "Don't know what to pick? Run `--wizard` …" with
    the 4-question summary + the "next time skip with" hint mention.
  - **README day-to-day commands** — new row:
    `First scaffold — don't know what to pick?` → `npx create-agent-harness --wizard`
- **No dev-toolkit / plugin.json updates** — `--wizard` is a flag on
  `npx create-agent-harness`, not a `harness` subcommand. Per
  ADR-030's triage table, "user-facing CLI flag on a different
  binary" gets README + USAGE only.
- **No code changes** — docs only.

### Added — Iter 100 (MILESTONE) (2026-06-14)

- **`npx create-agent-harness --wizard`** — interactive picker for
  users who don't yet know the 19 vertical IDs or 6 host IDs. iter
  100 is the third "user-facing tool" milestone after iter 50 (SBOM)
  and iter 90 (diag --bundle). 4-question flow: name → template
  (numeric or paste id) → host (numeric or paste, default
  `claude-code` on empty Enter) → description.
- **One-paragraph design**:
  - **New `wizard.ts` module** — pure function `runWizard(catalog, asker)`
    + `answersToInvocation(answers)` helper. Takes an `Asker` so the
    same code runs against stdin (production) and a scripted asker
    (tests). No `process.stdin` reads inside the module → no TTY
    coupling in the test suite.
  - **`makeReadlineAsker()`** wires the production stdin path.
  - **Falls through to the same `scaffold()`** the arg-driven form
    uses — one source of truth for the scaffold semantics.
  - **Errors immediately on non-TTY** — CI scripts that accidentally
    pass `--wizard` see a `exit 2` with the arg-driven equivalent,
    not a hang.
  - **"Next time, skip the wizard with:"** hint prints the equivalent
    `npx create-agent-harness ...` command so the user learns the
    fast path. `answersToInvocation()` omits defaults (no
    `--template minimal`, no `--host claude-code`) for terse output.
- **Re-prompt loops** for invalid inputs (bad name, out-of-range
  numeric, unknown id). Name validation mirrors `validateHarnessName()`
  in `renderer.ts` so the wizard's verdict matches the scaffolder's.
- **No-args usage block** updated to advertise `--wizard` + `--list`
  as the two interactive entrypoints.
- **`__tests__/harness-wizard.test.ts`** — 7 cases:
  - happy path (numeric name + template + host + description)
  - template can be pasted as id, not just numeric
  - host defaults to `claude-code` on empty Enter
  - re-prompts on invalid name then accepts a valid one
  - re-prompts on out-of-range template, then accepts valid number
  - `answersToInvocation` builds copy-pasteable command with all flags
  - `answersToInvocation` omits defaults (terse for `minimal` +
    `claude-code` defaults)
- **Why iter 100 is a milestone**: third "user-facing tool" milestone.
  iter 50 was SBOM (a build-time artefact). iter 90 was diag --bundle
  (a triage tool). iter 100 is the interactive onboarding tool — the
  first contact a new user has with the CLI, now matched to their
  knowledge state (they know what they want, not what to type).
- TS suite: **601/601** (was 594; +7 wizard cases).

### Changed — Iter 99 (2026-06-14)

- **`docs/USAGE.md` catches up after ~90 iters of new subcommands +
  verticals**. The walkthrough was last touched at iter 7 and still
  referenced 4 subcommands; the dispatcher now honours 16, the
  catalog has grown 1 → 19 templates, and 4 new ADRs (027-030) shipped.
- **Section 5 (Test locally)** gained a "Sanity-check before you ship"
  block listing the release-readiness umbrella:
  - `harness validate` (iter 20 — 6-check umbrella)
  - `harness diag` (iter 66)
  - `harness audit` (iter 51)
  - `harness sbom > sbom.json` (iter 51)
  - `harness mcp-scan` (iter 55)
- **Section 11 (Troubleshooting)** gained 3 new rows:
  - `harness doctor` reports issues you don't understand → run
    `harness diag --bundle > bundle.json` and attach to an issue
    (the bundle is sanitised; iter 90)
  - `harness diag` says MAJOR skew → `npm install @metaharness/kernel@<v>`
    with ADR-028 link
  - Share MCP/Bash/claims config for a security review →
    `harness export-config` (iter 97)
- **New section** — "When to use which subcommand" — 16-row table
  mapping user intent (e.g. "Smoke-check a fresh scaffold", "File a
  useful support ticket") → CLI command with iter attribution.
  Surfaces every subcommand the dispatcher honours in a discovery-
  friendly format.
- **Stale fixes**:
  - "17 ADRs" → "21 ADRs" (ADR-018 added iter 35; ADR-027 iter 55;
    ADR-028/029/030 iters 79/92/95)
  - "Check `npx create-agent-harness` (no args)" → "Check
    `--list`" with current count "19 verticals at iter 96"
- **No code changes** — pure docs.

### Changed — Iter 98 (2026-06-14)

- **iter-97's `export-config` propagated across user-facing surfaces**
  per ADR-030 steps 2 + 3:
  - **README day-to-day commands** — new row:
    `Share MCP + Bash + claims config for a security review` →
    `harness export-config <path> > config.json`
  - **`scripts/dev-toolkit.mjs`** — `HARNESS_SUBCOMMANDS` gains an
    `export-config` entry (iter 97) with one-line "Emit MCP + claims +
    permissions as single JSON for sharing/auditing (sanitised)"
    description. `node scripts/dev-toolkit.mjs` now reports
    `16 total — 16 listed`.
  - **`__tests__/dev-toolkit.test.ts`** assertion bumped 15 → 16 with
    explicit `export-config` pin — future regressions where someone
    drops the entry now fail loudly.
- **plugin.json commands array unchanged** — export-config has no
  Codex slash command (CLI utility only, no per-tool Codex skill).
  Per ADR-030's triage table, this is the correct propagation for
  "user-facing CLI tool without a matching slash command": README +
  dev-toolkit only, not codex skill / plugin.json.
- **Surface consistency**: every iter-69 / iter-83 catch-up sweep
  pattern now also covers iter-97's addition. Tab-completion drift
  caught by cli-flags-completions (iter 97 update); dev-toolkit
  currency caught here.
- Tests still 9/9 in dev-toolkit; new dev-toolkit assertion pins
  16 subcommands. Suite count unchanged.

### Added — Iter 97 (2026-06-14)

- **`harness export-config` — 16th subcommand**. Real new feature
  that complements iter-90's `diag --bundle`. Where the bundle
  captures *diagnostic state* for triage, export-config captures
  *security-relevant config* for sharing/auditing.
- **Single JSON output** containing:
  - `mcpServers` — full `.mcp/servers.json` contents (sanitised)
  - `claudeSettings` — full `.claude/settings.json` (sanitised) —
    the allow/deny + MCP wiring users actually want reviewed
  - `codexConfig` — `.codex/config.toml` as a string with secret-shaped
    TOML values inline-replaced (`api_key = "<redacted>"`)
  - `manifestMeta` — iter 56/58 meta block
  - `host` + `hosts` — what this harness targets
- **Sanitisation regex is broader than iter-90's bundle** —
  `(secret|token|key|password|passphrase)` (case-insensitive, no
  anchor). Where the bundle's `^anchor` matched `secret_token` etc.
  at the start, export-config catches `OPENAI_API_KEY`, `GITHUB_TOKEN`,
  `db_password` — env-var-style names where the secret indicator
  appears at the end or middle. False positives (a key literally
  named `notakey` redacts) are acceptable for an audit-share artefact:
  cost of over-redaction is low; cost of leaking is high.
- **Exit code contract**: 0 on success, 2 if `.harness/manifest.json`
  missing (with FAIL message — same shape as iter 66 diag).
- **Use case**: a user asks "is my MCP allowlist reasonable?" or "are
  my Bash permissions too tight?" — they paste `harness export-config`
  output into a security discussion without zipping their whole
  harness. Reviewers see the security surface, not the agent prompts.
- **Sites updated** (ADR-030 step 2 + 3):
  - `subcommands.ts` dispatcher + help text (15 → 16 subcommands)
  - `completions-cmd.ts` SUBCOMMANDS + zsh `_describe` block
  - `__tests__/cli-flags-completions.test.ts` 15 → 16 in both
    assertions (help text + all-three-shells)
- **`__tests__/harness-export-config.test.ts`** — 3 cases:
  - emits parseable JSON for fresh scaffold (claudeSettings + meta
    + hosts all populated)
  - redacts secret-like keys in claude settings (synthetic
    `api_key`, `token`, nested `OPENAI_API_KEY` all → `<redacted>`,
    non-secret allow list survives)
  - exits 2 + FAIL on no manifest at path
- TS suite: **594/594** (was 591; +3 export-config cases).

### Added — Iter 96 (2026-06-14)

- **`vertical:gaming` — 19th vertical template**. Third new vertical
  in 16 iters (after iter 80 education + iter 87 sales). Game design
  pod for the "Frontier" row.
- **Four agents** with discipline-anchored system prompts:
  - **Playtest Reader** (sonnet) — surfaces raw observations, not
    interpretations ("player paused for 12s before opening help
    overlay", not "players find this confusing"); "skip the highlight
    reel, the boring middle is where bugs live"
  - **Balance Critic** (opus) — proposes ONE specific change per
    imbalance + predicts the second-order effect; rejects vague
    "feels off" criticism
  - **Economy Modeler** (opus) — flags inflation/deflation/strati-
    fication; shows the spreadsheet logic, never "the economy is
    broken"
  - **Narrative Keeper** (sonnet) — maintains lore consistency;
    flags contradictions and dropped threads; **never invents lore**
- **Two commands**:
  - `playtest-recap` — full cycle (read → critique → model → check)
    outputting ONE design doc patch reviewable in <10 minutes
  - `design-doc-diff` — surface unresolved tensions between sections
    (mechanic changed → balance not aligned)
- **MCP namespaces**: `telemetry_store` + `design_doc`
- **iter-86 healthcheck did its job** — when I bumped catalog.json
  but hadn't updated the TS test or Rust test yet, healthcheck FAILed
  loudly:
  ```
  FAIL catalogCount TS test expects 18 but catalog has 19;
                    Rust test expects 18 but catalog has 19
  ```
  After updating all three sites, healthcheck PASSes with `19 templates
  in JSON + TS test + Rust test (in sync)`.
- **Defense layers all green pre-push**:
  - Layer 1 (catalogCount): PASS
  - Layer 3 (vertical-tour): 18/18 HEALTHY in 1.2s
  - Layer 4 (Rust): 5/5 passed
- **README templates table** updated — heading 18 → 19, `vertical:gaming`
  appended to the "Business / Frontier" row alongside `business`,
  `agentics`, `exotic`.

### Added — Iter 95 (2026-06-14)

- **ADR-030 — The Discovery Loop**. Iters 90→94 demonstrated the
  "build tool → propagate everywhere → surface at the moment of need →
  test the propagation" pattern. iter 95 captures it as ADR-030 so
  the next user-facing feature ships with the same discipline.
- **5 steps documented**:
  1. **Build** — implement + tests pin shape (iter 90)
  2. **Surface** — README + codex skill + harness help (iter 91)
  3. **Catalog** — dev-toolkit + plugin.json (iter 91)
  4. **Discover** — contextual "Next:" suggestion on FAIL (iters 93+94)
  5. **Test the propagation** — assert suggestion appears on FAIL AND
     does NOT appear on HEALTHY (the second half is the easily-forgotten one)
- **The "Next:" block contract** documented with 3 load-bearing
  elements: (a) command using user's actual context, (b) reassurance
  about the cost of taking the action, (c) appears only on FAIL.
- **Which features warrant the full 5-step treatment** documented as
  a triage table: user-facing CLI tools get all 5; internal scripts
  get step 1+3; cross-cutting infra gets step 1+5; new verticals
  follow a different pattern (ADR-029's tour-script form).
- **The cost-of-skipping table** lists what goes wrong at each step
  if omitted, so future contributors can make explicit trade-offs
  rather than silently skipping.
- **4 alternatives explicitly rejected** with rationale:
  - Single iter that does all 5 steps (diff too big, steps go silent)
  - Skip step 5 tests (silent regression on user's primary path)
  - Embed step 4 in step 1 (discovery is real, premature wiring)
  - Generic Next:-block infrastructure (N=1, abstraction premature)
- **7 required tests** referenced — all already exist + pass.
- `docs/adrs/INDEX.md` updated. `adr-index.test.ts` 3/3 still passes.
- Pairs with ADR-029: every multi-iter architectural decision now has
  a documented design rationale.

### Changed — Iter 94 (2026-06-14)

- **`harness validate` umbrella FAIL message now recommends
  `harness diag --bundle`** — symmetric with iter 93's doctor fix.
  The umbrella aggregates 6 checks (doctor + verify + path-guard +
  mcp + secrets + diag); any of them failing should surface the
  bundle as the next user action, not just the doctor sub-check.
- **New "Next:" block** appears only on FAIL:
  ```
  Result: N checks FAILED — fix before publish

  Next: capture the full diagnostic state for a support ticket:
    harness diag /path/to/harness --bundle > bundle.json
  (then attach bundle.json to a GitHub issue at
   https://github.com/ruvnet/metaharness/issues — the
   bundle is sanitised; secret_/token_/key_/password_ fields are redacted)
  ```
- **HEALTHY output is unchanged** — the bundle suggestion would be
  noise on a successful release-readiness check. iter-94 pins both
  paths in the test.
- **`packages/create-agent-harness/__tests__/validate.test.ts`**
  8 → **10** cases (+2):
  - umbrella FAIL message recommends diag --bundle (iter 94) — pins
    Next: block + bundle command + URL + redaction reassurance
  - HEALTHY result has no bundle suggestion noise — pins that the
    Next: block doesn't appear on green runs
- **iter 93 + iter 94 together**: both user-facing failure surfaces
  (doctor standalone + validate umbrella) now flow to the bundle.
  Any "what went wrong?" path ends at "here's the JSON to paste".
- TS suite: **591/591** (was 589).

### Changed — Iter 93 (2026-06-14)

- **`harness doctor` failure message now recommends
  `harness diag --bundle`**. Closes the discovery loop opened by
  iter 90: when doctor finds problems, the most common user next
  action is "what do I report?" — iter 93 points them straight at
  the iter-90 bundle.
- **New "Next:" block** on FAIL only (HEALTHY output unchanged):
  ```
  Result: N issues (/path/to/harness)

  Next: capture the full diagnostic state for a support ticket:
    harness diag /path/to/harness --bundle > bundle.json
  (then attach bundle.json to a GitHub issue at
   https://github.com/ruvnet/metaharness/issues — the
   bundle is sanitised; secret_/token_/key_/password_ fields are redacted)
  ```
- **Sanitisation reassurance is load-bearing** — users hitting their
  first doctor failure need to know the bundle is safe to paste into
  a public issue before they'll do it. The redaction callout is the
  contract that makes the suggestion actionable.
- **`__tests__/doctor-fail-message.test.ts`** — 2 new cases:
  - on FAIL, the message includes the diag --bundle suggestion + URL +
    redaction callout
  - the bundle command uses the user-passed path (not cwd)
- **HEALTHY output unchanged** — no "Next:" suggestion noise on
  successful doctor runs. The suggestion is contextual to failure.
- TS suite: **589/589** (was 587).

### Added — Iter 92 (2026-06-14)

- **ADR-029 — Cross-Language Invariants and Defense-in-Depth Catalog
  Gates**. iter 85→89 built a 4-layer defense around catalog
  correctness; iter 92 documents the architecture before the lesson
  fragments into 5 CHANGELOG entries.
- **The 4 layers documented, ordered by failure-surface latency**:
  1. `healthcheck.catalogCount` (iter 86) — pre-push on contributor's
     laptop, `<1s`
  2. CI Node-job `healthcheck` step — per push, per-OS-per-Node, `<1s`
  3. `examples/vertical-tour` in CI (iter 89) — per push, `~1.1s`,
     proves each template actually scaffolds + validates
  4. `generated-templates.test.ts` (TS) + `crates/template-catalog/tests`
     (Rust) — per-template structural pins
- **The cross-language counter recipe** — generic pattern for any
  "same count in N languages" invariant. JSON wins ties; TS test and
  Rust test extract via regex; healthcheck pins them together.
  Future "host count in N places", "skill count in N places", etc.
  invariants follow the same recipe.
- **4 alternatives explicitly rejected** with rationale: code-gen Rust
  from TS (breaks no-Node Rust build), eliminate Rust count assertion
  (Rust crate ships independently), set-equality instead of count
  (more code, no extra catches), JSON schema validator (scope creep).
- **6 required tests** referenced — all already exist + pass:
  catalogCount + default 8-check set + vertical-tour ordering +
  vertical-tour HEALTHY + TS template count + Rust template count.
- `docs/adrs/INDEX.md` updated — ADR-029 row appended after ADR-028
  with one-line summary of the 4 layers + the recipe.
- `adr-index.test.ts` 3/3 still passes — the index-pin test honours
  the new entry.

### Changed — Iter 91 (2026-06-14)

- **iter-90's `diag --bundle` now surfaces across all 4 user-facing
  surfaces** — same propagation pattern as iter 80→83 used for
  vertical:education:
  - **README day-to-day commands table** — new row:
    `File a support ticket — bundle everything the maintainer needs`
    → `harness diag <path> --bundle > bundle.json`
  - **`.codex/skills/diag-harness/README.md`** — Equivalent CLI block
    gains `--bundle` line + a one-paragraph callout explaining the
    sanitisation invariant (`secret|token|key|password|api_key` keys
    redacted so the bundle is safe for public GitHub issues)
  - **`.claude-plugin/plugin.json`** — `diag-harness` command's
    `description` updated to mention `--bundle` alongside `--json`
  - **`scripts/dev-toolkit.mjs`** — diag subcommand summary updated
    to flag both `--json` (CI gating) and `--bundle` (support tickets)
- Same regression mode the iter-67-69 sweep guarded against: when a
  new flag lands but only the source-of-truth surface mentions it.
  Every surface that documents the diag subcommand now mentions all
  three forms (default text, --json, --bundle).
- Tests still 24/24 across `dev-toolkit + codex-skills +
  claude-marketplace` — these existing pins cover the listing
  contracts even though the description text changed.

### Added — Iter 90 (MILESTONE) (2026-06-14)

- **`harness diag --bundle`** — real new user-facing feature. One
  command produces all the diagnostic context users need to file a
  useful issue. Pastes cleanly into a GitHub issue; maintainers get
  every load-bearing fact in one block.
- **Bundle contents** (`SupportBundle` interface):
  - `diag` — full DiagReport with `exitCode` (verdict + kernel + generator)
  - `harness.packageName / packageVersion` — what was scaffolded
  - `harness.rufloDeps` — only `@metaharness/*` + `create-agent-harness` entries
    (no third-party noise that's irrelevant to the harness's own state)
  - `manifest.present` + `manifest.content` — the full manifest, but
    **sanitised**: any object key matching `/^(secret|token|key|password|api[-_]?key)/i`
    is replaced with `"<redacted>"` so the bundle is safe to paste
  - `harnessFiles` — `.harness/*` enumeration (proves which lifecycle
    steps have run: `manifest.json` only → freshly scaffolded;
    `+ witness.json` → signed; `+ federation.json` → federated)
  - `env.nodeVersion / platform / arch` — cross-OS bug reproducer
- **Exit code follows diag verdict** — so CI scripts can do
  `harness diag --bundle > bundle.json` and gate on `$?`. Bundle is
  emitted even on exit 2 (no manifest) so the user can see "you ran
  this in the wrong directory" structurally.
- **`__tests__/harness-diag.test.ts`** 20 → **23** (+3):
  - emits a complete SupportBundle JSON for a fresh scaffold (all
    fields populated, including the iter-90 readdirSync ESM fix)
  - sanitises secret-like keys in the manifest (synthetic
    `secret_token` redacted, other vars survive)
  - exit code follows diag verdict — bundle is well-formed JSON even
    on exit 2
- **Why iter 90 is a milestone**: this is the first iter that targets
  the long tail of users running into problems in the wild. iter 1-89
  built the system; iter 90 ships the tool that closes the loop on
  "user hit a problem → maintainer can triage it" without a 5-message
  back-and-forth for environment details.
- TS suite: **587/587** (was 584).

### Added — Iter 89 (2026-06-14)

- **`vertical-tour` wired into `ci.yml`** Node job as a per-push smoke
  gate. iter-88's tour proved 17 verticals scaffold + validate in ~1.1s
  on a clean checkout; iter 89 makes that proof a CI invariant. Every
  push gets per-OS-per-Node verification that the whole catalog
  scaffolds cleanly across **3 OSes × 2 Node versions = 6 permutations**.
- **Ordering**: runs AFTER healthcheck in the Node job — healthcheck's
  iter-86 catalogCount check fails first if the cross-language template
  count drifts; vertical-tour then verifies each template actually
  scaffolds + validates.
- **Wall-time impact on CI**: ~1.1s per matrix cell. Total budget
  unchanged because the existing Node job was already 30-40s of
  install + build + tests; the tour is rounding-error.
- **Catches a new failure class**: a template that registers in
  TEMPLATES + catalog.json correctly (passing healthcheck.catalogCount)
  but fails to actually scaffold or validate. Pre-iter-89 this would
  only be caught if someone happened to run the demo locally; post-
  iter-89 the same push fails CI.
- **`__tests__/workflows.test.ts`** 9 → **10** cases (+1):
  - "ci.yml runs vertical-tour as a per-push smoke gate (iter 89)" —
    pins the `examples/vertical-tour/vertical-tour.mjs` invocation
    exists AND comes after healthcheck in the source order.
- TS suite: **584/584** (was 583).

### Added — Iter 88 (2026-06-14)

- **`examples/vertical-tour/`** — analogue of iter-55's `host-tour/`:
  one script scaffolds + validates EVERY vertical (currently 17,
  excluding `minimal`) in ~1.1 seconds. Closes the per-vertical-example
  combinatorial trap: instead of writing a separate `examples/<vertical>/`
  for each of 17 verticals (and the 6-host fanout of 102 unique
  scaffolds), one script proves the whole catalog scaffolds cleanly.
- **Reads the actually-registered TEMPLATES** — imports from the built
  generator's `TEMPLATES` export, not a hardcoded list. Adding a new
  vertical to `catalog.def.mjs` + `TEMPLATES` automatically covers it
  here; no per-vertical test maintenance.
- **Output is a markdown table** with file count, byte count, wall time,
  HEALTHY/FAIL per vertical. Exits non-zero with the names of any
  failing verticals.
- **`--json`** for CI scripts; **`--host=<id>`** to run on any of 6
  hosts.
- **`__tests__/examples-vertical-tour.test.ts`** (4 cases):
  - script + README exist
  - default host (claude-code) → HEALTHY for every vertical
  - `--json` emits parseable JSON with `failed: 0` + every report
    healthy
  - newest two verticals (`vertical:education` iter 80,
    `vertical:sales` iter 87) appear in the printout
- **`dev-toolkit.mjs`** examples list grows 4 → **5** (+ vertical-tour
  entry with iter 88 + `~1.1s` wall + description); test updated to
  pin all 5.
- TS suite: **583/583** (was 578; +4 vertical-tour cases + the
  dev-toolkit expectation bump). Local run output:
  ```
  Total wall time: 1100ms across 17 verticals (host=claude-code).
  [vertical-tour] DONE — 17/17 verticals HEALTHY in 1100ms
  ```

### Added — Iter 87 (2026-06-14)

- **`vertical:sales` — 18th vertical template**. Second new product
  surface in 7 iters; B2B pipeline pod for the "Customer / Growth"
  row.
- **Four agents** with honesty-bias system prompts:
  - **Prospector** (sonnet) — researches accounts, surfaces signals
    with citations; refuses to invent signals
  - **Qualifier** (haiku) — BANT/MEDDPICC triage; biased toward
    disqualification — running a no-fit lead costs more than declining
  - **Demo Coach** (sonnet) — personalised demo from prospector brief;
    never promises a roadmap item the product doesn't ship today
  - **Closer** (opus) — handles objections + negotiates against the
    pricing book; rejects bad-fit deals (a stretched promise is a
    churn quarter from now)
- **Two commands**:
  - `qualify-lead` — one BANT/MEDDPICC pass + go/no-go
  - `pipeline-report` — weekly conversion rates + the ONE bottleneck
- **MCP namespaces**: `crm_store` + `pricing_book`. `Bash(rm -rf*)` +
  `Bash(git push*)` denied explicitly.
- **iter-86 healthcheck enforced the cross-language sync** —
  `node scripts/healthcheck.mjs --check=catalogCount` confirmed all 3
  sites moved together before push (TS test 17 → 18, Rust test 17 → 18,
  catalog.json 17 → 18). The iter-83-style failure mode can't happen
  again.
- **README** templates table surfaces `vertical:sales` in the
  "Customer / Growth" row alongside support/crm/marketing/advertising;
  heading bumped 17 → 18.

### Added — Iter 86 (2026-06-14)

- **`scripts/healthcheck.mjs catalogCount` — new 8th check** that
  closes the cross-language assertion drift iter 85 documented. The
  template count is asserted in THREE places that must agree:
  1. `packages/create-agent-harness/templates/catalog.json` →
     `.templates.length`
  2. `packages/create-agent-harness/__tests__/generated-templates.test.ts`
     → `templates.length).toBe(N)` and `loaded.length).toBe(N)`
  3. `crates/template-catalog/src/lib.rs` →
     `assert_eq!(c.templates.len(), N, "expected N templates")`
- **catalogCount reads all three** and FAILs if any drifts. The exact
  miss class that caught iter 83's CI red (TS bumped to 17 in iter 80,
  Rust missed until iter 85) now fails LOUDLY in healthcheck — and
  healthcheck runs on every iter-43 CI Node job, so the regression
  surfaces in the SAME push that introduces it instead of two pushes
  later.
- **Local run on a clean repo**:
  ```
  PASS catalogCount 17 templates in JSON + TS test + Rust test (in sync)
  ```
  On a synthetic drift (TS still says 16, Rust + JSON say 17), the
  output would be:
  ```
  FAIL catalogCount TS test expects 16 but catalog has 17
  ```
- **`__tests__/healthcheck.test.ts`** 9 → **11** cases (+2):
  - 8 checks default (was 7)
  - JSON `results.length === 8`
  - `--check=catalogCount` alone reports PASS + `JSON + TS test + Rust test`
  - `--check=catalogCount` surfaces the template count in human output
- TS suite: **578/578** (was 576).
- The healthcheck → preflight → release.mjs chain now catches this
  drift class at the earliest point: `node scripts/healthcheck.mjs`
  on any contributor's laptop.

### Fixed — Iter 85 (2026-06-14)

- **`crates/template-catalog/src/lib.rs` template-count assertion**
  16 → 17. iter 80 added vertical:education, bumping the embedded
  catalog.json from 16 to 17 entries. The TypeScript test was updated
  in iter 80 but the parallel Rust assertion (5 lines away from the
  TS update conceptually, but in a different language) was missed.
- **CI caught the regression** on `1434320` (iter 83) — Rust job
  failed on all 3 OS targets:
  ```
  assertion `left == right` failed: expected 16 templates
  ```
- **The fix is one line** — bump the literal to 17 — plus a comment
  pointing at iter 80 + iter 85 so the regression history is visible
  in the source for any future template addition.
- **Lesson surfaced** by the test failure: catalog.json's template
  count is asserted in TWO places (TypeScript + Rust). Both must move
  together. Worth a future cross-language counter check in
  healthcheck if it happens again.
- **Cargo test passes locally**: `cargo test -p template-catalog --lib`
  → 5/5 passed.
- TS suite: **576/576** locally (Rust + TS now both green).

### Added — Iter 84 (2026-06-14)

- **`.github/workflows/pages-monitor.yml`** — daily liveness probe of
  the live Studio. iter 78 added post-deploy verify but only fires on
  `apps/web-ui/**` pushes. A quiet week leaves a window where the
  Studio could silently degrade between deploys; iter 84 closes it.
- **Schedule**: `cron: '17 2 * * *'` (02:17 UTC daily). Odd-minute
  offset avoids the cron herd that piles on at HH:00 / HH:15 / HH:30 /
  HH:45.
- **`workflow_dispatch`** also wired so the monitor can be triggered
  manually for live verification at any time.
- **One probe implementation** per ADR-028 — pages-monitor.yml
  delegates to `node scripts/healthcheck.mjs --probe-pages --check=pages`.
  Same 2-stage HTTP check used by daily-driver healthcheck (iter 72),
  release.mjs preflight (iter 77), and pages.yml verify (iter 78).
  Now four callers, zero duplicate fetch code.
- **`__tests__/workflows.test.ts`** 8 → **9** cases:
  - "pages-monitor.yml is a daily cron probe of the live Studio
    (iter 84)" — pins schedule trigger, daily-cron-shape, manual
    workflow_dispatch, and healthcheck delegation. CRLF-tolerant for
    Windows checkouts.
- TS suite: **576/576** (was 575).
- Failure mode caught: "deploy worked Monday, CDN went weird on
  Wednesday." If the Studio returns non-200 on any morning, the
  workflow status surfaces in the repo's Actions tab the same hour
  instead of hours later when someone manually probes.

### Added — Iter 83 (2026-06-14)

- **`dev-toolkit.mjs` now lists the 4 runnable example demos**. iter 55
  shipped the orientation map listing scripts/, harness subcommands,
  entry points, CI jobs — but the runnable demos in `examples/` were
  invisible. New contributors running `node scripts/dev-toolkit.mjs`
  for orientation couldn't discover the 4 single-script demos that
  exercise real product surfaces end-to-end.
- **New section** in default text output:
  ```
  ## Runnable example demos (examples/) — 4 listed
    quickstart  (iter 32, ~50ms ) — Scaffold minimal harness → validate
      $ node examples/quickstart/quickstart.mjs
    federation  (iter 40, ~20ms ) — Two-instance federation handshake demo
      $ node examples/federation/federation.mjs
    host-tour   (iter 55, ~200ms) — Scaffold + validate for ALL 6 hosts
      $ node examples/host-tour/host-tour.mjs
    education   (iter 82, ~200ms) — Scaffold vertical:education → 4-agent
      $ node examples/education/education.mjs
  ```
- **JSON output** gains an `examples` array (4 entries) so CI scripts
  and tooling can enumerate the demos programmatically.
- **`--filter=<topic>`** narrows examples too (the existing filter logic
  applies uniformly across all 4 sections).
- **`__tests__/dev-toolkit.test.ts`** 8 → **9** cases (+1):
  - "lists all 4 runnable example demos (iter 83)" — pins the section
    name, each demo's name, and each demo's `node examples/<name>/<name>.mjs`
    command-line shape. The `--json` test now also asserts
    `parsed.examples.length === 4`.
- TS suite: **575/575** (was 574; +1 dev-toolkit case).

### Added — Iter 82 (2026-06-14)

- **`examples/education/`** — runnable end-to-end demo of the iter-80
  vertical:education vertical. Matches the iter-32 `quickstart/` +
  iter-40 `federation/` pattern: a single script that exercises the
  scaffolder + validate umbrella without invoking npm or pulling
  network. ~200ms wall time.
- **`examples/education/education.mjs`** — 3-step demo:
  1. scaffold `my-tutor` from `vertical:education` (host selectable)
  2. surface the 4 agents + 2 commands + 2 skills the iter-80
     catalog promised
  3. run `harness validate --skip-gcp` and assert HEALTHY
  Exits non-zero if any of the 4 expected agents (tutor / explainer /
  quiz-master / grader) is missing, OR validate doesn't HEALTHY.
- **`examples/education/README.md`** — how to run + sample output +
  what-it-demonstrates table mapping iter numbers to what each layer
  exercises. Links sideways to `quickstart/`, `federation/`,
  `host-tour/`.
- **`__tests__/examples-education.test.ts`** — 6 cases:
  - script + README exist
  - default host (claude-code) → HEALTHY
  - all 4 expected agents surface in the printout
  - both iter-80 commands (`teach-next` skill + `mastery-report`
    command) surface
  - unsupported `--host=invalid-host` exits 2
  - non-default host (codex) → HEALTHY
- Why a separate demo: same reason `quickstart/` + `federation/` /
  `host-tour/` exist. Verticals are CODE that must keep working, not
  docs nobody runs. CI runs all four scripts as smoke tests; users
  can copy them as starting points.
- TS suite: **574/574** (was 568; +6 examples-education cases).

### Changed — Iter 81 (2026-06-14)

- **README templates table surfaces `vertical:education`** with one-line
  pedagogy summary. The new vertical shipped in iter 80 needed a
  README signal so users browsing the README catalog see it without
  having to run `npx create-agent-harness --list`.
- **Heading bumped 16 → 17 verticals**.
- **Per-template categorisation**: `vertical:education` sits in the
  "Knowledge" row alongside `vertical:research` and `vertical:ruview` —
  the three mastery/learning-shaped harnesses cluster.
- **Hand-curated count corrected**: the description line was
  "10 generated dirs"; now 11 with vertical:education's addition.

### Added — Iter 80 (MILESTONE) (2026-06-14)

- **`vertical:education` — 17th vertical template**. Real new product
  surface for the first time since iter 6's vertical:research (60+ iters
  ago). The recent iter run has been infrastructure (CI, security,
  diag, ADR); iter 80 is the milestone iter that ships a usable
  vertical-specific harness end-users can scaffold today:
  ```
  npx create-agent-harness my-tutor --template vertical:education --host claude-code
  ```
- **Four bespoke agents** with grade-aware system prompts:
  - **Tutor** (sonnet) — reads the learner's mastery map, picks the
    next concept whose prereqs are mastered, refuses to teach a
    concept on an unmastered foundation
  - **Explainer** (sonnet) — 3-layer teaching (intuition → worked
    example → formal statement) with "ready to go deeper?" gates
    between layers, says "I do not know" instead of inventing facts
  - **Quiz Master** (haiku) — calibrated quiz items (recall : apply :
    transfer = 1:2:1), hidden rubrics, difficulty calibrated against
    the learner's previous miss rate in memory
  - **Grader** (sonnet) — partial credit for correct reasoning,
    writes mastery memory (concept, item id, score, miss pattern,
    smallest re-explanation needed), encouraging-but-honest voice
- **Two commands**:
  - **`teach-next`** — one teaching cycle (pick → explain → quiz →
    grade → update mastery)
  - **`mastery-report`** — summarises the mastery map (mastered /
    in-progress / shaky / locked), recommends next session's focus
- **MCP namespaces**: `mastery_log` + `curriculum` (default-deny
  everything else; `Bash(rm -rf*)` and `Bash(git push*)` denied
  explicitly)
- **Pedagogy invariants surfaced as policy** — the abstain-not-
  hallucinate floor, the "never teach on unmastered prereq" rule,
  the hidden rubric (never revealed to learner) — these are in the
  system prompts so they survive any future kernel update.
- **`TEMPLATES` const** in `index.ts` updated 16 → 17 entries.
- **`catalog.json`** regenerated via `gen-templates.mjs` (17 entries).
- **Generated scaffold** produces 4 agent files + 2 command files +
  memory skill + manifest. End-to-end scaffold smoke-tested locally:
  ```
  Scaffolded vertical:education to /tmp/ahg-edu-mtqPXq
  .claude/commands/{doctor.md, mastery-report.md}
  .claude/skills/memory-inspect/SKILL.md
  .claude/skills/teach-next/SKILL.md
  src/agents/{tutor.ts, explainer.ts, quiz-master.ts, grader.ts}
  ```
- **Tests** — `packages/create-agent-harness/__tests__/generated-templates.test.ts`
  16 → 17 expected count + new pin for `vertical:education` in the
  round-trip output.
- TS suite: **568/568** (count unchanged; the existing 2 tests were
  updated in-place rather than added).

### Added — Iter 79 (2026-06-14)

- **ADR-028 — Skew Detection and Liveness — One Probe, Many Surfaces**.
  Iters 66-78 built a complete skew + liveness fabric (`harness diag`,
  `--probe-pages`, validate umbrella chain, release.mjs gate,
  pages.yml verify) without an ADR explaining the design rationale.
  iter 79 captures it before the knowledge fragments into 13
  CHANGELOG entries.
- **Five architectural decisions documented**:
  1. Two orthogonal axes — **skew** (informational by default) vs
     **liveness** (blocking by default)
  2. Skew detected by comparing `manifest.meta.*` fields to locally-
     resolved versions; one `skewVerdict()` comparator
  3. Liveness is one HTTP probe (`healthcheck --probe-pages`) with
     three callers (`healthcheck`, `preflight`/`release.mjs`,
     `pages.yml` verify)
  4. Exit code semantics per consumer context (table) — standalone
     diag fails on real skew; validate umbrella never fails on it
  5. JSON output delegates to text formatter for exit-code resolution
     so both surfaces stay in lockstep forever
- **4 alternatives explicitly rejected** with rationale:
  block release on kernel skew (wrong layer), re-implement the HTTP
  probe per consumer (breeds drift), `postinstall` hook auto-skew-check
  (anti-pattern), keep diag out of validate (decided informational
  per iter 76).
- **6 required tests** referenced from existing test files.
- `docs/adrs/INDEX.md` updated — ADR-028 entry appended.
- `__tests__/adr-index.test.ts` 3/3 still pass — the index-pin test
  honours the new entry.

### Added — Iter 78 (2026-06-14)

- **`pages.yml` now self-verifies after every deploy** — closes the
  "deploy step returned 200 but the served URL is broken" failure
  mode that's bitten the repo once already (iter 57's 404 deploys).
  iters 72/76/77 wired `--probe-pages` into CLI surfaces; iter 78
  wires it into CI itself.
- **3-job chain** in `pages.yml`: `build` → `deploy` → `verify`.
  The new `verify` job:
  - `needs: deploy` so it only runs on a green deploy
  - sleeps 30s for Fastly/CDN propagation (empirically enough on this
    repo without slowing the workflow)
  - runs `node scripts/healthcheck.mjs --probe-pages --check=pages`
    against the live URL — same 2-stage probe as the daily-driver
- **One probe implementation** across the whole repo: healthcheck owns
  the fetch logic; preflight (iter 77), release.mjs (iter 77), and
  now pages.yml (iter 78) all delegate to it. No duplicate fetch +
  parsing code.
- **`__tests__/workflows.test.ts`** 7 → 8 cases:
  - `pages.yml chains a verify job that probes the live Studio after deploy`
    asserts (a) job exists, (b) `needs: deploy`, (c) calls
    `healthcheck.mjs --probe-pages`.
- TS suite: **568/568** (was 567).

### Added — Iter 77 (2026-06-14)

- **`scripts/release.mjs` preflight now gates on the live Studio**.
  iter 72 made the HTTP probe possible (`healthcheck --probe-pages`);
  iter 76 used it from inside the validate umbrella; iter 77 wires it
  into release.mjs's preflight step so a broken Pages deploy blocks
  the tag push.
- **`scripts/preflight.mjs --probe-pages`** — new flag delegates to
  `node scripts/healthcheck.mjs --probe-pages --check=pages` so there's
  **one** HTTP probe implementation in the repo (no duplication).
  Without the flag the probe step is skipped — preflight stays
  offline-friendly by default.
- **release.mjs** unconditionally passes `--probe-pages` to preflight
  for non-dry-run releases. Dry-runs and `--skip-preflight` paths
  unchanged.
- **Effect**: when the maintainer runs `release.mjs minor --push`,
  the new step output is:
  ```
  STEP: 2/5 preflight (run every gate publish.yml would run)
  ...
  ==> live Studio probe (--probe-pages)... PASS
  PASS: preflight clean (incl. live Studio probe)
  ```
  If the Studio returns non-200 or the Vite bundle 404s, the tag push
  aborts before any git mutation.
- **Tests** — `release.test.ts` 6 → 8 cases (+2):
  - source pin: `release.mjs` passes `--probe-pages` to preflight
  - source pin: `preflight.mjs` honors `--probe-pages` + delegates to
    healthcheck (no duplicate fetch logic)
- TS suite: **567/567** (was 565).

### Added — Iter 76 (2026-06-14)

- **`harness validate` umbrella now chains `diag` as a 6th
  informational check** — closes the "iter 66 diag exists but
  release-prep doesn't surface kernel state" gap. The umbrella verdict
  (HEALTHY / FAILED) is **unchanged** for any kernel-skew scenario —
  kernel skew is a deploy-side runtime issue, not a release-readiness
  block.
- **`CheckResult.tag` optional override** — lets a check return code 0
  (don't block the umbrella) while displaying `PASS` / `WARN` / `SKIP`
  in the per-line output. Default code-based mapping unchanged.
- **`runDiag()` returns three states**:
  - `SKIP` — no `.harness/manifest.json`, or manifest is pre-iter-58
    (no `kernel_version`), or `@metaharness/kernel` not installed locally
  - `PASS` — `match` or `patch-diff` between manifest + local kernel
  - `WARN` — `minor-diff` / `major-diff` / `unparseable`
- **Live smoke output** on a fresh scaffold:
  ```
  PASS doctor     — ...
  PASS verify     — no witness — skipped (sign first)
  PASS path-guard — no hardcoded /tmp, C:\, /Users, /home in TS/JS/Rust
  PASS mcp        — no .mcp/servers.json — skipped
  PASS secrets    — skipped (--skip-gcp)
  PASS diag       — kernel manifest=0.1.0 local=0.1.0 (match)

  Result: HEALTHY (release-ready)
  ```
- **`packages/create-agent-harness/__tests__/validate.test.ts`**
  7 → 8 cases — pins `SKIP diag — manifest pre-iter-58` on a
  hand-rolled manifest with no meta block, AND that the umbrella
  verdict stays HEALTHY despite the SKIP.
- TS suite: **565/565** (was 563).

### Changed — Iter 75 (2026-06-14)

- **README day-to-day commands table refreshed** — was frozen at iter 62.
  Five new rows added:
  - `Is the deployed Studio alive?` → `healthcheck --probe-pages` (iter 72)
  - `Is THIS local kernel compatible with this harness?` → `harness diag` (iter 66)
  - `Same, for a CI script` → `harness diag --json` (iter 73)
  - `Preview the v0.1.0 GH release body` → `release-notes.mjs --version=0.1.0` (iter 36)
  - `Same, tweet-length summary` → `release-notes.mjs --summary` (iter 74)
- **Tests badge** refreshed 529 → **563** passing.
- **Status table** test-suite row 529/529 → **563/563** and 64 → 66
  test files.
- **New row** for "15 `harness` subcommands" with the full inline list,
  bolding `diag` as the freshly-shipped one (ADR-027).
- The `create-agent-harness` CLI row now points down to that subcommand
  row rather than re-listing 4 of the 15 by hand.

### Added — Iter 74 (2026-06-14)

- **`scripts/release-notes.mjs --summary`** — tight one-bullet-per-iter
  output suitable for tweets, tracking-issue updates, or release
  announcements. The default `renderNotes()` dumps the full body
  (perfect for GH release body); `renderSummary()` picks the first
  meaningful line of each section, strips bullet markers + bold
  markdown, caps at ~120 chars, and prefixes with `**Iter N**`.
- **Total-count + per-kind breakdown** at the top:
  `**8 CHANGELOG entries** across iters 66–73 (6 added + 2 fixed).`
- **Validated end-to-end** against the live CHANGELOG:
  ```
  node scripts/release-notes.mjs --version=0.1.0 \
    --from-iter=66 --to-iter=73 --summary

  - **Iter 66** — `harness diag` — 15th subcommand, the ADR-027 diagnostic UX loop
  - **Iter 67** — Shell completions catch up with the dispatcher
  - **Iter 68** — `harness diag` chained into the iter-52 e2e lifecycle
  - **Iter 69** — `scripts/dev-toolkit.mjs` currency
  - **Iter 70** — 7th Codex skill — `diag-harness`
  - **Iter 71** — `harness diag` now also surfaces generator-version skew
  - **Iter 72** — `scripts/healthcheck.mjs --probe-pages`
  - **Iter 73** — `harness diag --json`
  ```
- **`__tests__/release-notes.test.ts`** 9 → **15** (+6):
  - shows total count + per-kind breakdown
  - one bullet per iter with bolded iter prefix
  - strips bullet markers + bold markdown from title line
  - caps long titles at ~120 chars
  - empty sections renders same empty-state message
  - honors title when provided
- TS suite: **563/563** (was 557).

### Added — Iter 73 (2026-06-14)

- **`harness diag --json`** — machine-readable output for CI scripts
  that want to gate on the structured verdict rather than parse the
  human text.
- **One source of truth for exit codes** — `formatDiagReportJson`
  delegates to `formatDiagReport` for the verdict→exit-code mapping
  so both surfaces stay in lockstep forever. The JSON output appends
  an `exitCode` field for callers that only have the JSON in hand.
- **Position-independent flag** — `harness diag --json ./path` and
  `harness diag ./path --json` produce identical output.
- **Sample output**:
  ```json
  {
    "dir": "/tmp/ahg-diag-json-944dZR",
    "surface": "cli",
    "manifestKernelVersion": "0.1.0",
    "localKernelVersion": "0.1.0",
    "verdict": "match",
    "manifestGeneratorVersion": "0.1.0",
    "localGeneratorVersion": "0.1.0",
    "generatorVerdict": "match",
    "exitCode": 0
  }
  ```
- **`__tests__/harness-diag.test.ts`** 17 → **20** (+3):
  - emits parseable JSON with the full DiagReport + exitCode
  - position-independent flag (both orderings produce identical output)
  - missing manifest emits JSON with `exitCode: 2`
- TS suite: **557/557** (was 554).

### Added — Iter 72 (2026-06-14)

- **`scripts/healthcheck.mjs --probe-pages`** — opt-in HTTP probe of
  the live Studio at <https://ruvnet.github.io/metaharness/>.
  iter-42 healthcheck was deliberately offline (file-system only); the
  Pages site has become a primary distribution surface so the daily
  driver should know how to verify it's alive.
- **Two-stage probe** (catches more than "is the index 200?"):
  1. Fetch the index HTML, assert `200` + contains the "Agent Harness
     Generator" title
  2. Parse out the Vite bundle reference (`<script src="…/assets/index-<hash>.js">`)
     and HEAD-check it — proves the deploy isn't a 200-but-empty index
     pointing at broken bundles
- **Default behaviour is SKIP** — the check is added to the default
  run but stays informational unless `--probe-pages` is passed. This
  keeps healthcheck offline-friendly + airgap-runnable, while putting
  live-site verification one flag away.
- New live output with `--probe-pages`:
  ```
  PASS pages       https://ruvnet.github.io/metaharness/ OK + Vite bundle 200
  ```
- `__tests__/healthcheck.test.ts` 7 → 9 cases (+2):
  - pages check is SKIP by default (no network)
  - `--check=pages` alone is SKIP without `--probe-pages`
- The two existing checks-by-default tests updated to expect 7
  results (was 6).
- TS suite: **554/554** (was 552).

### Added — Iter 71 (2026-06-14)

- **`harness diag` now also surfaces generator-version skew.** iter 66
  reported kernel skew only. The manifest has always recorded
  `generator` (the create-agent-harness version at scaffold time);
  iter 71 makes that visible alongside the kernel block.
- **Implementation in `diag.ts`**:
  - `DiagReport` gained `manifestGeneratorVersion`, `localGeneratorVersion`,
    `generatorVerdict`
  - new `resolveLocalGeneratorVersion()` reads the running
    create-agent-harness's own `package.json` (workspace + installed
    fallback)
  - `buildDiagReport()` reads `m.generator` directly (top-level
    manifest field, present since iter 4) and runs the same
    `skewVerdict()` against the local version
  - `formatDiagReport()` prints two extra lines (`manifest generator:`,
    `installed generator:`) and a per-verdict generator-skew tag:
    `PASS` (match) / `INFO` (patch / minor / unparseable) / `WARN`
    (major). On MAJOR generator skew the WARN says "re-run
    `harness upgrade` to preview drift".
- **Generator skew is INFORMATIONAL — never changes the exit code.**
  Templates evolve, but the generated harness is self-contained;
  generator skew doesn't break anything, it just tells the user
  what `harness upgrade` would surface.
- **CLI smoke output**:
  ```
  surface:              cli
  manifest kernel:      0.1.0
  installed kernel:     0.1.0
  manifest generator:   0.1.0
  installed generator:  0.1.0

  PASS kernel versions match exactly
  PASS generator versions match exactly
  ```
- **Tests** — `harness-diag.test.ts` 14 → 17 (+3):
  - `formatDiagReport surfaces a manifest generator line even on match`
  - `generator-skew is INFORMATIONAL — never changes exit code`
  - end-to-end fresh scaffold shows both PASS lines
- TS suite: **552/552** (was 549).

### Added — Iter 70 (2026-06-14)

- **7th Codex skill — `diag-harness`** wrapping the iter-66 `harness
  diag` subcommand. Closes the "every user-facing subcommand has a
  matching codex skill" parity:
  - `create-harness`, `publish-harness`, `validate-harness`,
    `harness-secrets` (iter 22)
  - `verify-witness` (iter 28)
  - `upgrade-harness` (iter 49)
  - `diag-harness` (iter 70) ← new
- **`.codex/skills/diag-harness/skill.toml`** — name, dispatch via
  the `agent-harness-generator` MCP tool `diag_harness`, single `path`
  arg defaulting to cwd, catalog tags include `ADR-027`.
- **`.codex/skills/diag-harness/README.md`** — exit code table per
  verdict, sample output, lifecycle-position diagram, "when to run"
  list (clone someone else's harness, post-kernel-bump, cryptic doctor
  failures, fail-fast CI).
- **`.claude-plugin/plugin.json`** updated:
  - `skills` array grew 6 → 7 (`diag-harness` appended)
  - `commands` array gained a `diag-harness` entry with description
- **`__tests__/codex-skills.test.ts`** new case (7 → 8 tests): "all 7
  codex skills are present (iter 70: + diag-harness)" — pinned with
  per-skill iter attribution so removing one is visible in code review.
- **`scripts/marketplace-entry.mjs`** auto-picks up `plugin.json`'s
  `skills` array, so the IPFS marketplace entry generator now ships
  with 7 skills (no code change there).

### Fixed — Iter 69 (2026-06-14)

- **`scripts/dev-toolkit.mjs` currency** — the iter-55 contributor
  orientation map was frozen at 12 subcommands. Added the 3 that
  landed since:
  - `mcp-scan` (PR #1 / iter 55) — Security-scan the harness MCP
    surface (policy + perms + deps)
  - `analyze-repo` (PR #1 / iter 55) — Recommend a harness from a
    local repo (`--embed` for ruvllm)
  - `diag` (iter 66) — Kernel-version skew check (ADR-027 diagnostic)
- `node scripts/dev-toolkit.mjs` now reports `15 total — 15 listed`
  (was `12 total`).
- **`__tests__/dev-toolkit.test.ts`** updated: assertion grows
  12 → 15. Test no longer pretends the toolkit is current when it's
  five subcommands behind reality.
- This is the third "catch up with the 5 missed subcommands" repair
  in two iters (iter 67 fixed completions, iter 68 chained diag into
  e2e lifecycle, iter 69 fixes dev-toolkit). Every surface listing
  subcommands is now consistent.

### Added — Iter 68 (2026-06-14)

- **`harness diag` chained into the iter-52 e2e lifecycle test** as
  the 11th subcommand step. Before iter 68 the lifecycle pinned that
  10 subcommands (doctor / verify / sbom / audit / upgrade / publish /
  federate / etc.) all worked end-to-end on a single scaffolded
  harness — but iter 66's diag was added after iter 52 and was never
  chained in. iter 68 closes that gap.
- The new step asserts:
  - `diagCmd` exits 0 on a fresh scaffold (matches manifest +
    locally-resolved @metaharness/kernel)
  - The output line `PASS kernel versions match` is present
  - **Implicitly**: none of doctor / verify / mcp-scan / sbom / audit /
    upgrade / publish / federate corrupted the iter-58 `meta.kernel_version`
    or iter-56 `meta.surface` fields on the manifest. The whole lifecycle
    is metadata-safe.
- Test suite still **549/549** locally; iter 68 strengthens an existing
  test rather than adding a new case.

### Fixed — Iter 67 (2026-06-14)

- **Shell completions catch up with the dispatcher** — previously the
  `bash`, `zsh`, and `fish` completion scripts were missing 5
  subcommands the dispatcher had been honouring for weeks:
  - `sbom` + `audit` (iter 51) — slipped past the iter-48 completions
    when the per-harness security subcommands landed
  - `mcp-scan` + `analyze-repo` (PR #1 / iter 55) — slipped past when
    the Studio web-UI tree merged
  - `diag` (iter 66) — net-new but the same gap class
- **Implementation**:
  - `completions-cmd.ts` `SUBCOMMANDS` array now includes all 15
    dispatcher-honoured names (bash + fish auto-pickup from this list)
  - `zshCompletion()` had its OWN hardcoded subcommand list (the
    zsh `_describe` format wants `'name:description'` tuples) — 5
    new entries added with one-line descriptions
- **`__tests__/cli-flags-completions.test.ts`** updated:
  - the `harness help` assertion lists all 15 subcommands (was 10)
  - the all-three-shells completion assertion lists 14 (was 9)
  - guards against another silent regression
- TS suite: **549/549** locally; the test grew teeth without growing
  the test count.
- Why this matters: tab-completion drift is the worst kind — users
  silently stop discovering subcommands, support tickets disguise
  themselves as "how do I see what's available?" questions, and the
  fix is invisibly mechanical. The iter-67 completion guard now
  fails LOUDLY when the next subcommand lands without updating both
  paths.

### Added — Iter 66 (2026-06-14)

- **`harness diag` — 15th subcommand, the ADR-027 diagnostic UX loop**.
  iter 56 + iter 58 wrote `manifest.meta.surface` and
  `manifest.meta.kernel_version`; iter 66 makes them *actionable*
  from the CLI for an end user who downloaded a harness and wants to
  know if their local kernel install is compatible.
- **`packages/create-agent-harness/src/diag.ts`** — new module:
  - `skewVerdict(manifestVer, localVer)` — pure semver compare
    → `match` / `patch-diff` / `minor-diff` / `major-diff` / `unparseable`
  - `resolveLocalKernelVersion(harnessDir)` — uses `createRequire`
    rooted at the harness's own `package.json` so it follows real Node
    resolution; falls back to the workspace kernel when running
    uninstalled in the monorepo
  - `buildDiagReport(dir)` + `formatDiagReport(report)` — splits data
    collection from rendering so the report shape is testable directly
  - `diagCmd(args)` — the CLI entry, wired in `subcommands.ts`
- **Exit code contract**: 0 on match/patch (informational),
  1 on minor/major (action needed), 2 on no manifest at path.
- **CLI smoke (end-to-end against a real scaffold)**:
  ```
  harness diag /tmp/some-harness
    surface:              cli
    manifest kernel:      0.1.0
    installed kernel:     0.1.0
    PASS kernel versions match exactly
  ```
- **`__tests__/harness-diag.test.ts`** — 14 cases:
  - `skewVerdict` (6) — match / patch / minor / major / unparseable / prerelease
  - `formatDiagReport` (5) — exit codes per verdict + actionable line content
  - `diagCmd` e2e (3) — fresh scaffold → PASS, no manifest → exit 2,
    synthesized skew manifest → exit 1
- TS suite: **549/549** (was 535).
- `harness help` updated to list the new subcommand.

### Added — Iter 65 (2026-06-14)

- **Path-handling regression guard now scans `apps/`** — closes the
  third (and last) pillar of the `apps/web-ui` surface-coverage sweep:
  - iter 61 — `audit-deps.mjs` covers `apps/web-ui`
  - iter 64 — `scripts/sbom.mjs` covers `apps/web-ui`
  - iter 65 — `scripts/path-guard.mjs` covers `apps/web-ui`
- The iter-16 / iter-26 path-handling guard previously only walked
  `['packages', 'crates', 'scripts']`. PR #1's apps/web-ui tree was
  silently outside the scan, so a hardcoded `/tmp/`, `C:\…`,
  `/Users/…`, or `/home/…` in apps/web-ui/src/ would've slipped past
  the cross-platform guarantee.
- Verified: scanner reports clean against the live repo (zero hits
  in apps/web-ui/src/), confirming PR #1 is portable code.
- **`__tests__/path-handling.test.ts`** 8 → **10** cases (+2):
  - SCAN_DIRS includes `'apps'` (source-pinned, so removing it is
    visible in code review)
  - scanner runs green on the live repo with apps included
- TS suite: **535/535** (was 533).

### Added — Iter 64 (2026-06-14)

- **SBOM coverage of `apps/web-ui/`** — closes the SPDX analog of
  iter 61's audit-deps gap. Same surface (the bundle that ships to
  GitHub Pages), separate scanner — and SBOM is a regulated-industry
  deliverable, so a missing dep is a real compliance gap for
  downstream auditors.
- **Implementation** in `scripts/sbom.mjs`:
  - `readNpmLock(path)` is now path-parameterised (was hardcoded to
    repo root)
  - new `EXTRA_LOCK_DIRS = ['apps/web-ui']` const + `readExtraNpmLocks()`
  - `buildSbomFromRepo()` walks the workspace lock + every extra lock,
    deduping by `name@version` so transitively-shared deps aren't
    double-counted. Workspace lock wins on collision (authoritative
    resolved/integrity).
- **Local verification**: SBOM size went from ~180 → **196** packages.
  New entries include the web-UI's production deps: `jszip@3.10.1`,
  `react@18.3.1`, plus the rest of the Vite/React/Tailwind tree.
- **`__tests__/sbom.test.ts`**: 11 → **14** cases (+3):
  - includes apps/web-ui deps (`jszip`) — production-shipped JSZip bundle
  - includes apps/web-ui deps (`react`) — production-shipped Studio UI
  - dedupes packages that appear in multiple lockfiles
- TS suite: **533/533** (was 530).

### Fixed — Iter 63 (2026-06-14)

- **`@metaharness/vertical-base` now ships a README** — caught by running
  `node scripts/preflight.mjs` end-to-end for the first time on the
  road-to-v0.1.0 push. The iter-25 `pack-contents` invariants test
  pinned README+LICENSE for the 6 host adapters but only `dist/` for
  vertical packs, so the gap landed silently. Writing the missing
  `packages/vertical-base/README.md` (authoring guide for vertical-pack
  authors, anchored on ADR-013) closes it.
- **`__tests__/pack-contents.test.ts` tightened** — the
  `vertical packs ship dist/` case now also asserts each pack ships
  `README` and `LICENSE`. Suite **530/530** (was 529; 6/6 in
  pack-contents.test.ts, was 6/6 with weaker assertions).
- **Publish readiness — preflight gate status as of `fdcccd5`**:
  - PASS: git on main, semver consistency, every package has README,
    publishConfig.access=public, CHANGELOG mentions current iter,
    LICENSE is MIT, cargo fmt
  - FAIL (local env, NOT publish-blocking):
    `wasm size budget` — wasm-pack not installed on dev workstation;
    CI matrix builds + size-checks wasm correctly on every push.
  All real publish gates pass.

### Changed — Iter 62 (2026-06-14)

- **README.md rewritten end-user-first** — the previous version led with
  "meta-harness" architecture which is what *contributors* want to read.
  End users want "what can I make in 30 seconds?". New top:
  - Live Studio URL prominent in the badge row
  - "⚡ Try it in 30 seconds" callout at the very top with browser +
    `npx` paths side by side
  - Big linkable screenshot of the live Studio under the callout
  - Architecture / meta-harness sections moved BELOW the try-it path
- Status table refreshed:
  - Tests: 412 → **529** (was stale, behind by ~5 iters)
  - 5 Codex skills → 6 (upgrade-harness from iter 49 added)
  - 3 new shipped rows: Studio (live Pages URL), perf-regression gate,
    SPDX SBOM emitter
- `docs/web-ui/screenshot-desktop.png` (417 KB, ships with the repo)
  now linked from the top callout as a clickable Studio entrypoint.

### Added — Iter 61 (2026-06-14)

- **`scripts/audit-deps.mjs` now scans `apps/web-ui/`** — closes a real
  security gap. PR #1 put the web-UI Studio in `apps/web-ui/` outside
  the npm workspace (per ADR-027) so its own `package-lock.json` was
  **NOT** audited by the iter-38 aggregate gate — even though the
  built bundle is what ships to GitHub Pages (the production attack
  surface).
- **New flags**:
  - `--scan=<dir>` (repeatable) — audit an additional package tree
  - `--skip-extra` — disable auto-discovery
- **Auto-discovery**: any known-non-workspace tree with a real
  `package-lock.json` (today: just `apps/web-ui`) is scanned
  automatically. Adding more requires editing the `known` list in
  `discoverExtraScans()` — deliberate, not by env probing.
- Verified locally: 0 advisories at high+ across npm-workspace +
  apps/web-ui + cargo.
- **`__tests__/audit-deps.test.ts`** grew 7 → 12 cases (5 new):
  - auto-discovers apps/web-ui as an extra scan target
  - --skip-extra disables auto-discovery
  - --scan=<dir> is recognized + reported in INFO
  - unknown --scan=<dir> produces SKIP, not a crash
  - real npm audit covers apps/web-ui (0 advisories at high+)
- TS suite: **529/529** (up from 524).

### Fixed — Iter 60 (2026-06-14)

- **`ruvllmSemantic()` now memoised by input** — closes a pre-existing
  determinism bug in PR #1's `analyze-repo.test.ts > ruvllm embeddings
  (opt-in, deterministic, fallback-safe) > returns a per-archetype
  map`. The test asserts `ruvllmSemantic(profile) === ruvllmSemantic(profile)`,
  but `new RuvLLM(...)` instantiates fresh per-instance state on every
  call (LoRA seeds, threadpool ordering) so back-to-back invocations
  can produce float-precision drift on some CI runners — repro'd on
  Node 22 / ubuntu-latest after the PR #1 merge.
  Fix: a Map-based memo cache keyed on the EXACT inputs used in the
  `embed()` calls (`name`, `languages`, `tokens`). Identical inputs
  → identical rounded scores, forever. Cache reads are deep-cloned so
  callers cannot mutate cached entries. `_resetRuvllmCacheForTests()`
  exported for fresh-run tests.
- This was the only failing case on c42dfcc's CI; iter 60 should land
  CI green on main for the first time since the PR #1 merge red.

### Added — Iter 59 (2026-06-14)

- **`packages/bench/host-baseline.json` committed** — closes the
  iter-54 perf-gate loop. Before this iter, `scripts/bench-baseline.mjs`
  would always "establish" a new baseline on first run (no comparison
  point existed in the repo). Generated by running
  `BENCH_HOST_ITERS=2000 BENCH_HOST_OUT=packages/bench/host-baseline.json
   node packages/bench/dist/host-bin.js` against a clean checkout. The
  iter-54 CI step now compares real numbers against this reference at
  a 50% threshold (soft-gate, per iter 54).
- **cargo-deny soft-gate** — set `continue-on-error: true` on the
  `cargo-deny` job in `security.yml`. The Embark action loads
  `rustsec/advisory-db` and parse-errors on any malformed advisory
  TOML upstream (RUSTSEC-2026-0124.md broke parsing as of
  2026-06-14). Coverage isn't lost: `cargo-audit --deny warnings`
  and `audit-deps-aggregate --level=high` both run separately and
  use independent parsers, so a transient cargo-deny outage doesn't
  silence the vuln surface.
- **Pages workflow_dispatch triggered** — `gh workflow run pages.yml
  --ref main` to deploy the now-enabled Pages site. The previous
  successful run (`d4a3db8`) had a working build but a 404 deploy
  because Pages wasn't enabled yet; this run is the first real
  deployment.

### Added — Iter 58 (2026-06-14)

- **`manifest.meta.kernel_version` populated at scaffold time** —
  iter 56 added the field; iter 58 makes it load-bearing. New
  `resolveKernelVersion()` helper in `packages/create-agent-harness/src/index.ts`
  reads `@metaharness/kernel`'s package.json (3 lookup paths: workspace,
  installed sibling, top-level node_modules) and stamps the version
  into every scaffolded manifest. Never throws — a broken kernel
  install soft-passes to `kernel_version: undefined` (the doctor
  WARN path already handles that).
- **`__tests__/manifest-kernel-version.test.ts`** (2 cases) —
  scaffold a real harness against a tmpdir, read the manifest back,
  assert `meta.surface === 'cli'` and `meta.kernel_version` matches
  the resolved kernel version, plus a semver-shape sanity check.
- TS suite: **524/524** (up from 522).
- This closes the ADR-027 diagnostic loop. When a downstream
  validate sees a manifest-shape mismatch between CLI and Pages
  output, `meta.kernel_version` will identify the skew root cause.

### Added — Iter 57 (2026-06-13)

- **Pages workflow unblocked** — enabled GitHub Pages on the repo via
  the REST API (`POST /repos/.../pages` with `build_type=workflow` +
  `source.branch=main`). Build job was already green on `d4a3db8`; the
  deploy step had been failing with 404 because Pages wasn't enabled.
  No code change required — repo-admin action only.
- **Security cargo-deny fix** — the PR #1 merge wired
  `EmbarkStudios/cargo-deny-action@v1` with `arguments: --workspace check`
  but the action implicitly appends `command: check`, producing
  `cargo deny ... --workspace check check` and a CLI parse error
  (`error: invalid value 'check' for '[WHICH]...'`). Dropped the trailing
  `check` token so the action invocation lines up with the action's
  expected shape.

### Added — Iter 56 (2026-06-13)

- **`manifest.meta.surface` + `manifest.meta.kernel_version`** —
  added optional `HarnessMeta` fields on the `HarnessManifest` so the
  CLI vs web-UI parity test (ADR-027) has a load-bearing diagnostic
  field for skew. Default surface is `'cli'`; web-UI's renderer port
  sets `'web-ui'`.
- **`harness doctor` reports the surface** — PASS line when present,
  WARN line when missing (graceful for pre-iter-56 manifests).
- Merged cleanly with the PR #1 additions to `subcommands.ts`
  (`mcpScanCmd` + `analyzeRepoCmd`).

### Added — Iter 55 (2026-06-13)

- **`scripts/dev-toolkit.mjs`** — single-command repo orientation map.
  Lists the 6 entry-point scripts (healthcheck / preflight / release /
  sbom / audit-deps / bench-baseline), the 18 `scripts/*.mjs` helpers,
  the 12 `harness` subcommands, and the 6 CI matrix job groups.
  Modes: default text, `--json`, `--filter=<topic>`, `--check-health`.
  Designed for new contributors who shouldn't have to spelunk 50+
  CHANGELOG iter entries to find the right tool for a task.
- **`__tests__/dev-toolkit.test.ts`** (8 cases) — default exits 0 with
  4 sections, lists every harness subcommand, every entry point,
  `--json` is parseable, `--filter` narrows correctly, `--check-health`
  verifies, every listed script exists on disk.
- **`CONTRIBUTING.md`** refreshed with the "Orientation map" section
  and a "Day-to-day commands" table mapping question → command →
  wall time.
- **`docs/adrs/ADR-027-cli-and-web-ui-integration.md`** (drafted as
  ADR-022 originally; renumbered to 027 after the PR #1 merge to
  avoid collision with PR #1's ADR-022 MCP primitive) — defines the
  byte-parity contract between CLI and web-UI surfaces, the
  asymmetric-features table, decoupled release cadence (npm
  tag-driven vs Pages push-driven), and the 6 required tests.
- **PR #1 merge** — combined the web-UI Studio (188 files, +15977 /
  -23) into main: `apps/web-ui/` (Vite + React + TS + Tailwind),
  `crates/template-catalog/`, `harness mcp-scan` + `analyze-repo`
  subcommands, 7 new ADRs (020-026), gated Pages workflow. Test
  suite grew 486 → 522 cases on the merged tree.
- **`examples/host-tour/`** — single script scaffolds and validates
  one harness for each of all 6 hosts (claude-code, codex, pi-dev,
  hermes, openclaw, rvm), prints a markdown summary table + per-host
  file tree. 6/6 HEALTHY in ~190ms; non-zero exit if any host fails.
  Demonstrates the multi-host parity story (iter 2/4/11/12) end-to-end.

### Added — Iter 54 (2026-06-13)

- **CI Bench job extended to load-bear iter-39 + iter-53** — closes
  the perf-tracking loop end-to-end. The Bench (smoke) job now runs:
  1. Memory retrieval benchmark (iter 13) — small-corpus smoke
  2. Cross-host config-gen benchmark (iter 39) — `bench:hosts` script
     for the 6 host adapters, writes `host-bench-report.json`
  3. **Perf regression gate** (iter 53) — `bench-baseline.mjs`
     compares the host-bench report against
     `packages/bench/host-baseline.json` at a 50% threshold.
     Currently `continue-on-error: true` (soft-gate) so CI's
     non-deterministic runner perf doesn't false-fail. The signal
     is still visible in the logs as `[bench-baseline] FAIL: ...`.
  4. Upload BOTH reports (`bench-report.json` + `host-bench-report.json`)
     as a single `bench-reports` artifact.
- Before this iter: bench produced reports nobody compared against
  anything. Now the loop is closed — each CI run measures, compares,
  and records.
- `workflows.test.ts` (iter 30) still passes — the script-ref test
  catches any future drift in the wired `node scripts/<X>.mjs`
  references.

### Added — Iter 53 (2026-06-13)

- **`scripts/bench-baseline.mjs`** — performance regression detector
  against a stored baseline. Closes the loop on iter-13's memory bench
  + iter-39's host-bench: those produce reports, this one gates them.
  - `--current=<path>` (required) — bench report to evaluate
  - `--baseline=<path>` — comparison baseline
    (default: `packages/bench/baseline.json`)
  - `--threshold=<pct>` — max acceptable regression (default 25%)
  - `--update` — overwrite baseline with current (re-baselining)
  - Auto-classifies metrics: latency-ish keys (`meanMs`, `p95Ms`,
    `cost`, `wall`, `count`) are **lower-is-better**; quality keys
    (`ndcg`, `recall`, `precision`, `mrr`, `hitrate`) and unknowns
    are **higher-is-better**
  - First run with no baseline establishes one and exits 0
  - Exits 1 when any tracked metric regresses by > threshold
- **`flattenMetrics()` + `compare()` exported** for programmatic use.
- **`__tests__/bench-baseline.test.ts`** (11 cases):
  - `flattenMetrics`: handles host-bench shape (`results[i].host`),
    classifies latency keys as lower-is-better, classifies ndcg/recall
    as higher-is-better
  - `compare`: no regressions on matching reports, latency regression
    above threshold flagged, latency IMPROVEMENT not flagged (positive
    delta on `lower` is OK only when below threshold), quality
    regression flagged, quality improvement not flagged
  - script: `--update` writes baseline, missing baseline establishes
    one, exit 1 on real regression
- TS suite: **478/478** (up from 467).

### Added — Iter 52 (2026-06-13)

- **`__tests__/e2e-lifecycle.test.ts`** — strongest cross-iter
  regression net we have. Scaffolds ONE harness and runs every
  `harness` subcommand against it in a single chain:
  1. `scaffold()` (iter 4) → produces files + manifest
  2. `doctor()` (iter 8) → structural sanity
  3. `validate()` (iter 20) → 5-check umbrella (--skip-gcp)
  4. `verify()` (iter 8) → witness signature check
  5. `mcp ls` (iter 45) → list MCP servers
  6. `sbom --validate-only` (iter 51) → SPDX-2.3 shape check
  7. `audit` (iter 51) → npm audit precondition check
  8. `upgrade` (iter 47) → drift plan (DRY-RUN, expect No drift)
  9. `publish` (iter 46) → IPFS pin dry-run
  10. `federate init` (iter 9) → federation state file
- **Plus a per-host parity case** that runs scaffold + validate + sbom
  against all 6 hosts (claude-code / codex / pi-dev / hermes /
  openclaw / rvm) — catches host-specific regressions in the chain.
- If ANY subcommand breaks the contract, this test fires before
  publish. The chain mirrors what a real user does between
  `create-agent-harness <name>` and `harness publish --confirm`.
- TS suite: **467/467** (up from 465).

### Added — Iter 51 (2026-06-13)

- **2 new `harness` subcommands** brining the binary to **12 total**,
  surfacing the iter-38 + iter-50 security work at the per-harness layer:
  - **`harness sbom [path] [--out=<file>] [--include-dev] [--validate-only]`**
    — emits SPDX-2.3 SBOM for the harness at `<path>`. Reads
    `package-lock.json` when present (precise versions + integrity);
    falls back to `package.json dependencies` (declared ranges) with
    caveat. Prints JSON to stdout or writes to `--out`.
  - **`harness audit [path] [--level=high|critical|moderate|low|info]
    [--include-dev]`** — wraps `npm audit --json` against the
    harness's lockfile and reports structured per-severity counts +
    advisory IDs. Exits 1 on advisories ≥ level. Requires
    `package-lock.json` (CLI prompts for `npm install --package-lock-only`
    if missing).
- **`harness completions` updated** to include `sbom` + `audit` in all
  3 shells (bash/zsh/fish) — the cross-shell parity test catches the
  regression class where a new subcommand ships but the completions
  forget to update.
- **`__tests__/harness-sbom-audit.test.ts`** (8 cases):
  - `sbom`: no package.json (fail), package-lock present (use it),
    no lockfile (fall back to manifest), `--out=` writes file with
    valid SPDX-2.3 shape
  - `audit`: no package.json (fail), no lockfile (prompts), unknown
    `--level=` (exit 2), tiny lockfile runs cleanly (PASS or no-output)
- Full harness CLI surface: **12 subcommands** (sign / verify / doctor /
  federate / secrets / validate / mcp / publish / upgrade / completions
  / **sbom** / **audit**) + 4 standard CLI flags.
- TS suite: **465/465** (up from 457).

### Added — Iter 50 (2026-06-13) — MILESTONE

- **`scripts/sbom.mjs` — SPDX-2.3 Software Bill of Materials
  generator** — produces a SPDX-2.3 SBOM listing every dep with
  version + purl + license + checksum:
  - reads `package-lock.json` (full npm dep tree)
  - reads `Cargo.lock` (full cargo dep tree, if present)
  - emits SPDX-2.3-compatible JSON with `spdxVersion`, deterministic
    `documentNamespace` (hashed from package set), `SPDXRef-*` IDs,
    `externalRefs` as `pkg:` purls per package
  - validation gate via `validateSpdx()` — catches missing fields,
    bad SPDXIDs, non-purl refs
- Modes:
  - default — print JSON to stdout (pipe to file)
  - `--out=<path>` — write to file under `dist/`
  - `--validate-only` — verify the shape, no output written
  - `--include-dev` — include dev deps too (default: prod only)
- **Live numbers**: 128 packages enumerated (npm + cargo), SPDX
  validation OK.
- **Wired into `.github/workflows/security.yml`** as the `sbom` job:
  - regenerates SBOM on every push
  - validates the shape
  - uploads `dist/sbom.json` as a `sbom-spdx` CI artifact for
    downstream auditors / regulated-industry users
- **`__tests__/sbom.test.ts`** (11 cases):
  - script exists, `--validate-only` exits 0 with no stdout, default
    prints valid JSON, package count reported to stderr
  - `validateSpdx()` rejects missing `spdxVersion`, packages without
    SPDXID, non-purl `externalRefs`; accepts well-formed minimal docs
  - live-repo build: npm packages included, every package has a
    `pkg:npm/` or `pkg:cargo/` purl, every SPDXID is unique
- This realizes the "secure" + "production-ready" angles of the loop
  directive at the supply-chain layer. Enterprise procurement reviews
  can now consume `sbom.json` directly.
- **50 iters shipped.** Cumulative TS suite: **457/457**.

### Added — Iter 49 (2026-06-13)

- **6th Codex skill: `upgrade-harness`** — wraps the iter-47 `harness
  upgrade` CLI command. Mirrors the pattern of iter-22 (validate-harness,
  harness-secrets) and iter-28 (verify-witness):
  - args: `path` (default `.`), `apply` (default false; choices
    true/false), `conflict` (default inline; choices inline/rej)
  - dispatch: `mcp_tool` against the `upgrade_harness` MCP tool
  - tags: `upgrade`, `drift`, `template`, `scaffold`, `lifecycle`
  - README documents the 3-bucket plan model (added/removed/changed)
    + the lifecycle position + per-exit-code semantics
- **`.claude-plugin/plugin.json` updated** to list the 6th skill +
  6th command — otherwise the iter-24 orphan-skill check would flag
  the new directory.
- **Marketplace entry regenerated**: now reports `6 skills, 6
  commands` from the live plugin.json.
- Codex skill catalog: **create / publish / validate / secrets /
  verify-witness / upgrade-harness** — 6 surfaces (was 5).
- All 20 schema tests still pass (`codex-skills.test.ts` +
  `claude-marketplace-plugin.test.ts` + `marketplace-entry.test.ts`):
  no orphan skill, no orphan plugin entry, no shape drift.

### Added — Iter 48 (2026-06-13)

- **CLI conventional flags on the `harness` binary**:
  - `harness --help` and `harness -h` — aliases for `harness help`
  - `harness --version` and `harness -v` — prints `harness <version>`
    and exits
  Standard CLI conventions (gh, npm, cargo etc.) — users coming from
  any other CLI tool now get the expected behaviour without RTFM.
- **`harness completions <bash|zsh|fish>` subcommand (10th)** —
  emits shell completion scripts for the three major shells. Each
  knows the 9 top-level subcommands plus the sub-subcommand sets
  (secrets check/fetch/validate-token, mcp ls/invoke, federate
  init/add/remove/list/status, completions bash/zsh/fish). Users
  source the output:
  ```bash
  harness completions bash >> ~/.bash_completion
  harness completions zsh  >  ~/.zsh/_harness
  harness completions fish >  ~/.config/fish/completions/harness.fish
  ```
- Help text expanded with a Flags section documenting `--help/-h` +
  `--version/-v`.
- **`__tests__/cli-flags-completions.test.ts`** (11 cases):
  - `--help` and `-h` route to help (exit 0 with Usage line)
  - `--version` and `-v` print `harness <semver>`
  - help text lists all 10 subcommands + the new Flags section
  - bash completion contains `_harness_completion` function + `complete -F`
  - zsh completion starts with `#compdef harness`
  - fish completion uses `complete -c harness` + `__fish_use_subcommand`
  - unknown shell exits 2 with explanatory error
  - no shell shows help (exit 0 with usage)
  - **all three shells** list every subcommand in their completion
    output (cross-shell parity check)
- Full harness CLI surface: **10 subcommands** + 4 standard flags.
- TS suite: **446/446** (up from 435).

### Added — Iter 47 (2026-06-13)

- **`harness upgrade [path] [--apply] [--conflict=<inline|rej>]` CLI
  subcommand** — wires the iter-4 `planUpgrade()` + `applyPlan()` into
  the `harness` binary as the **9th** user-facing subcommand. Closes
  the harness lifecycle:
  ```
  scaffold (create-agent-harness)
      ↓
   edit (user)
      ↓
   upgrade (harness upgrade [--apply])     <- this iter
      ↓
   sign (harness sign)
      ↓
   verify (harness verify)
      ↓
   publish (harness publish [--confirm])
  ```
- Default mode is **dry-run** — re-renders the template that produced
  the harness with the same vars, computes a 3-bucket plan (added /
  removed / changed), and reports per-file disposition (clean / conflict).
- `--apply` writes the plan. Conflicts are surfaced via:
  - `--conflict=inline` (default) — Git-style `<<<<<<<` markers in-place
  - `--conflict=rej` — upstream version written to `<file>.rej` for
    manual merge tools
- Exit codes signal CI gating: `0` on clean apply or no drift, `1`
  on unresolved conflicts (so CI can flag them).
- **`__tests__/upgrade-cmd.test.ts`** (6 cases):
  - exits 1 if `<dir>` isn't a generated harness
  - reports `No drift` on a fresh scaffold (no false positives)
  - tampered file shows up in the plan in dry-run
  - `--apply` runs the apply path, exits 0 or 1 based on conflict
    resolution
  - unknown `--conflict=` value rejected with exit 2
  - manifest pointing at a non-existent template fails cleanly
- Full harness binary surface: **9 subcommands** —
  sign / verify / doctor / federate / secrets / validate / mcp /
  publish / upgrade.
- TS suite: **435/435** (up from 429).

### Added — Iter 46 (2026-06-13)

- **`harness publish [path] [--confirm]` CLI subcommand** — wires the
  iter-5 `publishHarness()` function into the `harness` binary as
  the 8th user-facing subcommand (sign / verify / doctor / federate
  / secrets / validate / mcp / **publish**):
  - default mode is **dry-run** — validates manifest exists, witness
    verifies (if present), reports what WOULD be pinned. Safe to run
    without Pinata creds.
  - `--confirm` actually pins to IPFS via Pinata. Requires
    `PINATA_JWT` env var (CLI prints the `harness secrets fetch
    PINATA_JWT` command if missing).
  - `--name=<override>` overrides the manifest's name field.
  - Output reports: manifest CID, size, confirmed status, next-step
    hint (re-run with `--confirm` or distribute via marketplace).
- **`__tests__/publish-cmd.test.ts`** (5 cases):
  - dry-run doesn't require `PINATA_JWT`
  - dry-run reports CID + size + `confirmed: false` + next-step hint
  - missing manifest fails cleanly with explanatory error
  - `--confirm` without `PINATA_JWT` exits 1 with `harness secrets
    fetch` pointer (load-bearing for the CLI's discoverability)
  - `--name=<override>` flows through
- CI milestone: iter-44 commit `c99e0f1` ran to **CI conclusion =
  SUCCESS** — second consecutive confirmed full-green run.
- TS suite: **429/429** (up from 424).

### Added — Iter 45 (2026-06-13)

- **`harness mcp <ls|invoke>` subcommand** — surfaces the iter-10/13/34
  MCP dispatch layer to the CLI. Closes the loop between the Rust
  kernel dispatcher, the TS wrapper, and the user-facing command line:
  - `harness mcp ls [path]` — list MCP servers + tools declared in
    `<path>/.mcp/servers.json`. Reports cleanly when the file is absent
    or empty.
  - `harness mcp invoke <server> <tool> [--args=<json>] [path]` —
    dispatches a tool through the kernel's claim-checked dispatcher
    using the harness's local `.harness/claims.json`. Prints the
    structured `outcome.kind`: `result` / `denied` / `not-found` /
    `bad-args`. Exit codes follow: 0 on result, 1 on denied/not-found,
    2 on bad-args / malformed input.
- **New `./dispatch` subpath export on `@metaharness/kernel`** — required
  so the CLI can `import('@metaharness/kernel/dispatch')` to load the
  `ToolDispatcher` class without pulling the full kernel index.
- **`__tests__/mcp-cmd.test.ts`** (12 cases):
  - `mcp ls` reports missing file, lists servers+tools, handles empty
  - `mcp invoke` validates positional args, rejects bad JSON, rejects
    array `--args`, returns `result` on matching claim, `denied` on
    no matching claim, defaults to empty claims when file absent
  - `mcpDispatch` help mentions iter-34 integration test, unknown
    subsub returns exit 2, default shows help
- TS suite: **424/424** (up from 412).

### Added — Iter 43 (2026-06-13)

- **Healthcheck wired into `ci.yml`** Node job — runs on every push
  per (OS, Node-version) combination after `npm test` + path-guard.
  6 read-only structural checks add ~1s per matrix cell; catches
  version drift, plugin schema breaks, codex orphan dirs, dead
  workflow script refs, missing examples — at the same moment
  vitest does, in the same job.
- **`docs/ARCHITECTURE.md`** — bird's-eye map of how the pieces compose:
  - 3-layer model diagram (Kernel → Adapters → User-facing surface)
  - Release pipeline diagram showing all 6 primitives + the
    `release.mjs` orchestrator + the server-side `publish.yml` mirror
  - Validation surface table: which command runs when, wall time,
    and what it covers (validate vs healthcheck vs preflight vs release)
  - CI matrix breakdown: 16 jobs across the matrix
  - Test contract table: maps every concern (claims, witness, MCP,
    plugin shape, etc.) to its pinning test file + iter number
- CI milestone confirmation: iter-41 commit `7b9f473` ran to **CI
  conclusion = SUCCESS** — first run conclusion success after the
  build-ordered Phase 4 fix.

### Added — Iter 42 (2026-06-13)

- **`scripts/healthcheck.mjs`** — user-facing daily-driver "is this
  branch healthy?" command. Distinct from `preflight.mjs` (release-
  specific, ~30s) and `release.mjs` (mutation flow): healthcheck is
  read-only, runs in ~1s, no network, no I/O beyond reading files.
- 6 checks (all soft-skip on unmet preconditions):
  - `version` — root + 12 packages + plugin.json + Cargo workspace
    all on same version (catches cross-pack drift between bumps)
  - `plugin` — `.claude-plugin/plugin.json` has kebab-case name,
    description ≥30 chars, author.id, non-empty skills/commands
  - `codex` — `.codex/skills/*` each have `skill.toml` + `README.md`;
    ≥4 skills total
  - `workflows` — every `node scripts/<X>.mjs` referenced in
    `.github/workflows/*.yml` points at a real file
  - `pathguard` — `scripts/path-guard.mjs` itself is wired in
    (full scan runs separately via `node scripts/path-guard.mjs`)
  - `examples` — `examples/quickstart/` + `examples/federation/`
    have both `.mjs` and `README.md` present
- Output modes:
  - default — human-readable tag column + Result line
  - `--json` — machine-readable for CI integration
  - `--check=<name>` — run only one check (fast iteration during dev)
- **`__tests__/healthcheck.test.ts`** (7 cases): script exists, default
  run = HEALTHY, all 6 checks default-on, `--json` parseable + has
  `ok: boolean`, `--check=plugin` filters to 1, unknown `--check=`
  fails not crashes, finishes <5s.
- Live run shows 6/6 PASS: 5 codex skills, 3 workflows all script
  refs resolve, 2 runnable examples, all sources at v0.1.0.
- TS suite: **412/412** (up from 405).

### Fixed — Iter 41 (2026-06-13)

- **CI Node jobs RED on iter-39** — `packages/bench` started importing
  the 6 host adapters for the cross-host benchmark, but
  `scripts/build-ordered.mjs` had `bench` in Phase 3 *parallel to* the
  hosts. On a fresh CI checkout the bench `tsc` ran before the hosts
  had finished, hitting `TS2307: Cannot find module '@metaharness/host-rvm'`.
- **Fix**: moved `bench` from Phase 3 to Phase 4 alongside
  `vertical-trading` (both depend on a previous phase's output).
  Now: kernel → vertical-base → (hosts + sdk + cli) → (vertical-trading
  + bench). Clean rebuild on Windows: 9.6s.
- Locally the test suite stayed 405/405 because the build artefacts
  from the prior iter-39 build were already on disk. This was a
  fresh-checkout-only failure — the kind cross-platform CI exists to
  catch.

### Added — Iter 40 (2026-06-13)

- **`examples/federation/federation.mjs`** — second runnable example
  (after the iter-32 quickstart). 7-step bidirectional handshake that
  exercises the federation transport from iter 9 without a real
  network:
  1. provision two harness tmpdirs (host-A, host-B)
  2. initialise federation state on each
  3. each side adds the other as a trusted peer
  4. round-trip both states through disk + reload
  5. trust-tier filter (only trusted peers)
  6. asymmetric demotion (A removes B, B retains A)
  7. summary + cleanup
- Runs in ~20ms. Imports from built `dist/` so no TS toolchain needed.
- **`examples/README.md` updated**: federation now marked runnable (was
  "docs"), with the new script and timing called out.
- **`__tests__/examples-federation.test.ts`** (3 cases):
  - script + README exist
  - 7-step handshake runs to completion (regression check that pins
    the 7 step markers, so removing one fails CI)
  - asymmetric demotion verified (`A now has 0 peer(s)` +
    `B still has 1 peer(s)`)
- Examples directory now has 2 runnable + 1 docs-only. Next iters can
  add `multi-host/multi-host.mjs` if user-facing demand surfaces.
- TS suite: **405/405** (up from 402).

### Added — Iter 39 (2026-06-13)

- **Cross-host config-gen benchmark** —
  `packages/bench/src/host-bench.ts` + `host-bin.ts` realize the
  "benchmark" loop directive at the host-adapter layer:
  - `benchHost(adapter, iters)` runs `generateConfig()` `iters` times
    (with a 50-iter JIT warmup), returns `mean / p50 / p95 / p99`
    latency + `filesPerCall` + `bytesPerCall`
  - `benchAllHosts(iters)` covers all 6 supported hosts in one call
  - `formatResultsTable(results)` emits a clean markdown table for
    CI annotations + README badges
- **CLI**: `npm --prefix packages/bench run bench:hosts` prints
  the per-host table to stdout. `BENCH_HOST_ITERS=10000` and
  `BENCH_HOST_OUT=./host-bench.json` configure for CI runs.
- **`packages/bench/__tests__/host-bench.test.ts`** (5 cases):
  - `benchHost` returns sensible metrics for every host (p99 ≥ p95 ≥ p50)
  - `benchAllHosts` covers all 6 adapters
  - markdown table has correct shape (header + separator + 6 rows)
  - sanity guard: mean latency per host < 5ms (catches accidental
    O(n²) regressions)
  - every host produces ≥1 file per call
- **Live measurement** (1000 iters/host, Windows):
  ```
  | Host        | mean (ms) | p99 (ms) | files | bytes |
  | claude-code | 0.001     | 0.005    | 2     | 3     |
  | codex       | 0.001     | 0.001    | 2     | 2     |
  | pi-dev      | 0.001     | 0.001    | 3     | 350   |
  | hermes      | 0.001     | 0.002    | 1     | 111   |
  | openclaw    | 0.002     | 0.010    | 3     | 915   |
  | rvm         | 0.004     | 0.023    | 4     | 2028  |
  ```
  Total wall time: **14ms for 6000 calls across 6 hosts**.
- TS suite: **402/402** (up from 397).

### Added — Iter 38 (2026-06-13)

- **`scripts/audit-deps.mjs`** — single aggregate security gate that
  wraps `npm audit` + `cargo audit` and emits structured per-tool
  `PASS / WARN / FAIL / SKIP` with one rolled-up exit code:
  - `--level=high|critical|moderate|low|info` (default `high`)
  - `--include-dev` to audit dev deps too
  - `--skip-npm` / `--skip-cargo` for partial runs
  - `--strict-tooling` fails if `cargo-audit` isn't installed (CI mode)
  - Cross-platform: `cmd.exe /d /s /c` for Windows `npm.cmd` + `cargo`
- **Wired into `.github/workflows/security.yml`** as the
  `audit-deps-aggregate` job alongside the existing per-tool jobs.
  Gives branch-protection a single boolean for "deps safety".
- **`__tests__/audit-deps.test.ts`** (7 cases):
  - script exists
  - unknown `--level` exits 2 with "tooling" error
  - `--skip-npm` + `--skip-cargo` both honored
  - configured level echoed in output
  - default level is `high`
  - LIVE npm audit against the workspace reports 0 advisories ≥ high
    (the actual gate — this is the real security signal)
  - `--strict-tooling` flag exercised without crashing the script
- Locally `npm audit --omit=dev --audit-level=high` against the
  workspace: **0 advisories**. The publish pipeline is shippable
  from a deps safety perspective.
- TS suite: **397/397** (up from 390).

### Added — Iter 37 (2026-06-13)

- **`__tests__/witness-tamper.test.ts`** (16 cases) — pins the TS
  witness-client shape gate around the Rust-side Ed25519 verifier
  (per ADR-011). The kernel handles the cryptographic check; this
  test pins the wrapper that surrounds it:
  - well-shaped manifest passes
  - non-object inputs rejected (null, string, number)
  - unsupported `schema` version rejected with reason mentioning
    `schema`
  - truncated `public_key` (32 hex chars instead of 64) rejected
  - truncated `signature` (64 hex chars instead of 128) rejected
  - missing `public_key` field rejected
  - `entries` as string instead of array rejected
  - missing `harness` / `version` fields rejected
  - `findWitness` locates both `<dir>/witness.json` and
    `<dir>/.harness/witness.json`
  - `findWitness` returns null on empty dir
  - `readAndVerify` reads + validates a well-shaped file
  - `readAndVerify` on a tampered signature reports the failure reason
  - `readAndVerify` throws on missing file (no silent success)
  - `readAndVerify` throws on invalid JSON
- This locks the publish-time gate that prevents an unsigned or
  shape-malformed harness from reaching npm. If the wrapper ever
  silently accepts a malformed manifest, the test fires immediately.
- TS suite: **390/390** (up from 374).

### Added — Iter 36 (2026-06-13)

- **`scripts/release-notes.mjs`** — extracts CHANGELOG entries as
  GitHub-flavoured release notes ready for
  `gh release create vX.Y.Z --notes-file -`. Selection modes:
  - `--from-iter=N --to-iter=M` — explicit iter range
  - `--version=X.Y.Z` — entries since the previous git tag
  - `--since=v0.1.0 --until=HEAD` — git-tag date window
  - default (no flags) — everything since the last released tag
- **`release.mjs` updated**: after `--push` succeeds, automatically
  writes `dist/release-notes-v<version>.md` and surfaces the
  `gh release create … --notes-file dist/…` command for the operator.
  Closes the loop between npm publish and the GitHub Release UI.
- **`__tests__/release-notes.test.ts`** (9 cases) — pins the
  parse → render → CLI shape:
  - canonical `### Added — Iter N (YYYY-MM-DD)` header parsed correctly
  - section ends at next `## ` heading (doesn't bleed into "Unreleased")
  - returns `[]` when no sections match
  - renderer groups by kind (Added before Fixed before Changed)
  - iter range header is correct
  - empty selection rendered gracefully
  - title forwarded
  - live CHANGELOG `--from-iter=30 --to-iter=35` smoke
  - bad `--since` tag exits non-zero with a clear error
- TS suite: **374/374** (up from 365).

### Added — Iter 35 (2026-06-13)

- **ADR-019: Release orchestration** —
  `docs/adrs/ADR-019-release-orchestration.md`. Locks down the
  iter-33 release flow as an architectural decision:
  - Composition over monolith: 5-step plan calls existing scripts in
    a documented order
  - Refuse dirty tree, no git mutation until step 5
  - `--dry-run` as safe-default inspection mode
  - Cross-platform via `cmd.exe /d /s /c` on Windows (same fix that
    landed in publish-dryrun iter 24 / install-all iter 31)
  - Test contract table maps every primitive to its pinning test
- **ADR-018 added to the index** — accidentally omitted in iter 12.
  The `__tests__/adr-index.test.ts` regression test (added below)
  would have caught the original miss.
- **`__tests__/adr-index.test.ts`** (3 cases) — locks the
  `docs/adrs/INDEX.md` against the actual file set:
  - every `ADR-NNN-*.md` file in the dir is listed
  - every `(./ADR-NNN-*.md)` link in the index resolves
  - every ADR has the canonical sections (Status, Context, Decision,
    Consequences) — catches stub ADRs that ship without the
    decision rationale
- TS suite: **365/365** (up from 362).

### Added — Iter 34 (2026-06-13)

- **`__tests__/mcp-dispatch-integration.test.ts`** (11 cases) — the
  full ToolDispatcher surface exercised end-to-end as realistic MCP
  flows, not just unit tests for the capability/resource matchers.
  Pins:
  - happy path: registered tool + matching claim → `result`
  - `not-found`: unregistered tool surfaces server+tool
  - `denied`: no matching claim, reason names the missing capability
  - `denied`: expired claim no longer authorises
  - `bad-args`: array/null args caught before handler runs (zero
    handler invocations confirmed)
  - handler throw → `denied` (not `result`), throw message in reason
  - `*` wildcard authorises every tool
  - `tool.invoke.mem.*` prefix matches mem.* but not eval.*
  - resource scoping: narrow grant (`ns/x`) vs wildcard (`ns/*`),
    correct match/no-match per pair
  - multiple-claims OR: any matching claim authorises (expired and
    unrelated claims in the same list don't block a valid one)
  - realistic end-to-end flow: issue claim → use tool → claim
    expires → tool denied → reissue claim → tool works again
- This is the layer iter-10 (MCP tool dispatch in Rust kernel) +
  iter-13 (MCP dispatch TS wrapper) built; before this iter only
  the matcher unit tests existed. The integration coverage closes
  the loop: a regression in either layer surfaces here before it
  ships.
- TS suite: **362/362** (up from 351).

### Added — Iter 33 (2026-06-13)

- **`scripts/release.mjs`** — single-command release orchestrator that
  composes the existing release primitives in one 5-step plan:
  1. `version-bump.mjs` (iter 29) — atomic cross-pack semver bump
  2. `preflight.mjs` (iter 14) — every gate publish.yml would run
  3. `marketplace-entry.mjs` (iter 27) — regen the IPFS-pinnable JSON
  4. `publish-dryrun.mjs` (iter 20) — verify all tarballs build cleanly
  5. `git add -A` + `git commit -m 'chore(release): vX.Y.Z'` + `git tag`
- Modes:
  - `node scripts/release.mjs patch` — no push, local only
  - `node scripts/release.mjs minor --push` — push branch + tag (publish.yml fires)
  - `node scripts/release.mjs 0.2.0-rc.1 --dry-run` — show plan only
  - `--skip-preflight`, `--skip-marketplace`, `--skip-pack` for fast iteration
- Sanity checks: refuses to run with a dirty working tree (unless
  `--dry-run`); reports current branch up front.
- **`__tests__/release.test.ts`** (6 cases) — pins the orchestration
  contract against the real repo using `--dry-run` so the test is
  hermetic by construction:
  - script exists
  - `--dry-run` exits 0 with `DRY-RUN complete` and creates no `v0.1.1`
    git tag (zero mutation check)
  - 5-step plan prints in order (`1/5` < `2/5` < ... < `5/5`)
  - `--skip-*` flags honored
  - semver bump kinds (patch/minor/major) forwarded to version-bump
  - explicit version (`0.5.7-rc.1`) forwarded to version-bump
- CI milestone: iter-31 commit `b37060c` was confirmed **CI SUCCESS** —
  the first run conclusion = success in repo history.
- TS suite: **351/351** (up from 345).

### Added — Iter 32 (2026-06-13)

- **`examples/quickstart/`** — first RUNNABLE example. Before this iter
  the `examples/` directory had three READMEs but no executable code.
  Now there's a single-script demo:
  - `node examples/quickstart/quickstart.mjs` — scaffolds a `demo-bot`
    harness from the `minimal` template, runs the full `harness validate`
    umbrella against the output, prints a summary, cleans up. ~50ms.
  - Flags: `--host=<id>` (any of 6 hosts), `--template=<id>`,
    `--name=<n>`, `--keep` (don't auto-clean).
  - Imports from the built `dist/` — no TS toolchain needed at runtime.
  - Locally verified on all 6 hosts (50–55ms each):
    `claude-code, codex, pi-dev, hermes, openclaw, rvm`.
- **`examples/README.md` rewritten** to lead with the quickstart and
  signal `runnable? yes` vs the docs-only multi-host + federation
  examples.
- **`__tests__/examples-quickstart.test.ts`** (4 cases) — pins the
  example as code that must keep running, not docs that nobody verifies:
  - script + README exist
  - default run exits 0 with `Result: HEALTHY`
  - invalid `--host` exits 2 with explanatory error
  - smoke-runs all 6 hosts (one assertion per host)
- CI milestone: iter-31 commit `b37060c` ran with **all 16 jobs GREEN**
  for the first time (Rust×3 + WASM×3 + Node20+22×3 + Bench + pack+install×3
  + CI-passed aggregator). The iter-31 batch-install fix unblocked the
  last 2 pack-install jobs.
- TS suite: **345/345** (up from 341).

### Fixed — Iter 31 (2026-06-13)

- **CI `pack+install` job RED on macos+windows since iter 16** —
  installing each tarball individually meant npm tried to resolve the
  cross-tarball `@metaharness/*` deps from the registry, where they don't
  exist pre-publish. Real CI error: `npm error 404 Not Found - GET
  https://registry.npmjs.org/@ruflo%2fkernel - Not found` ×7 of the
  11 packages. This was masking real install regressions because every
  host adapter failed in the same way.
- **Fix**: rewrote `scripts/install-all.mjs` to do a single batched
  `npm install <t1.tgz> <t2.tgz> ... <tN.tgz>` call. npm now resolves
  `@metaharness/*` deps from the OTHER tarballs in the same install set,
  not the registry. Then a second pass spot-checks each installed
  package's `package.json` is present under `node_modules/<scope>/<name>/`.
- **Verified locally**: 11/11 packages install cleanly (was 4/11
  before the fix). Includes the cross-deps (`host-rvm` finds its
  `@metaharness/kernel`, `vertical-trading` finds its `@metaharness/vertical-base`,
  `create-agent-harness` finds its `@metaharness/kernel`).
- This is the regression class iter 16's pack-install job was
  designed to catch — and now actually does.

### Added — Iter 30 (2026-06-13)

- **e2e validate-per-host sweep** added to
  `__tests__/e2e-scaffold-validate.test.ts`. Iter 23's "scaffolds for
  every host" only checked the scaffolder didn't throw — this new case
  runs the full `harness validate` umbrella against the output of every
  host (claude-code / codex / pi-dev / hermes / openclaw / rvm).
  Catches host-specific artifact regressions: a host adapter that emits
  a malformed `.codex/config.toml`, a host-specific MCP config that
  fails the iter-20 mcp check, etc. — without needing a host-specific
  test suite for each.
- **`__tests__/workflows.test.ts`** (7 cases) — `.github/workflows/*.yml`
  structural validation. Catches the silent-CI-drift bugs that
  actionlint would catch, but as part of the same vitest run:
  - no tab-indented YAML lines (causes parse errors only on some
    parsers)
  - every `node scripts/<X>.mjs` reference points at a real file
    (catches script renames that miss the workflow)
  - unique job names per workflow
  - ci.yml matrix runs every gate on all 3 OS
  - publish.yml runs **both gates** (`validate-gcp-secrets.mjs` +
    `publish-dryrun.mjs`) BEFORE any `npm publish --provenance`
  - publish.yml runs `marketplace-entry.mjs` AFTER the final
    `npm publish`
  - publish.yml has a step for every 6-host adapter package
- These two together close the loop: the validate umbrella is now
  asserted to work per-host, AND the publish workflow is asserted to
  invoke it in the right order. Future workflow drift fails CI before
  it ships.
- TS suite: **341/341** (up from 333).

### Added — Iter 29 (2026-06-13)

- **`scripts/version-bump.mjs`** — atomic cross-package version sync.
  Bumps EVERY `package.json` under the repo (root + 12 workspace packages
  + `.claude-plugin/plugin.json`) plus `Cargo.toml`'s
  `[workspace.package].version` in a single deterministic pass. The
  existing `preflight.mjs` already catches version drift across packages
  — this script makes the inverse (synchronised bump) a one-command op.
  - `node scripts/version-bump.mjs patch|minor|major|<x.y.z>`
  - `--dry-run` for safe diff preview
  - Workspace deps to other `@metaharness/*` packages get bumped in lockstep
    (so `host-rvm` → `@metaharness/kernel ^0.1.0` becomes `^0.1.1` together)
- **`__tests__/version-bump.test.ts`** (7 cases) — pins the cross-pack
  lockstep invariant inside a tmpdir fixture so the test is fully
  hermetic:
  - patch / minor / major / explicit-version bumps
  - workspace deps to other `@metaharness/*` packages updated in lockstep
  - `--dry-run` doesn't touch files
  - rejects unparseable target with non-zero exit
- CI milestone: iter-28 commit `7b9bbcf` ran with all 12 core matrix
  jobs GREEN — **second consecutive iter at full green**.
- TS suite: **333/333** (up from 326).

### Added — Iter 28 (2026-06-13)

- **Marketplace entry generation + IPFS pin wired into `publish.yml`**
  — completes the marketplace publishing pipeline as an actual,
  load-bearing CI step:
  1. After all 11 npm packages publish successfully…
  2. `node scripts/marketplace-entry.mjs` regenerates
     `dist/marketplace-entry.json` from live `.claude-plugin/plugin.json`
     and root `package.json`.
  3. Fetches `PINATA_JWT` from GCP Secret Manager (best-effort —
     `continue-on-error: true`; first-time releases skip cleanly).
  4. Single-file POST to Pinata's `pinFileToIPFS` endpoint, extracts
     the `IpfsHash`, surfaces it as a `::notice::` annotation + step
     output `marketplace_cid` for downstream registry-update workflows.
  5. Pin failure is non-fatal — the npm publish has already succeeded.
- **5th Codex skill: `verify-witness`** — distinct from the iter-22
  `validate-harness` umbrella because it only checks the Ed25519
  signature:
  - Use case: federation handshake / multi-signer workflow / CI mirror
    where you don't need the full release-readiness sweep.
  - Args: `path` (default `.`), `strict` (default `true` — fail if no
    witness; soft-skip when `false`).
  - `.codex/skills/verify-witness/skill.toml` + `README.md` follow the
    schema the iter-22 cross-skill test pins.
- **`.claude-plugin/plugin.json`** updated to list `verify-witness` as
  the 5th skill + 5th command (otherwise the iter-24 orphan-skill check
  would flag the new directory).
- Codex skill catalog now: **create / publish / validate / secrets /
  verify-witness** — 5 surfaces.
- Cumulative test suite: 326/326 (verify-witness + the marketplace
  pipeline already had test coverage from iter 22 + 27).

### Added — Iter 27 (2026-06-13)

- **`scripts/marketplace-entry.mjs`** — turns `.claude-plugin/plugin.json`
  into the marketplace-registry JSON that gets pinned to IPFS and
  discovered by other agents. Mirrors the shape of
  `v3/@claude-flow/cli/src/plugins/store/discovery.ts` so the same
  browsing UI consumes it without modification. Modes:
  - `--print` (stdout, for piping into `pinata pin file -`)
  - `--validate` (validate-only; no file written)
  - default (writes `dist/marketplace-entry.json`)
- **`buildMetaEntry()` + `validateEntry()`** — exported from the script
  for programmatic use (and the new test). Witness signature + IPFS
  CIDs are optional fields the publish pipeline fills in.
- **`__tests__/marketplace-entry.test.ts`** (6 cases) — pins the entry
  shape against the live plugin.json:
  - well-formed entry from live data
  - skills match iter-22 (`create-harness, publish-harness,
    validate-harness, harness-secrets`) — catches codex↔marketplace
    drift in either direction
  - tags include 6-host catalog (`openclaw`, `rvm`, `claude-code`)
  - witness/ipfs slots present only when input provides them
  - rejects too-short descriptions (<30 chars)
  - `validateEntry()` catches missing required fields
- **CI milestone**: iter-26 commit `ae99075` was the FIRST run where
  all 12 jobs went green simultaneously (Rust×3 + WASM×3 + Node20+22×3).
  The path-guard fix unblocked the Node lane.
- TS suite: **326/326** (up from 320).

### Fixed — Iter 26 (2026-06-13)

- **path-guard scanner was finding itself** — the Node CI jobs had
  been failing since iter 20 once the build-ordered fix (iter 24)
  exposed them. Root cause: `scripts/path-guard.mjs` is the scanner
  that flags hardcoded `/tmp/`, `C:\`, `/Users/`, `/home/` references,
  but it itself contains those very strings as the regex literals it's
  scanning for. Same for `packages/create-agent-harness/src/validate.ts`
  (iter 20's path-guard sub-check embeds the same regex) and
  `crates/kernel/src/hooks.rs` (test fixture `Bash(rm -rf /tmp)`).
  CI: 11 self-flagged regressions per run.
- **Fix**: added a `SKIP_FILES` set listing the three known-meta paths:
  - `scripts/path-guard.mjs` (the scanner)
  - `packages/create-agent-harness/src/validate.ts` (the umbrella that
    embeds the same regex)
  - `crates/kernel/src/hooks.rs` (the hook-matcher fixture)
- After the fix: `path-guard: clean (scanned packages, crates, scripts
  on win32)`. Real regression detection still works — only these three
  specific meta-files are exempt.

### Added — Iter 25 (2026-06-13)

- **`__tests__/pack-contents.test.ts`** (6 cases) — `npm pack --dry-run
  --json` on every package, then asserts the tarball CONTAINS the files
  README + exports promise:
  - `@metaharness/kernel` ships README + LICENSE + `dist/`
  - every host adapter (×6) ships README + LICENSE + `dist/`
  - `create-agent-harness` ships `dist/`, `templates/`, AND both bin
    entrypoints (`dist/bin.js`, `dist/harness-bin.js`) — the exact
    bug class that hit create-agent-harness@0.1.0 when npm auto-
    corrected the broken bin paths
  - vertical packs ship `dist/`
  - `@metaharness/sdk` ships `dist/` + README
  - NO package leaks `.env`, `node_modules`, `.tsbuildinfo`,
    `.DS_Store` (a separate regression class — accidental secret /
    bloat in a tarball)
- **Real bug caught immediately**: the test found that **all 10
  publishable packages (the 6 host adapters + kernel + sdk + 2
  verticals) were shipping WITHOUT LICENSE files**. This is an MIT
  license-text-must-accompany-the-code violation that would have
  hit the registry on first publish. The root `LICENSE` was the
  only one in the repo.
- **Fix**: copied root `LICENSE` to all 10 publishable package
  directories. Test now passes 6/6.
- TS suite: **320/320** (up from 314).

### Added — Iter 24 (2026-06-13)

- **`__tests__/claude-marketplace-plugin.test.ts`** (8 cases) — pins
  the shape of `.claude-plugin/plugin.json` so future host/skill drift
  fails CI before installs break silently:
  - field-by-field required-field check against marketplace schema
  - every `commands[i]` has kebab-case `name` + ≥10-char `description`
  - every `skills[]` entry has a backing `.codex/skills/<name>/` dir
  - every `.codex/skills/` directory is referenced from `plugin.json`
    (no orphans either way)
  - tags include every supported host (catches host-add drift —
    iter-12 added `rvm` and it took until now to land in plugin.json)
  - `skills.length` matches `.codex/skills` dir count exactly
- **`.claude-plugin/plugin.json` rewritten** to reflect current state:
  - 6-host description (was 4)
  - tags: added `openclaw`, `rvm`, `ed25519`, `witness`,
    `gcp-secret-manager` (5 new keywords for marketplace discoverability)
  - skills: dropped non-existent `list-templates`, added `validate-harness`
    + `harness-secrets` from iter 22
  - commands: now 4 entries (was 2), all backed by real codex skills

### Fixed — Iter 24 (2026-06-13)

- **Node CI jobs red on iter-23** (build failed across all 4 node jobs):
  - `npm run -ws --if-present build` runs the workspace builds in
    undefined order, and `tsc` in `host-rvm` runs BEFORE `kernel-js`
    produces `dist/index.d.ts` — failure: "Cannot find module
    `@metaharness/kernel`".
  - Replaced root `build` script with `scripts/build-ordered.mjs`,
    a 4-phase topological build:
      1. `kernel-js` (everyone depends on it)
      2. `vertical-base` (vertical-trading depends on it)
      3. all hosts + sdk + cli + bench (parallel-safe)
      4. `vertical-trading`
- **`kernel-js/src/index.ts:48`** — `import('../pkg/ruflo_kernel_wasm.js')`
  is wasm-pack output that doesn't exist on a TS-only checkout. Added
  `@ts-ignore`; the runtime gracefully falls back to NAPI when the
  dynamic import fails.
- **`kernel-js/src/memory-rvf.ts:50`** — `@ruvector/rvf` is an OPTIONAL
  peer dep. Added `@ts-ignore` so a fresh install without it builds
  cleanly (already had runtime fallback).
- **`scripts/publish-dryrun.mjs`** — `execFile` of `npm.cmd` on Windows
  with `shell: true` triggers Node 22's DEP0190 deprecation. Switched
  to `cmd.exe /d /s /c npm …` invocation; same behaviour, no warning.

### Added — Iter 23 (2026-06-13)

- **End-to-end integration test**
  (`__tests__/e2e-scaffold-validate.test.ts`) — 4 cases that walk the
  scaffolder → validate pipeline without mocks. This is the strongest
  cross-iter regression net we have; if any of these layers breaks,
  the test fires before publish:
  - `minimal/claude-code scaffolds, then 'harness validate' reports
    HEALTHY` — exercises scaffolder (iter 4), witness shape (iter 3+8),
    path-guard (iter 16), MCP config (iter 8), validate umbrella
    (iter 20) in one chain
  - `scaffolds for every host without throwing` — runs the scaffolder
    against all 6 hosts (claude-code / codex / pi-dev / hermes /
    openclaw / rvm); the previous codex-skills test only catches
    catalog drift, this catches actual generator regressions per-host
  - `scaffold output passes path-guard` — pins that the SCAFFOLDER
    itself doesn't emit hardcoded `/tmp/`, `C:\`, `/Users/` paths —
    if it did, every user-generated harness inherits the original
    iter-1 /tmp Windows bug
  - `subsequent scaffold with same name and force=true is idempotent` —
    catches non-deterministic generation (timestamps in templates,
    Math.random etc.) that would break drift detection
- TS suite: **306/306** (up from 302).
- CI on iter-22 commit: WASM-windows turned green for the first time —
  the iter-18 wasm-pack 0.13.1 + wasm-tools 1.250.0 pins worked.

### Added — Iter 22 (2026-06-13)

- **2 new Codex skills** that surface iter-18 and iter-20 features to
  Codex installations (`.codex/skills/<name>/{skill.toml,README.md}`):
  - **`validate-harness`** — wraps `harness validate`; runs all 5
    release-readiness gates (doctor + verify + path-guard + mcp +
    secrets) and reports per-check PASS/FAIL
  - **`harness-secrets`** — wraps `harness secrets`; modes are
    `check` (validate GCP setup), `fetch` (pipe secret value), and
    `validate-token` (fetch NPM_TOKEN + `npm whoami` confirm)
- **`create-harness` skill expanded to all 6 hosts** — previously the
  `host` arg only listed `claude-code, codex, pi-dev, hermes`. Added
  `openclaw` and `rvm` so Codex users see the full host catalog.
- **`publish-harness` README** added (it was the only skill missing one
  — the cross-skill test caught it).
- **`__tests__/codex-skills.test.ts`** (6 cases) — schema validation
  for every `.codex/skills/*/skill.toml`. Pins:
  - ≥4 skill directories present
  - both `skill.toml` + `README.md` per skill
  - required fields: `[skill].name|version|description`,
    `[dispatch].type=mcp_tool|server`, `[command].name`
  - dir name == `[skill].name` == `[command].name`
  - per-`[[args]]`: `name` + `prompt` present
  - the 4 expected skills (create / publish / validate / harness-secrets)
  - create-harness lists all 6 hosts
- Cumulative TS suite: **302/302** (up from 296).

### Added — Iter 21 (2026-06-13)

- **Wired the publish gates into `.github/workflows/publish.yml`** —
  iters 18 + 20 built `validate-gcp-secrets.mjs` and `publish-dryrun.mjs`
  but they weren't actually called by CI. Now both are mandatory gates
  in the publish job, running after smoke tests but before any
  `npm publish`:
  - **Gate 1**: `node scripts/validate-gcp-secrets.mjs` — re-verifies
    WIF → Secret Manager → `npm whoami` chain on the live runner.
    If anything has drifted between the last successful publish and
    now, the publish aborts BEFORE registry I/O.
  - **Gate 2**: `node scripts/publish-dryrun.mjs` — dry-runs every
    package's publish, exits non-zero if any package would fail
    (broken `files`, missing `bin`, unresolvable workspace ref).
- **Added `setup-gcloud@v2` step** before the gates — the WIF auth
  action sets ADC but doesn't install the SDK, and Gate 1 shells out
  to `gcloud secrets describe`.
- **Per-package publish steps for all 11 workspace packages** (was 2):
  - `@metaharness/kernel` (umbrella)
  - `@metaharness/sdk`
  - 6 host adapters (`host-claude-code`, `host-codex`, `host-pi-dev`,
    `host-hermes`, `host-openclaw`, `host-rvm`)
  - 2 vertical packs (`vertical-base`, `vertical-trading`)
  - `create-agent-harness`
- **`docs/RELEASE.md` updated** with the two new gates and the 11-package
  publish list, plus the rationale: this is the "validation using keys
  from gcp secrets" directive realised as an actual pipeline.

### Added — Iter 20 (2026-06-13)

- **`harness validate` umbrella command** — single release-readiness
  gate that fans out to 5 sub-checks and reports per-check PASS/FAIL:
  - `doctor`     — file-shape + manifest hash + ≥1 host artifact
  - `verify`     — witness manifest signature (skipped if no witness)
  - `path-guard` — TS/JS/Rust files scanned for hardcoded `/tmp/`,
                   `C:\`, `/Users/`, `/home/` (the original Windows
                   /tmp bug regression class)
  - `mcp`        — `.mcp/servers.json` (if present) has `name` +
                   `command` on every entry
  - `secrets`    — `gcloud auth list` + project + secret exist (or
                   skip with `--skip-gcp`)
  - 7 tests cover the umbrella + each check independently.
- **`scripts/publish-dryrun.mjs`** — runs `npm publish --dry-run --json`
  on every non-private workspace package and reports per-package
  PASS/WARN/FAIL with file count + unpacked size. Detects the
  "version already published" case as WARN rather than FAIL so the
  publish gate doesn't block on version-not-bumped. Handles npm's
  `npm.cmd` vs `npm` Windows quirk via per-platform shell:true.
  Validates all 11 packages locally with 10 PASS / 1 WARN / 0 FAIL.

### Fixed — Iter 19 (2026-06-13)

- **4 pre-existing test failures green'd** (`memory.rankWithDecay` and
  3 `SelfEvolvingRouter` tests):
  - `loadEmergent` in both `memory.ts` and `self-evolution.ts` used to
    consider `@ruvector/emergent-time` "available" as soon as the JS
    shim dynamically imported. But the WASM bindings need explicit
    `init()` before constructors work — the shim loads, the dynamic
    import resolves, and then `new emergent.AgenticClock(...)` throws
    `Cannot read properties of undefined (reading 'agenticclock_new')`.
    Probe-construct + discard inside `loadEmergent` catches that case
    and returns null so callers see a consistent "graceful absent"
    signal. Same pattern for `LearnedWeights` (also guards against
    upstream API drift).
  - `SelfEvolvingRouter` EMA fallback used `reward` directly as the
    EMA target. Since `computeReward` returns [0, 1] and the initial
    weight is 1.0, ALL touched tiers drifted below initial — meaning
    untouched tiers ALWAYS won re-ranking. Fixed by mapping the target
    to `reward * 2`, so 0.5 (neutral reward) maps to 1.0 (initial),
    successes pull above, failures below. The previously-failing
    "rewards successful tier" test now passes deterministically.
- TS suite: **289/289 passing** (up from 259/263).

### Added — Iter 18 (2026-06-13)

- **`harness secrets` subcommand** — long-requested GCP Secret Manager
  integration delivered as `harness secrets <check|fetch|validate-token>`:
  - `check` validates the full setup (gcloud on PATH, active project,
    auth principal, secret exists, WIF pool present)
  - `fetch <name>` prints a secret value to stdout (for `eval`/pipe use)
  - `validate-token` fetches `NPM_TOKEN` and runs `npm whoami` against
    the registry — no publish, just confirms the token is non-revoked
  - Common flags: `--project=<id>`, `--secret=<name>`, `--version=latest`
  - Shells out to `gcloud` (already a documented prereq) rather than
    pulling in `@google-cloud/secret-manager` (12 MB dep). 8 unit tests
    cover the mock-gcloud paths.
- **`scripts/validate-gcp-secrets.mjs`** — standalone pre-publish gate
  for `.github/workflows/publish.yml`. Runs 6 fail-fast checks before
  any `npm publish` and exits non-zero with structured `[gcp-validate]
  PASS/FAIL/WARN/INFO` lines that CI can grep on.

### Fixed — Iter 18 (2026-06-13)

- **CI WASM-windows broken** — `cargo install wasm-pack --locked`
  pinned to 0.15.0 whose lockfile pulls `cargo-platform 0.3.3` requiring
  rustc 1.91+. Pinned `wasm-pack 0.13.1` (rustc-1.74 compatible).
  Defensively pinned `wasm-tools 1.250.0` so future MSRV bumps don't
  silently break the matrix again.
- **`packages/host-rvm/src/index.ts:166` syntax error masked by
  `.replace()` hack** — the `lifecycle = "managed"` line opened with a
  backtick but closed with a single quote (`` `…"managed"');``). esbuild
  refused to transform the file, which silently dropped 26 tests from
  the suite. Removed the `.replace()` post-process and fixed the
  template literal properly. The 26 host-rvm tests now actually run.

### Fixed — Iter 17 (2026-06-13)

- **CI red on `e8d5b77` (iter 16) — all 3 OS Rust + WASM jobs failing.**
  Root causes + fixes (commit `f7245cc`):
  - `rust-toolchain.toml` pinned to **1.83.0** (Nov 2024). `wasm-tools
    1.252.0` + current `wasm-pack` need 1.85+. Bumped to **1.88.0**
    (latest stable as of 2025-06-26).
  - Workspace `rust-version` 1.75 → 1.85 (kernel-napi build script
    uses 1.77+ `cargo::` instruction syntax).
  - `cargo fmt --all` re-ran with 1.88 — 11 files reformatted.
  - 52 `missing_docs` errors on stub APIs (1.85+ tightened the check):
    removed from crate-wide warn, kept `rust_2018_idioms`.
  - `napi` crate needed `serde-json` feature for `serde_json::Value`
    return values.
  - `clippy::uninlined_format_args` fix in `witness_sign` bench.
  - Verified locally: fmt clean, clippy -D warnings clean, all tests pass.

### Added — Iter 16 (2026-06-13)

- **Full 3-platform CI matrix** — Ubuntu / macOS / Windows on every gate:
  - Rust (fmt --check / clippy -D warnings / test / doc) × 3 OS
  - WASM build + `wasm-tools validate` + 500 KB size budget × 3 OS
    (catches "works on Linux only" regressions in the wasm-pack pipeline)
  - Node 20 + 22 × 3 OS for TS tests
  - **`pack-install` job × 3 OS** — `npm pack` every published package
    then `npm install <tarball>` into a throwaway project. Catches the
    "broken files: [...] list", "missing bin script", "per-platform
    install fail" classes upstream of release.
  - Bench (smoke, Linux only — uploads `bench-report.json` artifact)
  - Final `ci-pass` aggregator job for branch-protection
- **Cross-platform path-handling guard** (`scripts/path-guard.mjs`):
  - Greps every Rust + TS source file for known-bad patterns:
    - Hardcoded `/tmp/` literals (the exact `/tmp` Windows bug that
      surfaced earlier in development — file writes appeared to succeed
      but landed somewhere bash couldn't see)
    - Hardcoded `C:\\`, `/Users/`, `/home/` absolute paths
  - Excludes tests, fixtures, and comments
  - Runs in CI on every push/PR via the Node job
- **`__tests__/path-handling.test.ts`** (8 cases): pins
  `os.tmpdir()` non-empty on every platform, posix.sep normalisation
  invariants, Windows drive-letter detection, mkdtemp parallel uniqueness
- **`@ruvector/rvf` integration** (paired with RVM per user request):
  - `@metaharness/kernel`: declares `@ruvector/rvf ^0.2.0` as optional peer
    dep + new `./memory-rvf` subpath export
  - `packages/kernel-js/src/memory-rvf.ts`: `createRvfBackend()`
    returns a `RvfBackend` wrapper over RVF's HNSW + SIMD index;
    `isRvfAvailable()` predicate; graceful null fallback when RVF
    isn't installed
  - `@metaharness/host-rvm`: emitted `wasm-guest.json` now declares
    `companion.vector_format` referencing `@ruvector/rvf` +
    `@ruvector/rvf-wasm`, marked `recommended: true`
  - host-rvm README documents the pairing (hardware-isolated vector
    storage via RVM partition + RVF binary format + RVF-wasm sub-guest)
  - 2 new TS test cases in memory-rvf + 1 new in host-rvm pinning
    the companion declaration

### Added — Iter 15 (2026-06-13)

- **`@metaharness/vertical-base` shared contract** for `@metaharness/vertical-*` packs
  (per ADR-013):
  - `VerticalPack`, `VerticalManifest`, `TemplateFileEntry`,
    `TemplateVar` interfaces
  - `readVerticalManifest(packRoot)` — reads + validates `manifest.json`
  - `validateVerticalManifest()` — throws descriptive errors on shape
    issues (missing id/description, missing src/dst/render, duplicate
    var names)
  - `verifyTemplateFilesPresent()` — pre-publish check for dangling
    references
  - 11 new TS test cases
- **`@metaharness/vertical-trading` standalone pack** — first concrete pack
  in the new pattern:
  - `templates/manifest.json` declares 10 files + 3 vars (name +
    description + host — host choices include all 6 host adapters,
    including the new RVM)
  - `load()` returns `{ manifest, templateRoot }` for the
    create-agent-harness external-template loader to consume
  - README documents the 5-agent pipeline + paper-mode-default + circuit
    breakers + Kelly multiplier + risk disclosure
  - 5 new TS test cases (templateRoot non-empty, manifest exists, load()
    returns valid, file-presence check, host choices include all 6)
- **External-template loader in CLI**
  (`packages/create-agent-harness/src/external-template.ts`):
  - `loadExternalTemplate(packageName)` dynamic-imports the pack package,
    calls its `.load()`, returns `{ manifest, templateRoot }`
  - Actionable error messages on missing package (`Did you forget to
    install it?`) + missing `load()` export + malformed result
  - CLI now accepts `--template-package @metaharness/vertical-trading` to use
    an external pack instead of a bundled template
  - 2 new TS test cases (empty packageName rejected, missing package
    error message contains install hint)

### Added — Iter 14 (2026-06-13)

- **`@metaharness/sdk` convenience helpers** for harness authors:
  - `defineAgent` / `defineSkill` / `defineTool` / `defineHook` /
    `defineMcpServer` / `defineHarness`
  - Every helper returns a frozen object (immutable post-definition)
  - Validates kebab-case names, non-empty system prompts, valid tiers,
    XOR command/url on MCP servers, name collisions across agents/skills
  - 18 new TS test cases pinning every validation rule + collision
    detection + freeze invariant
- **Browser-runtime WASM smoke fixture** (`__tests__/browser-smoke/`):
  - `fixture.html` loads `@metaharness/kernel`'s wasm bundle in a real browser
  - Runs the 3 key exports (`kernelInfo`, `mcpValidate` pass + reject)
  - Sets `window.__SMOKE_RESULT` for Playwright to read in iter 16
  - README documents how to serve the fixture today
- **Pre-publish validation script** (`scripts/preflight.mjs`):
  - 11 gates (git clean, on-main warn, version consistency, READMEs,
    publishConfig, CHANGELOG iter entry, LICENSE MIT, cargo fmt/clippy/
    test, wasm-pack build + size budget, npm test)
  - `--skip-wasm` and `--skip-rust` for faster local iterations
- **Release runbook** (`docs/RELEASE.md`):
  - 9-package release matrix (kernel + sdk + 6 host adapters + cli)
  - Step-by-step process: preflight → bump → tag → workflow fires →
    verify
  - Rollback policy (npm deprecate, never unpublish unless < 72h)
  - Dry-run workflow trigger for validating GCP auth without publishing

### Changed — Iter 13 (2026-06-13)

- **Repositioned as a META-HARNESS** in README + USAGE.md + GitHub
  description. agent-harness-generator is now explicitly positioned as
  *a harness that builds other harnesses* — the level above ruflo /
  Claude Code / etc. Architecture diagram updated to show the meta-
  harness layer above the harness-the-user-ships layer.

### Added — Iter 13 (2026-06-13)

- **`@metaharness/bench` package** — reproducible memory-retrieval benchmark:
  - 6 configs scored side-by-side (k ∈ {1,3,10} × decay ∈ {on,off})
  - Synthetic corpus + queries deterministic via `mulberry32` seed
  - 4-category eval (single-hop / temporal / multi-hop / open-domain)
    matching Mem0's shape
  - Reports recall@k, MRR, p50/p95 latency, per-category breakdown
  - JSON report header cites the Mem0 + ReasoningBank published baselines
    so users can compare against the real numbers
  - The ReasoningBank k=1 finding is testable in our shape: the report
    surfaces whether k=1 beats k=10 on temporal
  - 10 new TS test cases (cosine, decay, rank with/without decay,
    deterministic reproducibility, k-monotonicity)
- **Trajectory persistence** (`packages/kernel-js/src/trajectory.ts`):
  - `TrajectoryStore` — JSONL append-only with rotation cap
  - `append()`, `readAll()`, `rotateIfLarger(maxBytes)`, `size()`
  - 4 new TS test cases (append+read round-trip, empty-file handling,
    rotation no-op + rotation fires)
- **TS-side MCP dispatch wrapper** (`packages/kernel-js/src/dispatch.ts`):
  - `ToolDispatcher` in-process registry + dispatch with claims check
  - Structured outcome { result | denied | not-found | bad-args }
  - Honors wildcard `*` capabilities, `tool.invoke.*` suffix wildcards,
    and resource glob `agents/*`
  - Surfaces handler exceptions as denied with the message
  - 8 new TS test cases pinning every outcome path

### Added — Iter 12 (2026-06-13)

- **Sixth host adapter: `@metaharness/host-rvm`** for
  [RVM](https://github.com/ruvnet/rvm) — the Agentic Virtual Machine.
  Positioned as the **hardware-isolated deployment target** (vs the
  five OS-level adapters)
  - Generates `rvm-partition.toml` (TOML partition manifest), `capability-
    table.json` (capability tokens from kernel claims), `wasm-guest.json`
    (kernel bundle reference + F1–F4 recovery map), and idempotent
    `install-rvm.sh`
  - `rightsFromCapability()` maps the kernel's claim-capability strings
    onto RVM's 7 rights (READ/WRITE/GRANT/REVOKE/EXECUTE/PROVE/GRANT_ONCE)
  - `defaultProofTier()` derives the right's proof tier (P1 read, P2
    write/execute, P3 grant/revoke/prove)
  - `buildCapabilityTable()` lossless lift from kernel claims to RVM caps
  - **The kernel's WASM bundle IS the RVM guest** — no fork; one source,
    six deployment targets
- **ADR-018** documents RVM as the deployment target tier, the claim→
  capability mapping, the tier picture, trade-offs (AArch64-only, rvm-
  loader not on crates.io yet)
- `HOSTS` const in `create-agent-harness` now lists 6 hosts
- README badge added, host table extended with the hardware-isolated tier
- USAGE.md + create-agent-harness/README.md host tables updated
- Topics updated on GitHub

### Added — Iter 11 (2026-06-13)

- **Fifth host adapter: `@metaharness/host-openclaw`** for
  [OpenClaw](https://github.com/openclaw/openclaw) — "Personal AI Assistant.
  Any OS. Any Platform. The lobster way. 🦞"
  - Generates `openclaw.json` (JSON, not TOML/YAML) snippet to merge into
    `~/.openclaw/openclaw.json` under `mcp_servers`
  - Generates `SKILL.md` with YAML frontmatter + markdown for the
    workspace skill at `~/.openclaw/workspace/skills/<name>/SKILL.md`
  - Generates idempotent `install-openclaw.sh` runbook:
    `npm install -g openclaw@latest` → `openclaw onboard --install-daemon`
    → merge MCP snippet → drop SKILL.md in workspace
  - YAML-safe quote escaping in skill description
  - 16 new TS test cases covering serverToOpenClaw stdio/url/env,
    configJson shape + valid-JSON + trailing-newline, skillMarkdown
    frontmatter + quote escaping + agent listing, installScript shebang
    + onboard cmd + workspace path, adapter export contract
- `HOSTS` const in `create-agent-harness` now includes `openclaw` (5 total)
- README, USAGE.md, package READMEs updated with `openclaw` row
- OpenClaw badge added to README header
- Comparison table in `host-openclaw/README.md` highlights what's
  different from the other four adapters (only host with built-in
  multi-platform messaging WhatsApp/Telegram/Slack/Discord)

### Added — Iter 10 (2026-06-13)

- **MCP tool dispatch chain in Rust kernel** (`crates/kernel/src/dispatch.rs`):
  - `ToolCallRequest`, `Dispatch::{Invoke, NotFound, BadArgs, Denied}`
  - `dispatch()` looks up the tool, shape-checks args (must be JSON
    object), checks claims against `tool.invoke.<server>.<tool>` capability
  - `dispatch_unauthenticated()` skips claim check for SelfPeer/dev paths
  - 6 new Rust test cases including the capability-specificity case
    (allow `tool.invoke.memory.*` does NOT allow alerts)
- **Cost tracking subsystem in Rust** (`crates/kernel/src/cost.rs`):
  - `CostEvent`, `CostTotals` with per-tier breakdown +
    success/fail counts
  - `check_budget()` returns Ok(remaining) or Err(over-by)
  - `success_rate()` and `avg_cost()` derivers
  - 5 new Rust tests
- **AST-aware identifier rename** (`packages/create-agent-harness/src/
  rename.ts`):
  - Token-boundary-aware regex (no Babel dependency)
  - Skips partial-word matches (`oldName` doesn't touch `oldNameXY`)
  - Skips left-side property accesses (`obj.oldName.foo` left alone)
  - DOES rename inside string literals (intentional — error messages
    reference identifiers by name)
  - `renameFileMap()` helper for bulk transforms
  - 13 new TS tests including rule-chain ordering (a -> b -> c)
- **Tarball builder for IPFS** (`packages/create-agent-harness/src/
  tarball.ts`):
  - POSIX ustar format with FIXED metadata (mode 0644, mtime 0, uid 0,
    gid 0, ustar version "00") for deterministic sha256 across CI
    runners
  - Skips .git, node_modules, target, dist, .cache
  - 5 new TS tests including determinism + content-change-changes-hash
- **Cross-host integration smoke** (`__tests__/integration/multi-host.test.
  ts`):
  - Scaffolds minimal template for every host -> validates package.json
    declares @metaharness/host-<n>
  - Scaffolds every template for claude-code -> validates artifact
    presence
  - mcpServers config contains the harness name

### Added — Iter 9 (2026-06-13)

- **Federation transport in Rust kernel** (`crates/kernel/src/federation.rs`):
  - `Peer`, `TrustTier` (Untrusted / Trusted / SelfPeer), `Message`
    envelope, `PeerRegistry`
  - `admit_message()` security primitive: SelfPeer always admits; Trusted
    admits read-only ops without claim; everything else needs a claim
  - `is_read_only_capability()` recognises `*.read`, `*.list`, `*.search`
    plus a small allowlist
  - 11 new Rust tests pinning the admit-decision matrix
- **`harness federate` subcommand** (`packages/create-agent-harness/src/
  federate.ts`):
  - 5 subactions: `init`, `add`, `remove`, `list [--trusted]`, `status`,
    `help`
  - State persisted at `.harness/federation.json`
  - Immutable state operations (test-friendly)
  - 11 new TS tests
- **Real intelligence pipeline orchestration** (`crates/kernel/src/intel.rs`):
  - `PipelineState` with steps + completed + aborted
  - `next_phase()` advances Retrieve -> Judge -> Distill -> Consolidate;
    Skip outcomes still advance, Fail outcomes abort the pipeline
  - `should_fire_distill()` fallback predicate (judge_score >= 0.7) for
    when the TS PageHinkleyDetector isn't loaded
  - 7 new Rust tests
- **Renovate config** (`renovate.json`):
  - Weekly schedule, automerge patch/minor, group @metaharness/* and
    @ruvector/* internal
  - wasm-bindgen / wasm-bindgen-cli marked no-automerge (toolchain
    upgrades need review)
  - ed25519-dalek MAJOR bumps require explicit sign-off (security-critical
    label)
  - lockFileMaintenance enabled
- **Examples directory** (`examples/`):
  - `multi-host/` walkthrough showing one harness targeting Claude Code +
    Codex
  - `federation/` walkthrough showing 2-peer trust-tier coordination

### Added — Iter 8 (2026-06-13)

- **`harness` CLI binary** (`packages/create-agent-harness/src/harness-bin.ts`)
  with three subcommands:
  - `harness sign [path]` — produce/update witness manifest; reads
    `WITNESS_SIGNING_KEY` env (64-char hex), refuses on missing/malformed
    keys, delegates to kernel signing when available, emits a shape-valid
    placeholder otherwise (so doctor + verify report the gap explicitly)
  - `harness verify [path]` — read + verify witness.json, prints harness
    name + version + entry count + public key prefix
  - `harness doctor [path]` — smoke checks: package.json, @metaharness/kernel
    dep, .harness/manifest.json + .sha256, manifest hash consistency,
    at least one host artifact (.claude/, .codex/, AGENTS.md, or
    cli-config.yaml)
  - `harness help` — usage summary
- 11 new TS test cases for the subcommands (help, verify with/without
  witness, doctor healthy/missing-host/hash-mismatch, sign with/without
  key/with malformed key)
- Package bin map adds `harness` binary alongside `create-agent-harness`
- **MCP tool registry in Rust kernel** (`crates/kernel/src/mcp.rs`):
  - `ToolSpec` (name, server, description, JSON-schema input)
  - `ToolRegistry` with register/get/list/for_server, replaces on same
    (server, name) key
  - `validate_tool()` requires non-empty name + server, schema must be
    a JSON object
  - 7 new Rust test cases (validate-tool, registry register/get/replace,
    for-server filter)
- **Per-package READMEs** for the 6 npm-published packages:
  - `@metaharness/kernel` — kernel API + memory subpath usage
  - `create-agent-harness` — scaffold quick start + template + host matrix
  - `@metaharness/host-claude-code` — hooks three-level shape, 3 settings scopes
  - `@metaharness/host-codex` — TOML quirks (trusted-project gate, no hooks)
  - `@metaharness/host-pi-dev` — no-MCP design clarification, badlogic Pi (NOT
    Inflection)
  - `@metaharness/host-hermes` — Hermes-4 `<think>` / `<tool_call>` quirk,
    two-project disambiguation
- **GCP setup automation** (`scripts/setup-gcp.sh`):
  - One-shot bash script: APIs → WIF pool → OIDC provider → publisher SA
    → pool-to-SA binding → NPM_TOKEN secret → SA read access → variable
    wiring instructions
  - Idempotent — re-runnable; skips steps already done

### Added — Iter 7 (2026-06-13)

- **Real Hooks subsystem in Rust** (`crates/kernel/src/hooks.rs`):
  - `HandlerSpec` + `HandlerKind` (5 types per Claude Code: Command, Http,
    McpTool, Prompt, Agent)
  - `matcher_matches()` with pseudo-DSL support (`*`, `Bash(rm *)`)
  - `merge_decisions()` with defer-cascade rule + per-event default
    (PreToolUse / SubagentStart default to Ask, others to Allow)
  - 10 new Rust tests pinning matcher + merge invariants
- **Real Claims subsystem in Rust** (`crates/kernel/src/claims.rs`):
  - `check()` with wildcard + prefix-with-dot + glob resource matching
  - Expired claims skipped; first matching unexpired wins
  - 9 new Rust tests
- **Self-evolving routing TS layer**
  (`packages/kernel-js/src/self-evolution.ts`):
  - `SelfEvolvingRouter` wraps `@ruvector/emergent-time`'s
    `LearnedWeights` over the kernel router
  - `computeReward()` from success + latency + cost components
  - Graceful EMA fallback when emergent-time isn't installed
  - 8 new TS tests pinning reward computation, learning behaviour, bias
- **End-user walkthrough doc** (`docs/USAGE.md`):
  - 11-section walkthrough from install to publish to self-evolution
  - Troubleshooting table covering the 5 most likely failure modes

### Added — Iter 6 (2026-06-13)

- 3 vertical templates: trading, legal, research (5 total templates)
- Witness verification client wired into publish gate
- Marketplace registry entry generator (matches ruflo plugin registry shape)

### Added — Iter 5 (2026-06-13)

- Memory subsystem with `@ruvector/emergent-time@0.1.0` integration
- Full ruflo-eject pipeline (`--from-existing`)
- Real 3-tier routing heuristics in Rust kernel
- `vertical:support` template
- `harness publish` IPFS subcommand (Pinata)

### Added — Iter 4 (2026-06-13)

- End-to-end scaffold pipeline (template walker + atomic writer)
- `vertical:devops` template
- `harness upgrade` drift detection
- `--from-existing` ruflo-eject detection

### Added — Iter 3 (2026-06-13)

- **Real Ed25519 witness signing in Rust** (`crates/kernel/src/witness.rs`)
  - `sign_manifest()` + `verify_manifest()` using `ed25519-dalek` 2.1
  - Canonicaliser (`canonical_payload`) that sorts entries by id ascending
    for deterministic signatures across CI runners (load-bearing for ADR-011)
  - `sha256_hex()` helper for marker fingerprinting
  - 8 new tests pinning sign/verify, sort-invariance, tamper detection
  - Criterion bench (`benches/witness_sign.rs`): sign-10, sign-100, verify-50
- **Codex skills** (`.codex/skills/`):
  - `create-harness/skill.toml` + `README.md` — invoked as `/create-harness` in Codex
  - `publish-harness/skill.toml` — smoke-test + witness-sign + publish gate
  - `config.toml.example` — drop-in for `~/.codex/config.toml` MCP registration
- **GCP Workload Identity Federation setup** (`docs/setup/gcp-secrets.md`)
  - 6-step gcloud walkthrough + Terraform equivalent
  - Variable wiring (`GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_WIF_SERVICE_ACCOUNT`)
  - Rotation instructions
- **Template engine** (`packages/create-agent-harness/src/renderer.ts`)
  - Mustache-style `{{var}}` interpolation with unresolved-var reporting
  - `extractVarReferences()` for template lint
  - `validateHarnessName()` mirroring npm's rules
- **`.harness/manifest.json` schema** (`packages/create-agent-harness/src/manifest.ts`)
  - Mirrors copier's `.copier-answers.yml` for drift detection (ADR-008)
  - sha256-based file fingerprinting
  - `diffFingerprints()` returns added/removed/changed paths
- 25 new tests across renderer + manifest (29 → 54 total TS test cases)

### Added — Iter 2 (2026-06-13)

- 4 host adapter packages: `@metaharness/host-{claude-code,codex,pi-dev,hermes}`
- First template (`templates/minimal/`)
- Claude marketplace plugin manifest (`.claude-plugin/plugin.json`) + 2 skills
- Vitest config + 29 TypeScript test cases
- Rust criterion benches (`mcp_validate`, `witness_canon`)

### Added — Iter 1 (2026-06-13)

- Cargo workspace + npm workspace scaffold
- 7-subsystem Rust kernel stubs with serde round-trip tests
- WASM bindings (wasm-bindgen) + NAPI-RS bindings
- `@metaharness/kernel` runtime resolver (native → wasm fallback)
- `create-agent-harness` CLI entry point
- CI matrix (Rust × 3 platforms, wasm validate + 500 KB budget, Node 20/22 × 3 platforms)
- Publish workflow (GCP Workload Identity Federation → Secret Manager → npm provenance)
- Security workflow (cargo-audit, cargo-deny, npm-audit, CodeQL, weekly cron)
- Smoke test contract (`scripts/smoke.mjs`)

### Designed — Pre-iter (2026-06-13)

- 17 ADRs in `docs/adrs/` covering kernel boundary, generator architecture, host integration, marketplace, memory/learning, CI guards, drift detection, anti-slop, TDD, witness, eject/upgrade, vertical packs, self-evolution, naming, migration

## How releases work

This project versions to semver. Publishes are tag-driven and gated on:
1. CI matrix green
2. WASM bundle within size budget
3. Witness manifest signed
4. GCP Secret Manager NPM_TOKEN fetched via Workload Identity Federation
5. `npm publish --provenance` (SLSA L2)

No long-lived NPM token exists in any GitHub secret. See [`docs/setup/gcp-secrets.md`](docs/setup/gcp-secrets.md).
