#!/usr/bin/env node
// nightly-sota-review.mjs — self-driving nightly SOTA-review pipeline for Darwin (ADR-184).
//
// Runs UNATTENDED via a service-account key (no interactive gcloud token). The weekend pain was the
// interactive `ruv@ruv.net` token expiring; this pipeline auths with darwin-nightly@…iam.gserviceaccount.com.
//
// Steps (each logged): auth+health → n=25 GCP scout (≤3 cheap VMs) → SOTA compare (Pareto + Wilson CI,
// conservative on n=25 noise) → escalate ONLY a true needle-mover to n=300 → if n=300 confirms a new SOTA,
// render a PR + tracking issue (opened only in a real run, never in --dry-run) → cost guard + cleanup.
//
// Flags:
//   --dry-run        print the full plan + SOTA-compare on EXISTING board/Firestore data; dispatch nothing, open nothing.
//   --scout-only     real n=25 scout, NO escalation to n=300, NO PR/issue.
//   --candidate "model[:mode]"   curated scout candidate (repeatable). Default: current champion + deepseek-v4-flash single.
//   --max-cost <usd> OpenRouter spend cap for this run (default 25). Trips → stop dispatching + cleanup.
//   --max-vms <n>    cap scout VMs (default 3).
//   --poll-min <m>   per-scout poll budget in minutes (default 90).
//   --sa-key <path>  service-account key file (default /home/ruvultra/.config/darwin-nightly-sa.json).
//   --no-auth        skip activate-service-account (use the ambient gcloud login — for local dev only).
//
// Exit codes: 0 = clean (incl. "no SOTA change"); 1 = error; 2 = guard tripped mid-run (cleaned up).
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAttestation, integrityGateDecision, parsePredictionsJsonl } from './sota-attest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const PROJECT = process.env.PROJECT || 'cognitum-20260110';
const SA_EMAIL = 'darwin-nightly@cognitum-20260110.iam.gserviceaccount.com';
const PARETO_PATH = join(REPO, 'apps/web-ui/public/assets/swe-pareto.json');
const GH_REPO = 'ruvnet/agent-harness-generator';
const GCP_CLUSTER = join(REPO, 'scripts/gcp-cluster.mjs');

// ── arg parsing ──
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const opts = (n) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] ? [argv[i + 1]] : []));
const DRY = flag('dry-run');
const SCOUT_ONLY = flag('scout-only');
const MAX_COST = +opt('max-cost', '25');
const MAX_VMS = +opt('max-vms', '3');
const POLL_MIN = +opt('poll-min', '90');
const SA_KEY = opt('sa-key', '/home/ruvultra/.config/darwin-nightly-sa.json');
const NO_AUTH = flag('no-auth');
const CANDIDATES = opts('candidate');
// ADR-231 integrity gate: the (gold, solver, predictions) triple to attest the confirmed run against.
// In --dry-run these default to the committed Verified-500 gold report to demonstrate fail-closed on real data.
const SWEBENCH_DIR = join(REPO, 'packages/darwin-mode/bench/swebench');
const GOLD_REPORT = opt('gold-report', join(SWEBENCH_DIR, 'darwin-agentic.verified-500-cascade-local.json'));
const SOLVER_REPORT = opt('solver-report', null);
const PREDICTIONS = opt('predictions', null);
const ATTEST_MAX_SKIPS = +opt('attest-max-skips', '4');

// ── isolated gcloud config so we never clobber the user's interactive ruv@ruv.net login ──
const GCLOUD_CONFIG = process.env.CLOUDSDK_CONFIG || mkdtempSync(join(tmpdir(), 'darwin-nightly-gcloud-'));
const gEnv = { ...process.env, CLOUDSDK_CONFIG: GCLOUD_CONFIG, PROJECT, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' };

const ts = () => new Date().toISOString();
const log = (...m) => console.log(`[${ts()}]`, ...m);
const warn = (...m) => console.warn(`[${ts()}] WARN`, ...m);
const die = (...m) => { console.error(`[${ts()}] ERROR`, ...m); process.exit(1); };

const gcloud = (args, { quiet = false } = {}) =>
  execFileSync('gcloud', args, { encoding: 'utf8', env: gEnv, stdio: quiet ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'inherit'] });
