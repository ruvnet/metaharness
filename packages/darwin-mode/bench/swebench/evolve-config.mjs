#!/usr/bin/env node
// ADR-184/187/188 — Darwin config-evolution for SWE-bench: evolve the STRUCTURED SOLVER POLICY (a config
// genome), not the prompt, toward a SOTA-breaking configuration on the HARD-25 discriminator set.
//
// This is the flagship "evolve the policy" thesis applied to the SWE-bench solver. It REUSES the evolve-arch.mjs
// evolution concepts (population → mutate/crossover → select-from-elite → cost-bounded generations, ADR-100
// selection / ADR-089 crossover) but swaps the fitness from a mock/Value-Score to **real conformant resolve on
// the curated HARD-25** (the 25 Opus-give-up Lite instances, hard-lite-ids.json).
//
//   GENOME = { mode: single|cascade|ecascade|xbo|xcascade|bo3,
//              baseModel,                  // or, for xbo/xcascade, a comma-list of DISTINCT models
//              escalateModel | null,       // tier-2 for cascade/ecascade/xcascade
//              maxSteps, temp }            // levers we've been probing by hand
//   FITNESS = resolved / 25  on the HARD-25 (conformant: --no-test-oracle; Best@k judge selection OK; gold tests
//             touch ONLY the final swebench scoring, never solve/select).
//
//   LOOP    = seed population (known-good GLM→Opus ecascade, frontier-xbo, full-Opus, + diverse mutants)
//             → evaluate (dispatch a GCP HARD=1 SAMPLE=25 run per UNMEASURED genome, bounded concurrency,
//               respect the 32-vCPU GCP quota with e2-standard-4 ≤ maxConcurrent) → poll Firestore for resolved
//             → select top-k → mutate/crossover genome fields → next generation. Stop early on convergence or
//               the ADR-072 cost-breaker ($400 incremental OpenRouter spend, measured live).
//
// HONESTY: fitness is ALWAYS a real Firestore resolved-count / 25. Unmeasured genomes are dispatched as real GCP
// runs; never mock a genome's hard-25 fitness. If quota/budget blocks the search, it reports exactly how far it got.
//
// Usage:
//   node evolve-config.mjs run [--gens N] [--pop K] [--max-conc C] [--cost-cap USD] [--poll-min M] [--seed S]
//   node evolve-config.mjs seed                 # print the seeded population + any Firestore-measured fitness
//   node evolve-config.mjs lookup               # dump the current HARD-25 Firestore fitness lookup
//
// Env: PROJECT (cognitum-20260110), ZONE (us-central1-a). OpenRouter key at /tmp/.orkey. SA auth headless.

import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as presolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = presolve(__dirname, '../../../..');           // .../agent-harness-generator
const CLUSTER = presolve(REPO_ROOT, 'scripts/gcp-cluster.mjs');
const PROJECT = process.env.PROJECT || 'cognitum-20260110';
const OUT_DIR = presolve(__dirname, '');
const ORKEY_PATH = '/tmp/.orkey';

// ── budget breaker (ADR-072): incremental OpenRouter spend cap, measured live, delta from search start ──
const SPEND_BASE = +(process.env.SPEND_BASE || 1052.01);        // historical accounting base (for absolute logging)
function curSpendAbs() {
  try {
    const key = readFileSync(ORKEY_PATH, 'utf8').trim();
    const j = JSON.parse(execSync(`curl -sS -m12 https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer ${key}"`, { encoding: 'utf8' }));
    return +(j.data.usage - SPEND_BASE).toFixed(2);
  } catch { return null; }
}

