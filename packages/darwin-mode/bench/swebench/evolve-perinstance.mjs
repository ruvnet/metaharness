#!/usr/bin/env node
// evolve-perinstance.mjs — PER-INSTANCE parallel config-evolution to crack the SWE-bench HARD tail.
//
// Each of the 25 hard Lite instances (hard-lite-ids.json — the Opus give-ups) gets its OWN tiny Darwin
// evolution over the CAPABILITY genome, with fitness = k-sample conformant resolve on that ONE instance.
// The point is DIAGNOSIS: learn WHICH GENERAL capability (model / escalation / Best-of-N width / turn
// budget) cracks each instance — then assemble the generalizable capability set and validate it as ONE
// conformant harness on held-out n=300 (separate, NO per-instance tuning).
//
// ════════════════════════════════════════════════════════════════════════════════════════════════════
// ⚠️ CONFORMANCE FIREWALL — the central design constraint. Get this wrong and the whole thing is worthless.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
//   1. PER-INSTANCE EVOLUTION = DIAGNOSIS ONLY. Evolving a config per-instance against the gold-test pass
//      is TUNING ON THE TEST (HV-1) — the resulting per-instance config is OVERFIT to that instance and
//      its k/k resolve is NOT a claimable result. We label every per-instance number `diagnosis:true`.
//   2. NO leaderboard/SOTA claim may come from per-instance gold-tuned configs. The deliverables are
//      (a) a COVERAGE MAP (which instance cracked, by what capability, at what k-rate), and
//      (b) the GENERALIZABLE capability set — which must be validated as ONE harness (or a conformant
//          router that selects config WITHOUT gold tests) on held-out instances / n=300.
//   3. The genome encodes GENERAL capabilities (toggles) only — never instance-specific hacks. The solver
//      itself is conformant: solve-agentic.mjs runs --no-test-oracle (in-loop signal = the repo's OWN
//      tests); gold tests SCORE the finished patches and are NEVER seen during solving.
//
// CAPABILITY GENOME dims (the levers, all GENERAL):
//   mode   ∈ {single, cascade, bo3, xbo}   — single=baseline; cascade=cheap→frontier escalation on a
//                                             repo-gate miss; bo3=Best-of-N width on one model; xbo=cross-
//                                             model Best-of-N (orthogonal failure modes → higher union).
//   model / escalateModel / xmodels        — which model(s); cascade tier-2.
//   maxSteps                               — turn budget.
//   temp                                   — base sampling temperature (samples jitter for diversity).
//   NOTE: localization / reproduction / reviewer are capabilities NOT yet config-toggleable in this
//   harness (they'd need NEW solver code). We DIAGNOSE with what's toggleable and flag the rest as the
//   roadmap (see the report's `capabilityRoadmap`).
//
// FITNESS: resolved_k / k for (instance, genome) read from Firestore `darwin_inst_runs` (k>=2 to beat
//   binary noise). Unmeasured (instance,genome) pairs are dispatched as real GCP single-instance runs.
//   NEVER mocked — if quota/budget blocks the search it reports exactly how far it got.
//
// PARALLELISM: (instance × genome) probes are dispatched across bounded GCP VMs (e2-standard-4), packing
//   the free CPU quota and respecting in-flight experiments (never deletes the controller / non-perinst VMs).
//
// BREAKERS: ~$300 INCREMENTAL OpenRouter spend (delta from search START, measured live — NOT a stale base),
//   a wall-clock cap, and guaranteed VM reap of finished perinst workers.
//
// Usage:
//   node evolve-perinstance.mjs run   [--gens N --pop K --k SAMPLES --max-conc C --cost-cap USD \
//                                       --poll-min M --max-runtime-min R --instances N --seed S --dry]
//   node evolve-perinstance.mjs lookup            # dump the darwin_inst_runs per-instance fitness table
//   node evolve-perinstance.mjs coverage          # build + print the coverage map from current Firestore
//   node evolve-perinstance.mjs seed              # print the seed genome population (capability set)
//
// Env: PROJECT (cognitum-20260110), ZONE (us-central1-a). OpenRouter key at /tmp/.orkey. SA auth headless.

