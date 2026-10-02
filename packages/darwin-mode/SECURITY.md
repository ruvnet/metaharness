# Darwin Mode — Security Model & Adversarial Audit

> Package: `@metaharness/darwin` (`packages/darwin-mode`)
> Scope: the self-modification boundary — `src/safety.ts`, `src/sandbox.ts`, `src/scorer.ts`.
> Audit suite: `__tests__/security/` (97 tests).

Darwin Mode lets an agent **mutate its own harness** (seven policy files), run the
mutated harness against a benchmark, and promote measured, safe wins. A
self-modifying agent that can edit anything is a liability; this document
describes the boundary that makes the system **honestly bounded**, the
adversarial tests that pin it, and the **residual gaps** the audit found.

Related ADRs:
[ADR-070](../../docs/adrs/ADR-070-darwin-mode-self-improving-harness.md) (loop) ·
[ADR-071](../../docs/adrs/ADR-071-darwin-mutation-surfaces-safety-allowlist.md) (mutation surfaces + gate) ·
[ADR-072](../../docs/adrs/ADR-072-darwin-scoring-and-promotion.md) (scoring + promotion) ·
[ADR-073](../../docs/adrs/ADR-073-darwin-archive-and-selection.md) (archive/lineage) ·
[ADR-074](../../docs/adrs/ADR-074-darwin-ruvector-memory-ruflo-fabric.md) (memory/fabric) ·
[ADR-075](../../docs/adrs/ADR-075-darwin-prototype-roadmap-and-acceptance.md) (acceptance).

---

## 1. Threat model

**Adversary**: the variant generator (today a deterministic mutator; tomorrow an
LLM behind the *same* gate). It is assumed to be capable of emitting any text
into the files it is allowed to write, and to *try* to:

1. **Escape the allowlist** — write an 8th file, a nested dir, a symlink to host
   files, a dependency manifest, or an `.env`/key file.
2. **Smuggle a capability** — embed `process.env`, `child_process`, `fetch`, a
   shell string (`curl|sh`), `eval`, dynamic `import`, or a destructive fs op in
   an *approved* file.
3. **Exfiltrate via the test command** — leak ambient secrets (`AWS_SECRET_ACCESS_KEY`,
   proxy config) or inject shell metacharacters (`;`, `&&`, `$(...)`) into the
   command that scores it.
4. **Re-grade itself** — propose a self-serving `score_policy.ts` to inflate its
   own score, or get promoted while carrying a blocked action.

**Not in scope** (see §7): containing *arbitrary native code* that a
repo-provided test command legitimately runs — that is an OS-sandbox concern,
not this gate's. This gate bounds *what the agent writes*, not what the repo's
own test runner does.

---

## 2. The seven-file allowlist (ADR-071)

A variant directory may contain **only** these seven files — one concern each.
Anything else is disqualified before execution.

| Surface (`MutationSurface`) | File | Controls |
|---|---|---|
| `planner` | `planner.ts` | task decomposition |
| `contextBuilder` | `context_builder.ts` | what enters context |
| `reviewer` | `reviewer.ts` | patch critique |
| `retryPolicy` | `retry_policy.ts` | retry / abandon / escalate |
| `toolPolicy` | `tool_policy.ts` | which tools, in what order |
| `memoryPolicy` | `memory_policy.ts` | remember / retrieve / forget |
| `scorePolicy` | `score_policy.ts` | *proposes* weights (read-only at run time) |

Source of truth: `FILE_BY_SURFACE` / `APPROVED_FILES` in `src/safety.ts`.

---

## 3. Two-layer, defense-in-depth gate (ADR-071)

Two **independent** checks share `BLOCKED_CONTENT_PATTERNS` but run at different
points, so a class that slips one is caught by the other.

- **`inspectVariant(dir)`** — runs in the sandbox **before any command executes**.
  Walks the directory with `lstat` (never follows symlinks), enforces the
  allowlist, blocked-filename substrings, size cap (256 KiB/file), entry cap
  (32), and content patterns. Returns a non-empty findings list to disqualify.