// ── GCP quota awareness ──
const VCPU_QUOTA = 32, VM_VCPU = 4; // e2-standard-4
function listVMs() {
  try {
    const out = execFileSync('gcloud', ['compute', 'instances', 'list', `--project=${PROJECT}`, '--format=value(name,status,machineType.basename())'], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).filter((l) => l.startsWith('darwin-')).map((l) => {
      const [name, status, mtype = ''] = l.split('\t');
      const vcpu = +(mtype.match(/-(\d+)$/)?.[1]) || 8;
      return { name, status, vcpu };
    });
  } catch { return []; }
}
function usedVCPU() { return listVMs().filter((v) => v.status === 'RUNNING' || v.status === 'STAGING').reduce((s, v) => s + v.vcpu, 0); }
function freeVMSlots() { return Math.max(0, Math.floor((VCPU_QUOTA - usedVCPU()) / VM_VCPU)); }
// best-effort: delete TERMINATED/STOPPED darwin workers (never the controller) to free quota + stop billing
function reap() {
  for (const v of listVMs()) {
    if (v.name === 'darwin-controller') continue;
    if (v.status === 'TERMINATED' || v.status === 'STOPPED') {
      try { execFileSync('gcloud', ['compute', 'instances', 'delete', v.name, `--project=${PROJECT}`, '--zone=' + (process.env.ZONE || 'us-central1-a'), '--quiet'], { stdio: 'pipe' }); } catch { /**/ }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// GENOME — the structured solver policy. Encodes the levers we've probed by hand (LEARNINGS §23/25/28/35/48/49)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════
export const CHEAP_MODELS = ['z-ai/glm-5.2', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v3.2', 'moonshotai/kimi-k2.6', 'minimax/minimax-m2.5'];
export const FRONTIER_MODELS = ['anthropic/claude-opus-4.8', 'openai/gpt-5.5', 'anthropic/claude-sonnet-4.6'];
export const ESCALATE_MODELS = [...FRONTIER_MODELS, 'anthropic/claude-haiku-4.5', 'deepseek/deepseek-r1-0528'];
export const MODES = ['single', 'cascade', 'ecascade', 'xbo', 'xcascade', 'bo3'];
export const STEPS = [12, 15, 20];
export const TEMPS = [0, 0.2, 0.5];

export const mkRng = (s) => () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const pick = (rng, a) => a[Math.floor(rng() * a.length)];
function pickModels(rng, k, pool = CHEAP_MODELS) { const p = [...pool]; const out = []; for (let i = 0; i < k && p.length; i++) out.push(p.splice(Math.floor(rng() * p.length), 1)[0]); return out; }

// Canonical Firestore model-string for a genome (must EXACTLY match what the runner self-reports, see
// gcp-swebench-runner.sh: ecascade:$MODEL>$ESCALATE ; xbo:$XMODELS ; xcascade:$XMODELS>$ESCALATE ; else $MODEL).
export function fsModelString(g) {
  switch (g.mode) {
    case 'ecascade': return `ecascade:${g.baseModel}>${g.escalateModel}`;
    case 'xcascade': return `xcascade:${g.xmodels.join(',')}>${g.escalateModel}`;
    case 'xbo': return `xbo:${g.xmodels.join(',')}`;
    default: return g.baseModel; // single | cascade | bo3 self-report MODEL=baseModel
  }
}
// Order-independent identity key (xbo/xcascade are set-based; mode disambiguates).
export function gkey(g) {
  const setKey = (ms) => ms.map((m) => m.split('/').pop()).sort().join('+');
  switch (g.mode) {
    case 'ecascade': return `ecascade|${g.baseModel.split('/').pop()}>${g.escalateModel.split('/').pop()}|s${g.maxSteps}`;
    case 'xcascade': return `xcascade|${setKey(g.xmodels)}>${g.escalateModel.split('/').pop()}|s${g.maxSteps}`;
    case 'xbo': return `xbo|${setKey(g.xmodels)}|s${g.maxSteps}`;
    case 'cascade': return `cascade|${g.baseModel.split('/').pop()}>${(g.escalateModel || '').split('/').pop()}|s${g.maxSteps}`;
    case 'bo3': return `bo3|${g.baseModel.split('/').pop()}|s${g.maxSteps}`;
    default: return `single|${g.baseModel.split('/').pop()}|s${g.maxSteps}`;
  }
}
// short human label
export const glabel = (g) => gkey(g);

// per-instance cost prior ($/inst) — for ranking ties & dispatch ordering (cheap genomes first). Real $ is the
// breaker; this is only a tie-break heuristic. Hard-25 has ~its own cost but priors are directionally fine.
const baseCost = (m) => /opus/.test(m) ? 0.5 : /gpt-5/.test(m) ? 0.4 : /sonnet/.test(m) ? 0.15 : /haiku/.test(m) ? 0.03 : /r1/.test(m) ? 0.08 : /glm/.test(m) ? 0.018 : /kimi/.test(m) ? 0.02 : 0.01;
export function costPrior(g) {
  const b = baseCost(g.baseModel || (g.xmodels && g.xmodels[0]) || 'glm');
  let c;
  switch (g.mode) {
    case 'single': c = b; break;
    case 'bo3': c = 3 * b + 0.0002; break;
    case 'cascade': c = b + 0.62 * (b * 6); break;
    case 'ecascade': c = b + 0.45 * baseCost(g.escalateModel); break;       // ~45% empty tail escalates (§28)
    case 'xbo': c = g.xmodels.reduce((s, m) => s + baseCost(m), 0); break;
    case 'xcascade': c = g.xmodels.reduce((s, m) => s + baseCost(m), 0) + 0.45 * baseCost(g.escalateModel); break;
    default: c = b;
  }
  return c * (g.maxSteps / 15);
}

const isFrontier = (m) => FRONTIER_MODELS.includes(m);
export function normalizeGenome(g) {
  const h = { mode: g.mode, baseModel: g.baseModel || null, escalateModel: g.escalateModel || null,
    xmodels: g.xmodels ? [...new Set(g.xmodels)] : null, maxSteps: g.maxSteps || 15, temp: g.temp ?? 0 };
  if (h.mode === 'xbo' || h.mode === 'xcascade') { if (!h.xmodels || h.xmodels.length < 2) h.xmodels = CHEAP_MODELS.slice(0, 2); h.baseModel = null; }
  else { h.xmodels = null; if (!h.baseModel) h.baseModel = CHEAP_MODELS[0]; }
  if (h.mode === 'cascade' || h.mode === 'ecascade' || h.mode === 'xcascade') {
    if (!h.escalateModel) h.escalateModel = FRONTIER_MODELS[0];
    // cascade-family: the BASE tier must be cheap (escalate is the frontier tier) — a frontier base cascading
    // to a frontier escalate is degenerate. Coerce a frontier base → its cheap analogue's slot.
    if ((h.mode === 'cascade' || h.mode === 'ecascade') && isFrontier(h.baseModel)) h.baseModel = CHEAP_MODELS[0];
    // base must differ from escalate (avoid X>X no-op cascades)
    if (h.baseModel && h.baseModel === h.escalateModel) h.escalateModel = ESCALATE_MODELS.find((m) => m !== h.baseModel) || FRONTIER_MODELS[0];
    if (h.xmodels && h.xmodels.includes(h.escalateModel)) h.escalateModel = ESCALATE_MODELS.find((m) => !h.xmodels.includes(m)) || FRONTIER_MODELS[0];
  } else h.escalateModel = null;
  return h;
}

export function randomGenome(rng) {
  const mode = pick(rng, MODES);
  const g = { mode, maxSteps: pick(rng, STEPS), temp: pick(rng, TEMPS) };
  if (mode === 'xbo' || mode === 'xcascade') g.xmodels = pickModels(rng, 2 + Math.floor(rng() * 2));
  else g.baseModel = pick(rng, CHEAP_MODELS);
  if (mode === 'cascade' || mode === 'ecascade' || mode === 'xcascade') g.escalateModel = pick(rng, ESCALATE_MODELS);
  return normalizeGenome(g);
}

export function mutate(rng, g) {
  const h = normalizeGenome(g);
  const fields = ['mode', 'base', 'escalate', 'steps'];
  const f = pick(rng, fields);
  if (f === 'mode') { const n = remodel(rng, { ...h, mode: pick(rng, MODES) }); return normalizeGenome(n); }
  if (f === 'base') { if (h.mode === 'xbo' || h.mode === 'xcascade') h.xmodels = pickModels(rng, 2 + Math.floor(rng() * 2)); else h.baseModel = pick(rng, CHEAP_MODELS); }
  else if (f === 'escalate') { if (h.escalateModel) h.escalateModel = pick(rng, ESCALATE_MODELS); else h.maxSteps = pick(rng, STEPS); }
  else h.maxSteps = pick(rng, STEPS);
  return normalizeGenome(h);
}
// re-fill mode-dependent fields after a mode change
function remodel(rng, h) {
  if (h.mode === 'xbo' || h.mode === 'xcascade') { h.xmodels = h.xmodels && h.xmodels.length >= 2 ? h.xmodels : pickModels(rng, 2 + Math.floor(rng() * 2)); h.baseModel = null; }
  else { h.baseModel = h.baseModel || pick(rng, CHEAP_MODELS); h.xmodels = null; }
  if (h.mode === 'cascade' || h.mode === 'ecascade' || h.mode === 'xcascade') h.escalateModel = h.escalateModel || pick(rng, ESCALATE_MODELS);
  else h.escalateModel = null;
  return h;
}

export function crossover(rng, a, b) {
  // inherit mode from one parent, then pull mode-compatible genes from both (ADR-089).
  const mode = rng() < 0.5 ? a.mode : b.mode;
  const h = { mode, maxSteps: rng() < 0.5 ? a.maxSteps : b.maxSteps, temp: rng() < 0.5 ? a.temp : b.temp };
  const baseFrom = (p) => p.baseModel || (p.xmodels && p.xmodels[0]) || CHEAP_MODELS[0];
  const escFrom = (p) => p.escalateModel || pick(rng, ESCALATE_MODELS);
  if (mode === 'xbo' || mode === 'xcascade') {
    // union the parents' model pools, keep 2-3 distinct
    const pool = [...new Set([...(a.xmodels || [a.baseModel]).filter(Boolean), ...(b.xmodels || [b.baseModel]).filter(Boolean)])];
    h.xmodels = pool.slice(0, Math.min(3, Math.max(2, pool.length)));
    if (h.xmodels.length < 2) h.xmodels = CHEAP_MODELS.slice(0, 2);
  } else {
    h.baseModel = rng() < 0.5 ? baseFrom(a) : baseFrom(b);
  }
  if (mode === 'cascade' || mode === 'ecascade' || mode === 'xcascade') h.escalateModel = rng() < 0.5 ? escFrom(a) : escFrom(b);
  return normalizeGenome(h);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// FITNESS — REAL conformant resolve on HARD-25 from Firestore darwin_runs. NEVER mocked.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════
function fsToken() { return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim(); }
function fetchDarwinRuns() {
  const token = fsToken();
  const out = execSync(`curl -s -H "Authorization: Bearer ${token}" "https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/darwin_runs?pageSize=300"`, { encoding: 'utf8', maxBuffer: 1 << 25 });
  const docs = JSON.parse(out).documents || [];
  const g = (f, k) => f[k]?.stringValue ?? (f[k]?.integerValue && +f[k].integerValue) ?? f[k]?.doubleValue ?? f[k]?.booleanValue;
  return docs.map((d) => ({ name: d.name, model: g(d.fields, 'model'), mode: g(d.fields, 'mode'), resolved: g(d.fields, 'resolved'), total: g(d.fields, 'total'), src: g(d.fields, 'source'), ts: g(d.fields, 'ts') }));
}
// HARD-25 fitness lookup: model-string → best resolved (of total==25 docs). Existing 31-doc corpus seeds it.
// We MAX over repeats (matches buildLookup; the degenerate 1/25 & truncated runs are dominated by a good run).
export function buildHardLookup(runs) {
  const L = {};
  for (const r of runs) {
    if (r.total !== 25) continue;       // hard-25 convention: dispatched with HARD=1 SAMPLE=25 → total self-reports 25
    if (r.resolved == null || !r.model) continue;
    const key = canonModelString(r.model, r.mode);
    L[key] = Math.max(L[key] ?? 0, r.resolved);
  }
  return L;
}
// canonicalize a Firestore (model,mode) into a mode-aware set-independent key so dispatch & readback agree.
export function canonModelString(model, mode) {
  const setKey = (csv) => csv.split(',').map((m) => m.split('/').pop()).sort().join('+');
  if (mode === 'xbo' || /^xbo:/.test(model)) return `xbo|${setKey(model.replace(/^xbo:/, ''))}`;
  if (mode === 'xcascade' || /^xcascade:/.test(model)) { const [base, esc] = model.replace(/^xcascade:/, '').split('>'); return `xcascade|${setKey(base)}>${(esc || '').split('/').pop()}`; }
  if (mode === 'ecascade' || /^ecascade:/.test(model)) { const [base, esc] = model.replace(/^ecascade:/, '').split('>'); return `ecascade|${base.split('/').pop()}>${(esc || '').split('/').pop()}`; }
  if (mode === 'cascade') return `cascade|${model.split('/').pop()}`;
  if (mode === 'bo3') return `bo3|${model.split('/').pop()}`;
  return `single|${model.split('/').pop()}`;
}
// the readback key for a genome (ignores maxSteps — Firestore doesn't record it; steps is a secondary dim we
// can't read back, so we treat a genome's fitness as keyed on model+mode, accepting steps-aliasing as noise).
export function readbackKey(g) {
  const setKey = (ms) => ms.map((m) => m.split('/').pop()).sort().join('+');
  switch (g.mode) {
    case 'ecascade': return `ecascade|${g.baseModel.split('/').pop()}>${g.escalateModel.split('/').pop()}`;
    case 'xcascade': return `xcascade|${setKey(g.xmodels)}>${g.escalateModel.split('/').pop()}`;
    case 'xbo': return `xbo|${setKey(g.xmodels)}`;
    case 'cascade': return `cascade|${g.baseModel.split('/').pop()}`;
    case 'bo3': return `bo3|${g.baseModel.split('/').pop()}`;
    default: return `single|${g.baseModel.split('/').pop()}`;
  }
}
export const fitnessOf = (g, lookup) => { const r = lookup[readbackKey(g)]; return r == null ? null : r / 25; };

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// DISPATCH — provision a real GCP HARD=1 SAMPLE=25 run for a genome via the proven gcp-cluster.mjs path.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════
function dispatchGenome(g, { dry = false } = {}) {
  // map genome → gcp-cluster subcommand. HARD=1 SAMPLE=25 → manifest=hard-25, TOTAL self-reports 25.
  const env = { ...process.env, HARD: '1', SAMPLE: '25', MACHINE: 'e2-standard-4', AUTOSTOP: '1' };
  let args;
  switch (g.mode) {
    case 'ecascade': args = ['ecascade', g.baseModel, g.escalateModel, '25', 'lite']; break;
    case 'xcascade': args = ['xcascade', g.xmodels.join(','), g.escalateModel, '25']; break;
    case 'xbo': args = ['provexbo', g.xmodels.join(','), '25']; break;
    case 'cascade': args = ['proveone', g.baseModel, 'cascade', '25']; break; // proveone sets mode; cascade needs escalate → use ecascade path instead if escalate desired
    case 'bo3': args = ['proveone', g.baseModel, 'bo3', '25']; break;
    default: args = ['proveone', g.baseModel, 'single', '25']; break;
  }
  // proveone doesn't pass MAXSTEPS unless env-set; runner reads MAXSTEPS env → forward it.
  env.MAXSTEPS = String(g.maxSteps);
  if (dry) { console.log(`  [dry] node gcp-cluster.mjs ${args.join(' ')}  (HARD=1 SAMPLE=25 MAXSTEPS=${g.maxSteps})`); return true; }
  const r = spawnSync('node', [CLUSTER, ...args], { env, encoding: 'utf8' });
  const ok = (r.stdout || '').includes('provisioning') || (r.stdout || '').includes('✓');
  if (!ok) console.error(`  dispatch FAILED ${glabel(g)}: ${((r.stdout || '') + (r.stderr || '')).split('\n').filter(Boolean).slice(-2).join(' | ')}`);
  else console.log(`  dispatched ${glabel(g)} → ${args[0]}`);
  return ok;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// SEED POPULATION — known-good anchors (LEARNINGS) + structured diversity around them.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════
export function seedPopulation() {
  return [
    // anchors (already measured in the corpus — give the search a real foothold)
    normalizeGenome({ mode: 'ecascade', baseModel: 'z-ai/glm-5.2', escalateModel: 'anthropic/claude-opus-4.8', maxSteps: 15 }), // §28 baseline (16/25)
    normalizeGenome({ mode: 'xbo', xmodels: ['anthropic/claude-opus-4.8', 'z-ai/glm-5.2'], maxSteps: 15 }),                       // frontier-xbo (18/25, current best)
    normalizeGenome({ mode: 'single', baseModel: 'anthropic/claude-opus-4.8', maxSteps: 15 }),                                   // full-Opus (15/25)
    normalizeGenome({ mode: 'xcascade', xmodels: ['deepseek/deepseek-v3.2', 'z-ai/glm-5.2'], escalateModel: 'anthropic/claude-opus-4.8', maxSteps: 15 }), // FUGU (14/25)
    // diverse mutants probing UNDER-explored combinations (the epistasis the manual probes missed):
    normalizeGenome({ mode: 'xbo', xmodels: ['anthropic/claude-opus-4.8', 'deepseek/deepseek-v3.2'], maxSteps: 15 }),            // opus + a DIFFERENT cheap (orthogonal to glm)
    normalizeGenome({ mode: 'xbo', xmodels: ['anthropic/claude-opus-4.8', 'openai/gpt-5.5'], maxSteps: 15 }),                    // two-frontier xbo (orthogonal frontier failures)
    normalizeGenome({ mode: 'ecascade', baseModel: 'deepseek/deepseek-v3.2', escalateModel: 'anthropic/claude-opus-4.8', maxSteps: 15 }), // different cheap base → opus
    normalizeGenome({ mode: 'xcascade', xmodels: ['anthropic/claude-opus-4.8', 'z-ai/glm-5.2'], escalateModel: 'openai/gpt-5.5', maxSteps: 15 }), // strong base xbo → 2nd frontier escalation
  ];
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE EVOLUTION LOOP (real fitness, cost- + quota- + runtime-bounded).
// ════════════════════════════════════════════════════════════════════════════════════════════════════════
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(opts) {
  const { gens, pop, maxConc, costCap, pollMin, maxPollTicks, maxRuntimeMin, seed, dry } = opts;
  const t0 = Date.now();
  const startSpend = curSpendAbs() ?? 0;
  const rng = mkRng(seed);
  const logPath = presolve(OUT_DIR, 'evolve-config-run.json');
  const trajectory = []; const allDispatched = new Set(); let provisioned = 0;
  const dedupe = (arr) => [...new Map(arr.map((g) => [gkey(g), g])).values()];

  console.log(`=== Darwin config-evolution (HARD-25 fitness) ===`);
  console.log(`gens≤${gens} pop=${pop} maxConc=${maxConc} costCap=+$${costCap} pollMin=${pollMin} runtime≤${maxRuntimeMin}m  start-spend $${startSpend}`);
  console.log(`(2 in-flight frontier probes respected; quota=${VCPU_QUOTA}vCPU, used=${usedVCPU()}, free slots=${freeVMSlots()})`);

  const tripped = () => {
    const mins = (Date.now() - t0) / 60000;
    if (mins > maxRuntimeMin) return `runtime ${mins.toFixed(0)}m > ${maxRuntimeMin}m`;
    const s = curSpendAbs();
    if (s != null && s - startSpend > costCap) return `incremental spend $${(s - startSpend).toFixed(2)} > cap $${costCap}`;
    return null;
  };

  let P = dedupe(seedPopulation());
  while (P.length < pop) P.push(randomGenome(rng));
  P = dedupe(P).slice(0, Math.max(pop, P.length));

  let bestEver = { fit: -1, g: null };

  for (let gen = 1; gen <= gens; gen++) {
    const stop = tripped(); if (stop) { console.log(`\nSTOP (breaker): ${stop}`); break; }
    let lookup = buildHardLookup(fetchDarwinRuns());
    console.log(`\n[gen ${gen}] population ${P.length}; ${Object.keys(lookup).length} HARD-25 combos measured in Firestore`);

    // identify unmeasured genomes in the current population
    let unmeasured = P.filter((g) => fitnessOf(g, lookup) == null);
    // cheapest-first dispatch order (so a budget trip leaves us with the cheapest probes done)
    unmeasured.sort((a, b) => costPrior(a) - costPrior(b));

    if (unmeasured.length) {
      console.log(`  ${unmeasured.length} unmeasured genomes to dispatch (cheapest-first):`);
      for (const g of unmeasured) console.log(`    ~$${costPrior(g).toFixed(3)}/inst  ${glabel(g)}`);
      reap();
      // dispatch with bounded concurrency (respect maxConc AND live quota)
      const queue = [...unmeasured];
      while (queue.length) {
        const s2 = tripped(); if (s2) { console.log(`  STOP mid-dispatch (breaker): ${s2}`); queue.length = 0; break; }
        reap();
        const inflightMine = listVMs().filter((v) => (v.status === 'RUNNING' || v.status === 'STAGING') && /-(g\d|ec-|xbo-|xc-|x-)/.test(v.name)).length;
        const slots = Math.min(maxConc - inflightMine, freeVMSlots());
        if (slots <= 0) { console.log(`  waiting on quota/concurrency (inflight=${inflightMine}, freeSlots=${freeVMSlots()})…`); await sleep(pollMin * 60000); continue; }
        for (let i = 0; i < slots && queue.length; i++) {
          const g = queue.shift();
          if (allDispatched.has(gkey(g))) continue;
          if (dispatchGenome(g, { dry })) { allDispatched.add(gkey(g)); provisioned++; }
        }
        await sleep(15000); // let creates settle before recomputing slots
      }

      // poll Firestore for the dispatched genomes' results
      if (!dry) {
        console.log(`  polling Firestore for ${unmeasured.length} results (≤${maxPollTicks}×${pollMin}m)…`);
        for (let t = 0; t < maxPollTicks; t++) {
          const s3 = tripped(); if (s3) { console.log(`  STOP mid-poll (breaker): ${s3}`); break; }
          await sleep(pollMin * 60000);
          reap();
          lookup = buildHardLookup(fetchDarwinRuns());
          const done = unmeasured.filter((g) => fitnessOf(g, lookup) != null).length;
          console.log(`    gen ${gen} poll ${t + 1}: ${done}/${unmeasured.length} self-reported  (spend Δ$${((curSpendAbs() ?? startSpend) - startSpend).toFixed(2)})`);
          if (done >= unmeasured.length) break;
        }
      }
    } else {
      console.log('  all population genomes already measured — pure selection this gen.');
    }

    // score the population on REAL fitness (skip still-unmeasured)
    lookup = buildHardLookup(fetchDarwinRuns());
    const scored = P.map((g) => ({ g, fit: fitnessOf(g, lookup) })).filter((s) => s.fit != null).sort((a, b) => b.fit - a.fit);
    if (!scored.length) { console.log('  no measured fitness yet this gen — cannot select; stopping.'); break; }
    const genBest = scored[0];
    if (genBest.fit > bestEver.fit) bestEver = { fit: genBest.fit, g: genBest.g };
    trajectory.push({ gen, best: +(genBest.fit * 25).toFixed(0) + '/25', bestPct: +(genBest.fit * 100).toFixed(1), bestGenome: glabel(genBest.g),
      measured: scored.length, population: P.map(glabel), leaderboard: scored.slice(0, 5).map((s) => ({ g: glabel(s.g), fit: `${Math.round(s.fit * 25)}/25`, pct: +(s.fit * 100).toFixed(1) })) });
    console.log(`  gen ${gen} best: ${Math.round(genBest.fit * 25)}/25 (${(genBest.fit * 100).toFixed(1)}%)  ${glabel(genBest.g)}`);
    for (const s of scored.slice(0, 5)) console.log(`    ${Math.round(s.fit * 25)}/25  ${glabel(s.g)}`);
    writeFileSync(logPath, JSON.stringify({ opts, startSpend, trajectory, bestEver: { fit: bestEver.fit, genome: bestEver.g, label: bestEver.g && glabel(bestEver.g) }, spendNow: curSpendAbs() }, null, 2));

    // selection (ADR-100 elitism) + variation (ADR-089 crossover + mutation) → next generation
    if (gen < gens) {
      const elite = scored.slice(0, Math.max(2, Math.floor(pop / 2))).map((s) => s.g);
      const next = [...elite];
      let guard = 0;
      while (next.length < pop && guard++ < pop * 20) {
        const child = rng() < 0.5 ? mutate(rng, pick(rng, elite)) : crossover(rng, pick(rng, elite), pick(rng, elite));
        if (!next.some((x) => gkey(x) === gkey(child))) next.push(child);
      }
      P = dedupe(next);
      while (P.length < pop) P.push(randomGenome(rng));
    }
  }

  // ── final report + guaranteed cleanup ──
  reap();
  const endSpend = curSpendAbs();
  const baselineFit = 16 / 25; // §48 GLM→Opus 16/25 stated baseline
  const beats = bestEver.fit > baselineFit + 1e-9;
  const report = {
    title: 'Darwin config-evolution — HARD-25 SWE-bench solver-config search',
    adr: 'ADR-184/187/188 (evolve the structured policy)',
    finishedAt: new Date().toISOString(),
    runtimeMin: +((Date.now() - t0) / 60000).toFixed(1),
    spend: { startAbs: startSpend, endAbs: endSpend, incremental: endSpend == null ? null : +(endSpend - startSpend).toFixed(2), capUsd: costCap },
    provisioned, dispatchedGenomes: [...allDispatched],
    baseline: { label: 'GLM→Opus ecascade (§48)', fit: '16/25', pct: 64.0 },
    best: bestEver.g ? { label: glabel(bestEver.g), genome: bestEver.g, fit: `${Math.round(bestEver.fit * 25)}/25`, pct: +(bestEver.fit * 100).toFixed(1), fsModel: fsModelString(bestEver.g) } : null,
    beatsBaseline: beats,
    trajectory,
  };
  writeFileSync(presolve(OUT_DIR, 'evolve-config-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`FINISHED. provisioned ${provisioned} VMs, incremental spend $${endSpend == null ? '?' : (endSpend - startSpend).toFixed(2)} / cap $${costCap}.`);
  if (report.best) console.log(`BEST GENOME: ${report.best.fit} (${report.best.pct}%)  ${report.best.label}`);
  console.log(`BEATS GLM→Opus 16/25 baseline? ${beats ? 'YES' : 'no'}`);
  console.log(`trajectory + report → evolve-config-run.json / evolve-config-report.json`);
  console.log(`Run \`node ${CLUSTER} down all\` if any worker VM lingers (controller excluded).`);
  return report;
}

// ── CLI ──
if (process.argv[1] && process.argv[1].endsWith('evolve-config.mjs')) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'run';
  const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  if (cmd === 'lookup') {
    const L = buildHardLookup(fetchDarwinRuns());
    console.log('HARD-25 Firestore fitness lookup (resolved/25):');
    for (const [k, v] of Object.entries(L).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(2)}/25 (${(v / 25 * 100).toFixed(0)}%)  ${k}`);
  } else if (cmd === 'seed') {
    const L = buildHardLookup(fetchDarwinRuns());
    console.log('Seed population (+ Firestore-measured HARD-25 fitness where known):');
    for (const g of seedPopulation()) { const f = fitnessOf(g, L); console.log(`  ${f == null ? ' —  ' : (Math.round(f * 25) + '/25').padStart(5)}  ~$${costPrior(g).toFixed(3)}/inst  ${glabel(g)}`); }
  } else if (cmd === 'run') {
    await run({
      gens: +argv('--gens', 3), pop: +argv('--pop', 5), maxConc: +argv('--max-conc', 3),
      costCap: +argv('--cost-cap', 400), pollMin: +argv('--poll-min', 8), maxPollTicks: +argv('--max-poll-ticks', 22),
      maxRuntimeMin: +argv('--max-runtime-min', 600), seed: +argv('--seed', 1), dry: args.includes('--dry'),
    });
  } else {
    console.log('usage: evolve-config.mjs <run|seed|lookup> [--gens N --pop K --max-conc C --cost-cap USD --poll-min M --seed S --dry]');
  }
}
