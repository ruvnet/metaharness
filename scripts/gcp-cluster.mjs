#!/usr/bin/env node
// gcp-cluster.mjs — a metaharness to manage the Darwin SWE-benchmarking GCP fleet.
//
// Encodes the hard-won lessons (ADR-180/181): VMs SELF-RUN via a startup-script (no fragile SSH-launch),
// python3-venv installed explicitly, pd-standard to dodge the SSD quota, CPU-quota-aware provisioning,
// serial-console monitoring (read-only, never wedges), and auto-collect → Firestore + local.
//
// Usage:
//   node gcp-cluster.mjs up <board> <model> [name]     provision one self-running VM
//   node gcp-cluster.mjs matrix                          provision the default model×board matrix (quota-aware)
//   node gcp-cluster.mjs status                          phase + preds + resolve for every darwin-* VM (serial log)
//   node gcp-cluster.mjs logs <name>                     tail a VM's runner log (serial)
//   node gcp-cluster.mjs collect <name>                  scp results → ./fleet-out/<name> + push to Firestore
//   node gcp-cluster.mjs down <name|all>                 delete VM(s) to stop billing
//
// Env: PROJECT (default cognitum-20260110), ZONE (us-central1-a). OpenRouter key from /tmp/.orkey.
import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { evolve as evolveArch, fetchFirestoreLookup, mockResolve, mkey, gkey, llmPropose } from '../packages/darwin-mode/bench/swebench/evolve-arch.mjs';

const PROJECT = process.env.PROJECT || 'cognitum-20260110';
const ZONE = process.env.ZONE || 'us-central1-a';
const MACHINE = process.env.MACHINE || 'e2-standard-8';
const VCPU = 8;                 // per VM
const CPU_QUOTA = 32, SSD_QUOTA = 500; // us-central1 limits (pd-standard avoids SSD quota)
const RUNNER_URL = 'https://raw.githubusercontent.com/ruvnet/agent-harness-generator/main/scripts/gcp-swebench-runner.sh';
const PREFIX = 'darwin-';

const BOARDS = { lite: 'SWE-bench Lite', verified: 'SWE-bench Verified', multilingual: 'SWE-bench Multilingual', pro: 'SWE-bench Pro', 'terminal-bench': 'Terminal-Bench Core' };
// NOTE: the `terminal-bench` board is driven by the dedicated tbench-gcp.mjs dispatcher +
// scripts/gcp-tbench-runner.sh (the VM installs the official `tb` harness + our agent, runs
// hardest-first, self-reports to Firestore darwin_tbench_runs, autostops). It is listed here so
// `BOARDS['terminal-bench']` resolves for shared status/down tooling; provisioning goes through
// tbench-gcp.mjs because the runner contract (tb, not swebench) differs.
// default matrix: cheap models × boards (model slug : short tag)
const MATRIX = [
  ['lite', 'z-ai/glm-5.2', 'glm'],
  ['lite', 'moonshotai/kimi-k2.6', 'kimi'],
  ['verified', 'deepseek/deepseek-v4-flash', 'ds'],
];

const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const gq = (args) => execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const key = () => readFileSync('/tmp/.orkey', 'utf8').trim();

// self-running startup script: install deps, fetch the fixed runner from main, solve+eval, leave results.
const STARTUP = `#!/bin/bash
M(){ curl -sf -H 'Metadata-Flavor: Google' "http://metadata/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true; } # -f: missing attr → empty, NOT the 404 HTML (which broke SAMPLE on non-sample runs)
export ORKEY=$(M orkey) BENCH=$(M bench) MODE=$(M mode) MODEL=$(M model) ESCALATE=$(M escalate) SAMPLE=$(M sample) XMODELS=$(M xmodels) MAXCOST=$(M maxcost) ESCCOST=$(M esccost) MAXSTEPS=$(M maxsteps) HARD=$(M hard) TRACE=$(M trace) CONCURRENCY=4
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null 2>&1; apt-get install -y python3-venv python3-pip git >/dev/null 2>&1
mkdir -p /opt
curl -fsSL ${RUNNER_URL} -o /opt/runner.sh
bash /opt/runner.sh > /var/log/darwin-runner.log 2>&1
echo "STARTUP_DONE $(date)" >> /var/log/darwin-runner.log
`;

