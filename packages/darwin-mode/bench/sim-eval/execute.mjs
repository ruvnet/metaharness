// SPDX-License-Identifier: MIT
//
// One sealed run for #523: build the arm's SIM store, run Darwin evolve() on
// the TRAIN partition only, then grade the winner on the SEALED held-out
// partition. Imports the built package (dist), so `npx tsc` must run first.

import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evolve } from '../../dist/evolve.js';
import { SimMemory, indexSimAttempt } from '../../dist/sim-memory.js';
import { openRvfSimIndex } from '../../dist/sim-rvf.js';
import { runVariantTasksAgent } from '../../dist/tier2-sandbox.js';
import { evolveConfig, hashEmbed, poisonRecords, simScope, sourceStoreFor, slug } from './plan.mjs';

const EMBED_DIM = 256;

/** SimMemory that logs every optimizer context call (manipulation check). */
class LoggingSimMemory extends SimMemory {
  constructor(path) { super(path); this.log = []; }
  async context(query) {
    const t0 = performance.now();
    const res = await super.context(query);
    this.log.push({
      retrieval: res.retrieval, records: res.records.length, tokens: res.estimatedTokens,
      ms: Number((performance.now() - t0).toFixed(2)), ids: res.records.slice(0, 8).map((r) => r.id),
      poison: res.records.filter((r) => r.id.startsWith('poison-')).length,
    });
    return res;
  }
}

export function storePath(storesDir, model, bench) {
  return join(storesDir, `${slug(model)}__${bench}.json`);
}

async function fixtureRepo(root) {
  const dir = join(root, 'repo');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sim-eval-fixture', version: '1.0.0', scripts: { test: 'node --test' } }));
  await writeFile(join(dir, 'src', 'index.js'), 'export const value = 1;\n');
  return dir;
}

const embedder = { async embed(text) { return hashEmbed(text, EMBED_DIM); } };

/** Exact-match self check: a record's own vector must come back as the top hit. */
async function rvfSelfCheck(index, record) {
  const v = await embedder.embed([record.problemKey, record.diagnosis, record.mutationSurface, record.rationale].join(' '));
  const hits = await index.search(v, 8);
  return hits.length > 0 && hits[0].id === record.id;
}

async function readTraces(workRoot) {
  const dir = join(workRoot, 'runs');
  const out = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json') || f.endsWith('.bench.json')) continue;
    const j = JSON.parse(await readFile(join(dir, f), 'utf8'));
    out.push(...(j.traces ?? []));
  }
  return out;
}

/**
 * Execute one run spec. `makeProposer(spec)` returns a CodeGenerator with a
 * `.telemetry`; `summarize(t)` turns it into a row. Throws SpendCapError through.
 */
