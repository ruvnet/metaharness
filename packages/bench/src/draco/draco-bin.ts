#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// DRACO M3 runner CLI (ADR-037).
//
//   node dist/draco/draco-bin.js                 # --no-judge, MOCK transport (offline machinery baseline)
//   node dist/draco/draco-bin.js --domain=science
//   node dist/draco/draco-bin.js --limit=5
//   node dist/draco/draco-bin.js --out=draco/runs/baseline-mock.json
//
// LIVE runs (real OpenRouter, real score) require OPENROUTER_API_KEY in env
// (GCP-secret-gated) and the LLM-judge — those land in M4/M5. This CLI runs the
// DETERMINISTIC subset only, and unless --live is passed it uses a MOCK
// transport so the output is explicitly a MACHINERY baseline, never a quality
// claim. The report records transport:"mock".

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDraco, type DracoCorpus } from './runner.js';
import { openRouterTransport, type OpenRouterTransport } from './fusion.js';
import { liveUrlChecker, type UrlChecker } from './scorer.js';
import { runAblation, runThreeWayAblation, runAugmentAblation, runSelfConsistencyAblation } from './ablation.js';
import { DRACO_CHEAP_MODELS, DRACO_CHEAP_SINGLE_MODEL, DRACO_CHEAP_JUDGE } from './optimized.js';

const here = dirname(fileURLToPath(import.meta.url));
const dracoDir = resolve(here); // dist/draco at runtime; corpus is shipped alongside source

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

// Corpus lives at packages/bench/draco/corpus.json (next to the source, not
// dist). Resolve up from dist/draco → ../../draco/corpus.json, with a fallback.
function loadCorpus(): DracoCorpus {
  const candidates = [
    resolve(dracoDir, '..', '..', 'draco', 'corpus.json'),
    resolve(dracoDir, 'corpus.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      /* next */
    }
  }
  throw new Error('DRACO corpus.json not found');
}

// MOCK transport: deterministic, offline. Produces a synthetic dossier that is
// DELIBERATELY thin — it does not embed the rubric terms or real citations, so
// the machinery baseline scores LOW. That is correct + honest: a mock cannot
// earn a quality score; only a live model run can.
function mockTransport(): OpenRouterTransport {
  return async (modelId) => ({
    text: `[mock:${modelId}] synthetic stage output — no live model, no real citations.`,
    tokens: 8,
  });
}
const mockUrlChecker: UrlChecker = async () => 'dead'; // mock answers cite nothing real