function listVMs() {
  try {
    const out = gq(['compute', 'instances', 'list', `--project=${PROJECT}`, '--format=value(name,status,machineType.basename())']);
    return out.trim().split('\n').filter(l => l.startsWith(PREFIX)).map(l => { const [name, status, mtype = ''] = l.split('\t'); const vcpu = +(mtype.match(/-(\d+)$/)?.[1]) || (/small|micro/.test(mtype) ? 2 : VCPU); return { name, status, mtype, vcpu }; });
  } catch { return []; }
}
function usedVCPU() { return listVMs().filter(v => v.status === 'RUNNING' || v.status === 'STAGING').reduce((s, v) => s + v.vcpu, 0); }
function vmExists(name) { return listVMs().some(v => v.name === name); }

function provision(o) {
  const { board, model, tag, mode = 'single', sample = '', escalate = '', xmodels = '', machine = MACHINE } = o;
  if (!BOARDS[board]) throw new Error(`unknown board ${board} (have: ${Object.keys(BOARDS).join(',')})`);
  const vcpu = +(machine.match(/-(\d+)$/)?.[1]) || VCPU;
  if (usedVCPU() + vcpu > CPU_QUOTA) { console.error(`SKIP ${tag}: would exceed CPU quota (${usedVCPU()}+${vcpu}/${CPU_QUOTA}) — down some VMs first`); return false; }
  const name = `${PREFIX}${board}-${tag}`.replace(/-+$/, '').slice(0, 62).replace(/-+$/, ''); // GCP names must end alphanumeric
  if (vmExists(name)) { console.error(`SKIP ${tag}: ${name} already exists`); return false; }
  const tmp = `/tmp/startup-${name}.sh`; writeFileSync(tmp, STARTUP);
  const maxcost = process.env.MAXCOST || '', esccost = process.env.ESCCOST || '', maxsteps = process.env.MAXSTEPS || '', hard = process.env.HARD || '', trace = process.env.TRACE || ''; // §36: avoid silent $20 base truncation on big/full runs; HARD=1 → runner filters to hard-<board>-ids.json; TRACE=1 → ADR-196 trace-localize on the escalation tier (§56)
  const meta = `orkey=${key()},bench=${board},mode=${mode},model=${model}` + (escalate ? `,escalate=${escalate}` : '') + (sample ? `,sample=${sample}` : '') + (maxcost ? `,maxcost=${maxcost}` : '') + (esccost ? `,esccost=${esccost}` : '') + (maxsteps ? `,maxsteps=${maxsteps}` : '') + (hard ? `,hard=${hard}` : '') + (trace ? `,trace=${trace}` : '');
  let mff = `startup-script=${tmp}`;
  if (xmodels) { const xf = `/tmp/xmodels-${name}.txt`; writeFileSync(xf, xmodels); mff += `,xmodels=${xf}`; } // commas break --metadata; use a file
  console.error(`provisioning ${name}  (${model}${xmodels ? `=[${xmodels}]` : ''} · ${mode}${sample ? ` · n=${sample}` : ''} · ${BOARDS[board]})`);
  try {
    gq(['compute', 'instances', 'create', name, `--project=${PROJECT}`, `--zone=${ZONE}`,
      `--machine-type=${machine}`, '--image-family=ubuntu-2204-lts', '--image-project=ubuntu-os-cloud',
      '--boot-disk-size=300GB', '--boot-disk-type=pd-standard', '--no-address', // no external IP (egress via Cloud NAT) — dodges IN_USE_ADDRESSES quota (8)
      `--metadata=${meta}`, `--metadata-from-file=${mff}`, '--scopes=cloud-platform']);
  } catch (e) { console.error(`SKIP ${tag}: create failed — ${(e.message || '').split('\n').find((l) => /ERROR|Quota|exceeded/.test(l)) || 'error'}`); return false; }
  console.log(`✓ ${name} provisioning (self-runs on boot)`); return true;
}
// Early-proving matrix: cheap architecture variants raced on a small sample to find the optimum fast.
const PROVE = [
  { board: 'lite', model: 'deepseek/deepseek-v4-flash', mode: 'single', tag: 'p-ds' },
  { board: 'lite', model: 'z-ai/glm-5.2', mode: 'single', tag: 'p-glm' },
  { board: 'lite', model: 'moonshotai/kimi-k2.6', mode: 'single', tag: 'p-kimi' },
  { board: 'lite', model: 'deepseek/deepseek-v4-flash', mode: 'bo3', tag: 'p-bo3' },
  { board: 'lite', model: 'deepseek/deepseek-v4-flash', mode: 'cascade', escalate: 'z-ai/glm-5.2', tag: 'p-casc' },
];
function prove(sample) {
  const n = sample || '25';
  console.log(`Early-proving ${PROVE.length} variants on n=${n} (e2-standard-4, quota-aware):`);
  for (const v of PROVE) provision({ ...v, sample: n, machine: 'e2-standard-4' });
}
function rank() {
  let docs = []; try { docs = JSON.parse(gq(['firestore', 'databases', 'documents', 'list', `--project=${PROJECT}`]) || '[]'); } catch { /* use REST */ }
  try {
    const out = sh(`curl -s -H "Authorization: Bearer ${fsToken()}" "https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/darwin_runs?pageSize=100"`);
    const d = JSON.parse(out).documents || [];
    const rows = d.map((x) => { const f = x.fields; const g = (k) => f[k]?.stringValue ?? f[k]?.doubleValue ?? (f[k]?.integerValue && +f[k].integerValue); return { model: g('model'), mode: g('mode'), bench: g('benchmark'), pct: g('resolve_pct'), n: g('total'), src: g('source') }; });
    rows.sort((a, b) => (b.pct || 0) - (a.pct || 0));
    console.log('darwin_runs (by resolve %):');
    for (const r of rows) console.log(`  ${String(r.pct).padStart(5)}%  ${r.bench}/${r.mode}  ${r.model}  (n=${r.n}, ${r.src})`);
  } catch (e) { console.error('rank failed:', e.message.split('\n')[0]); }
}

