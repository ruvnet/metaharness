# ADR-180 — Distributed benchmark runs: GCP VM runner + Firestore results store

**Status**: Accepted (runner: `scripts/gcp-swebench-runner.sh`; store: Firestore `darwin_runs`)
**Date:** 2026-06-23
**Related:** ADR-150 (local $0 inference), ADR-179

## Context

Getting Darwin's *own* numbers on SWE-bench **Verified (500)** and **Pro (731)** needs their Docker images
(hundreds of GB) and hours of compute — and the local box (a) lacks those cached images and (b) is shared
with a second session. Per-machine result files (JSON in the tree) also don't aggregate across runs.

## Decision

1. **Compute offload to GCP** (project `cognitum-20260110`): a self-contained startup-script runner
   (`gcp-swebench-runner.sh`) installs Docker/Node/swebench, clones the repo, restores the OpenRouter key from
   instance metadata, runs the interactive solver (single or Best-of-3+judge) on a chosen split, gold-evals,
   and leaves artifacts in `/opt/darwin/out` for `scp`. First use: `darwin-verified-runner` (e2-standard-8).
   Pro is runnable via its own OS harness (`scaleapi/SWE-bench_Pro-os` + `jefzda/sweap-images`).
2. **Firestore as the durable results store** (native mode, default DB). Run records (benchmark, mode, model,
   resolved/total, resolve %, Wilson CI, cost/inst, run total, conformant, source) go to the `darwin_runs`
   collection via `scripts/firestore-upload.mjs` (REST + token auth, no SDK dep).
3. **Security (configured via gcloud):** Firestore native mode is IAM-gated by default (no public client
   access; verified no `allUsers`/`allAuthenticatedUsers` bindings). A dedicated SA `darwin-bench-writer`
   holds **only** `roles/datastore.user` (least privilege) for automated writers; the ephemeral OpenRouter key
   rides instance metadata on short-lived VMs.

## Consequences

- Verified/Pro runs no longer contend with local work; results aggregate in one queryable store.
- Cost: VM ~$2–5/run + model spend; remember to delete the VM after retrieval.
- gcloud user creds need periodic interactive reauth (`gcloud auth login`) — a manual gate for provisioning.
- The leaderboard JSON can be regenerated from `darwin_runs` once enough runs accumulate.

## Operational hardening (2026-06-23, learned in production)

- **`IN_USE_ADDRESSES` quota (8/region) is the REAL concurrency cap** — it trips before the 32-vCPU limit
  (each VM with an external IP consumes one). Fix: provision with **`--no-address`** + a **Cloud NAT**
  (`darwin-nat-router` / `darwin-nat`, AUTO_ONLY, all subnets) for shared egress (Docker Hub, OpenRouter, GitHub,
  Firestore). Now the fleet scales to the vCPU boundary, not the 8-IP wall.
- **`provision` must catch create-errors** (try/catch → return false) — a single quota-failed `create` otherwise
  throws and crashes the whole `autotune` loop (it did, once). Now it skips the variant and the loop continues.
- **Cost auto-control**: workers `shutdown -h` after self-reporting (AUTOSTOP=1); the controller's supervise
  (and `autotune`) collect-then-DELETE done workers. No idle-billing, no orphans.
- **Self-report denominator must equal instances run** (`TOTAL=SAMPLE` for prove-N) — a hardcoded /300 made
  prove-25 numbers 12× too low + mislabeled; caught only by live data, not unit tests. Purge bad rows on fix.
- **Metadata fetch MUST use `curl -f`** — a *missing* instance-attribute (e.g. no `sample` on a full-300 `up`)
  returns a **404 HTML page**, not empty. Without `-f` that HTML became `SAMPLE`, so `[ -n "$SAMPLE" ]` was true
  and the slice ran `slice(0,<!DOCTYPE html>…)` → SyntaxError → solver never started → **0 preds, VM billed idle
  for hours** (both full-300 verdict runs were silently dead). `M(){ curl -sf … || true; }`. Sanity-check
  long-running VMs (`wc -l out/*.jsonl`) — a flat spend + 0 preds = a startup crash, not slow solving.