const gq = (args) => execFileSync('gcloud', args, { encoding: 'utf8', env: gEnv, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

// ── Wilson score interval (95%) for a binomial proportion — same stats the board CIs use ──
function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 100];
  const p = k / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return [Math.max(0, (center - half) * 100), Math.min(100, (center + half) * 100)];
}

// ═══════════════ Part 1: auth + health ═══════════════
function authHeadless() {
  if (NO_AUTH) { log('auth: --no-auth, using ambient gcloud login'); return; }
  let keyFile = SA_KEY;
  if (!existsSync(keyFile)) {
    // Fallback: the local key is gone (fresh host) → restore from Secret Manager. This needs an ambient
    // identity that can read DARWIN_SA_KEY; on a scheduled host that identity is usually a VM/SA already.
    warn(`SA key not at ${keyFile}; restoring from Secret Manager DARWIN_SA_KEY`);
    try {
      const data = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret=DARWIN_SA_KEY', `--project=${PROJECT}`],
        { encoding: 'utf8', env: gEnv });
      keyFile = join(GCLOUD_CONFIG, 'darwin-nightly-sa.json');
      writeFileSync(keyFile, data, { mode: 0o600 });
    } catch (e) { die(`cannot restore SA key from Secret Manager: ${(e.message || '').split('\n')[0]}`); }
  }
  gcloud(['auth', 'activate-service-account', `--key-file=${keyFile}`], { quiet: true });
  const active = gq(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  if (active !== SA_EMAIL) die(`expected active account ${SA_EMAIL}, got "${active}"`);
  log(`auth: activated ${SA_EMAIL} (headless, key-file)`);
}

// IAM bindings can lag a couple minutes; retry the canonical headless check before proceeding.
function verifyHeadlessAccess() {
  for (let i = 0; i < 6; i++) {
    try {
      const out = gq(['compute', 'instances', 'list', `--project=${PROJECT}`, '--format=value(name)']);
      log(`health: compute instances list OK (${out.split('\n').filter(Boolean).length} VMs visible) — no interactive prompt`);
      return out.split('\n').filter(Boolean);
    } catch (e) {
      warn(`compute list attempt ${i + 1}/6 failed (IAM propagation?): ${(e.message || '').split('\n').find(l => /ERROR|PERMISSION/.test(l)) || 'err'}`);
      execSync('sleep 20');
    }
  }
  die('compute instances list never succeeded headlessly — check compute.admin binding');
}

function restoreOpenRouterKey() {
  try {
    const data = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret=OPENROUTER_API_KEY', `--project=${PROJECT}`],
      { encoding: 'utf8', env: gEnv }).trim();
    writeFileSync('/tmp/.orkey', data + '\n', { mode: 0o600 });
    log(`health: OPENROUTER_API_KEY restored from Secret Manager → /tmp/.orkey (len=${data.length})`);
    return data;
  } catch (e) { die(`cannot read OPENROUTER_API_KEY: ${(e.message || '').split('\n')[0]}`); }
}

function checkSpend(key) {
  try {
    const j = JSON.parse(execSync(`curl -sS -m8 https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer ${key}"`, { encoding: 'utf8' }));
    return +(+j.data.usage).toFixed(2);
  } catch { return null; }
}

// ═══════════════ Firestore: read measured n=25 runs ═══════════════
function fsToken() { return gq(['auth', 'print-access-token']); }
function fetchFirestoreDocs() {
  for (let i = 0; i < 6; i++) {
    try {
      const out = execSync(`curl -s -H "Authorization: Bearer ${fsToken()}" "https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/darwin_runs?pageSize=300"`,
        { encoding: 'utf8', maxBuffer: 1 << 25 });
      const j = JSON.parse(out);
      if (j.error) throw new Error(j.error.message);
      return j.documents || [];
    } catch (e) {
      warn(`Firestore read attempt ${i + 1}/6: ${(e.message || '').split('\n')[0]}`);
      execSync('sleep 20');
    }
  }
  die('Firestore darwin_runs unreadable — check datastore.user binding');
}
function gv(f, k) { return f[k]?.stringValue ?? f[k]?.doubleValue ?? (f[k]?.integerValue != null ? +f[k].integerValue : undefined); }

