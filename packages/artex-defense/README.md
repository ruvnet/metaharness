# MetaHarness defensive evidence replay

Import an ARTEX findings export or normalized defensive telemetry, compare two policies, and verify a receipt with the original bytes. This private workspace runs in a MetaHarness checkout. Monitor is the default. The optional simulate mode applies, expires and rolls back session leases in memory.

## Run the example

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