import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as presolve } from 'node:path';
import {
  randomGenome, mutate, crossover, gkey, normalizeGenome, costPrior, fsModelString,
  CHEAP_MODELS, FRONTIER_MODELS, mkRng,
} from './evolve-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = process.env.PROJECT || 'cognitum-20260110';
const ZONE = process.env.ZONE || 'us-central1-a';
const OUT_DIR = __dirname;
const ORKEY_PATH = '/tmp/.orkey';
const HARD_IDS = JSON.parse(readFileSync(presolve(__dirname, 'hard-lite-ids.json'), 'utf8'));
// raw URL the VM startup-script fetches the per-instance runner from (must be on main for a real run).
const RUNNER_URL = process.env.PERINST_RUNNER_URL ||
  'https://raw.githubusercontent.com/ruvnet/agent-harness-generator/main/scripts/gcp-perinstance-runner.sh';

// ── budget breaker: incremental OpenRouter spend, measured live, delta from SEARCH START (not a stale base) ──
export function curSpendAbs() {
  try {
    const key = readFileSync(ORKEY_PATH, 'utf8').trim();
    const j = JSON.parse(execSync(`curl -sS -m12 https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer ${key}"`, { encoding: 'utf8' }));
    return +(+j.data.usage).toFixed(2);
  } catch { return null; }
}

