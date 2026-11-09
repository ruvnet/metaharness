# MetaHarness: gaming vertical

<!-- ruv-seo:start (ADR-356) -->
MetaHarness example — ready-made game-design pod (concept, mechanics, balance, playtest) for Claude Code.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/gaming` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/gaming my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 33
Manifest: ./my-bot/.harness/manifest.json

  Next steps:
    cd my-bot
    npm install && harness doctor
    claude -p --plugin-dir . "/pitch a co-op deckbuilder set on a generation ship"
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — evolve the scaffolded harness against its own tests instead of hand-tuning it.
<!-- ruv-seo:end -->

## Reference

A ready-made multi-agent game-design pod scaffolded as a Claude Code harness. One command drops a working `claude-code` plugin directory on disk with four specialist agents wired up — a concept lead, a mechanics designer, a balance analyst, and a playtest critic — plus the project settings, slash commands, and MCP plumbing needed to actually run them. Aimed at solo designers, game-jam teams, and studios who want a structured pod for ideation and iteration instead of a single generalist prompt. This is a scaffold, not a game engine: it does not ship Unity/Unreal/Godot integrations, no asset pipeline, no live ops — it gives you the design loop, you bring the runtime.

## Quickstart

```bash
npx @metaharness/gaming@latest my-bot
cd my-bot && npm install && harness doctor
```

The `harness doctor` step validates that Claude Code is on PATH, the plugin manifest parses, and each agent's model tier is reachable.

## What you get

- `agents/concept-lead.md` — pitch and high-concept exploration (tier: **opus**)
- `agents/mechanics-designer.md` — core loop, systems, and rule specification (tier: **sonnet**)
- `agents/balance-analyst.md` — numeric tuning, curves, and economy modelling (tier: **sonnet**)
- `agents/playtest-critic.md` — adversarial critique, fun audit, edge-case hunting (tier: **haiku**)
- `commands/pitch.md`, `commands/loop.md`, `commands/balance.md`, `commands/playtest.md` — slash commands that route to the right agent
- `.claude/settings.json` — plugin manifest, permissions, and hook wiring
- `CLAUDE.md` — pod operating rules: who calls whom, when to fan out, when to converge

## Advanced

```bash
# Validate the scaffold and the model routing
harness doctor
# => OK  plugin manifest
# => OK  agents/concept-lead.md          (claude-opus)
# => OK  agents/mechanics-designer.md    (claude-sonnet)
# => OK  agents/balance-analyst.md       (claude-sonnet)
# => OK  agents/playtest-critic.md       (claude-haiku)

# Lint frontmatter, agent tier hints, and command routing
harness validate
# => 4 agents, 4 commands, 0 errors

# Run the pod headless against a design brief
claude -p --plugin-dir ./my-bot "/pitch a co-op deckbuilder set on a generation ship"
# => concept-lead drafts pitch -> mechanics-designer proposes core loop
# => balance-analyst flags one runaway resource curve
# => playtest-critic returns 6 fun-risk findings
```

## FAQ

**Does this generate a playable game?**
No. It generates design artifacts — pitch docs, mechanic specs, balance tables, playtest critiques. Hand those to your engine of choice.

**Why four agents instead of one prompt?**
Because "design a game" is the kind of task where a single generalist regresses to genre cliches. Splitting concept / mechanics / balance / playtest forces each pass to defend its choices to the next agent.

**Can I swap the model tiers?**
Yes. Each agent's frontmatter has a `model` field. Drop `playtest-critic` to `haiku` for cheap iteration, bump `concept-lead` to `opus` when you want the high-concept work to stretch.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/89ab98e6e5f082a376170a941c9d1914
