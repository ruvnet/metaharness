// SPDX-License-Identifier: MIT
// ADR-251: assemble the three-arm SWE_BENCH_RESULTS from solved arm JSONL +
// official docker-eval reports, then hand it to swebench-three-arm.mjs.
//
//   node assemble-three-arm.mjs \
//     --prereg ../../../avo/bench/results/prereg-100-adr251.json \
//     --arm darwin-fixed=results/arm-darwin-fixed.jsonl:/tmp/avo-darwin-fixed.darwinfixed_adr251.json \
//     --arm avo-no-supervisor=results/arm-avo-no-supervisor.jsonl:/tmp/avo-avo-no-supervisor.avonosup_adr251.json \
//     --arm avo-supervisor-memory=results/arm-avo-supervisor-memory.jsonl:/tmp/avo-avo-supervisor-memory.avosup_adr251.json \
//     --out ../../../avo/bench/results/three-arm-input.json
//
// Dedup: one record per instance (last non-error wins). Enforces all three arms
// cover the identical preregistered 100 ids. `resolved` = instance in the arm's
// eval report resolved_ids. Emits the SWEbenchComparison input for compareSWEbench.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rel = (p) => (isAbsolute(p) ? p : resolve(HERE, p));
const many = (f) => args.map((a, i) => (args[i - 1] === f ? a : null)).filter(Boolean);

const PREREG = JSON.parse(readFileSync(rel(args[args.indexOf('--prereg') + 1]), 'utf8'));
const OUT = rel(args[args.indexOf('--out') + 1]);
const expectedIds = [...PREREG.instanceIds].sort();

function loadArm(spec) {
  const [arm, paths] = spec.split('=');
  const [jsonlPath, reportPath] = paths.split(':');
  const rows = readFileSync(rel(jsonlPath), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  // last non-error record per instance
  const byId = new Map();
  for (const r of rows) {
    if (r.error && byId.has(r.instanceId)) continue;
    byId.set(r.instanceId, r);
  }
  const report = JSON.parse(readFileSync(rel(reportPath), 'utf8'));
  const resolved = new Set(report.resolved_ids ?? []);
  const observations = [];
  for (const id of expectedIds) {
    const r = byId.get(id);
    if (!r) throw new Error(`${arm}: missing solved record for ${id}`);
    observations.push({
      instanceId: id,
      arm,
      resolved: resolved.has(id),
      costUsd: r.costUsd ?? 0,
      wallTimeMs: r.wallTimeMs ?? 0,
      policyViolations: r.policyViolations ?? 0,
      expectedReplayHash: r.expectedReplayHash ?? 'sha256:na',
      actualReplayHash: r.actualReplayHash ?? 'sha256:na',
      rollbackCount: r.rollbackCount ?? 0,
      coherenceRetention: r.coherenceRetention ?? 0,
    });
  }
  const resolvedCount = observations.filter((o) => o.resolved).length;
  console.error(`${arm}: ${observations.length} obs, ${resolvedCount} resolved, report says ${report.resolved_instances}`);
  return observations;
}

const observations = many('--arm').flatMap(loadArm);
const input = {
  generatedAt: PREREG.config.preregisteredAt,
  datasetKind: 'swe-bench-unseen-preregistered',
  model: PREREG.config.model,
  reasoningConfiguration: PREREG.config.reasoningConfiguration,
  tokenBudget: 0,
  evaluatorVersion: 'swebench-3.0.17 official docker (SWE-bench_Verified test split)',
  taskSetHash: PREREG.taskSetHash,
  observations,
};
writeFileSync(OUT, JSON.stringify(input, null, 2) + '\n');
console.error(`wrote ${OUT} (${observations.length} observations across ${many('--arm').length} arms)`);
