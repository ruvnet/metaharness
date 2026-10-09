#!/usr/bin/env node
// Cluster non-solved Arena calibration episodes by what went wrong, so task generators can target
// recurring REASONING failures (and so truncation/infra noise is visible as its own cluster).
//
//   node --experimental-strip-types cluster-failures.mjs --db-dir DIR [--k 5] [--threshold 0.95]
//        [--mutual] [--embed-url URL] [--embed-model all-minilm] [--ruvector-cmd "npx -y ruvector@0.3.3"]
//        [--no-ruvector] [--out clusters.json] <file.jsonl | dir> ...
//
// Pipeline: collect episode rows (reward !== 1) -> one short text per episode -> local embedding
// (ollama all-minilm, 384-d) -> ruvector store (create/insert, then one serial kNN search per vector)
// -> similarity graph (edges with cosine >= threshold among each node's k nearest) -> union-find.
// If any ruvector step fails or its receipts disagree, the run falls back to exact in-process cosine
// kNN and says so in `backend` / `ruvectorError`. Report JSON -> stdout (and --out); logs -> stderr.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RUVECTOR_DEFAULT_CMD, cosine, knnRuvector, ruvectorStore } from './lib/ruvector.mjs';
import { CLASSES as FITNESS_CLASSES, classifyEpisodeDetailed, planContext as fitnessPlanContext } from './lib/fitness.mjs';

export { cosine, knnRuvector };
// One classifier for fitness and clustering: a second copy with different rules would make a cluster's
// "reasoning" label disagree with what the fitness counted as reasoning.
const CLASSIFIER = 'lib/fitness.mjs#classifyEpisodeDetailed';

export const DIM = 384;
export const CLASSES = [...FITNESS_CLASSES]; // solved, partial, reasoning, format, truncation, infra
const log = (...a) => console.error('[cluster-failures]', ...a);
const sha256 = b => createHash('sha256').update(b).digest('hex');
const DIGEST = /^[a-f0-9]{64}$/;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();

/** finish_reason of the last provider call; v1-runner rows carry no provider metrics ('unrecorded'). */
export function lastFinishReason(row) {
  const pm = row?.trajectory?.provider_metrics;
  return Array.isArray(pm) && pm.length ? String(pm[pm.length - 1]?.finish_reason ?? 'unknown') : 'unrecorded';
}

/** Short embedding text: family, difficulty, class, failure code, finish reason, last reply, final observation. */
export function episodeText(row, cls) {
  const msgs = Array.isArray(row?.trajectory?.messages) ? row.trajectory.messages : [];
  const last = msgs[msgs.length - 1];
  let assistant;
  if (row?.failure && last?.role !== 'assistant') assistant = '(failing reply not recorded)';
  else {
    const a = [...msgs].reverse().find(m => m?.role === 'assistant');
    assistant = a ? clip(oneLine(a.content), 300) || '(empty reply)' : '(no assistant reply)';
  }
  const lastUser = [...msgs].reverse().find(m => m?.role === 'user');
  let obs = 'unparseable';
  try {
    const o = JSON.parse(lastUser?.content ?? '');
    obs = `done=${Boolean(o.done)} error=${clip(oneLine(o.error), 120) || 'none'} reward=${Number(o.reward)}`;
  } catch { /* keep 'unparseable' */ }
  // Most diagnostic fields first: the embedder has a 512-token window and dense JSON tokenizes long.
  return `family=${row.task_id} difficulty=${row.difficulty} class=${cls} failure=${row.failure ?? 'none'} `
    + `finish=${lastFinishReason(row)} reward=${row.reward} | final_obs: ${obs} | last_assistant: ${assistant}`;
}

/**
 * Expand files/dirs to *.jsonl, read every episode row, keep non-solved, dedupe by trajectoryDigest.
 * `classify(row, ctx)` returns a class string or {cls, reason}; ctx = planContext(rows of the same file).
 * A row the classifier rejects is counted in stats.invalid and skipped (never reclassified by other rules).
 */