async function main() {
  const corpus = loadCorpus();
  const live = has('live');
  const noJudge = has('no-judge');
  const domain = arg('domain');
  const limit = arg('limit') ? parseInt(arg('limit')!, 10) : undefined;
  const out = arg('out');

  let transport: OpenRouterTransport;
  let checkUrl: UrlChecker;
  let kind: 'mock' | 'live';
  // M4: a judged run adds the independent LLM-judge faithfulness dimension.
  // Default for --live is JUDGED (the full proof); --no-judge runs the
  // deterministic subset only. Mock runs are never judged (a mock judge would
  // be theater).
  let judgeTransport: OpenRouterTransport | undefined;
  if (live) {
    transport = openRouterTransport(); // throws if OPENROUTER_API_KEY absent
    checkUrl = liveUrlChecker();
    kind = 'live';
    if (!noJudge) judgeTransport = openRouterTransport(); // judge model picked by runner
  } else {
    transport = mockTransport();
    checkUrl = mockUrlChecker;
    kind = 'mock';
  }

  // --cheap: confirm the pipeline + ordering on inexpensive models before
  // spending on the frontier. Overrides the fusion map + single model + judge.
  const cheap = has('cheap');
  const cheapOpts = cheap
    ? { fusionModels: DRACO_CHEAP_MODELS, singleModel: DRACO_CHEAP_SINGLE_MODEL, judgeModel: DRACO_CHEAP_JUDGE }
    : {};

  // Heartbeat so a long live run shows progress on stderr instead of going dark
  // until the final summary. No-op for tiny mock runs but harmless.
  const onProgress = (done: number, total: number, id: string) =>
    process.stderr.write(`[draco] ${done}/${total} done (${id})\n`);

  // The full thesis: --threeway runs vanilla < harness < fusion+harness.
  if (has('threeway')) {
    const r = await runThreeWayAblation(corpus, { transport, transportKind: kind, checkUrl, judgeTransport, limit, onProgress, ...cheapOpts });
    process.stdout.write(`\nDRACO ${kind.toUpperCase()} THREE-WAY — vanilla < harness < fusion+harness\n`);
    if (kind === 'mock') process.stdout.write('NOTE: MOCK transport — demonstrates the machinery, not a live result.\n');
    process.stdout.write(`  vanilla (raw chat):            ${r.arms.vanilla.score.toFixed(4)}\n`);
    process.stdout.write(`  harness (structure, 1 model):  ${r.arms.harness.score.toFixed(4)}  (+${r.deltas.harnessOverVanilla.toFixed(4)} vs vanilla)\n`);
    process.stdout.write(`  fusion+harness (independent):  ${r.arms.fusion.score.toFixed(4)}  (+${r.deltas.fusionOverHarness.toFixed(4)} vs harness)\n`);
    process.stdout.write(`  ordering (best last): ${r.ordering.join(' < ')}\n`);
    process.stdout.write(`  thesis (vanilla ≤ harness ≤ fusion, fusion > vanilla): ${r.thesisHolds ? 'HOLDS' : 'does not hold'}\n`);
    if (out) {
      const outPath = resolve(out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(r, null, 2) + '\n', 'utf-8');
      process.stderr.write(`[draco] wrote ${outPath}\n`);
    }
    return;
  }

  // ADR-038 arm 2: --selfcon runs vanilla vs best-of-N self-consistency selection.
  if (has('selfcon')) {
    const nCand = arg('candidates') ? parseInt(arg('candidates')!, 10) : 3;
    const sc = await runSelfConsistencyAblation(corpus, { transport, transportKind: kind, checkUrl, judgeTransport, limit, onProgress, candidates: nCand, ...cheapOpts });
    process.stdout.write(`\nDRACO ${kind.toUpperCase()} SELF-CONSISTENCY — vanilla vs best-of-${sc.candidates} selection\n`);
    if (kind === 'mock') process.stdout.write('NOTE: MOCK transport — machinery only, not a live result.\n');
    process.stdout.write(`  vanilla (single draw):      ${sc.vanilla.score.toFixed(4)}\n`);
    process.stdout.write(`  self-consistency (best-of-${sc.candidates}): ${sc.selfConsistency.score.toFixed(4)}  (${sc.delta >= 0 ? '+' : ''}${sc.delta.toFixed(4)} vs vanilla)\n`);
    process.stdout.write(`  self-consistency ${sc.selfConsistencyWins ? 'WINS' : 'does not win'}\n`);
    process.stdout.write(`  by dimension: grounding ${sc.deltaByDimension.grounding.toFixed(2)} · coverage ${sc.deltaByDimension.coverage.toFixed(2)} · balance ${sc.deltaByDimension.balance.toFixed(2)} · cleanliness ${sc.deltaByDimension.cleanliness.toFixed(2)}${sc.deltaByDimension.faithfulness != null ? ` · faithfulness ${sc.deltaByDimension.faithfulness.toFixed(2)}` : ''}\n`);
    process.stdout.write(`  selection histogram (angle picks): ${JSON.stringify(sc.selectionHistogram)}\n`);
    if (out) {
      const outPath = resolve(out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(sc, null, 2) + '\n', 'utf-8');
      process.stderr.write(`[draco] wrote ${outPath}\n`);
    }
    return;
  }

  // ADR-038 arm 1: --augment runs vanilla vs augment-not-replace (verify→prune).
  if (has('augment')) {
    const ag = await runAugmentAblation(corpus, { transport, transportKind: kind, checkUrl, judgeTransport, limit, onProgress, ...cheapOpts });
    process.stdout.write(`\nDRACO ${kind.toUpperCase()} AUGMENT — vanilla vs augment-not-replace (verify→prune)\n`);
    if (kind === 'mock') process.stdout.write('NOTE: MOCK transport — machinery only, not a live result.\n');
    process.stdout.write(`  vanilla (raw dossier):      ${ag.vanilla.score.toFixed(4)}\n`);
    process.stdout.write(`  augment (verify→prune):     ${ag.augment.score.toFixed(4)}  (${ag.delta >= 0 ? '+' : ''}${ag.delta.toFixed(4)} vs vanilla)\n`);
    process.stdout.write(`  augment ${ag.augmentWins ? 'WINS' : 'does not win'}\n`);
    process.stdout.write(`  by dimension: grounding ${ag.deltaByDimension.grounding.toFixed(2)} · coverage ${ag.deltaByDimension.coverage.toFixed(2)} · balance ${ag.deltaByDimension.balance.toFixed(2)} · cleanliness ${ag.deltaByDimension.cleanliness.toFixed(2)}${ag.deltaByDimension.faithfulness != null ? ` · faithfulness ${ag.deltaByDimension.faithfulness.toFixed(2)}` : ''}\n`);
    if (out) {
      const outPath = resolve(out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(ag, null, 2) + '\n', 'utf-8');
      process.stderr.write(`[draco] wrote ${outPath}\n`);
    }
    return;
  }

  // M6: --ablation runs the fusion-vs-single comparison (the beyond-SOTA proof).
  if (has('ablation')) {
    const ab = await runAblation(corpus, { transport, transportKind: kind, checkUrl, judgeTransport, limit, onProgress, ...cheapOpts });
    process.stdout.write(`\nDRACO ${kind.toUpperCase()} ABLATION — optimised fusion vs single-model\n`);
    if (kind === 'mock') {
      process.stdout.write('NOTE: MOCK transport — this demonstrates the ablation MACHINERY, not a live result.\n');
    }
    process.stdout.write(`single (${'one model end-to-end'}): ${ab.single.score.toFixed(4)}\n`);
    process.stdout.write(`fusion (independent verifier${ab.judged ? ' + judge' : ''}): ${ab.fusion.score.toFixed(4)}\n`);
    process.stdout.write(`delta: ${ab.delta >= 0 ? '+' : ''}${ab.delta.toFixed(4)}  →  fusion ${ab.fusionWins ? 'WINS' : 'does not win'}\n`);
    process.stdout.write(`  by dimension: grounding ${ab.deltaByDimension.grounding.toFixed(2)} · coverage ${ab.deltaByDimension.coverage.toFixed(2)} · balance ${ab.deltaByDimension.balance.toFixed(2)} · cleanliness ${ab.deltaByDimension.cleanliness.toFixed(2)}${ab.deltaByDimension.faithfulness != null ? ` · faithfulness ${ab.deltaByDimension.faithfulness.toFixed(2)}` : ''}\n`);
    if (out) {
      const outPath = resolve(out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(ab, null, 2) + '\n', 'utf-8');
      process.stderr.write(`[draco] wrote ${outPath}\n`);
    }
    return;
  }

  const report = await runDraco(corpus, { transport, transportKind: kind, checkUrl, domain, limit, judgeTransport });

  // Print a human summary
  const mode = report.judged ? 'judged' : '--no-judge, deterministic subset';
  process.stdout.write(`\nDRACO ${kind.toUpperCase()} run (${mode})\n`);
  if (kind === 'mock') {
    process.stdout.write('NOTE: MOCK transport — this is a MACHINERY baseline, NOT a quality score.\n');
    process.stdout.write('      A real score needs `--live` + OPENROUTER_API_KEY (GCP-secret) + the judge.\n');
  }
  process.stdout.write(`corpus v${report.corpusVersion} · ${report.efficiency.questions} questions · ${report.efficiency.totalTokens} tokens\n`);
  process.stdout.write(`score (mean quality): ${report.score.toFixed(4)}\n`);
  for (const [d, s] of Object.entries(report.perDomain)) {
    process.stdout.write(`  ${d.padEnd(16)} ${s.toFixed(4)}\n`);
  }

  if (out) {
    const outPath = resolve(out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    process.stderr.write(`[draco] wrote ${outPath}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`[draco] ${err?.message ?? err}\n`);
  process.exit(1);
});
