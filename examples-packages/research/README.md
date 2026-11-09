# MetaHarness: research vertical

<!-- ruv-seo:start (ADR-356) -->
MetaHarness example — multi-agent research dossier scaffold for Claude Code with scout, web search, grading, synthesis.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. The scaffold runs `npx metaharness@latest`, so the first run needs network access. This is the `@metaharness/research` path from [`metaharness`](https://www.npmjs.com/package/metaharness): the same scaffold as `npx metaharness new my-bot`, plus this example's files.

## Quickstart

```bash
npx @metaharness/research my-bot
npx -y -p metaharness harness doctor my-bot | tail -1
```

Expected output (npm notices removed, temp path shortened to `./`):

```text
Scaffolded my-bot into ./my-bot
Files: 29
Manifest: ./my-bot/.harness/manifest.json

Next steps:
  1. cd my-bot && npm install
  2. npm run doctor    # verify Claude Code + MCP servers
  3. Open in Claude Code and run /research <your topic>
Result: HEALTHY (./my-bot)
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — evolve the scaffolded harness against its own tests instead of hand-tuning it.
<!-- ruv-seo:end -->

## Reference

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.

A ready-made multi-agent research harness for Claude Code. One command scaffolds a project with six specialized agents — scout, web-searcher, source-grader, synthesizer, fact-checker, citer — wired through tiered model routing (haiku for fan-out, sonnet for synthesis, opus for adversarial fact-checking) so you can run deep, multi-source, cited research the moment `npm install` finishes. It is **not** a hosted SaaS, a search API, or a finished UI — it is the prompts, agent definitions, hooks, and Claude Code settings you'd otherwise spend a weekend writing.

## Quickstart

```bash
npx @metaharness/research@latest my-bot
cd my-bot && npm install && npm run doctor
```

`harness doctor` checks your Node version, Claude Code install, and required MCP servers. When it reports green, open the project in Claude Code and ask: *"Research the state of robotic foundation models in 2026 with at least 12 sources."*

## What you get

- **`agents/scout.md`** (haiku, Tier 2) — decomposes the question into 5-10 sub-queries and seeds the search frontier.
- **`agents/web-searcher.md`** (haiku, Tier 2) — fans out parallel `WebSearch` + `WebFetch` calls, one per sub-query.
- **`agents/source-grader.md`** (sonnet, Tier 3) — scores each source on authority, recency, and primary-vs-secondary, drops the weakest.
- **`agents/synthesizer.md`** (sonnet, Tier 3) — produces the draft report with inline citation anchors.
- **`agents/fact-checker.md`** (opus, Tier 3) — adversarially re-reads each claim against its cited source and flags drift.
- **`agents/citer.md`** (haiku, Tier 2) — normalizes citations into a single bibliography (APA + URL + access date).
- **`.claude/settings.json`** with `WebSearch`, `WebFetch`, `Read`, `Write` pre-allowed; `Bash(rm:*)` denied.
- **`.claude/commands/research.md`** — slash command `/research <topic>` that fires the full six-agent pipeline.

## Advanced

Validate the scaffold's structure before you trust it on a real project:

```bash
$ npm run validate
PASS  agents/scout.md          (frontmatter ok, tools allowed)
PASS  agents/web-searcher.md   (frontmatter ok, tools allowed)
PASS  agents/source-grader.md  (frontmatter ok, tools allowed)
PASS  .claude/settings.json    (schema valid)
PASS  .claude/commands/research.md
6/6 checks passed
```

Run the pipeline headlessly from CI or a cron job, with a per-run budget cap:

```bash
$ claude -p --plugin-dir my-bot --max-budget-usd 1.50 \
    "/research impact of EU AI Act on open-weight model releases"
[scout]        decomposed into 7 sub-queries
[web-searcher] 38 sources fetched, 6 dropped (paywall/404)
[source-grader] kept 22 of 32 sources (avg authority 0.74)
[synthesizer]  draft written: report.md (2,840 words, 22 citations)
[fact-checker] 1 claim flagged: "EU AI Act enforces from Aug 2025" -> source says Feb 2026
[citer]        bibliography.md written (22 entries, APA)
$ harness cost
total: $1.21 / $1.50 cap
```

Regenerate one agent without re-scaffolding the whole project:

```bash
$ npx harness regen agents/fact-checker.md
regenerated agents/fact-checker.md (sonnet -> opus, prompt v2)
```

## FAQ

**Q: Do I need an Anthropic API key, or does Claude Code's subscription cover it?**
A: Either works. If you launch the pipeline from inside Claude Code interactively, your subscription covers it. If you run it headlessly via `claude -p`, you need `ANTHROPIC_API_KEY` in your environment.

**Q: Can I swap WebSearch for a different search provider (Tavily, Brave, SerpAPI)?**
A: Yes. Edit `agents/web-searcher.md` — replace the `WebSearch` tool reference with an MCP server of your choice, then update `.claude/settings.json` to allow the new server. The rest of the pipeline doesn't care which search backend you use.

**Q: Why six agents instead of one big prompt?**
A: Cost and accuracy. Fan-out search and citation normalization are cheap haiku work; adversarial fact-checking is where opus earns its keep. A monolithic prompt would either burn opus tokens on URL fetching or use haiku on claim verification — both are wrong trades. The vertical encodes the right routing.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/7ad69e82554b1f144aa4f5b34498536b