- **`validateGeneratedCode(code)`** — runs on LLM/agent output **before it is
  written to disk**. Content-only, de-duplicated reasons. A violating generation
  is **discarded, never repaired in place**.

Both are **code, not comments**. A disqualified variant never has its test
command run: the sandbox seals a `RunTrace` with the reserved `exitCode 99` and
records the findings as `blockedActions`.

---

## 4. Shell-free, env-scrubbed sandbox (ADR-070 §sandbox)

`runVariantTask` in `src/sandbox.ts`:

- **Gate first.** `inspectVariant` runs before anything; findings ⇒ `exitCode 99`,
  no command executed (proven: `sandbox-injection.test.ts` →
  *"disqualified variant never runs its command"*).
- **No shell.** The command is whitespace-split into argv and run via
  `execFile` — **never** a shell. `;`, `&&`, `|`, `$(...)` are inert argument
  strings, not metacharacters (proven: *"shell-free execution"* cases).
- **Scrubbed env.** Only `PATH`, `NODE_ENV=test`, `METAHARNESS_VARIANT`,
  `METAHARNESS_TASK` are exposed. `AWS_SECRET_ACCESS_KEY`, `HTTP_PROXY`,
  `DARWIN_SECRET`, etc. read as `undefined` inside the command (proven:
  *"environment scrubbing"* case).
- **Never throws.** A failing/timing-out command becomes a `RunTrace`, so a
  hostile variant cannot abort the evolution loop.

---

## 5. Frozen scorer / benchmark immutability (ADR-072)

`scoreVariant` in `src/scorer.ts` is **frozen kernel code**, *not* the variant's
`score_policy.ts`. Its only inputs are
`(variantId, traces, parentScore, promotionDelta, taskTimeoutMs)` — **there is no
parameter through which variant file content can enter**. A variant may *propose*
different weights, but the authoritative verdict is computed here, so a variant
**can never re-grade itself** (proven: `scorer-immutability.test.ts`).

Two structural guarantees:

