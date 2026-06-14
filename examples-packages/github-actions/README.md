# MetaHarness × GitHub Actions

A one-command scaffold for a **non-interactive** agent harness that runs on
the GitHub Actions runner — no human at the keyboard. It drops a trigger
workflow and a reusable composite action into `.github/`, wires least-privilege
token permissions, and is ready to run from a webhook (manual dispatch, issue
comment, push, PR, or schedule).

This is the 9th MetaHarness host (ADR-033) and the only one built for CI/CD:
the harness must complete a task autonomously, emit structured output, and exit
cleanly. It is not an interactive workspace — for that, use
`@metaharness/claude-code` or one of the other host wrappers.

## Quickstart

```bash
npx @metaharness/github-actions@latest my-bot
cd my-bot
git add .github && git commit -m "add harness workflow" && git push
```

Then add your model-provider key as a repo secret
(`Settings → Secrets and variables → Actions → ANTHROPIC_API_KEY`) and run it
from the **Actions** tab, or by commenting on an issue.

## What you get

- `.github/workflows/<name>.yml` — the trigger workflow. Default triggers are
  `workflow_dispatch` + `issue_comment` (the safest pair); `push`,
  `pull_request`, and `schedule` are commented-out opt-ins.
- `.github/actions/<name>/action.yml` — a reusable composite action the
  workflow calls, so the harness logic works across multiple workflows.
- `install.md` — the wiring + permissions runbook.
- `.harness/manifest.json` — signed-shape provenance.
- `.claude-plugin/plugin.json` — so the same folder also loads as a Claude
  Code plugin (`claude -p --plugin-dir my-bot`).

## Default-deny → least-privilege token (ADR-022)

The workflow's `permissions:` block starts at `contents: read` and grants only
what the harness policy's allow-list implies:

| allow token | GitHub scope |
|---|---|
| `create-pr`, `push-branch` | `contents: write`, `pull-requests: write` |
| `label`, `triage` | `issues: write` |
| `checks`, `status` | `checks: write` |

Anything unmapped stays denied. For production-touching jobs (release pushes),
gate behind a GitHub Environment with required reviewers — the token scope
alone does not add human review.

## Advanced

```bash
# Health-check the scaffold (validates the workflow + action YAML parse)
npx harness doctor

# Full umbrella gate
npx harness validate

# Scan the harness's permission surface (flags over-broad grants)
npx harness mcp-scan
```

## FAQ

**Q: How is this different from the other MetaHarness hosts?**
A: Every other host is interactive — a human starts a session. GitHub Actions
is webhook-triggered with no human present; the harness runs to completion on
the runner and exits.

**Q: Do I need an Anthropic key to scaffold?**
A: No — scaffolding is offline. You need the key (as a repo secret) only when
the workflow actually runs.

**Q: Can I trigger it on push or a schedule?**
A: Yes — uncomment the `push` / `pull_request` / `schedule` blocks in the
generated workflow. They're included but disabled by default for safety.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/a77366913e70fe65d9cffa12d59f8ef9