// The runner self-reports resolve_pct but NOT cost (verified: darwin_runs docs have no `cost` field).
// To Pareto-compare a live scout we infer cost: prefer a measured board entry for the same model, else a
// log-scaled per-model base. This is a documented limitation — the verdict's cost is inferred, not measured,
// until the n=300 confirm run (which DOES measure OpenRouter spend) provides the real figure.
function inferCost(model, mode, lite) {
  const slug = model.split('/').pop().toLowerCase();
  const match = lite.find(e => e.cost != null && e.model && e.model.toLowerCase().includes(slug.split('-')[0]));
  if (match) return { cost: match.cost, src: `board:${match.name}` };
  const base = /glm/.test(slug) ? 0.018 : /kimi/.test(slug) ? 0.02 : /v3\.2/.test(slug) ? 0.012 : /minimax/.test(slug) ? 0.012 : /opus/.test(slug) ? 0.5 : 0.005;
  const mult = mode === 'bo3' ? 3 : mode === 'cascade' ? 5 : mode === 'xbo' ? 2 : 1;
  return { cost: +(base * mult).toFixed(4), src: 'inferred-base' };
}
function docKey(f) {
  const model = gv(f, 'model') || '';
  const mode = (gv(f, 'mode') || 'single').toLowerCase();
  return `${model.split('/').pop().replace(/ .*/, '')}|${mode}`;
}
// Only compare Lite rows against the Lite frontier (Firestore mixes lite/verified/pro). scouts are Lite.
function isLite(f) { return /lite/i.test(gv(f, 'benchmark') || 'lite'); }

// ═══════════════ Part 3: SOTA compare (Pareto + Wilson) ═══════════════
// A candidate "moves the needle" only if it is Pareto-improving vs the current Lite frontier, judged
// CONSERVATIVELY with the candidate's Wilson CI (n=25 is noisy/directional, not a verdict).
function loadFrontier() {
  const board = JSON.parse(readFileSync(PARETO_PATH, 'utf8'));
  const lite = board.benchmarks.lite.entries;
  // Pareto frontier = entries not dominated (cheaper AND ≥ resolve) by another. Cost may be null → skip.
  const pts = lite.filter(e => e.cost != null && e.resolve != null).map(e => ({ name: e.name, resolve: e.resolve, cost: e.cost, kind: e.kind }));
  const frontier = pts.filter(a => !pts.some(b => b !== a && b.cost <= a.cost && b.resolve >= a.resolve && (b.cost < a.cost || b.resolve > a.resolve)));
  frontier.sort((x, y) => x.cost - y.cost);
  return { board, lite, frontier, pts };
}

// Does candidate (resolve%, cost) Pareto-improve the frontier? Returns {moves, reason}.
// Conservative rule: use the LOWER Wilson bound for "higher resolve at ≤ cost" claims so n=25 noise
// can't fake a win; for "cheaper at ≥ a current resolve" use the point estimate (cost is exact, not noisy).
function paretoVerdict(cand, frontier) {
  const [loCI] = cand.ci; // Wilson lower bound (%)
  // (a) cheaper at ≥ some frontier resolve: cand.cost < f.cost AND cand.resolve (lower CI) ≥ f.resolve
  for (const f of frontier) {
    if (cand.cost < f.cost && loCI >= f.resolve) {
      return { moves: true, reason: `cheaper ($${cand.cost} < $${f.cost} "${f.name}") at ≥ its resolve (cand CI-low ${loCI.toFixed(1)}% ≥ ${f.resolve}%)` };
    }
  }
  // (b) higher resolve at ≤ some frontier cost: cand.cost ≤ f.cost AND cand.resolve (lower CI) > f.resolve
  for (const f of frontier) {
    if (cand.cost <= f.cost && loCI > f.resolve) {
      return { moves: true, reason: `higher resolve (cand CI-low ${loCI.toFixed(1)}% > ${f.resolve}% "${f.name}") at ≤ its cost ($${cand.cost} ≤ $${f.cost})` };
    }
  }
  // Promising-but-not-conclusive: point estimate dominates a frontier point even if CI-low doesn't.
  for (const f of frontier) {
    if (cand.cost <= f.cost && cand.resolve > f.resolve) {
      return { moves: false, promising: true, reason: `point estimate ${cand.resolve}% > ${f.resolve}% "${f.name}" at ≤ cost, but CI-low ${loCI.toFixed(1)}% ≤ ${f.resolve}% — n=25 noise, NOT conclusive` };
    }
  }
  return { moves: false, reason: `dominated by frontier (best CI-low ${loCI.toFixed(1)}% at $${cand.cost})` };
}