function cleanupDone() {
  for (const v of listVMs()) {
    if (v.name === `${PREFIX}controller`) continue;
    if (v.status === 'TERMINATED' || v.status === 'STOPPED') { try { gq(['compute', 'instances', 'delete', v.name, `--project=${PROJECT}`, `--zone=${ZONE}`, '--quiet']); console.log(`  cleaned ${v.name}`); } catch { /**/ } }
  }
}
// CLOSED multi-generation loop: each gen evolves on REAL Firestore data, dispatches the unmeasured genomes it
// proposes as prove-N jobs, waits for their self-reports, then evolves the next generation. The 2-phase gate
// + full-300 confirmation (separate) guard against n=25 noise. This is "Sovereign Evolution" running for real.
function curSpend() { try { const j = JSON.parse(sh(`curl -sS -m8 https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer ${key()}"`)); return +(j.data.usage - 1052.01).toFixed(2); } catch { return null; } }
async function autotune({ gens = 4, w = 0.7, sample = '25', maxVms = 20, spendCapUsd = 200, maxRuntimeMin = 360, maxGenVms = 8 }) {
  // ── RUNAWAY GUARDS ──: gen cap, total-VM cap, per-gen-VM cap, OpenRouter spend cap, wall-clock cap, guaranteed cleanup.
  const t0 = Date.now(); let provisioned = 0;
  const startSpend = curSpend() ?? 0;
  console.log(`autotune: gens≤${gens} maxVms≤${maxVms} spendCap=$${spendCapUsd} runtime≤${maxRuntimeMin}m (start spend $${startSpend})`);
  const tripped = () => {
    const mins = (Date.now() - t0) / 60000; if (mins > maxRuntimeMin) return `runtime ${mins.toFixed(0)}m`;
    if (provisioned >= maxVms) return `maxVms ${provisioned}`;
    const s = curSpend(); if (s != null && s > spendCapUsd) return `spend $${s} > $${spendCapUsd}`;
    return null;
  };
  try {
    for (let gen = 1; gen <= gens; gen++) {
      const stop = tripped(); if (stop) { console.log(`STOP (guard): ${stop}`); break; }
      const lookup = fetchFirestoreLookup(PROJECT);
      const unmeasured = new Map();
      const resolveFn = (g) => { const v = lookup[mkey(g)]; if (v == null) { unmeasured.set(mkey(g), g); return mockResolve(g); } return v; };
      const { champion } = evolveArch({ w, gens: 6, pop: 12, seed: gen, resolveFn });
      let llmGenomes = []; try { llmGenomes = await llmPropose(lookup, { w, n: 4, key: readFileSync('/tmp/.orkey', 'utf8').trim() }); } catch { /**/ }
      for (const g of llmGenomes) if (!unmeasured.has(mkey(g))) unmeasured.set(mkey(g), g);
      console.log(`\n[gen ${gen}] measured=${Object.keys(lookup).length} · champion=${gkey(champion.g)} V=${champion.mean.toFixed(1)} · proposing ${unmeasured.size} (LLM ${llmGenomes.length}) · provisioned-so-far ${provisioned}/${maxVms}`);
      if (unmeasured.size === 0) { console.log('converged — all proposals already measured.'); break; }
      cleanupDone();
      const dispatched = []; let genCount = 0;
      for (const [k, g] of unmeasured) {
        if (provisioned >= maxVms) { console.log(`maxVms cap (${maxVms}) — not dispatching more`); break; }
        if (genCount >= maxGenVms) break;                    // per-gen cap (also respects 32-vCPU quota in provision)
        const isX = g.mode === 'xbo';
        if (provision({ board: 'lite', model: isX ? 'xbo' : g.model, mode: g.mode, escalate: g.escalate, xmodels: isX ? g.model : '', sample, machine: 'e2-standard-4', tag: `g${gen}-${k.replace(/[|/.: +]/g, '-')}`.slice(0, 40) })) { dispatched.push(k); provisioned++; genCount++; }
      }
      console.log(`dispatched ${dispatched.length} prove-${sample} jobs (total provisioned ${provisioned}/${maxVms}); polling…`);
      for (let t = 0; t < 24 && dispatched.length; t++) { // ≤2h/gen
        const s2 = tripped(); if (s2) { console.log(`STOP mid-poll (guard): ${s2}`); break; }
        await new Promise((r) => setTimeout(r, 300000));
        cleanupDone();
        const done = dispatched.filter((k) => fetchFirestoreLookup(PROJECT)[k] != null).length;
        console.log(`  gen ${gen}: ${done}/${dispatched.length} self-reported`);
        if (done >= dispatched.length) break;
      }
    }
  } finally {
    cleanupDone();  // never leave halted VMs billing, even on abort/error
    console.log(`\nautotune finished. provisioned ${provisioned} VMs, spend $${curSpend()} (Δ$${((curSpend() ?? 0) - startSpend).toFixed(2)}). \`rank\` for the frontier; confirm champion at full-300 (phase-2). Run \`down all\` if any VM lingers.`);
  }
}