export function collectFailures(paths, classify = classifyEpisodeDetailed, planContext = fitnessPlanContext) {
  const files = paths.flatMap(p => (statSync(p).isDirectory()
    ? readdirSync(p).filter(f => f.endsWith('.jsonl')).sort().map(f => join(p, f)) : [p]));
  const seen = new Set(), episodes = [], inputs = [];
  const stats = { episodes: 0, solved: 0, duplicates: 0, malformed: 0, invalid: 0 };
  for (const file of files) {
    const bytes = readFileSync(file);
    const lines = bytes.toString('utf8').split('\n').filter(l => l.trim());
    const label = `${basename(dirname(file))}/${basename(file)}`;
    const parsed = lines.map(l => { try { return JSON.parse(l); } catch { stats.malformed++; return null; } });
    let ctx = {};
    try { ctx = planContext(parsed.filter(Boolean)) ?? {}; } catch { /* no usable plan row */ }
    let fileEpisodes = 0;
    for (const row of parsed) {
      if (row?.type !== 'episode') continue;
      stats.episodes++; fileEpisodes++;
      if (typeof row.reward !== 'number' || !Number.isFinite(row.reward) || row.reward < 0 || row.reward > 1
        || typeof row.task_id !== 'string') { stats.invalid++; continue; }
      if (row.reward === 1) { stats.solved++; continue; }
      const key = DIGEST.test(row.trajectoryDigest ?? '') ? row.trajectoryDigest
        : `${label}|${row.task_id}|${row.difficulty}|${row.seed}|${row.attempt}`;
      if (seen.has(key)) { stats.duplicates++; continue; }
      seen.add(key);
      let cls, reason = null;
      try {
        const r = classify(row, ctx);
        cls = typeof r === 'string' ? r : r?.cls; reason = typeof r === 'object' ? r?.reason ?? null : null;
        if (!CLASSES.includes(cls)) throw new Error(`bad_class:${cls}`);
      } catch { stats.invalid++; continue; }
      episodes.push({ id: `f${String(episodes.length).padStart(4, '0')}`, file: label, family: row.task_id,
        difficulty: row.difficulty, seed: row.seed, attempt: row.attempt, reward: row.reward,
        failure: row.failure ?? null, finish: lastFinishReason(row), cls, reason,
        tokens: row.total_tokens_reported ?? null, digest: row.trajectoryDigest ?? null, text: episodeText(row, cls) });
    }
    inputs.push({ file: label, sha256: sha256(bytes), lines: lines.length, episodes: fileEpisodes });
  }
  return { episodes, inputs, stats };
}

export function checkVector(v, dim = DIM) {
  if (!Array.isArray(v) || v.length !== dim || !v.every(Number.isFinite)) throw new Error('invalid_embedding');
  if (!v.some(x => x !== 0)) throw new Error('zero_embedding');
  return v;
}

/** POST {model, prompt} to ollama /api/embeddings (num_ctx 512 = all-minilm's full window; default is 256). */
export async function ollamaEmbed(text, { url, model, timeoutMs = 60_000 }) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: text, options: { num_ctx: 512 } }), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(/context length/i.test(body) ? 'embed_context_overflow' : `embed_http_${res.status}`);
  }
  return checkVector((await res.json()).embedding);
}

/** Embed, trimming the tail (the reply snippet) by 25% per retry if the text overflows the window. */
export async function embedEpisode(text, embed) {
  for (let t = text, tries = 0; ; tries++) {
    try { return { vector: await embed(t), text: t, trimmed: tries > 0 }; } catch (e) {
      if (e.message !== 'embed_context_overflow' || tries >= 4) throw e;
      t = `${t.slice(0, Math.floor(t.length * 0.75))}...`;
    }
  }
}

/** Exact kNN: Map id -> [{id, sim}] (self excluded), most similar first. */
export function knnInProcess(items, k) {
  const out = new Map();
  for (const a of items) {
    out.set(a.id, items.filter(b => b.id !== a.id).map(b => ({ id: b.id, sim: cosine(a.vector, b.vector) }))
      .sort((x, y) => y.sim - x.sim || (x.id < y.id ? -1 : 1)).slice(0, k));
  }
  return out;
}