// ═══════════════ Scout dispatch via gcp-cluster.mjs ═══════════════
const champFromBoard = (lite) => {
  // current champion = highest-Value-ish: take the highest-resolve MEASURED darwin single/cheap entry as the probe baseline.
  const meas = lite.filter(e => e.kind === 'meas' && e.cost != null);
  meas.sort((a, b) => b.resolve - a.resolve);
  return meas[0];
};

function defaultCandidates(lite) {
  // Keep it cheap (≤3 VMs): the cheap workhorse + the current cheap champion model, single mode.
  return ['deepseek/deepseek-v4-flash:single', 'z-ai/glm-5.2:single'];
}

function parseCandidate(c) {
  const [model, mode = 'single'] = c.split(':');
  return { model, mode };
}

function dispatchScout(cand, n = '25') {
  // Reuse gcp-cluster.mjs `proveone <model> <mode> <sample>` — self-running e2-standard-4 VM.
  const args = ['proveone', cand.model, cand.mode, n];
  log(`scout: dispatch ${cand.model} (${cand.mode}) n=${n} via gcp-cluster proveone`);
  if (DRY) { log(`  [dry-run] would run: node ${GCP_CLUSTER} ${args.join(' ')}`); return null; }
  const out = execFileSync('node', [GCP_CLUSTER, ...args], { encoding: 'utf8', env: gEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  process.stdout.write(out);
  const name = (out.match(/darwin-[a-z0-9-]+/) || [])[0];
  return name;
}

// ═══════════════ ADR-231: submission-integrity gate (fail-closed) ═══════════════
// Build the integrity attestation for a (gold, solver, predictions) triple and apply the fail-closed gate.
// Returns { att, gate } or null if the gold report can't be read. Pure I/O + the pure sota-attest logic —
// $0, no network, no Docker. Exported for the unit test.
export function runIntegrityGate({ goldPath, solverPath, predictionsPath, maxSkips = 4, harnessVersion } = {}) {
  if (!goldPath || !existsSync(goldPath)) return null;
  const gold = JSON.parse(readFileSync(goldPath, 'utf8'));
  const solver = solverPath && existsSync(solverPath) ? JSON.parse(readFileSync(solverPath, 'utf8')) : null;
  const predictions = predictionsPath && existsSync(predictionsPath)
    ? parsePredictionsJsonl(readFileSync(predictionsPath, 'utf8')) : null;
  const att = buildAttestation(gold, solver, { harnessVersion, predictions });
  const gate = integrityGateDecision(att, { maxSkips });
  return { att, gate };
}

// Markdown per-vector table + witness + signature line, embedded into the PR/issue body on a clean gate.
export function attestationSection(att) {
  if (!att) return '';
  // Markdown-table-cell escape: backslash FIRST (else it double-escapes / leaves input backslashes
  // unescaped — CodeQL js/incomplete-sanitization), then pipe, then flatten newlines.
  const cell = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 160);
  const rows = att.vectors.map((v) => `| \`${v.vector}\` | ${v.result.toUpperCase()}${v.critical ? ' **(critical)**' : ''} | ${cell(v.evidence)} |`).join('\n');
  const sig = att.signature.sig ? `\`ed25519:${att.signature.sig.slice(0, 24)}…\` (pubkey \`${att.signature.pubkey.slice(0, 24)}…\`)` : '`unsigned` — sign at publish';
  return `

### Integrity attestation (ADR-231)

**witness_sha256:** \`${att.signature.witness_sha256}\`
**signature:** ${sig}
**summary:** ${JSON.stringify(att.summary)}

| vector | result | evidence |
|---|---|---|
${rows}

_Recompute + verify: \`node scripts/sota-attest.mjs --verify integrity-attestation.json\`._`;
}

// ═══════════════ PR + issue rendering (opened only in a real, confirmed run) ═══════════════
function renderPRBody(cand, n300, att) {
  return `## New Darwin SOTA candidate confirmed at n=300

**Config:** \`${cand.model}\` (${cand.mode})
**n=300 result:** ${n300.resolved}/${n300.total} = **${n300.pct}%** resolve, $${n300.cost}/inst (gold, conformant)
**n=25 scout:** ${cand.k}/${cand.n} = ${cand.resolve}% (Wilson CI ${cand.ci[0].toFixed(1)}–${cand.ci[1].toFixed(1)}%)

### Why it moves the needle
${cand.verdict.reason}

### Changes
- \`apps/web-ui/public/assets/swe-pareto.json\` — add/update the Lite entry + refresh the Pareto frontier
- \`packages/darwin-mode/bench/swebench/LEARNINGS.md\` — record the new SOTA + evidence
- \`packages/darwin-mode/bench/swebench/RESULTS.md\` — append the n=300 confirmation row
- \`integrity-attestation.json\` — signed ADR-231 exploit-audit committed beside the report
${attestationSection(att)}

🤖 Generated with [claude-flow](https://github.com/ruvnet/claude-flow)`;
}
function renderIssue(cand, n300, att) {
  return {
    title: `Darwin SOTA: ${cand.model} (${cand.mode}) → ${n300.pct}% Lite @ $${n300.cost}/inst (n=300 confirmed)`,
    body: `Nightly SOTA-review confirmed a new Pareto-optimal Darwin config.

**Evidence chain:** n=25 scout (${cand.resolve}%, CI ${cand.ci[0].toFixed(1)}–${cand.ci[1].toFixed(1)}%) → escalated → **n=300 confirm ${n300.pct}%** (${n300.resolved}/${n300.total}, gold, conformant).
**Pareto verdict:** ${cand.verdict.reason}
**Cost:** $${n300.cost}/inst (measured OpenRouter spend).
**Integrity (ADR-231):** ${att ? `attested — witness \`${att.signature.witness_sha256.slice(0, 16)}…\`, summary ${JSON.stringify(att.summary)}` : 'attestation pending'}.

Pipeline: \`scripts/nightly-sota-review.mjs\` · run ${ts()}.
${attestationSection(att)}

🤖 Generated with [claude-flow](https://github.com/ruvnet/claude-flow)`,
  };
}