- **Any `blockedActions` ⇒ `safetyScore 0` ⇒ `promoted: false`**, and the
  promotion gate requires `safetyScore ≥ 0.95`. An unsafe variant cannot win,
  even against a weak parent (proven: *"a blocked-action variant can NEVER be
  promoted"*).
- **Reproducible.** Identical traces yield an identical `finalScore`/`promoted`,
  independent of `variantId` (proven: *"identical traces ⇒ identical verdict"*).

The child also **cannot edit the benchmark**: `tasks` and `testCommand` live in
the `RepoProfile`, outside the variant directory and outside the allowlist
(ADR-071 rule 9).

---

## 6. The ten containment rules → where enforced → which test proves it

| # | Rule (ADR-071) | Enforced in | Proving test |
|---|---|---|---|
| 1 | No production writes | allowlist; sandbox runs in repo root with scrubbed env, variant dir is write target only | `inspect-bypass` (allowlist), `sandbox-injection` (disqualified-never-runs) |
| 2 | No credential access | `BLOCKED_FILENAME_PATTERNS` (`.env`/`secret`/`token`/`id_rsa`/…) + `BLOCKED_CONTENT_PATTERNS` (secret handling) + env scrub | `inspect-bypass` (blocked filenames + blocked content `secret/token/credential/private_key`); `sandbox-injection` (env scrub) |
| 3 | No network by default | content patterns `fetch(`/`XHR`/`WebSocket`/`node:net,http,…`/`from 'net'…`/`curl,wget,ssh` | `inspect-bypass` + `validate-generated` (network cases) |
| 4 | No mutation outside approved files | `APPROVED_FILES` allowlist; `MAX_FILES`; no nested dirs; no symlinks | `inspect-bypass` (extra files, subdir, symlink, >32 entries) |
| 5 | No promotion without benchmark evidence | `scoreVariant` promotion gate (4 clauses) | `scorer-immutability` + `scorer.test.ts` (gate) |
| 6 | No deletion commands | content patterns `rm` + flag/path (`\brm\s+[-/]`)/`rmdir`/`unlink`/`rmSync` | `inspect-bypass` + `validate-generated` (`rm -rf`, `rm <path>`, `rmSync`) |
| 7 | No child-process escape | content patterns `child_process`/`exec*`/`spawn*` | `inspect-bypass` + `validate-generated` (process exec); `sandbox-injection` (no shell) |
| 8 | No hidden state | size cap + entry cap; no symlinks (no out-of-tree state) | `inspect-bypass` (oversized file, >32 entries, symlink) |
| 9 | No benchmark changes by the child | tasks/testCommand are in `RepoProfile`, never in the allowlist; scorer takes only traces | `scorer-immutability` (no variant-file channel) |
| 10 | Full lineage + rollback | archive tree + witness (ADR-073/ADR-011) | covered by `archive.test.ts` (out of this audit's scope) |

---

## 7. Residual risks / out of scope

### 7a. Hardened content-scan gaps (FIXED)

The audit found three blind spots where a payload defeated
`BLOCKED_CONTENT_PATTERNS`. **All three are now closed in `src/safety.ts`** (both
`inspectVariant` and `validateGeneratedCode` inherit the same patterns), and the
tests that documented them are pinned **green** as regression tests.

| # | Former bypass | Payload | Fix shipped in `BLOCKED_CONTENT_PATTERNS` |
|---|---|---|---|
| **#1** | Computed-member env access | `process['env']` · ``process[`env`]`` · `Reflect.get(process,'env')` | `/process\s*[.[]\s*['"\x60]?\s*env/i` (dot **or** bracket, optional quote/backtick) + a dedicated `/\bReflect\s*\.\s*get\s*\(\s*process/i` |
| **#2** | Subpath module import | `import … from 'fs/promises'` (also `'fs/x'`, `'net/…'`) | `/from\s+['"](fs|net|http|https|dns|tls|dgram|cluster|vm|worker_threads)(\/[^'"]*)?['"]/i` + `node:fs/…` subpaths |
| **#3** | Non-`-rf` destructive shell | `"rm /etc/important_config"` (a bare `rm <path>`) | `/\brm\s+[-/]/i` (any flag **or** path), not only `rm -rf` |

> Even before the fix, the env-scrub in the sandbox (§4) meant **#1 could not
> exfiltrate a real secret at run time** (env is empty) and the no-shell
> execution limited **#2/#3** to an already-scrubbed Node process — so these were
> defense-in-depth erosions of layer 1, not a full break. They are now closed so
> the static scan and the structural guarantees agree.

Files: `__tests__/security/inspect-bypass.test.ts` (hardened #1a/#1b/#1c/#2/#3),
`__tests__/security/validate-generated.test.ts` (hardened #1/#2/#3) — now green.

### 7a-bis. Hardened content-scan gap, 4th instance (FIXED — 2026-10-02)

A 2026-10-02 Dream Cycle re-audit (`docs/dream-cycle/2026-10-02-gist.md`) found a
4th blind spot in the same family as §7a, and closed it the same way.

| # | Former bypass | Payload | Fix shipped in `BLOCKED_CONTENT_PATTERNS` |
|---|---|---|---|
| **#4** | Optional chaining (`?.`) | `process?.env` · `process?.['env']` · `process?.binding(` · `Reflect?.get(process,…)` · `eval?.(` · `fetch?.(` · `require?.(` · generic `exec?.(` | Every pattern requiring the identifier to be IMMEDIATELY followed by `.`/`(`/`[` now tolerates an optional `?.` in between (`\??\.?` inserted before the separator). `import(` and `new Function` are unaffected — `?.` on either is a JS **syntax error** (cannot optional-chain a `new` expression or the `import()` keyword form), confirmed empirically, so no fix was needed there. |

> Unlike #1-#3, this one has **no structural second layer**: #1's env-scrub
> meant a successful `process.env` read returned nothing live, and #2/#3's
> no-shell-execution contained the blast radius to an already-scrubbed Node
> process. `fetch?.(...)` has no such backstop — `tier2-sandbox.ts`'s Tier-2
> agent sandbox genuinely executes a passing variant's real surface code in a
> live (env-scrubbed but network-unrestricted) Node child, so a variant that
> cleared this gate with `fetch?.(...)` could make a real outbound HTTP call,
> violating ADR-071 containment rule #3 ("no network access by default") for
> real, not just on paper. Also unlike #1-#3, these are not obfuscation —
> optional chaining is ordinary, idiomatic modern TS an LLM mutator is likely
> to emit with no evasive intent at all.

**Round 2 (same night, independent critic):** the round-1 fix above closed
`?.` but missed a sibling token with the identical shape — the **non-null
assertion operator (`!`)**. `fetch!(url)`, `process!.env`, `eval!(code)`,
`require!(mod)`, generic `exec!(cmd)`, and `Reflect!.get(process,…)` are all
valid TypeScript (`!` erases to nothing at compile time) and cleared both
gates exactly like round 1's `?.` payloads did — demonstrated end-to-end
against the shipped round-1 code with a real `inspectVariant()` call on a
crafted `planner.ts`. The critic also caught a **false-positive regression**
in round 1's `process.env`/`process.binding` fix: making every separator
character independently optional (`\??\.?\s*\[?`) meant "process" and "env"
could match with **no separator at all**, flagging ordinary identifiers like
`processEnvVar` or the type `NodeJS.ProcessEnv`. The round-2 fix replaces the
independently-optional pieces with an alternation of whole, valid separator
forms (`.` | `?.` | `!.` before a bare property, or an optional `?.`/`!`
before a mandatory `[`) — so a real separator is always required — and adds
the same `(?:\?\.|!)?` tolerance (for the call-form patterns, where the
trailing `(` stays mandatory, so no equivalent false-positive risk exists)
to `exec`/`eval`/`fetch`/`require`/`Reflect.get`'s `!` forms. Independently
re-reproduced (red→green, zero regressions, zero new false positives on the
5 identifiers the critic flagged) before shipping.

Files: `__tests__/security/inspect-bypass.test.ts` (hardened #4a-#4h, #5
round-2 non-null-assertion cases + false-positive regression cases),
`__tests__/security/validate-generated.test.ts` (same, mirrored) — now green.

### 7b. Out of scope by design

- **The repo-provided `testCommand` runs real code.** `inspectVariant` bounds
  what the *agent writes*, not what the *repo's own test runner* legitimately
  executes. Containing that runner (CPU/mem/fs/network limits) is an **OS-level
  sandbox** concern (containers/seccomp/cgroups), outside this package. The
  package's contribution is: shell-free invocation + scrubbed env + a hard
  wall-clock timeout + output-buffer cap.
- **Deterministic mutator is a placeholder.** Today's mutator is string
  replacement; the LLM `CodeGenerator` (ADR-071 §contract) drops in **behind the
  same gate** — `validateGeneratedCode` is the choke point that does not move.
- **Pattern-based scanning is heuristic.** A static regex scan cannot prove
  semantic safety; it is a *floor*. The §7a bypasses illustrate that obfuscation
  is always possible against a denylist. The structural defenses (allowlist,
  no-symlink, no-shell, env-scrub, frozen scorer, safety-gated promotion) are the
  load-bearing guarantees; the content denylist is a best-effort early filter.
- **Penalty-layer heuristics** (`scorer.ts` `SECRET_RE`/`DESTRUCTIVE_RE`/…) match
  on trace stderr text and are coarse by design (ADR-072 §penalty); they are not
  a containment boundary, only a scoring signal.

---

## 8. Running the audit

```bash
npx vitest run packages/darwin-mode/__tests__/security
```

97 tests, all green: every blocked attack in §3–§6 is rejected **and** the three
former §7a content-scan gaps are now closed and pinned as regression tests. If a
new obfuscation is found, add it as a failing test, harden
`BLOCKED_CONTENT_PATTERNS`, and update this doc together.