/** Union-find over kNN edges with sim >= threshold (optionally only mutual kNN pairs). Returns id[][] by size desc. */
export function clusterGraph(ids, neighbors, { threshold, mutual = false }) {
  const parent = new Map(ids.map(id => [id, id]));
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const isNb = (a, b) => (neighbors.get(a) ?? []).some(n => n.id === b);
  let edges = 0;
  for (const a of ids) for (const { id: b, sim } of neighbors.get(a) ?? []) {
    if (!(sim >= threshold) || !parent.has(b) || (mutual && !isNb(b, a))) continue;
    edges++;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map();
  for (const id of ids) { const r = find(id); groups.set(r, [...(groups.get(r) ?? []), id]); }
  return { edges, clusters: [...groups.values()].sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1)) };
}

const tally = xs => Object.fromEntries(Object.entries(xs.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {}))
  .sort((a, b) => b[1] - a[1]));
export function quantiles(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), q = p => +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))].toFixed(4);
  return { n: s.length, min: q(0), p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), max: q(1) };
}

/** Per-cluster mix and 2 exemplars (highest mean similarity to the rest of the cluster). */
export function describeClusters(clusters, items) {
  const byId = new Map(items.map(e => [e.id, e]));
  return clusters.map((ids, i) => {
    const members = ids.map(id => byId.get(id));
    const centrality = members.map(m => ({ m, c: members.length < 2 ? 1
      : members.reduce((s, o) => s + (o === m ? 0 : cosine(m.vector, o.vector)), 0) / (members.length - 1) }))
      .sort((a, b) => b.c - a.c || (a.m.id < b.m.id ? -1 : 1));
    const mean = centrality.reduce((s, x) => s + x.c, 0) / centrality.length;
    return { cluster: i, size: ids.length, cohesion: +mean.toFixed(4),
      families: tally(members.map(m => m.family)), classes: tally(members.map(m => m.cls)),
      reasons: tally(members.map(m => m.reason ?? 'n/a')), failures: tally(members.map(m => m.failure ?? 'none')),
      finish: tally(members.map(m => m.finish)), difficulties: tally(members.map(m => `d${m.difficulty}`)),
      meanReward: +(members.reduce((s, m) => s + m.reward, 0) / members.length).toFixed(4),
      exemplars: centrality.slice(0, 2).map(({ m }) => ({ id: m.id, file: m.file, seed: m.seed, attempt: m.attempt,
        family: m.family, difficulty: m.difficulty, cls: m.cls, reason: m.reason, failure: m.failure, reward: m.reward,
        tokens: m.tokens, snippet: clip(m.text, 360) })),
      members: ids };
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    'db-dir': { type: 'string' }, k: { type: 'string', default: '5' }, threshold: { type: 'string', default: '0.95' },
    mutual: { type: 'boolean', default: false }, 'embed-url': { type: 'string', default: 'http://localhost:11434/api/embeddings' },
    'embed-model': { type: 'string', default: 'all-minilm' }, 'ruvector-cmd': { type: 'string' },
    'no-ruvector': { type: 'boolean', default: false }, out: { type: 'string' }, 'max-episodes': { type: 'string', default: '5000' } } });
  const k = Number(o.k), threshold = Number(o.threshold), maxEpisodes = Number(o['max-episodes']);
  if (!Number.isInteger(k) || k < 1 || k > 100) throw new Error('invalid_k');
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) throw new Error('invalid_threshold');
  if (!positionals.length) throw new Error('no_inputs');
  if (!o['no-ruvector'] && !o['db-dir']) throw new Error('db_dir_required (or pass --no-ruvector)');
  const classifier = CLASSIFIER;
  const { episodes, inputs, stats } = collectFailures(positionals.map(p => resolve(p)));
  if (episodes.length > maxEpisodes) throw new Error(`too_many_episodes:${episodes.length}>${maxEpisodes}`);
  if (episodes.length < 2) throw new Error(`not_enough_failures:${episodes.length}`);
  log(`${episodes.length} non-solved episodes from ${inputs.length} files (classifier: ${classifier})`);
  const items = [], embed = t => ollamaEmbed(t, { url: o['embed-url'], model: o['embed-model'] });
  for (const e of episodes) {
    const { vector, text, trimmed } = await embedEpisode(e.text, embed);
    if (trimmed) stats.embedTextTrimmed = (stats.embedTextTrimmed ?? 0) + 1;
    items.push({ ...e, text, vector,
      metadata: { family: e.family, difficulty: e.difficulty, cls: e.cls, failure: e.failure ?? 'none' } });
  }
  log(`embedded ${items.length} texts with ${o['embed-model']} (${DIM}-d)`);
  let backend = 'in-process-cosine', ruvectorError = o['no-ruvector'] ? 'disabled by --no-ruvector' : null, ruvector = null, neighbors;
  if (!o['no-ruvector']) {
    const cmd = o['ruvector-cmd'] ? o['ruvector-cmd'].split(/\s+/).filter(Boolean) : RUVECTOR_DEFAULT_CMD;
    try {
      const store = ruvectorStore({ dbDir: o['db-dir'], cmd });
      const version = await store.version();
      const r = await knnRuvector(items, k, store);
      neighbors = r.neighbors; ruvector = { version, ...r.receipt }; backend = 'ruvector';
      log(`ruvector ${version}: ${r.receipt.count} vectors, ${r.receipt.searches} searches, max |dist-(1-cos)| = ${r.receipt.maxAbsErr.toExponential(2)}`);
    } catch (e) { ruvectorError = String(e.message ?? e); log(`ruvector FAILED, falling back to in-process cosine: ${ruvectorError}`); }
  }
  if (!neighbors) neighbors = knnInProcess(items, k);
  const ids = items.map(e => e.id);
  const { edges, clusters } = clusterGraph(ids, neighbors, { threshold, mutual: o.mutual });
  const described = describeClusters(clusters, items);
  const report = { kind: 'arena_failure_clusters', generatedAt: new Date().toISOString(), backend, ruvectorError, ruvector,
    embedder: { url: o['embed-url'], model: o['embed-model'], dim: DIM }, classifier,
    params: { k, threshold, mutual: o.mutual, edgeRule: 'cosine >= threshold among k nearest; union-find (single linkage)' },
    inputs, stats: { ...stats, nonSolved: episodes.length, edges, clusters: clusters.length,
      multiMemberClusters: clusters.filter(c => c.length > 1).length, singletons: clusters.filter(c => c.length === 1).length },
    overall: { classes: tally(episodes.map(e => e.cls)), reasons: tally(episodes.map(e => e.reason ?? 'n/a')),
      failures: tally(episodes.map(e => e.failure ?? 'none')), finish: tally(episodes.map(e => e.finish)),
      families: tally(episodes.map(e => e.family)) },
    nearestNeighborSim: quantiles(ids.map(id => neighbors.get(id)?.[0]?.sim).filter(Number.isFinite)),
    caveats: [
      'v1-runner rows (no provider_metrics) end at the observation before the failing reply: their text says "(failing reply not recorded)" and finish=unrecorded, so they cluster on family/difficulty/failure code, not on cause.',
      'Similarity is over short templated texts; clusters are descriptive diagnostics, not a measured property of the policy.',
    ],
    clusters: described };
  const json = JSON.stringify(report, null, 2);
  if (o.out) writeFileSync(o.out, `${json}\n`);
  process.stdout.write(`${json}\n`);
  for (const c of described.filter(c => c.size > 1)) {
    log(`cluster ${c.cluster}: size ${c.size} cohesion ${c.cohesion} classes ${JSON.stringify(c.classes)} families ${JSON.stringify(c.families)}`);
  }
  log(`backend=${backend} clusters=${clusters.length} (multi-member ${report.stats.multiMemberClusters}, singletons ${report.stats.singletons})`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { log(`error: ${e.message}`); process.exit(2); });
}