export async function executeRun(spec, ctx) {
  const { partitions, design, scratchRoot, storesDir, harnessVersion, makeProposer, summarize } = ctx;
  const started = Date.now();
  const root = await mkdtemp(join(scratchRoot, `${spec.phase}-`));
  const repoRoot = await fixtureRepo(root);
  const workRoot = join(root, 'work');
  const scope = simScope(spec, harnessVersion);
  const proposer = makeProposer(spec);

  let store = null;
  let index = null;
  const rvf = { used: false, selfCheck: null, records: 0 };
  if (spec.simMode !== 'off') {
    if (spec.phase === 'source') {
      store = new LoggingSimMemory(storePath(storesDir, spec.model, spec.bench)); // shared, sequential per store
    } else {
      const local = join(root, 'sim.json');
      const src = sourceStoreFor(spec);
      if (src) await copyFile(storePath(storesDir, src.model, src.bench), local);
      store = new LoggingSimMemory(local);
      await store.load();
      if (spec.poison) for (const p of poisonRecords(scope)) await store.append(p);
    }
    await store.load();
    if (spec.simMode === 'retrieval') {
      index = await openRvfSimIndex(join(root, 'experiences.rvf'), EMBED_DIM);
      if (index) {
        const all = store.all();
        for (const r of all) await indexSimAttempt(r, embedder, index);
        rvf.records = all.length;
        rvf.selfCheck = all.length ? await rvfSelfCheck(index, all[all.length - 1]) : null;
        // A failed exact-match check means vector retrieval would silently return
        // nothing usable; fall back to deterministic lexical and record it.
        if (rvf.selfCheck === false) { await index.close(); index = null; } else rvf.used = true;
      }
    }
  }
  const sim = store ? {
    store, mode: spec.simMode, scope, maxTokens: design.simMaxTokens,
    ...(index ? { embedder, vectorIndex: index } : {}),
  } : undefined;

  let result;
  try {
    result = await evolve(evolveConfig(spec, partitions, design, { repoRoot, workRoot, generator: proposer, sim }));
  } finally {
    if (index) await index.close();
    if (store) await store.close();
  }

  // ── Sealed grading: the held-out partition is used ONLY here, after the run. ──
  const winner = result.winner ?? result.baseline;
  const held = await runVariantTasksAgent(winner.variant, partitions[spec.bench].heldout);
  const baseHeld = await runVariantTasksAgent(result.baseline.variant, partitions[spec.bench].heldout);
  const winTrain = await runVariantTasksAgent(winner.variant, partitions[spec.bench].train);
  const solved = (ts) => ts.filter((t) => t.exitCode === 0).length;

  const children = result.records.filter((r) => r.variant.parentId !== null);
  const summaries = children.map((r) => r.variant.mutationSummary);
  const traces = await readTraces(workRoot);
  const simLog = store?.log ?? [];
  const lineage = result.winnerLineage
    .map((id) => result.records.find((r) => r.variant.id === id)?.variant)
    .filter((v) => v && v.parentId !== null)
    .map((v) => v.mutationSurface);

  return {
    prereg: ctx.preregId, phase: spec.phase, id: spec.id, model: spec.model, bench: spec.bench,
    seed: spec.seed, arm: spec.arm, simMode: spec.simMode, memory: spec.memory, poison: !!spec.poison,
    sourceStore: spec.phase === 'target' || spec.phase === 'smoke' ? sourceStoreFor(spec) : null,
    startedAt: new Date(started).toISOString(), wallMs: Date.now() - started,
    value: solved(held) / held.length, heldoutSolved: solved(held), heldoutN: held.length,
    baselineHeldout: solved(baseHeld) / baseHeld.length,
    winnerTrain: solved(winTrain) / winTrain.length,
    winnerId: winner.variant.id, winnerFinalScore: winner.score?.finalScore ?? null, winnerLineageSurfaces: lineage,
    candidates: children.length, evaluatorTaskRuns: result.records.length * partitions[spec.bench].train.length,
    validatorRejections: summaries.filter((s) => s.startsWith('mutation rejected by validator')).length,
    canaryRejections: summaries.filter((s) => s.startsWith('mutation rejected') && /node:fs|readFileSync/.test(s)).length,
    noOps: summaries.filter((s) => /no-op|no change/.test(s)).length,
    effectiveSurfaceEdits: children.filter((r) => ['planner', 'contextBuilder', 'retryPolicy'].includes(r.variant.mutationSurface)
      && !/rejected|no-op|no change/.test(r.variant.mutationSummary)).length,
    disqualifiedTraces: traces.filter((t) => t.exitCode === 99).length,
    childErrorTraces: traces.filter((t) => /child error|driver produced no result/.test(t.stdout + t.stderr)).length,
    proposer: summarize(proposer.telemetry),
    sim: {
      calls: simLog.length,
      retrieval: simLog.reduce((m, l) => ({ ...m, [l.retrieval]: (m[l.retrieval] ?? 0) + 1 }), {}),
      meanTokens: simLog.length ? Math.round(simLog.reduce((s, l) => s + l.tokens, 0) / simLog.length) : 0,
      meanRecords: simLog.length ? Number((simLog.reduce((s, l) => s + l.records, 0) / simLog.length).toFixed(2)) : 0,
      poisonShown: simLog.reduce((s, l) => s + l.poison, 0),
      p95ContextMs: simLog.length ? [...simLog.map((l) => l.ms)].sort((a, b) => a - b)[Math.floor(0.95 * simLog.length)] : null,
      selections: simLog.map((l) => l.ids),
    },
    rvf,
  };
}
