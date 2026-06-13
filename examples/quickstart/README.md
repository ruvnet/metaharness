# quickstart — one-script end-to-end demo

> Zero-to-validated-harness in a single command. No npm install (beyond the workspace root), no network, no shell ceremony.

## Run it

From the repo root:

```bash
node examples/quickstart/quickstart.mjs
```

Output (~1 second on a clean checkout):

```
[step 1] Scaffold a "demo-bot" harness from template="minimal" host="claude-code"
  output dir: C:\Users\…\Temp\ahg-quickstart-AbCdEf
  wrote 13 files, manifest at .harness/manifest.json

[step 2] Validate the scaffolded output
  harness validate — …\ahg-quickstart-AbCdEf
    PASS doctor     — …
    PASS verify     — no witness — skipped (sign first)
    PASS path-guard — no hardcoded /tmp, C:\, /Users, /home in TS/JS/Rust
    PASS mcp        — no .mcp/servers.json — skipped
    PASS secrets    — skipped (--skip-gcp)

  Result: HEALTHY (release-ready)

[step 3] Summary
  generated 13 files in 142ms
  scaffold paths reported: 13
  validation: HEALTHY

[quickstart] DONE in 187ms — host=claude-code template=minimal
```

## What it exercises

This single script touches every layer the meta-harness ships:

| Layer | Iter where it landed |
|---|---|
| Scaffolder (`scaffold()`) | 4 |
| Template renderer | 3 |
| Per-host adapter (`host=claude-code` default) | 2 |
| Validate umbrella (doctor + path-guard + mcp) | 20 |
| Witness shape check (skipped — no signing key in demo) | 3 + 8 |

If any of those layers regress, this script's exit code goes non-zero. CI runs it on every push via [the e2e test](../../__tests__/e2e-scaffold-validate.test.ts) — running the script directly is the local equivalent.

## Flags

| Flag | What it does |
|---|---|
| `--host=<id>` | Choose a different host (`claude-code`, `codex`, `pi-dev`, `hermes`, `openclaw`, `rvm`). Default `claude-code`. |
| `--template=<id>` | Choose a different template (`minimal`, `vertical:trading`, `vertical:devops`, `vertical:legal`, `vertical:support`, `vertical:research`, `eject-from-ruflo`). Default `minimal`. |
| `--name=<name>` | Override the generated harness name. Default `demo-bot`. |
| `--keep` | Don't clean up the temp directory at the end (inspect the output). |

### Examples

```bash
# Try a different host
node examples/quickstart/quickstart.mjs --host=codex

# Try a vertical pack
node examples/quickstart/quickstart.mjs --template=vertical:trading

# Inspect what was produced
node examples/quickstart/quickstart.mjs --keep
# … then `ls $(... output path printed above)/`
```

## Why this script exists

The full release pipeline is broad — preflight, build-ordered, wasm-pack, pack-install smoke, GCP secrets, IPFS pin. New contributors hit it cold and don't know where to start.

This script is the **smallest possible** runnable demo that proves the core flow works on your machine. If it passes, the rest of the pipeline is mostly automation around it.
