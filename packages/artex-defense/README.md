# @metaharness/artex-defense — Defensive Evidence Replay for ARTEX Findings

<!-- ruv-seo:start (ADR-356) -->
![@metaharness/artex-defense pipeline: ARTEX findings or identity and edge telemetry, a scoped manifest bound to tenant, case and SHA-256, a paired baseline and candidate policy replay, a simulated session quarantine, and a hash-chained MetaHarness receipt that verify recomputes](https://raw.githubusercontent.com/ruvnet/metaharness/main/docs/assets/readme/artex-defense.svg)

`@metaharness/artex-defense` is the blue-team side of a red/blue exercise: it imports ARTEX security findings or identity and edge telemetry, replays a baseline and a candidate detection policy over the same events, simulates a session quarantine, and pins the result to a tamper-evident MetaHarness receipt that anyone holding the original evidence can independently verify.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. CLI `artex-defense` plus an ESM library, also available as `redblue defense` in [`@metaharness/redblue`](https://www.npmjs.com/package/@metaharness/redblue). Offline: no network, no shell, nothing applied to a live system. Inputs are capped at 8 MiB and 10,000 events.

[![npm version](https://img.shields.io/npm/v/@metaharness/artex-defense.svg)](https://www.npmjs.com/package/@metaharness/artex-defense)
[![license: MIT](https://img.shields.io/npm/l/@metaharness/artex-defense.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@metaharness/artex-defense.svg)](https://nodejs.org)

## Quickstart

```bash
mkdir demo && cd demo && npm init -y >/dev/null
npm install @metaharness/artex-defense
pkg=node_modules/@metaharness/artex-defense
npx artex-defense replay $pkg/fixtures/identity.manifest.json $pkg/fixtures/identity.json report.json simulate
```

Expected output (one line, wrapped here):

```text
{"tailSha256":"3a00ff7160220b71da94f2d10a3186301a6a58043d144d2cfa5616f1517fc9c6","mode":"simulate",
 "baseline":{"events":3,"observations":2,"alerts":0,"simulatedQuarantines":0},
 "candidate":{"events":3,"observations":1,"alerts":1,"simulatedQuarantines":1}}
```

The candidate policy correlates a credential change with later anomalous use in the same session and raises one alert; the decoy-only baseline does not. Keep the `tailSha256` apart from the report, then `npx artex-defense verify <manifest> <input> report.json <tailSha256>` prints `{"verified":true}` only for the exact report bytes.

**Next:** [`@metaharness/redblue`](https://www.npmjs.com/package/@metaharness/redblue) — attack the agents you own, then use `redblue defense` to check what your detection policy would have done.
<!-- ruv-seo:end -->

## Reference

Import an ARTEX findings export or normalized defensive telemetry, compare two policies, and verify a receipt with the original bytes. Monitor is the default. The optional simulate mode applies, expires and rolls back session leases in memory. Nothing is enforced on a real system and nothing goes over the network.

### Install

Node 20 or later. The only dependency is `@metaharness/harness`, the receipt log.

```sh
npm install @metaharness/artex-defense
```

Run the checked in fixtures from the installed package:

```sh
pkg=node_modules/@metaharness/artex-defense
out=$(mktemp -d)
npx artex-defense replay $pkg/fixtures/identity.manifest.json $pkg/fixtures/identity.json "$out/report.json" simulate > "$out/checkpoint.json"
tail_hash=$(node -p "require(process.argv[1]).tailSha256" "$out/checkpoint.json")
npx artex-defense verify $pkg/fixtures/identity.manifest.json $pkg/fixtures/identity.json "$out/report.json" "$tail_hash"
```

The same commands are available as `redblue defense <command>` in [`@metaharness/redblue`](https://www.npmjs.com/package/@metaharness/redblue), which ships this package as a dependency. The library entry exports the importer, both policies, the simulator, the receipt functions and `dispatch(command, args)`, which returns `{code, lines, errors}` without exiting the process.

### Run from a source checkout

Use Node 22.18 or later for native TypeScript support in a source checkout. Node 20 uses the built workspace dependency. For Node 20, install workspace dependencies and build `@metaharness/harness` first.

From the repository root:

```sh
cd packages/artex-defense
out=$(mktemp -d)
node cli.mjs replay fixtures/identity.manifest.json fixtures/identity.json "$out/report.json" simulate > "$out/checkpoint.json"
tail_hash=$(node -p "require(process.argv[1]).tailSha256" "$out/checkpoint.json")
node cli.mjs verify fixtures/identity.manifest.json fixtures/identity.json "$out/report.json" "$tail_hash"
node cli.mjs replay fixtures/findings.manifest.json fixtures/findings.csv "$out/findings.json"
node --test
node cli.mjs benchmark
```

The identity fixture produces one candidate session lease and zero baseline leases. The CSV fixture produces one observation and zero leases. For a real audit, retain the printed checkpoint and scoped manifest through a trusted channel separate from the report. Verification recomputes all results and requires the exact serialized report bytes. New reports are created atomically with private file permissions. A preexisting output path is refused.

On Linux with user namespaces enabled, run the fixture tests and benchmark under `unshare --user --map-root-user --net` for network isolation. Set up dependencies before entering the namespace.

## Accepted evidence

A trusted operator supplies a UTF8 manifest with exactly five fields: version (1), format (csv or json), tenant, caseId and expectedSha256. The SHA256 is over the original bytes including BOM and line endings. CSV exports contain no tenant identifier. Bind the export to its correct tenant and case at collection time. Import limits are 8 MiB and 10,000 events.

The importer recognizes the [v0.6.0 findings CSV](https://github.com/BaaRai/ARTEX/blob/v0.6.0/report/findings.go) and the [reviewed source layout](https://github.com/BaaRai/ARTEX/blob/9355d83eeab2f4e6dc97dad2d80889add6c9a58b/report/findings.go) with the added Report Stage field. It retains a scoped row reference, severity and traffic evidence count. Raw descriptions, request data and traffic IDs stay out of reports. The exporter omits the timezone. Imported CSV timestamps use a UTC convention and contribute observations only.

JSON telemetry follows the checked in identity fixture. Each event has a unique per source id, session, integer timestamp in milliseconds, kind and source. The baseline recognizes a decoy hit from a canary. The candidate also correlates an identity credential change with later anomalous use reported by edge or endpoint telemetry in the same case and session, within five minutes. Missing corroboration, generic markers and CSV findings produce observations only. Labels describe the collector's assertions. A digest cannot verify that the collector observed a real compromise. Scoped hashes are pseudonymous and may be guessable for low entropy inputs.

## Results and replay

Both policies evaluate the same events. The virtual response applies on a decision, expires after five minutes, and de-duplicates repeated intents. The simulation library also accepts explicit rollback times. The report includes at most 128 lifecycle records and full counts. Two hash chained MetaHarness receipts commit to the imported and normalized input and the evaluated report. An independently retained tail detects a substituted chain.

The benchmark draws 20 development and 20 separate incident histories from the same signal families, plus 10,000 benign histories based on ten templates. It emits per-family results, corpus and receipt digests, and p95 for the candidate evaluator alone. It measures synthetic policy behavior. Assess field accuracy, telemetry quality and enforcement latency on independently labeled traffic before any production rollout.

## Reproduce the optimization measurements

From the optimized checkout, compare against the original implementation at `325eb57f04d6ff70836de999c8a8b8b2956661cb`. Use Node 22.18 or later, or build the harness dependency in both worktrees on Node 20.

```sh
before=$(mktemp -d)
git worktree add --detach "$before" 325eb57f04d6ff70836de999c8a8b8b2956661cb
node packages/artex-defense/profile.mjs --cli --samples 8 --large 10000 "$before" . > paired-profile.json
git worktree remove "$before"
```

The profiler alternates execution order and records the individual timings. It checks agreement on normalized evidence, both policy outputs, simulation and receipt digests. In memory timings cover import through receipt creation. The optional CLI measurements include process startup, local file access and independent verification against the baseline checkpoint.
