# Contrastive mechanism benchmark

This offline benchmark executes real parser changes. It is **synthetic mechanism evidence**, not a claim about LLM ability, SWE-bench, current Darwin performance, or transfer to other task families. All adapters spend $0 and make no network requests.

From the repository root:

```sh
npm ci --ignore-scripts
npm run build --workspace=@metaharness/darwin
node packages/darwin-mode/bench/contrastive/run.mjs > /tmp/contrastive-benchmark.json
```

Optional arguments are a uint32 seed and 1 to 1000 latency repetitions:

```sh
node packages/darwin-mode/bench/contrastive/run.mjs 261014224 100
```

## Experiment

Eight development invoices cover quoted pipe delimiters and decimal comma amounts. Two independent parser components control these real operations. The frozen harness understands neither. An invariant proposer enables quote-aware parsing; a domain proposer enables decimal comma normalization. Proposals cite development failures. The composer can combine supported changes, and the combination must execute before selection.

The evaluator constructs expected records before input serialization. Its development answers live in its callback closure. Editors receive input rows and failure observations, with no answer records or scores. Each evaluation executes every development row once and reuses its failure list for observations. One hundred fresh seeded invoices are generated under a separate partition and are scored after development selection. No holdout row enters an editor or evaluator callback. Input disjointness is asserted.

The control uses the same four possible component configurations. It independently samples three configurations, evaluates them plus the frozen baseline, and selects using development scores only. This matches four evaluations and three candidate generations as logical operations. The sampling control does not use engine callback admissions. This does not match real model dollar or token cost. It may tie or beat the contrastive loop. The report includes all results across 32 predetermined sampling seeds to show seed sensitivity.

The frozen harness is an execution baseline. It does not run the existing Darwin evolutionary optimizer. The proposers are handwritten rules and the task distribution deliberately exercises their two operations; a larger improvement here would not establish general LLM gains.

## Evidence and acceptance

The runner asserts:

1. The full loop admits exactly seven callbacks: four probes and three editors.
2. A six-call ceiling prevents the final composition probe.
3. Two unchanged proposals reuse the baseline probe, avoiding two executions.
4. Every probe receipt binds to the digest of the configuration actually interpreted.
5. Development and holdout inputs are disjoint; selected development scores agree with an independent execution.
6. Repeated identical runs select the same candidate digest.

No holdout performance gain is asserted or hardcoded. The report contains measured successes, callback counts, median and p95 latency, complete loop receipts, source and built JavaScript hashes, Node version, and the current commit. Hashes bind uncommitted source bytes too; the commit alone does not prove a clean tree.

Latency includes in-process adapters, validation, hashing, scheduling and receipt generation. It excludes build time and is not a provider latency estimate. The five warmup runs are excluded from the summaries. Provenance collection happens after timing.

## Reuse and limits

`synthetic-adapter.mjs` is a minimal adapter example. Replace the proposer and evaluator with trusted real task adapters for a live pilot. The host must enforce its provider cost ceilings, cancellation and tool capabilities. Keep production promotion and independent acceptance outside the editor.

Same-process closures separate benchmark roles; they are not an isolation boundary against malicious adapters. The holdout shares the development distribution. No external transfer or representative real task superiority is established.