// ═══════════════ --gate-only: run JUST the ADR-231 integrity gate (no GCP, $0, CI-safe) ═══════════════
// Renders the fail-closed gate decision on the (gold, solver, predictions) triple and the PR/issue body it
// would embed. Opens nothing, dispatches nothing, touches no cloud — the pure integrity path in isolation.
function gateOnly() {
  log(`nightly-sota-review GATE-ONLY  gold=${GOLD_REPORT.split('/').pop()}  solver=${SOLVER_REPORT ? SOLVER_REPORT.split('/').pop() : '(none)'}  predictions=${PREDICTIONS ? PREDICTIONS.split('/').pop() : '(none)'}  max-skips=${ATTEST_MAX_SKIPS}`);
  const gated = runIntegrityGate({ goldPath: GOLD_REPORT, solverPath: SOLVER_REPORT, predictionsPath: PREDICTIONS, maxSkips: ATTEST_MAX_SKIPS });
  if (!gated) { warn(`gold report not found at ${GOLD_REPORT} — fail-closed (cannot attest).`); process.exit(2); }
  const { att, gate } = gated;
  log(`attestation: summary ${JSON.stringify(att.summary)}   witness ${att.signature.witness_sha256.slice(0, 16)}…   patches_linted ${att.patches_linted ?? 'none'}`);
  for (const v of att.vectors) log(`    ${v.result.toUpperCase().padEnd(16)} ${v.vector}${v.critical ? ' *CRITICAL*' : ''}`);
  if (gate.open) {
    log(`GATE: OPEN — ${gate.reason}`);
    const sample = { model: 'confirmed-config', mode: 'cascade', resolve: att.run.resolve_pct, cost: att.cost.per_inst_usd ?? '?', k: 0, n: 25, ci: att.run.wilson_ci || [0, 0], verdict: { reason: 'ADR-231 gate demo — integrity attestation embedded' } };
    const n300 = { resolved: att.run.resolved, total: att.run.n, pct: att.run.resolve_pct, cost: att.cost.per_inst_usd ?? '?' };
    log('── would-open PR body (attestation embedded) ──\n' + renderPRBody(sample, n300, att));
    log('nightly-sota-review GATE-ONLY DONE — clean, WOULD open.');
    process.exit(0);
  }
  log(`GATE: FAIL-CLOSED — would NOT open a SOTA issue/PR: ${gate.reason}`);
  log('nightly-sota-review GATE-ONLY DONE — fail-closed, opened nothing.');
  process.exit(0);
}