function serial(name) { try { return gq(['compute', 'instances', 'get-serial-port-output', name, `--project=${PROJECT}`, `--zone=${ZONE}`]); } catch { return ''; } }
function phaseOf(log) {
  if (/STARTUP_DONE|=== DONE/.test(log)) return 'DONE';
  const m = [...log.matchAll(/\[(\d)\/5\]|GOLD EVAL|SOLVE/g)]; return m.length ? m[m.length - 1][0] : 'boot';
}

function status() {
  const vms = listVMs();
  if (!vms.length) { console.log('no darwin-* VMs.'); return; }
  console.log(`Fleet (${vms.length} VMs, ${usedVCPU()}/${CPU_QUOTA} vCPU):`);
  for (const v of vms) {
    const log = v.status === 'RUNNING' ? serial(v.name) : '';
    const preds = (log.match(/(\d+)\/\d+ \[/g) || []).pop() || '';
    console.log(`  ${v.name}  [${v.status}]  phase=${log ? phaseOf(log) : '-'}  ${preds}`);
  }
}

function fsToken() { return gq(['auth', 'print-access-token']).trim(); }
function pushFirestore(rec) {
  const tv = (v) => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v }
    : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : { stringValue: String(v) };
  const fields = Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, tv(v)]));
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/darwin_runs`;
  try { sh(`curl -s -X POST '${url}' -H 'Authorization: Bearer ${fsToken()}' -H 'Content-Type: application/json' -d '${JSON.stringify({ fields }).replace(/'/g, "'\\''")}'`); return true; } catch { return false; }
}
const DENOM = { lite: 300, verified: 500, multilingual: 300, pro: 25 }; // pro = the committed pro-25 cascade manifest
function collect(name) {
  const dir = `./fleet-out/${name}`; mkdirSync(dir, { recursive: true });
  try { gq(['compute', 'scp', '--recurse', `${name}:/opt/darwin/out`, dir, `--project=${PROJECT}`, `--zone=${ZONE}`]); }
  catch (e) { console.error(`scp ${name} failed (run in progress?):`, e.message.split('\n')[0]); return false; }
  let report; try { report = sh(`ls ${dir}/out/*darwin-*.json 2>/dev/null | head -1`).trim(); } catch {}
  if (report && existsSync(report)) {
    const r = JSON.parse(readFileSync(report, 'utf8'));
    const board = name.split('-')[1], model = name.split('-').slice(2).join('-');
    const resolved = (r.resolved_ids || []).length, total = DENOM[board] || 300;
    const ok = pushFirestore({ benchmark: BOARDS[board] || board, model, mode: 'single', resolved, total,
      resolve_pct: +(resolved / total * 100).toFixed(1), conformant: true, ts: new Date().toISOString().slice(0, 10), source: `gcp:${name}` });
    console.log(`✓ ${name}: ${resolved}/${total} = ${(resolved / total * 100).toFixed(1)}% → Firestore ${ok ? 'OK' : 'FAIL'}`);
    return true;
  }
  console.log(`${name}: collected to ${dir} (no gold report yet)`); return false;
}

