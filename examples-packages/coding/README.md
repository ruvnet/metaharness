# MetaHarness: coding vertical

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/coding flow: npx @metaharness/coding my-bot scaffolds the example files and the .harness manifest, then harness doctor reports HEALTHY](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/example-scaffold.svg)

MetaHarness example — engineering pod scaffold (architect, implementer, reviewer, test-writer) for Claude Code.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/coding` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/coding my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 31
Manifest: ./my-bot/.harness/manifest.json

Next steps:
  cd my-bot && npm install
  harness doctor
  claude --plugin-dir . "Ship your first feature"
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — evolve the scaffolded harness against its own tests instead of hand-tuning it.
<!-- ruv-seo:end -->

## Reference

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.

A ready-made multi-agent engineering pod for Claude Code. One command scaffolds a working harness with four specialized agents — architect, implementer, reviewer, test-writer — wired into Claude Code's plugin directory layout with sensible permissions, hooks, and tier-appropriate model routing. Use it when you want a starting point for shipping real code with AI pair-programmers instead of staring at a blank `.claude/` folder. It does NOT install a runtime, does NOT call a model on its own, and does NOT lock you into any specific MCP server — it is a scaffold, not a service.

## Quickstart

```bash
npx @metaharness/coding@latest my-bot
cd my-bot
npm install
harness doctor
```

`harness doctor` confirms the scaffold layout, agent definitions, and Claude Code plugin manifest are valid. After that you can point Claude Code at the directory (`claude --plugin-dir .`) and the four agents become spawnable via the Task tool.

## What you get

- `agents/architect.md` — design + decomposition agent, tier: **opus**
- `agents/implementer.md` — code-writing agent, tier: **sonnet**
- `agents/reviewer.md` — diff review + correctness/security pass, tier: **sonnet**
- `agents/test-writer.md` — TDD-style test generation, tier: **haiku**
- `.claude/settings.json` — pre-configured permissions, hook stubs, model routing defaults
- `CLAUDE.md` — house rules describing the pod, the SendMessage pipeline, and when to escalate
- `harness.config.json` — declares the vertical (`coding`) and host (`claude-code`) so `harness doctor` knows how to validate

## Advanced

Validate the scaffold structure:

```bash
harness doctor
# ✓ plugin manifest .claude/settings.json
# ✓ 4 agents found (architect, implementer, reviewer, test-writer)
# ✓ host: claude-code
# ✓ vertical: coding
```

Strict-validate agent frontmatter and tier assignments:

```bash
harness validate --strict
# agents/architect.md      tier=opus     ok
# agents/implementer.md    tier=sonnet   ok
# agents/reviewer.md       tier=sonnet   ok
# agents/test-writer.md    tier=haiku    ok
```

Headlessly drive the pod from Claude Code:

```bash
claude -p --plugin-dir my-bot "Ship a typed REST client for the GitHub issues API with tests"
# spawns architect → implementer → reviewer → test-writer via SendMessage pipeline
```

Regenerate over an existing directory (force overwrite):

```bash
npx @metaharness/coding@latest my-bot --force
```

## FAQ

**Q: Do I need an Anthropic API key to run the scaffold?**
A: No. The scaffold itself is just files — agents, settings, and config. You need a Claude Code install (and whatever model access it's configured with) to actually run the agents.

**Q: Can I swap the model tiers?**
A: Yes. Each agent's tier lives in the frontmatter of its `agents/*.md` file. Change `tier: opus` to `tier: sonnet` and rerun `harness doctor` to re-validate.

**Q: How is this different from just copying a `.claude/` folder from GitHub?**
A: The scaffold is versioned, includes `harness doctor` / `harness validate` so drift is detectable, declares its vertical so future tooling can target it, and is regenerable in place with `--force` without losing your custom CLAUDE.md edits (those live alongside, not inside, the generated files).

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/640c8b74b2e57690f81d130acf3cf439
