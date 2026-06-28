// SPDX-License-Identifier: MIT
//
// h3-code-localize.mjs — ADR-201 H3-code PAID MICRO-PILOT (≤$1). The $0 gate (h3-code-gate.mjs)
// established that a code import/test graph TRAVERSES non-trivially (graphHits>0, 5/5 instances)
// and that topology traversal RECOVERS gold patch files the dense cosine top-k misses (2/2
// dense-misses recovered). This script runs the REAL cheap models on the question the gate could
// not settle at $0: when a cheap model is handed a DENSE-cosine-ranked file set vs a budget-matched
// GRAPH-topology-ranked file set, does the graph arm raise the model's GOLD-FILE LOCALIZATION rate?
//
// Localization (picking the file that contains the fix) is the NECESSARY condition for resolve —
// no model can patch a file it never sees. It is also the part an n=25 budget can power cleanly,
// whereas an n=25 Docker-RESOLVE run is statistically underpowered for the <8% effect the gate
// predicts (Wilson CIs would swamp it) and is infra-heavy (25–50 GB of images). We therefore
// measure localization here and recommend a POWERED (n≥100) Docker-resolve run as the next gate.
//
// Arms (budget-matched: SAME number of candidate files K_CTX, DIFFERENT ranking):
//   • dense : top-K_CTX files by cosine(problem_statement, file)            — cosine over code
//   • graph : seeds(issue/test) → kHopNeighbors(depth) → ranked by PageRank — topology traversal
//             (NO cosine; falls back to hub-degree, then dense, to fill the budget)
// Models  : deepseek/deepseek-v4-pro, z-ai/glm-5.2 (cheap). Temp 0.
// Metrics : gold-hit@1 / gold-hit@3 (model pick), set-recall (gold in arm's K_CTX set at all),
//           graph−dense Δ per model with Wilson 95% CI, Cr (graph/dense context tokens), $ cost.
//
// HONESTY: this measures LOCALIZATION, not end-to-end resolve. Reported straight either way. n stated.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  initEmbedder, cosine, cloneRepo, walkPy, buildGraph, pageRank,
  extractSeeds, goldCodeFiles,
} from './h3-code-gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const argv = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };

