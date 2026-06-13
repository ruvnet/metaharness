# Examples

Real, runnable patterns showing how to use `agent-harness-generator`.

| Example | What it shows | Runnable? |
|---|---|---|
| [`quickstart/`](./quickstart/) | One-script zero-to-validated-harness end-to-end demo | yes |
| [`multi-host/`](./multi-host/) | One harness targeting Claude Code + Codex with the same kernel | docs |
| [`federation/`](./federation/) | Two harness instances coordinating via the kernel's federation transport | docs |

### Try the quickstart first

```bash
node examples/quickstart/quickstart.mjs
```

That's the smallest possible end-to-end run — scaffold → validate → report — exit 0 if HEALTHY. Default takes ~50ms on a built checkout. If it passes locally, the rest of the pipeline is mostly automation around the same flow.

See [`quickstart/README.md`](./quickstart/README.md) for `--host`, `--template`, `--keep` flags.