// ── GCP quota awareness (respect in-flight experiments; only count/our reap perinst workers) ──
const VCPU_QUOTA = 32, VM_VCPU = 4; // e2-standard-4
const PERINST_PREFIX = 'darwin-pi-';
function listVMs() {
  try {
    const out = execFileSync('gcloud', ['compute', 'instances', 'list', `--project=${PROJECT}`, '--format=value(name,status,machineType.basename())'], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const [name, status, mtype = ''] = l.split('\t');
      const vcpu = +(mtype.match(/-(\d+)$/)?.[1]) || (/small|micro/.test(mtype) ? 2 : 8);
      return { name, status, vcpu };
    });
  } catch { return []; }
}
function usedVCPU() { return listVMs().filter((v) => v.status === 'RUNNING' || v.status === 'STAGING').reduce((s, v) => s + v.vcpu, 0); }
function freeVMSlots() { return Math.max(0, Math.floor((VCPU_QUOTA - usedVCPU()) / VM_VCPU)); }
function inflightPerinst() { return listVMs().filter((v) => v.name.startsWith(PERINST_PREFIX) && (v.status === 'RUNNING' || v.status === 'STAGING')).length; }
// reap ONLY our finished perinst workers — never the controller, never other experiments' VMs.
function reap() {
  for (const v of listVMs()) {
    if (!v.name.startsWith(PERINST_PREFIX)) continue;
    if (v.status === 'TERMINATED' || v.status === 'STOPPED') {
      try { execFileSync('gcloud', ['compute', 'instances', 'delete', v.name, `--project=${PROJECT}`, '--zone=' + ZONE, '--quiet'], { stdio: 'pipe' }); } catch { /**/ }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// CAPABILITY GENOME — reuse evolve-config's GENERAL genome, restricted to the per-instance-affordable
// capability levers (single/cascade/bo3/xbo; the per-instance runner implements exactly these). The
// frontier-heavy global modes (ecascade/xcascade) are global-set constructs, not single-instance levers.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
export const PI_MODES = ['single', 'cascade', 'bo3', 'xbo'];

// map a genome → its per-instance capability label (the thing we report as "what cracked it").
export function capabilityOf(g) {
  switch (g.mode) {
    case 'single': return /opus|gpt-5|sonnet/.test(g.baseModel || '') ? 'frontier-single' : 'cheap-single';
    case 'cascade': return 'cheap→frontier-escalation';
    case 'bo3': return 'best-of-N-width';
    case 'xbo': return 'cross-model-best-of-N';
    default: return g.mode;
  }
}

// per-instance identity key: the genome key WITHOUT maxSteps aliasing issues — the runner records the exact
// gkey we pass, so readback is exact (unlike the global path which can't read maxSteps). We keep gkey() whole.
export const pikey = (instanceId, g) => `${instanceId}::${gkey(g)}`;

// SEED capability population for EACH instance — the general levers we want to A/B per instance.
// Cheapest-first ordering is applied at dispatch; this is the menu of GENERAL capabilities to diagnose.
export function seedGenomes() {
  return [
    normalizeGenome({ mode: 'single', baseModel: 'z-ai/glm-5.2', maxSteps: 15 }),                                   // cheap baseline
    normalizeGenome({ mode: 'single', baseModel: 'anthropic/claude-opus-4.8', maxSteps: 15 }),                      // frontier baseline
    normalizeGenome({ mode: 'single', baseModel: 'anthropic/claude-opus-4.8', maxSteps: 20 }),                      // + turn budget
    normalizeGenome({ mode: 'bo3', baseModel: 'anthropic/claude-opus-4.8', maxSteps: 15 }),                         // Best-of-N width (frontier)
    normalizeGenome({ mode: 'cascade', baseModel: 'z-ai/glm-5.2', escalateModel: 'anthropic/claude-opus-4.8', maxSteps: 15 }), // escalation lever
    normalizeGenome({ mode: 'xbo', xmodels: ['anthropic/claude-opus-4.8', 'z-ai/glm-5.2'], maxSteps: 15 }),         // cross-model BoN
  ];
}
// restrict a (possibly ecascade/xcascade) genome to the per-instance mode set.
function coerceMode(g) {
  if (PI_MODES.includes(g.mode)) return g;
  // collapse global-only modes onto their per-instance analogue
  if (g.mode === 'ecascade') return normalizeGenome({ mode: 'cascade', baseModel: g.baseModel, escalateModel: g.escalateModel, maxSteps: g.maxSteps, temp: g.temp });
  if (g.mode === 'xcascade') return normalizeGenome({ mode: 'xbo', xmodels: g.xmodels, maxSteps: g.maxSteps, temp: g.temp });
  return normalizeGenome({ ...g, mode: 'single' });
}
export function randomPIGenome(rng) {
  // bias randomness onto PI_MODES by re-rolling mode through coerceMode
  let g = randomGenome(rng); let guard = 0;
  while (!PI_MODES.includes(g.mode) && guard++ < 8) g = randomGenome(rng);
  return coerceMode(g);
}
export const mutatePI = (rng, g) => coerceMode(mutate(rng, g));
export const crossoverPI = (rng, a, b) => coerceMode(crossover(rng, a, b));

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// FITNESS — REAL per-instance k-sample resolve from Firestore darwin_inst_runs. NEVER mocked.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
function fsToken() { return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim(); }
export function fetchInstRuns() {
  const token = fsToken();
  const out = execSync(`curl -s -H "Authorization: Bearer ${token}" "https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/darwin_inst_runs?pageSize=500"`, { encoding: 'utf8', maxBuffer: 1 << 25 });
  const docs = JSON.parse(out).documents || [];
  const g = (f, k) => f[k]?.stringValue ?? (f[k]?.integerValue != null ? +f[k].integerValue : undefined) ?? f[k]?.doubleValue ?? f[k]?.booleanValue;
  return docs.map((d) => ({
    instance_id: g(d.fields, 'instance_id'), gkey: g(d.fields, 'gkey'), mode: g(d.fields, 'mode'),
    model: g(d.fields, 'model'), ksamp: g(d.fields, 'ksamp'), resolved_k: g(d.fields, 'resolved_k'),
    capability: g(d.fields, 'capability'), ts: g(d.fields, 'ts'),
  })).filter((r) => r.instance_id && r.gkey);
}
// lookup: `${instance}::${gkey}` → { resolved_k, ksamp, fit, capability }. MAX over repeats (best run wins).
export function buildInstLookup(runs) {
  const L = {};
  for (const r of runs) {
    if (r.resolved_k == null || r.ksamp == null || !r.ksamp) continue;
    const key = `${r.instance_id}::${r.gkey}`;
    const fit = r.resolved_k / r.ksamp;
    if (!L[key] || fit > L[key].fit) L[key] = { resolved_k: r.resolved_k, ksamp: r.ksamp, fit, capability: r.capability };
  }
  return L;
}
export const fitnessOf = (instanceId, g, L) => { const r = L[pikey(instanceId, g)]; return r == null ? null : r.fit; };

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// COVERAGE MAP — the deliverable. Per instance: best capability that cracked it + k-rate; uncrackable flag.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
export function buildCoverage(runs, instances = HARD_IDS) {
  const byInst = {};
  for (const r of runs) { (byInst[r.instance_id] ||= []).push(r); }
  const rows = instances.map((id) => {
    const probes = (byInst[id] || []).map((r) => ({ gkey: r.gkey, mode: r.mode, model: r.model, capability: r.capability, resolved_k: r.resolved_k, ksamp: r.ksamp, fit: r.ksamp ? r.resolved_k / r.ksamp : 0 }));
    probes.sort((a, b) => b.fit - a.fit);
    const best = probes[0] || null;
    const cracked = !!best && best.resolved_k > 0;
    return { instance_id: id, cracked, probesRun: probes.length,
      bestCapability: cracked ? best.capability : null, bestGenome: cracked ? best.gkey : null,
      bestRate: cracked ? `${best.resolved_k}/${best.ksamp}` : '0', bestModel: cracked ? best.model : null,
      // "robust" = cracked on a STRICT MAJORITY of samples (>50%; less likely to be lucky binary noise)
      robust: cracked && best.resolved_k * 2 > best.ksamp && best.ksamp >= 2,
      allProbes: probes };
  });
  const cracked = rows.filter((r) => r.cracked);
  const robust = rows.filter((r) => r.robust);
  // generalizable capability tally: how many instances each capability cracked (best-of)
  const capTally = {};
  for (const r of cracked) capTally[r.bestCapability] = (capTally[r.bestCapability] || 0) + 1;
  return {
    total: instances.length, probed: rows.filter((r) => r.probesRun > 0).length,
    cracked: cracked.length, robustCracked: robust.length, uncracked: instances.length - cracked.length,
    capabilityTally: Object.fromEntries(Object.entries(capTally).sort((a, b) => b[1] - a[1])),
    uncrackedInstances: rows.filter((r) => !r.cracked).map((r) => r.instance_id),
    rows,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// DISPATCH — one GCP e2-standard-4 per (instance, genome): self-runs the per-instance k-sample runner.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
function key() { return readFileSync(ORKEY_PATH, 'utf8').trim(); }
const STARTUP = (runnerUrl) => `#!/bin/bash
M(){ curl -sf -H 'Metadata-Flavor: Google' "http://metadata/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null 2>&1; apt-get install -y git curl >/dev/null 2>&1
mkdir -p /opt
curl -fsSL ${runnerUrl} -o /opt/perinst-runner.sh
bash /opt/perinst-runner.sh > /var/log/darwin-perinst.log 2>&1
echo "STARTUP_DONE $(date)" >> /var/log/darwin-perinst.log
`;
// short, GCP-name-safe tag for an (instance, genome) probe. A 6-char hash of the FULL pikey is appended so
// genomes that differ only in a truncated-away suffix (e.g. s15 vs s20) never collide into the same VM name.
// 6 base-36 chars derived from ALL 32 bits (low-order digits via modulo, so a one-char tail diff like
// s15→s20 changes the hash — NOT slice(0,6) of the high digits, which dropped the differing low bits).
function hash6(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return (h % 2176782336).toString(36).padStart(6, '0'); } // 36^6 = 2176782336
export function vmName(instanceId, g) {
  const h = hash6(pikey(instanceId, g));                       // 6-char collision-proof suffix, appended LAST
  const inst = instanceId.replace(/__/g, '-').replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 24);
  const gk = gkey(g).replace(/[|/.:>+]/g, '-').toLowerCase().slice(0, 22);
  // reserve room for `-<h>` so the hash is NEVER truncated away (two genomes differing only in a
  // truncated suffix — e.g. s15 vs s20 — get distinct hashes and so distinct names).
  const body = `${PERINST_PREFIX}${inst}-${gk}`.replace(/-+/g, '-').replace(/-+$/, '').slice(0, 62 - (h.length + 1)).replace(/-+$/, '');
  return `${body}-${h}`;
}
export function dispatchProbe(instanceId, g, { dry = false, runnerUrl = RUNNER_URL } = {}) {
  const name = vmName(instanceId, g);
  const meta = {
    orkey: key(), instance: instanceId, gkey: gkey(g), mode: g.mode,
    model: g.baseModel || '', escalate: g.escalateModel || '', xmodels: (g.xmodels || []).join(','),
    ksamp: String(g.__k || 2), maxsteps: String(g.maxSteps), temp: String(g.temp ?? 0),
    branch: process.env.BRANCH || 'claude/darwin-mode-evolve-polyglot',
  };
  if (dry) { console.log(`  [dry] ${name}  (${capabilityOf(g)} · ${fsModelString(g)} · k=${meta.ksamp} · steps=${g.maxSteps})`); return true; }
  // xmodels has commas (break --metadata) — pass via file like gcp-cluster.mjs.
  const tmp = `/tmp/startup-${name}.sh`; writeFileSync(tmp, STARTUP(runnerUrl));
  const metaPairs = Object.entries(meta).filter(([k, v]) => k !== 'xmodels' && v !== '').map(([k, v]) => `${k}=${v}`).join(',');
  let mff = `startup-script=${tmp}`;
  if (meta.xmodels) { const xf = `/tmp/xmodels-${name}.txt`; writeFileSync(xf, meta.xmodels); mff += `,xmodels=${xf}`; }
  try {
    execFileSync('gcloud', ['compute', 'instances', 'create', name, `--project=${PROJECT}`, `--zone=${ZONE}`,
      '--machine-type=e2-standard-4', '--image-family=ubuntu-2204-lts', '--image-project=ubuntu-os-cloud',
      '--boot-disk-size=200GB', '--boot-disk-type=pd-standard', '--no-address',
      `--metadata=${metaPairs}`, `--metadata-from-file=${mff}`, '--scopes=cloud-platform'], { stdio: 'pipe' });
    console.log(`  dispatched ${name}  (${capabilityOf(g)})`);
    return true;
  } catch (e) {
    const msg = (e.stderr?.toString() || e.message || '').split('\n').find((l) => /ERROR|Quota|exceeded|already exists/.test(l)) || 'create failed';
    console.error(`  dispatch FAILED ${name}: ${msg}`);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// THE PER-INSTANCE EVOLUTION LOOP (real fitness, cost- + quota- + runtime-bounded, parallel across instances)
// ════════════════════════════════════════════════════════════════════════════════════════════════════
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(opts) {
  const { gens, pop, k, maxConc, costCap, pollMin, maxPollTicks, maxRuntimeMin, instances, seed, dry } = opts;
  const t0 = Date.now();
  const startSpend = curSpendAbs() ?? 0;
  const rng = mkRng(seed);
  const targets = HARD_IDS.slice(0, instances);
  const logPath = presolve(OUT_DIR, 'evolve-perinstance-run.json');
  const allDispatched = new Set(); let provisioned = 0;
  const dedupe = (arr) => [...new Map(arr.map((g) => [gkey(g), g])).values()];

  console.log('=== PER-INSTANCE config-evolution (HARD-tail DIAGNOSIS) ===');
  console.log(`instances=${targets.length} gens<=${gens} pop=${pop} k=${k} maxConc=${maxConc} costCap=+$${costCap} (incremental) runtime<=${maxRuntimeMin}m`);
  console.log(`FIREWALL: per-instance results are DIAGNOSIS ONLY (overfit, not claimable). start-spend abs $${startSpend}`);
  console.log(`(quota=${VCPU_QUOTA}vCPU, used=${usedVCPU()}, free e2-standard-4 slots=${freeVMSlots()}; in-flight perinst=${inflightPerinst()})`);

  const tripped = () => {
    const mins = (Date.now() - t0) / 60000;
    if (mins > maxRuntimeMin) return `runtime ${mins.toFixed(0)}m > ${maxRuntimeMin}m`;
    const s = curSpendAbs();
    if (s != null && s - startSpend > costCap) return `incremental spend $${(s - startSpend).toFixed(2)} > cap $${costCap}`;
    return null;
  };

  // per-instance populations (each instance evolves independently)
  const popOf = {};
  for (const id of targets) {
    let P = dedupe(seedGenomes());
    while (P.length < pop) P.push(randomPIGenome(rng));
    popOf[id] = dedupe(P).slice(0, Math.max(pop, P.length));
  }

  for (let gen = 1; gen <= gens; gen++) {
    const stop = tripped(); if (stop) { console.log(`\nSTOP (breaker): ${stop}`); break; }
    let L = buildInstLookup(fetchInstRuns());
    console.log(`\n[gen ${gen}] ${Object.keys(L).length} (instance,genome) probes measured in Firestore`);

    // assemble the full unmeasured (instance × genome) work queue for this gen, cheapest-first.
    const queue = [];
    for (const id of targets) for (const g of popOf[id]) {
      if (fitnessOf(id, g, L) != null) continue;
      if (allDispatched.has(pikey(id, g))) continue;
      queue.push({ id, g: { ...g, __k: k } });
    }
    queue.sort((a, b) => costPrior(a.g) - costPrior(b.g));
    console.log(`  ${queue.length} unmeasured (instance,genome) probes to dispatch (cheapest-first)`);

    if (queue.length) {
      reap();
      while (queue.length) {
        const s2 = tripped(); if (s2) { console.log(`  STOP mid-dispatch (breaker): ${s2}`); queue.length = 0; break; }
        reap();
        const slots = Math.min(maxConc - inflightPerinst(), freeVMSlots());
        if (slots <= 0) { console.log(`  waiting on quota/concurrency (inflight perinst=${inflightPerinst()}, freeSlots=${freeVMSlots()})…`); await sleep(pollMin * 60000); continue; }
        for (let i = 0; i < slots && queue.length; i++) {
          const { id, g } = queue.shift();
          if (allDispatched.has(pikey(id, g))) continue;
          if (dispatchProbe(id, g, { dry })) { allDispatched.add(pikey(id, g)); provisioned++; }
        }
        await sleep(dry ? 50 : 20000);
      }
      // poll Firestore for results of this gen's dispatched probes
      if (!dry) {
        console.log(`  polling Firestore (<=${maxPollTicks}x${pollMin}m)…`);
        const want = [...allDispatched];
        for (let t = 0; t < maxPollTicks; t++) {
          const s3 = tripped(); if (s3) { console.log(`  STOP mid-poll (breaker): ${s3}`); break; }
          await sleep(pollMin * 60000);
          reap();
          L = buildInstLookup(fetchInstRuns());
          const done = want.filter((kk) => L[kk] != null).length;
          console.log(`    gen ${gen} poll ${t + 1}: ${done}/${want.length} probes self-reported  (spend Δ$${((curSpendAbs() ?? startSpend) - startSpend).toFixed(2)})`);
          if (done >= want.length) break;
        }
      }
    }

    // score + evolve each instance's population independently on REAL per-instance fitness
    L = buildInstLookup(fetchInstRuns());
    let crackedThisGen = 0;
    for (const id of targets) {
      const scored = popOf[id].map((g) => ({ g, fit: fitnessOf(id, g, L) })).filter((s) => s.fit != null).sort((a, b) => b.fit - a.fit);
      if (!scored.length) continue;
      if (scored[0].fit > 0) crackedThisGen++;
      if (gen < gens) {
        // elitism + variation, but only if this instance isn't already robustly cracked (save budget)
        const robust = scored[0].fit >= 0.5;
        if (robust) { popOf[id] = scored.slice(0, pop).map((s) => s.g); continue; } // freeze a solved instance
        const elite = scored.slice(0, Math.max(2, Math.floor(pop / 2))).map((s) => s.g);
        const next = [...elite]; let guard = 0;
        while (next.length < pop && guard++ < pop * 20) {
          const child = rng() < 0.5 ? mutatePI(rng, elite[Math.floor(rng() * elite.length)]) : crossoverPI(rng, elite[Math.floor(rng() * elite.length)], elite[Math.floor(rng() * elite.length)]);
          if (!next.some((x) => gkey(x) === gkey(child))) next.push(child);
        }
        popOf[id] = dedupe(next);
      }
    }
    const cov = buildCoverage(fetchInstRuns(), targets);
    console.log(`  gen ${gen}: ${cov.cracked}/${cov.total} instances cracked (>=1 sample), ${cov.robustCracked} robust; capabilities: ${JSON.stringify(cov.capabilityTally)}`);
    writeFileSync(logPath, JSON.stringify({ opts, startSpend, gen, coverage: cov, provisioned, dispatched: [...allDispatched], spendNow: curSpendAbs() }, null, 2));
  }

  // ── final report + guaranteed cleanup ──
  reap();
  const endSpend = curSpendAbs();
  const runs = (() => { try { return fetchInstRuns(); } catch { return []; } })();
  const coverage = buildCoverage(runs, targets);
  const report = {
    title: 'Per-instance config-evolution — SWE-bench HARD-tail capability DIAGNOSIS',
    firewall: 'DIAGNOSIS ONLY. Per-instance gold-tuned configs are OVERFIT (HV-1) and NOT claimable. ' +
              'Deliverables: coverage map + generalizable capability set; validate as ONE conformant harness on held-out n=300 with zero per-instance gold tuning.',
    finishedAt: new Date().toISOString(),
    runtimeMin: +((Date.now() - t0) / 60000).toFixed(1),
    spend: { startAbs: startSpend, endAbs: endSpend, incremental: endSpend == null ? null : +(endSpend - startSpend).toFixed(2), capUsd: costCap },
    provisioned, dispatchedProbes: allDispatched.size,
    coverage,
    capabilityRoadmap: {
      configToggleable: ['model', 'escalateModel(cascade)', 'maxSteps(turn-budget)', 'bonWidth(bo3)', 'crossModelBoN(xbo)', 'temperature'],
      needsNewHarnessCode: ['explicit localization pass', 'reproduction/repro-script generation', 'self-review/reviewer pass'],
      note: 'localization/reproduction/reviewer were NOT diagnosable here (not config-toggleable). If many instances stay uncracked under all toggleable capabilities, those are the next harness-code investments.',
    },
    heldOutValidationPlan: heldOutPlan(coverage),
  };
  writeFileSync(presolve(OUT_DIR, 'evolve-perinstance-report.json'), JSON.stringify(report, null, 2));
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`FINISHED. provisioned ${provisioned} perinst VMs, incremental spend $${endSpend == null ? '?' : (endSpend - startSpend).toFixed(2)} / cap $${costCap}.`);
  console.log(`COVERAGE: ${coverage.cracked}/${coverage.total} cracked (>=1 sample), ${coverage.robustCracked} robust, ${coverage.uncracked} uncracked.`);
  console.log(`Generalizable capability tally: ${JSON.stringify(coverage.capabilityTally)}`);
  console.log(`reports → evolve-perinstance-run.json / evolve-perinstance-report.json`);
  console.log(`Reap stragglers: gcloud compute instances list | grep ${PERINST_PREFIX}`);
  return report;
}

// held-out conformant validation plan derived from the diagnosed capability set.
export function heldOutPlan(coverage) {
  const caps = Object.keys(coverage.capabilityTally);
  const top = caps[0] || 'cross-model-best-of-N';
  return {
    step1_assembleOneHarness: `Build ONE conformant harness combining the generalizable capabilities (${caps.join(', ') || 'none yet'}), ` +
      'with config selected by a NON-gold router (e.g. difficulty-router.mjs on problem-statement features) — NEVER a gold test.',
    step2_runHeldOut: 'Run that single harness on the full n=300 Lite (and/or a held-out split disjoint from the 25 hard ids) with --no-test-oracle. ' +
      'No per-instance config is allowed; the router picks config from problem features only.',
    step3_compare: `Compare held-out resolve% to the current conformant baseline (3-tier 55.3% headline arc). ` +
      'A gain there is CLAIMABLE (it generalizes); the per-instance diagnosis numbers are NOT.',
    estCost: 'n=300 at the dominant capability (~' + top + '): single-pass ~$0.02-0.5/inst depending on model → ~$6-150 for a cheap-led router; ' +
      'a frontier-heavy xbo/bo3 router ~$150-300. Budget one full-300 confirm at ~$80-150 for a cheap→frontier-escalation router.',
    conformanceCheck: 'Assert usedOracleDuringSolve===false (solve-agentic leakage guard) on every instance; router input must contain NO gold-test signal.',
  };
}

// ── CLI ──
if (process.argv[1] && process.argv[1].endsWith('evolve-perinstance.mjs')) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'run';
  const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  if (cmd === 'lookup') {
    const L = buildInstLookup(fetchInstRuns());
    console.log('darwin_inst_runs per-instance fitness (resolved_k/k) — DIAGNOSIS:');
    for (const [kk, v] of Object.entries(L).sort()) console.log(`  ${v.resolved_k}/${v.ksamp} (${(v.fit * 100).toFixed(0)}%)  ${kk}  [${v.capability}]`);
  } else if (cmd === 'coverage') {
    const cov = buildCoverage(fetchInstRuns());
    console.log(JSON.stringify(cov, null, 2));
  } else if (cmd === 'seed') {
    console.log('Per-instance seed capability genomes (the GENERAL levers diagnosed for each instance):');
    for (const g of seedGenomes()) console.log(`  ~$${costPrior(g).toFixed(3)}/inst  ${gkey(g).padEnd(40)} → ${capabilityOf(g)}`);
  } else if (cmd === 'run') {
    await run({
      gens: +argv('--gens', 2), pop: +argv('--pop', 6), k: +argv('--k', 2), maxConc: +argv('--max-conc', 4),
      costCap: +argv('--cost-cap', 300), pollMin: +argv('--poll-min', 8), maxPollTicks: +argv('--max-poll-ticks', 30),
      maxRuntimeMin: +argv('--max-runtime-min', 720), instances: +argv('--instances', 25), seed: +argv('--seed', 1),
      dry: args.includes('--dry'),
    });
  } else {
    console.log('usage: evolve-perinstance.mjs <run|lookup|coverage|seed> [--gens N --pop K --k S --max-conc C --cost-cap USD --instances N --dry]');
  }
}
