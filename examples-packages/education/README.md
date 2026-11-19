# MetaHarness: education vertical

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/education flow: npx @metaharness/education my-bot scaffolds the example files and the .harness manifest, then harness doctor reports HEALTHY](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/example-scaffold.svg)

MetaHarness example — tutor pod that teaches over a curriculum with planner, tutor, and grader agents.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/education` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/education my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 33
Manifest: ./my-bot/.harness/manifest.json

Next steps:
  cd my-bot && npm install
  harness doctor && claude -p --plugin-dir . "Teach me the chain rule"
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — evolve the scaffolded harness against its own tests instead of hand-tuning it.
<!-- ruv-seo:end -->

## Reference

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.

A ready-made Claude Code scaffold for a multi-agent tutoring pod. You get a planner that sequences a curriculum, a tutor that delivers lessons and answers questions, and a grader that checks understanding with rubric-backed feedback — all wired into Claude Code with sensible model tiers, memory, and slash commands. This is a starting template for educators, EdTech prototypers, and self-learners building a focused study companion. It is not a full LMS, not a content library, and does not ship pre-built curricula — you bring the syllabus, the pod runs the lessons.

## Quickstart

```bash
npx @metaharness/education@latest my-bot
cd my-bot && npm install && harness doctor
```

That produces a `my-bot/` directory containing a Claude Code plugin: agents under `.claude/agents/`, slash commands under `.claude/commands/`, MCP wiring under `.mcp.json`, and a `harness.config.json` describing the pod.

## What you get

- `planner` agent (sonnet) — parses a syllabus, builds a lesson sequence, tracks where each learner is in the curriculum.
- `tutor` agent (sonnet) — runs the actual lesson turn: explains concepts, answers follow-ups, adapts depth to the learner's level.
- `grader` agent (opus) — scores free-response answers against a rubric and produces actionable feedback.
- `drill` agent (haiku) — generates flashcards, quick-check questions, and spaced-repetition prompts. Cheap, high-volume.
- `/lesson`, `/quiz`, `/review` slash commands wired to the pod.
- `.mcp.json` registering the curriculum store and progress-tracking MCP servers.
- `harness.config.json` describing tiers, routing rules, and the agent graph.

## Advanced

Verify the scaffold:

```bash
harness doctor
# ✓ node >= 20
# ✓ .claude/agents (4 agents)
# ✓ .claude/commands (3 commands)
# ✓ .mcp.json valid
# ✓ harness.config.json schema OK
```

Validate the agent graph and routing rules:

```bash
harness validate
# planner -> tutor -> grader   OK
# drill (parallel)             OK
# no orphan agents             OK
```

Smoke-test the pod headlessly without launching the interactive UI:

```bash
claude -p --plugin-dir my-bot "Teach me the chain rule, then quiz me."
```

Swap a tier — for example, demote the tutor to haiku for cost-sensitive deployments — by editing `harness.config.json` and re-running `harness validate`.

## FAQ

**Q: Do I need a curriculum file to start?**
A: No. The planner will accept a topic ("teach me linear algebra") and synthesize a working sequence. Drop a `curriculum.md` in the project root to override.

**Q: Can I use it with a model other than Claude?**
A: The scaffold targets `claude-code` as the host. You can re-point individual agents at other providers via the agent frontmatter, but slash commands and MCP wiring assume Claude Code.

**Q: How is learner state persisted?**
A: Progress goes through the MCP server defined in `.mcp.json` — by default a local SQLite-backed store under `.harness/`. Replace it with your own server if you want server-side state.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/c459b1590580a91bee8cc879140196c6