const GRAPH_NODE_PATH = argv('--graph-node', '/home/ruvultra/projects/ruvector/npm/packages/graph-node');
const SCRATCH = argv('--scratch', '/tmp/claude-1000/-home-ruvultra-projects-agent-harness-generator/ec35bf87-f599-4921-ac41-4996378d9334/scratchpad/h3-code-repos');
const CANDIDATES = argv('--dataset', join(__dirname, '../swerebench/candidates-65.json'));
const OUT = argv('--out', join(__dirname, 'data/h3-code-localize-report.json'));
const N = parseInt(argv('--n', '25'), 10);
const K_CTX = parseInt(argv('--kctx', '15'), 10);   // files presented to the model per arm (budget)
const KHOP = parseInt(argv('--khop', '2'), 10);
const MAX_FILES = parseInt(argv('--max-files', '1200'), 10);
const MODELS = (argv('--models', 'deepseek/deepseek-v4-pro,z-ai/glm-5.2')).split(',').map((s) => s.trim());
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const KEY = (process.env.OPENROUTER_API_KEY || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
const DRY = process.argv.includes('--dry');

// Instances: skip the 5 used in the gate (avoid double-counting), prefer small/medium clonable repos.
// Exclude known-huge repos to keep clone+graph tractable for a micro-pilot.
const HUGE = new Set(['sympy/sympy', 'home-assistant/core', 'dask/dask', 'google/flax',
  'mesonbuild/meson', 'vyperlang/vyper', 'sphinx-doc/sphinx', 'ethereum/web3.py', 'pyvista/pyvista',
  'sktime/sktime', 'simpeg/simpeg', 'beeware/briefcase', 'run-llama/llama_deploy', 'Blaizzy/mlx-vlm']);
const GATE_USED = new Set(['scikit-hep__cabinetry-506', 'lmfit__lmfit-py-989', 'pgmpy__pgmpy-1906',
  'zarr-developers__zarr-python-2661', 'pdm-project__pdm-3393']);

const log = (...a) => console.error(...a);

function estTok(s) { return Math.ceil(String(s || '').length / 4); }
// Wilson 95% CI for a proportion
function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function sigListing(graph, ids) {
  return ids.map((id) => {
    const n = graph.nodes.find((x) => x.id === id); if (!n) return '';
    const sigs = [...n.symbols].slice(0, 8).join(', ');
    return sigs ? `${n.rel}\n    defines: ${sigs}` : n.rel;
  }).filter(Boolean).join('\n');
}

async function callLLM(model, listing, problem) {
  const prompt = `A bug is reported below. From the candidate files (path + defined symbols), list ONLY the file paths most likely to contain the FIX — most-likely first, one per line, at most 3. Output paths verbatim, nothing else.\n--- problem ---\n${String(problem).slice(0, 4000)}\n--- candidate files ---\n${listing.slice(0, 16000)}\n`;
  if (DRY) return { picks: [], cost: 0, tok: 0 };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    // reasoning DISABLED + generous max_tokens: deepseek-v4-pro/glm are reasoning models that emit
    // EMPTY content when hidden reasoning consumes a short budget (verified: a prior 200-token run
    // gave 90% empty deepseek responses → invalid). Same fix as h3-pilot.mjs / ruvector-eval.mjs.
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 800, temperature: 0, reasoning: { enabled: false }, usage: { include: true } }),
  });
  const j = await res.json();
  const raw = j.choices?.[0]?.message?.content ?? '';
  const picks = raw.split('\n').map((l) => l.trim().replace(/^[-*\d.\s]+/, '').replace(/[`'"]/g, '')).filter(Boolean);
  return { picks, cost: j.usage?.cost ?? 0, tok: j.usage?.total_tokens ?? 0, raw };
}

const relOf = (graph, id) => graph.nodes.find((n) => n.id === id)?.rel;
const matchGold = (rels, gold) => gold.some((g) => rels.some((r) => r === g || r.endsWith('/' + g) || basename(r) === basename(g)));

async function buildArms(inst, dest, embed) {
  let files = walkPy(dest);
  if (files.length > MAX_FILES) files = files.sort((a, b) => a.length - b.length).slice(0, MAX_FILES);
  const graph = buildGraph(dest, files);
  if (graph.nodes.length < 5 || graph.edgeCount === 0) return null;
  for (const n of graph.nodes) n.vec = await embed(n.text);

  const gold = goldCodeFiles(inst.patch);
  const goldIds = gold.map((g) => { for (const [rel, id] of graph.byRel) if (rel === g || rel.endsWith('/' + g) || basename(rel) === basename(g)) return id; return null; }).filter(Boolean);

  // DENSE arm: top-K_CTX by cosine(problem, file)
  const qvec = await embed(String(inst.problem_statement || '').slice(0, 2000));
  const denseRanked = graph.nodes.map((n) => ({ id: n.id, s: cosine(qvec, n.vec) })).sort((a, b) => b.s - a.s);
  const denseSet = denseRanked.slice(0, K_CTX).map((x) => x.id);

  // GRAPH arm: seeds → kHop reach (real graph-node) → PageRank-rank → top-K_CTX; fill w/ hub-degree then dense
  const { seeds } = extractSeeds(graph, inst.problem_statement, inst.test_patch);
  const seedIds = seeds.filter((id) => !goldIds.includes(id)); // discover gold via topology, don't seed it
  let reached = new Set();
  let graphBackend = 'none';
  if (seedIds.length) {
    try {
      const gn = req(GRAPH_NODE_PATH);
      const db = new gn.GraphDatabase({ distanceMetric: 'Cosine', dimensions: graph.nodes[0].vec.length });
      const z = new Float32Array(graph.nodes[0].vec.length);
      for (const n of graph.nodes) await db.createNode({ id: n.id, embedding: Float32Array.from(n.vec) });
      for (const e of graph.edges) { try { await db.createEdge({ from: e.from, to: e.to, description: 'rel', embedding: z }); } catch { /* dup */ } }
      for (const sid of seedIds) for (const x of await db.kHopNeighbors(sid, KHOP)) reached.add(x);
      graphBackend = `@ruvector/graph-node@${gn.version ? gn.version() : '?'}`;
    } catch {
      graphBackend = 'js-bfs';
      for (const sid of seedIds) { let fr = new Set([sid]); reached.add(sid); for (let h = 0; h < KHOP; h++) { const nx = new Set(); for (const u of fr) for (const v of (graph.adj.get(u) || [])) if (!reached.has(v)) { reached.add(v); nx.add(v); } fr = nx; } }
    }
  }
  const pr = pageRank(graph.nodes, graph.adj);
  // graph candidate set = seeds + reached, ranked by PageRank (topology only; NO cosine)
  const graphPool = [...new Set([...seedIds, ...reached])];
  graphPool.sort((a, b) => (pr.get(b) || 0) - (pr.get(a) || 0));
  let graphSet = graphPool.slice(0, K_CTX);
  // fill budget if traversal under-produced — hub-degree, then dense (clearly logged)
  let filledFrom = 'topology';
  if (graphSet.length < K_CTX) {
    filledFrom = 'topology+hubdeg+dense';
    const degRanked = [...graph.indeg.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    for (const id of degRanked) { if (graphSet.length >= K_CTX) break; if (!graphSet.includes(id)) graphSet.push(id); }
    for (const id of denseSet) { if (graphSet.length >= K_CTX) break; if (!graphSet.includes(id)) graphSet.push(id); }
  }

  const denseRels = denseSet.map((id) => relOf(graph, id));
  const graphRels = graphSet.map((id) => relOf(graph, id));
  const denseTok = denseSet.reduce((a, id) => a + estTok(graph.nodes.find((n) => n.id === id)?.text), 0);
  const graphTok = graphSet.reduce((a, id) => a + estTok(graph.nodes.find((n) => n.id === id)?.text), 0);

  return {
    graph, gold, goldIds, denseSet, graphSet, denseRels, graphRels,
    seedCount: seedIds.length, graphBackend, filledFrom, reached: reached.size,
    setRecallDense: matchGold(denseRels, gold), setRecallGraph: matchGold(graphRels, gold),
    Cr: denseTok ? 1 - graphTok / denseTok : 0, denseTok, graphTok,
    listingDense: sigListing(graph, denseSet), listingGraph: sigListing(graph, graphSet),
  };
}

async function main() {
  if (!KEY && !DRY) { log('No OPENROUTER_API_KEY / /tmp/.orkey — use --dry'); process.exit(1); }
  const dataset = JSON.parse(readFileSync(CANDIDATES, 'utf8')).instances;
  const pool = dataset.filter((x) => !GATE_USED.has(x.instance_id) && !HUGE.has(x.repo));
  const chosen = pool.slice(0, N);
  const embed = await initEmbedder();
  mkdirSync(dirname(OUT), { recursive: true });

  // accumulators: model -> arm -> {hit1, hit3, n}; plus set-recall (model-independent)
  const acc = {}; for (const m of MODELS) acc[m] = { dense: { h1: 0, h3: 0, n: 0, empty: 0 }, graph: { h1: 0, h3: 0, n: 0, empty: 0 } };
  const setRec = { dense: 0, graph: 0, n: 0 };
  let cost = 0, tok = 0; const rows = [];

  for (const inst of chosen) {
    const dest = join(SCRATCH, inst.instance_id);
    try { cloneRepo(inst.repo, inst.base_commit, dest); } catch (e) { log(`[clone-fail] ${inst.instance_id}: ${e.message}`); continue; }
    let arms; try { arms = await buildArms(inst, dest, embed); } catch (e) { log(`[build-fail] ${inst.instance_id}: ${e.message}`); continue; }
    if (!arms || !arms.gold.length || !arms.goldIds.length) { log(`[skip] ${inst.instance_id} (no gold match / trivial)`); continue; }

    setRec.n++; if (arms.setRecallDense) setRec.dense++; if (arms.setRecallGraph) setRec.graph++;
    const row = { instance_id: inst.instance_id, repo: inst.repo, is_lite: inst.is_lite ?? null,
      gold: arms.gold, seeds: arms.seedCount, graphBackend: arms.graphBackend, reached: arms.reached,
      filledFrom: arms.filledFrom, setRecallDense: arms.setRecallDense, setRecallGraph: arms.setRecallGraph,
      Cr: arms.Cr, models: {} };

    for (const model of MODELS) {
      const d = await callLLM(model, arms.listingDense, inst.problem_statement);
      const g = await callLLM(model, arms.listingGraph, inst.problem_statement);
      cost += d.cost + g.cost; tok += d.tok + g.tok;
      const dHit1 = matchGold(d.picks.slice(0, 1), arms.gold), dHit3 = matchGold(d.picks.slice(0, 3), arms.gold);
      const gHit1 = matchGold(g.picks.slice(0, 1), arms.gold), gHit3 = matchGold(g.picks.slice(0, 3), arms.gold);
      acc[model].dense.n++; acc[model].graph.n++;
      if (!d.picks.length) acc[model].dense.empty++; if (!g.picks.length) acc[model].graph.empty++;
      if (dHit1) acc[model].dense.h1++; if (dHit3) acc[model].dense.h3++;
      if (gHit1) acc[model].graph.h1++; if (gHit3) acc[model].graph.h3++;
      row.models[model] = { densePicks: d.picks.slice(0, 3), graphPicks: g.picks.slice(0, 3), dHit1, dHit3, gHit1, gHit3 };
    }
    rows.push(row);
    log(`[${rows.length}] ${inst.instance_id} setRecall d/g=${arms.setRecallDense ? 1 : 0}/${arms.setRecallGraph ? 1 : 0} ` +
        MODELS.map((m) => `${m.split('/')[1]}:d@3=${row.models[m]?.dHit3 ? 1 : 0} g@3=${row.models[m]?.gHit3 ? 1 : 0}`).join(' '));
  }

  const perModel = {};
  for (const m of MODELS) {
    const A = acc[m];
    const mk = (x) => ({ hit1: x.h1, hit3: x.h3, n: x.n, empty: x.empty, emptyRate: x.n ? x.empty / x.n : 0, acc1: x.n ? x.h1 / x.n : 0, acc3: x.n ? x.h3 / x.n : 0, ci3: wilson(x.h3, x.n) });
    const dn = mk(A.dense), gr = mk(A.graph);
    perModel[m] = { dense: dn, graph: gr, deltaHit3_pp: (gr.acc3 - dn.acc3) * 100, deltaHit1_pp: (gr.acc1 - dn.acc1) * 100 };
  }
  const summary = {
    adr: 'ADR-201 H3-code', kind: 'paid-localization-ablation', n: setRec.n, kCtx: K_CTX, khop: KHOP,
    embedder: 'onnx-all-MiniLM-L6-v2-384', models: MODELS,
    label: 'dense(cosine over code) vs graph(kHop+PageRank topology) candidate sets, budget-matched; cheap-model gold-file localization',
    note: 'Measures LOCALIZATION (necessary condition for resolve), NOT end-to-end Docker resolve. n stated. Reported straight.',
    setRecall: { dense: setRec.dense, graph: setRec.graph, n: setRec.n,
      denseAcc: setRec.n ? setRec.dense / setRec.n : 0, graphAcc: setRec.n ? setRec.graph / setRec.n : 0 },
    perModel, cost_usd: Math.round(cost * 1e4) / 1e4, tokens: tok, rows,
  };
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  log(`\n${'='.repeat(70)}`);
  log(`PAID LOCALIZATION ABLATION — n=${setRec.n}, $${summary.cost_usd}`);
  log(`set-recall (gold in arm's ${K_CTX}-file set): dense=${(summary.setRecall.denseAcc * 100).toFixed(0)}% graph=${(summary.setRecall.graphAcc * 100).toFixed(0)}%`);
  for (const m of MODELS) {
    const p = perModel[m];
    log(`${m}: gold-hit@3 dense=${(p.dense.acc3 * 100).toFixed(0)}% [${(p.dense.ci3[0] * 100).toFixed(0)},${(p.dense.ci3[1] * 100).toFixed(0)}] graph=${(p.graph.acc3 * 100).toFixed(0)}% [${(p.graph.ci3[0] * 100).toFixed(0)},${(p.graph.ci3[1] * 100).toFixed(0)}] Δ=${p.deltaHit3_pp >= 0 ? '+' : ''}${p.deltaHit3_pp.toFixed(1)}pp`);
  }
  log(`report → ${OUT}`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
