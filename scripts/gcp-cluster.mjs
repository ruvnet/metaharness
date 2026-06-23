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

const PROJECT = process.env.PROJECT || 'cognitum-20260110';
const ZONE = process.env.ZONE || 'us-central1-a';
const MACHINE = process.env.MACHINE || 'e2-standard-8';
const VCPU = 8;                 // per VM
const CPU_QUOTA = 32, SSD_QUOTA = 500; // us-central1 limits (pd-standard avoids SSD quota)
const RUNNER_URL = 'https://raw.githubusercontent.com/ruvnet/agent-harness-generator/main/scripts/gcp-swebench-runner.sh';
const PREFIX = 'darwin-';

const BOARDS = { lite: 'SWE-bench Lite', verified: 'SWE-bench Verified', multilingual: 'SWE-bench Multilingual' };
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
M(){ curl -s -H 'Metadata-Flavor: Google' "http://metadata/computeMetadata/v1/instance/attributes/$1"; }
export ORKEY=$(M orkey) BENCH=$(M bench) MODE=$(M mode) MODEL=$(M model) CONCURRENCY=4
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null 2>&1; apt-get install -y python3-venv python3-pip git >/dev/null 2>&1
mkdir -p /opt
curl -fsSL ${RUNNER_URL} -o /opt/runner.sh
bash /opt/runner.sh > /var/log/darwin-runner.log 2>&1
echo "STARTUP_DONE $(date)" >> /var/log/darwin-runner.log
`;

function listVMs() {
  try {
    const out = gq(['compute', 'instances', 'list', `--project=${PROJECT}`, '--format=value(name,status)']);
    return out.trim().split('\n').filter(l => l.startsWith(PREFIX)).map(l => { const [name, status] = l.split('\t'); return { name, status }; });
  } catch { return []; }
}
function usedVCPU() { return listVMs().filter(v => v.status === 'RUNNING' || v.status === 'STAGING').length * VCPU; }

function provision(board, model, tag) {
  if (!BOARDS[board]) throw new Error(`unknown board ${board} (have: ${Object.keys(BOARDS).join(',')})`);
  if (usedVCPU() + VCPU > CPU_QUOTA) { console.error(`SKIP ${tag}: would exceed CPU quota (${usedVCPU()}/${CPU_QUOTA})`); return; }
  const name = `${PREFIX}${board}-${tag}`;
  const tmp = `/tmp/startup-${name}.sh`; writeFileSync(tmp, STARTUP);
  console.error(`provisioning ${name}  (${model} · ${BOARDS[board]})`);
  gq(['compute', 'instances', 'create', name, `--project=${PROJECT}`, `--zone=${ZONE}`,
    `--machine-type=${MACHINE}`, '--image-family=ubuntu-2204-lts', '--image-project=ubuntu-os-cloud',
    '--boot-disk-size=200GB', '--boot-disk-type=pd-standard',  // pd-standard: dodges the 500GB SSD quota
    `--metadata=orkey=${key()},bench=${board},mode=single,model=${model}`,
    `--metadata-from-file=startup-script=${tmp}`, '--scopes=cloud-platform']);
  console.log(`✓ ${name} provisioning (self-runs on boot)`);
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

function collect(name) {
  const dir = `./fleet-out/${name}`; mkdirSync(dir, { recursive: true });
  console.error(`scp ${name}:/opt/darwin/out → ${dir}`);
  try { gq(['compute', 'scp', '--recurse', `${name}:/opt/darwin/out`, dir, `--project=${PROJECT}`, `--zone=${ZONE}`]); }
  catch (e) { console.error('scp failed (run still in progress?):', e.message.split('\n')[0]); return; }
  // find the gold-eval report + push a record to Firestore
  let report;
  try { report = sh(`ls ${dir}/out/*darwin-*.json 2>/dev/null | head -1`).trim(); } catch {}
  if (report && existsSync(report)) {
    const r = JSON.parse(readFileSync(report, 'utf8'));
    const resolved = (r.resolved_ids || []).length, total = (r.submitted_ids || r.completed_ids || []).length || '?';
    console.log(`✓ ${name}: ${resolved} resolved (report ${report}). Push to Firestore via firestore-upload.mjs.`);
  } else console.log(`collected to ${dir} (no gold report yet)`);
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'up') provision(a, b, c || b.split('/').pop().replace(/[.:]/g, '-'));
else if (cmd === 'matrix') { for (const [board, model, tag] of MATRIX) try { provision(board, model, tag); } catch (e) { console.error(e.message); } }
else if (cmd === 'status') status();
else if (cmd === 'logs') console.log(serial(a).split('\n').slice(-30).join('\n'));
else if (cmd === 'collect') collect(a);
else if (cmd === 'down') {
  const names = a === 'all' ? listVMs().map(v => v.name) : [a];
  if (names.length) { gq(['compute', 'instances', 'delete', ...names, `--project=${PROJECT}`, `--zone=${ZONE}`, '--quiet']); console.log(`deleted: ${names.join(', ')}`); }
} else {
  console.log('usage: gcp-cluster.mjs <up board model [tag]|matrix|status|logs <vm>|collect <vm>|down <vm|all>>');
}