async function supervise() {
  const collected = new Set();
  for (let tick = 0; ; tick++) {
    console.log(`\n[supervise tick ${tick} ${new Date().toISOString()}]`);
    status();
    // collect-then-DELETE any done worker (cost-saver). Firestore self-report is the source of truth, so
    // delete even if scp fails / the VM already AUTOSTOP-halted. Never the controller.
    for (const v of listVMs()) {
      if (v.name === `${PREFIX}controller` || collected.has(v.name)) continue;
      const log = v.status === 'RUNNING' ? serial(v.name) : '';
      const done = v.status === 'TERMINATED' || v.status === 'STOPPED' || /STARTUP_DONE|=== DONE/.test(log);
      if (done) {
        try { collect(v.name); } catch { /**/ }            // best-effort local copy
        console.log(`cleanup: deleting done ${v.name} (results in Firestore)`);
        try { gq(['compute', 'instances', 'delete', v.name, `--project=${PROJECT}`, `--zone=${ZONE}`, '--quiet']); } catch { /**/ }
        collected.add(v.name);
      }
    }
    await new Promise(r => setTimeout(r, 300000)); // 5 min
  }
}

const [cmd, a, b, c, d] = process.argv.slice(2);
if (cmd === 'up') provision({ board: a, model: b, tag: c || b.split('/').pop().replace(/[.:]/g, '-') });
else if (cmd === 'matrix') { for (const [board, model, tag] of MATRIX) try { provision({ board, model, tag }); } catch (e) { console.error(e.message); } }
else if (cmd === 'prove') prove(a);
else if (cmd === 'proveone') provision({ board: 'lite', model: a, mode: b || 'single', sample: c || '25', machine: 'e2-standard-4', tag: 'x-' + a.split('/').pop().replace(/[.:]/g, '-') + '-' + (b || 'single') });
else if (cmd === 'provexbo') provision({ board: 'lite', model: 'xbo', mode: 'xbo', xmodels: a, sample: b || '25', machine: 'e2-standard-4', tag: 'xbo-' + a.split(',').map((m) => m.split('/').pop().slice(0, 6)).join('-').replace(/[.:]/g, '-').slice(0, 34) });
else if (cmd === 'ecascade') provision({ board: d || 'lite', model: a, mode: 'ecascade', escalate: b, sample: c || '', machine: MACHINE, tag: ((d ? d.slice(0, 4) + '-' : '') + 'ec-' + a.split('/').pop().slice(0, 8) + '-' + b.split('/').pop().slice(0, 8)).replace(/[.:]/g, '-') }); // empty-patch cascade: a=cheap, b=escalate(opus), d=board(default lite)
else if (cmd === 'xcascade') provision({ board: 'lite', model: 'xcascade', mode: 'xcascade', xmodels: a, escalate: b, sample: c || '25', machine: MACHINE, tag: ('xc-' + a.split(',').map((m) => m.split('/').pop().slice(0, 5)).join('-') + '-' + b.split('/').pop().slice(0, 6)).replace(/[.:]/g, '-').slice(0, 50) }); // FUGU: a=xbo csv base, b=escalate(opus)
else if (cmd === 'evolve') {  // auto-tune: evolve on REAL Firestore data → dispatch unmeasured genomes as prove jobs
  const w = +(a || 0.7);
  const lookup = fetchFirestoreLookup(PROJECT);
  console.log(`evolve: ${Object.keys(lookup).length} measured combos seed the population:`, lookup);
  const unmeasured = new Map();
  const resolveFn = (g) => { const v = lookup[mkey(g)]; if (v == null) { unmeasured.set(mkey(g), g); return mockResolve(g); } return v; };
  const { champion } = evolveArch({ w, gens: 6, pop: 12, seed: 1, resolveFn });
  console.log(`champion (w=${w}): ${gkey(champion.g)}  Value=${champion.mean.toFixed(1)} ±${champion.ci95.toFixed(1)}`);
  console.log(`dispatching ${unmeasured.size} unmeasured genomes as prove-25 jobs (quota-aware):`);
  for (const [k, g] of unmeasured) provision({ board: 'lite', model: g.model, mode: g.mode, escalate: g.escalate, sample: '25', machine: 'e2-standard-4', tag: 'ev-' + k.replace(/[|/.: ]/g, '-') });
}
else if (cmd === 'autotune') await autotune({ gens: +(a || 4), w: +(b || 0.7) });
else if (cmd === 'rank') rank();
else if (cmd === 'status') status();
else if (cmd === 'logs') console.log(serial(a).split('\n').slice(-30).join('\n'));
else if (cmd === 'collect') collect(a);
else if (cmd === 'supervise') await supervise();
else if (cmd === 'down') {
  const names = a === 'all' ? listVMs().map(v => v.name) : [a];
  if (names.length) { gq(['compute', 'instances', 'delete', ...names, `--project=${PROJECT}`, `--zone=${ZONE}`, '--quiet']); console.log(`deleted: ${names.join(', ')}`); }
} else {
  console.log('usage: gcp-cluster.mjs <up board model [tag]|matrix|prove [n]|rank|matrix|status|logs <vm>|collect <vm>|down <vm|all>>');
}
