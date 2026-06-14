# education — runnable demo of `vertical:education` (iter 80)

> Scaffold + validate a tutoring-pod harness in ~200ms, no network.

## Run

```bash
node examples/education/education.mjs                 # default host: claude-code
node examples/education/education.mjs --host=codex    # any of 6 hosts
node examples/education/education.mjs --keep          # leave the scaffold for inspection
```

Output:

```
# vertical:education — runnable demo
#   host: claude-code
#   template: vertical:education (iter 80)

[1/3] scaffold → 13 files in 9ms
[2/3] shape:
        agents:   explainer, grader, quiz-master, tutor
        commands: doctor, mastery-report
        skills:   memory-inspect, teach-next
[3/3] validate → HEALTHY (release-ready)

[education] DONE in 184ms — try:
             cd /tmp/ahg-edu-claude-code-X9aB
             cat src/agents/tutor.ts
             cat .claude/commands/mastery-report.md
```

## What it demonstrates

| Layer | This script exercises |
|---|---|
| Scaffolder (iter 4) | `scaffold()` with the iter-80 vertical |
| Per-vertical catalog (iter 80) | 4 agent personae + 2 commands + memory skill |
| Validate umbrella (iter 20) | `harness validate --skip-gcp` → HEALTHY |
| Diag chain (iter 76) | The umbrella includes the iter-66 diag check |

The 4 agents (tutor → explainer → quiz-master → grader) and the 2 commands (`teach-next`, `mastery-report`) come from the iter-80 vertical definition. The pedagogy invariants — abstain-not-hallucinate, no teaching on unmastered prereqs, hidden rubrics — live in the system prompts so they survive any kernel update.

## Why a separate runnable example

Same reason `examples/quickstart/` + `examples/federation/` exist: a single-script demo that doesn't need any test runner. Contributors and CI can run it in isolation; users can copy-edit it as a starting point for their own onboarding scripts.

## Per-host parity

The script is host-aware — pass `--host=hermes` (or any of the 6) to see how the same vertical scaffold maps onto a different agentic CLI. Useful for verifying that a new vertical works on every host before publish.

## Related

- [`examples/quickstart/`](../quickstart/) — minimal vertical, default host claude-code
- [`examples/federation/`](../federation/) — two-instance federation handshake
- [`examples/host-tour/`](../host-tour/) — scaffold + validate for all 6 hosts

## When to run

- After editing `vertical_education/` templates — quick visual confirmation
- After bumping `@ruflo/kernel` — does the existing scaffold still pass validate?
- In CI as a per-vertical smoke test alongside `harness validate`