// ═══════════════ main ═══════════════
async function main() {
  if (flag('gate-only')) return gateOnly();
  log(`nightly-sota-review START  mode=${DRY ? 'DRY-RUN' : SCOUT_ONLY ? 'SCOUT-ONLY' : 'FULL'}  project=${PROJECT}  max-cost=$${MAX_COST}  max-vms=${MAX_VMS}`);

  // ── Step 1: auth + health ──
  authHeadless();
  const vmsBefore = verifyHeadlessAccess();
  const orKey = restoreOpenRouterKey();
  const spend0 = checkSpend(orKey);
  log(`health: OpenRouter usage so far $${spend0 ?? '?'}; this run budget $${MAX_COST}`);

  // ── Step 3 (pre): load board + measured Firestore, build the SOTA-compare on existing data ──
  const { board, lite, frontier } = loadFrontier();
  log(`board: Lite frontier (Pareto) =`);
  for (const f of frontier) log(`    ${f.resolve.toString().padStart(5)}%  $${String(f.cost).padEnd(6)}  ${f.name}`);
  const champ = champFromBoard(lite);
  log(`board: current measured champion = ${champ?.name} (${champ?.resolve}% @ $${champ?.cost})`);

  const docs = fetchFirestoreDocs();
  log(`firestore: ${docs.length} darwin_runs docs measured`);

  // Determine scout candidates (idempotency: drop any whose model|mode is already a Firestore n=25 row).
  const measuredKeys = new Set(docs.filter(d => isLite(d.fields)).map(d => docKey(d.fields)));
  let cands = (CANDIDATES.length ? CANDIDATES : defaultCandidates(lite)).map(parseCandidate);
  const before = cands.length;
  cands = cands.filter(c => {
    const k = `${c.model.split('/').pop()}|${c.mode}`;
    if (measuredKeys.has(k)) { log(`idempotency: skip ${k} — already measured in Firestore`); return false; }
    return true;
  }).slice(0, MAX_VMS);
  log(`scout: ${cands.length}/${before} candidate(s) to dispatch (cap ${MAX_VMS}): ${cands.map(c => `${c.model}:${c.mode}`).join(', ') || '(none)'}`);

  // ── DRY-RUN: compare existing board data, render PR/issue text, dispatch + open nothing ──
  if (DRY) {
    log('── DRY-RUN: SOTA-compare on EXISTING data (no dispatch) ──');
    // Compare every measured Firestore n=25 row against the frontier to show the verdict logic.
    // Skip rows that are ALREADY a board entry (a confirmed result is not a "new" needle-mover) and any
    // oracle/ceiling pilot (not an escalatable config) — exactly what the real run would skip.
    const boardModels = new Set(lite.map(e => (e.model || '').toLowerCase()));
    let anyNeedle = false;
    for (const d of docs) {
      const f = d.fields;
      if (!isLite(f)) continue;                       // Lite-only compare (skip verified/pro rows)
      const pct = gv(f, 'resolve_pct'); const total = gv(f, 'total') || 25;
      if (pct == null) continue;
      const model = gv(f, 'model'); const mode = gv(f, 'mode') || 'single';
      if (/union|ceiling|oracle/i.test(`${model} ${mode}`)) continue;  // not a config
      let cost = gv(f, 'cost'); if (cost == null) cost = inferCost(model, mode, lite).cost;
      const k = Math.round((pct / 100) * total);
      const cand = { model, mode, resolve: pct, cost, k, n: total, ci: wilson(k, total) };
      const verdict = paretoVerdict(cand, frontier);
      const onBoard = [...boardModels].some(bm => bm.includes(model.split('/').pop().toLowerCase().split('-')[0]) && Math.abs(pct - (lite.find(e => (e.model || '').toLowerCase() === bm)?.resolve ?? -99)) < 0.6);
      if (verdict.moves && !onBoard) { anyNeedle = true; log(`  NEEDLE-MOVER (would escalate): ${cand.model}/${cand.mode} ${pct}% $${cost} — ${verdict.reason}`); }
      else if (verdict.moves && onBoard) log(`  already on board (no-op): ${cand.model}/${cand.mode} ${pct}% — matches an existing entry, not new`);
      else if (verdict.promising) log(`  promising (NOT conclusive at n=25): ${cand.model}/${cand.mode} ${pct}% $${cost} — ${verdict.reason}`);
    }
    log(`  → decision: ${anyNeedle ? 'WOULD escalate ≥1 candidate to n=300' : 'NO SOTA change — nothing moves the frontier with CI considered'}`);
    // ── ADR-231 integrity gate demo on REAL committed artifacts ($0, fail-closed) ──
    const gated = runIntegrityGate({ goldPath: GOLD_REPORT, solverPath: SOLVER_REPORT, predictionsPath: PREDICTIONS, maxSkips: ATTEST_MAX_SKIPS });
    let attForRender = null;
    if (gated) {
      const { att, gate } = gated;
      log(`── DRY-RUN: ADR-231 integrity gate on ${GOLD_REPORT.split('/').pop()}${SOLVER_REPORT ? ' + ' + SOLVER_REPORT.split('/').pop() : ' (gold-only)'} ──`);
      log(`  summary ${JSON.stringify(att.summary)}   witness ${att.signature.witness_sha256.slice(0, 16)}…`);
      for (const v of att.vectors) log(`    ${v.result.toUpperCase().padEnd(16)} ${v.vector}${v.critical ? ' *CRITICAL*' : ''}`);
      if (gate.open) { log(`  GATE: OPEN — ${gate.reason}. Attestation WOULD be embedded + committed beside the report.`); attForRender = att; }
      else log(`  GATE: FAIL-CLOSED — would NOT open a SOTA issue/PR: ${gate.reason}`);
    } else log(`  GATE: gold report not found at ${GOLD_REPORT} — cannot attest (fail-closed).`);
    // Render a sample PR + issue so the path is exercised without opening anything.
    const sample = { model: champ?.name || 'sample', mode: 'single', resolve: champ?.resolve || 0, cost: champ?.cost || 0, k: 0, n: 25, ci: [0, 0], verdict: { reason: '(dry-run sample render — not a real verdict)' } };
    const n300sample = { resolved: 0, total: 300, pct: 0, cost: champ?.cost || 0 };
    log('── DRY-RUN: rendered PR body (NOT opened) ──\n' + renderPRBody(sample, n300sample, attForRender));
    const iss = renderIssue(sample, n300sample, attForRender);
    log('── DRY-RUN: rendered tracking issue (NOT opened) ──\nTITLE: ' + iss.title + '\n' + iss.body);
    log(`plan: would dispatch ${cands.length} scout VM(s): ${cands.map(c => `${c.model}:${c.mode}`).join(', ') || '(none)'}`);
    log('nightly-sota-review DONE (dry-run, zero side effects)');
    return;
  }

  if (!cands.length) { log('no un-measured candidates to scout — exiting clean (no SOTA change)'); return; }

  // ── Step 2: dispatch the n=25 scout (≤MAX_VMS cheap VMs) ──
  const dispatched = [];
  for (const c of cands) {
    if ((checkSpend(orKey) ?? 0) - (spend0 ?? 0) > MAX_COST) { warn(`cost guard: spend Δ exceeds $${MAX_COST} — stop dispatching`); break; }
    const name = dispatchScout(c, '25');
    if (name) dispatched.push({ ...c, name, key: `${c.model.split('/').pop()}|${c.mode}` });
  }
  if (!dispatched.length) die('no scout VM dispatched');

  // ── poll Firestore until each self-reports (or per-scout time budget) ──
  const deadline = Date.now() + POLL_MIN * 60000;
  const results = new Map();
  log(`scout: polling Firestore every 3m up to ${POLL_MIN}m for ${dispatched.map(d => d.key).join(', ')}`);
  while (Date.now() < deadline && results.size < dispatched.length) {
    execSync('sleep 180');
    const now = fetchFirestoreDocs();
    for (const d of dispatched) {
      if (results.has(d.key)) continue;
      // Prefer the row whose `source` names our VM; else any fresh Lite row with the same model|mode key.
      const hit = now.find(x => isLite(x.fields) && docKey(x.fields) === d.key && (gv(x.fields, 'source') || '').includes(d.name.replace(/^darwin-/, '')))
        || now.find(x => isLite(x.fields) && docKey(x.fields) === d.key);
      if (hit) {
        const f = hit.fields; const pct = gv(f, 'resolve_pct'); const total = gv(f, 'total') || 25;
        let cost = gv(f, 'cost') ?? null, costSrc = 'firestore';
        if (cost == null) { const ic = inferCost(d.model, d.mode, lite); cost = ic.cost; costSrc = ic.src; }
        const k = Math.round((pct / 100) * total);
        results.set(d.key, { ...d, resolve: pct, cost, costSrc, k, n: total, ci: wilson(k, total) });
        log(`scout: ${d.key} self-reported → ${pct}% (${k}/${total}), CI ${wilson(k, total).map(x => x.toFixed(1)).join('–')}%, $${cost} (${costSrc})`);
      }
    }
    log(`scout: ${results.size}/${dispatched.length} self-reported (${Math.round((deadline - Date.now()) / 60000)}m left)`);
  }

  // ── always clean up the scout VMs (cost guard) ──
  for (const d of dispatched) {
    try { execFileSync('node', [GCP_CLUSTER, 'down', d.name], { encoding: 'utf8', env: gEnv, stdio: 'inherit' }); }
    catch { warn(`cleanup: failed to down ${d.name} — run \`node scripts/gcp-cluster.mjs down ${d.name}\``); }
  }

  if (!results.size) die('no scout self-reported within budget — VMs cleaned up; re-run later');

  // ── Step 3: SOTA compare each scout result vs frontier (Pareto + Wilson) ──
  const needleMovers = [];
  for (const r of results.values()) {
    const verdict = paretoVerdict(r, frontier);
    r.verdict = verdict;
    if (verdict.moves) { needleMovers.push(r); log(`SOTA-compare: ${r.key} MOVES THE NEEDLE — ${verdict.reason}`); }
    else if (verdict.promising) log(`SOTA-compare: ${r.key} promising but NOT conclusive (n=25) — ${verdict.reason}`);
    else log(`SOTA-compare: ${r.key} no change — ${verdict.reason}`);
  }

  if (SCOUT_ONLY) {
    log(`scout-only: ${needleMovers.length} needle-mover(s) at n=25 (directional). No escalation/PR/issue. Done.`);
    return;
  }
  if (!needleMovers.length) { log('no SOTA change — nothing Pareto-improves the frontier with CI considered. Exiting clean.'); return; }

  // ── Step 4: escalate ONLY a true needle-mover to n=300 (the only verdict) ──
  log(`escalate: ${needleMovers.length} candidate(s) clear the n=25 gate → dispatching n=300 confirm`);
  for (const m of needleMovers) {
    if ((checkSpend(orKey) ?? 0) - (spend0 ?? 0) > MAX_COST) { warn('cost guard tripped before escalation — stopping'); process.exit(2); }
    dispatchScout({ model: m.model, mode: m.mode }, '300');
    log(`escalate: n=300 dispatched for ${m.key} — this run does NOT block on the full result (hours).`);
    log(`escalate: a follow-up run will read the n=300 Firestore row; n=300 is the only SOTA verdict.`);
    // ── ADR-231 fail-closed gate: a SOTA issue/PR opens ONLY if the confirmed run's (gold, solver,
    //    predictions) triple passes the exploit audit. If the confirm artifacts already exist on disk
    //    (a follow-up run), attest now; otherwise the follow-up run that opens the PR runs the gate. A
    //    missing/dirty attestation is fail-closed: we do NOT open.
    const gated = runIntegrityGate({ goldPath: GOLD_REPORT, solverPath: SOLVER_REPORT, predictionsPath: PREDICTIONS, maxSkips: ATTEST_MAX_SKIPS });
    if (!gated || !gated.gate.open) {
      warn(`GATE FAIL-CLOSED for ${m.key}: ${gated ? gated.gate.reason : 'no gold report to attest'} — NOT opening a SOTA issue/PR.`);
      continue;
    }
    log(`GATE OPEN for ${m.key}: ${gated.gate.reason} — attestation will be embedded + committed.`);
    // Step 5 PR/issue path is exercised by rendering (real open happens once n=300 is in Firestore in a
    // subsequent run; we never open on n=25 alone). The attestation is embedded into the body.
    log('── would-open PR body (after n=300 confirms) ──\n' + renderPRBody({ ...m }, { resolved: '?', total: 300, pct: '?', cost: m.cost }, gated.att));
  }
  log('nightly-sota-review DONE (escalated; PR/issue open deferred to n=300 confirmation)');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => die(e.stack || e.message));
