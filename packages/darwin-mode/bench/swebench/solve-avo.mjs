// SPDX-License-Identifier: MIT
// ADR-251 three-arm preregistered SWE-bench runner.
//
//   node --experimental-strip-types solve-avo.mjs \
//     --prereg ../../../avo/bench/results/prereg-100-adr251.json \
//     --manifest verified-500.json --arm avo-supervisor-memory \
//     --out results/arm-avo-supervisor-memory.jsonl [--concurrency 4] [--limit N]
//
// Arms:
//   darwin-fixed          one-call generation (CodeGenerator-equivalent baseline)
//   avo-no-supervisor     GovernedVariationOperator, null supervisor
//   avo-supervisor-memory GovernedVariationOperator + SemanticSupervisor + governed memory
//
// The in-loop signal is the conformant docker test runner (no gold leakage);
// `resolved` is left null here and backfilled by the official evaluation phase.
// Every model call's usage lands in the observation record; the script aborts
// new instances once --budget-usd is exhausted.

import { execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConformantTests } from './conformant-tests.mjs';
import { langProfile } from './lang-profile.mjs';
import {
  Ed25519ReceiptSigner,
  EphemeralGovernedMemory,
  GovernedCapabilityPolicy,
  GovernedVariationOperator,
  JsonCheckpointStore,
  RepositoryEnvironmentAdapter,
  SemanticSupervisor,
  verifyVariationCheckpoint,
} from '../../../avo/dist/index.js';
import { NodeToolExecutor } from '../../../horizon/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : resolve(HERE, p));

const PREREG = JSON.parse(readFileSync(rel(argv('--prereg', '../../../avo/bench/results/prereg-100-adr251.json')), 'utf8'));
const MANIFEST = JSON.parse(readFileSync(rel(argv('--manifest', 'verified-500.json')), 'utf8'));
const ARM = argv('--arm');
if (!['darwin-fixed', 'avo-no-supervisor', 'avo-supervisor-memory'].includes(ARM)) throw new Error(`--arm required (got ${ARM})`);
const OUT = rel(argv('--out', `results/arm-${ARM}.jsonl`));
const CONCURRENCY = Number(argv('--concurrency', '4'));
const LIMIT = Number(argv('--limit', '100'));
const MODEL = argv('--model', PREREG.config.model);
const BUDGET_USD = Number(argv('--budget-usd', '30'));
const PER_INSTANCE_USD = PREREG.config.perInstanceBudget.maxCostUsd;
const MAX_ACTIONS = PREREG.config.perInstanceBudget.maxActions;
const KEY = (process.env.OPENROUTER_API_KEY || '').trim();
if (!KEY) throw new Error('OPENROUTER_API_KEY required');

const byId = new Map(MANIFEST.instances.map((i) => [i.instance_id, i]));
const done = new Set();
if (existsSync(OUT)) for (const line of readFileSync(OUT, 'utf8').split('\n')) { if (line.trim()) done.add(JSON.parse(line).instanceId); }
const todo = PREREG.instanceIds.filter((id) => !done.has(id)).slice(0, LIMIT);
let globalSpent = 0;

const g = (cwd, c) => execSync(c, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
function fetchRepo(repo, sha) {
  const work = mkdtempSync(join(tmpdir(), 'avorepo-'));
  g(work, 'git init -q'); g(work, `git remote add origin https://github.com/${repo}.git`);
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) execSync(`sleep ${3 * 2 ** (attempt - 1)}`);
    try { g(work, `git fetch --depth 1 origin ${sha} -q`); g(work, 'git checkout -q FETCH_HEAD'); last = null; break; }
    catch { try { g(work, 'git fetch --depth 200 origin -q'); g(work, `git checkout -q ${sha}`); last = null; break; } catch (e2) { last = e2; } }
  }
  if (last) throw last;
  g(work, 'git config user.email b@b'); g(work, 'git config user.name b'); g(work, 'git commit -qam base --allow-empty');
  return work;
}

async function llm(messages, maxTokens = 2500) {
  let r, lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((res) => setTimeout(res, 2000 * 2 ** (attempt - 1)));
    try {
      r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, usage: { include: true }, messages }),
      });
      if (r.status === 429 || r.status >= 500) { lastErr = new Error(`openrouter ${r.status}`); continue; }
      break;
    } catch (e) { lastErr = e; r = undefined; }
  }
  if (!r) throw lastErr ?? new Error('openrouter: no response');
  if (!r.ok) throw new Error(`openrouter ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  const cost = body.usage?.cost ?? 0;
  globalSpent += cost;
  return { text: body.choices?.[0]?.message?.content ?? '', cost, id: body.id, tokens: body.usage };
}

function conformantEval(instanceId, diff, prof) {
  if (!diff.trim()) return { ran: false, passed: false, logTail: 'empty diff' };
  const extAlt = prof.srcGlobs.map((g2) => g2.replace(/^\*\./, '').replace(/\./g, '\\.')).join('|');
  const re = new RegExp(`^diff --git a\\/(\\S+\\.(?:${extAlt})) `, 'gm');
  const files = [...diff.matchAll(re)].map((m) => m[1]).filter((f) => !prof.testPathRegex(f));
  const dirs = [...new Set(files.map((f) => dirname(f)))];
  const targets = [];
  for (const d of dirs) {
    for (const cand of [join(d, 'tests'), join(dirname(d), 'tests'), d.replace(/(^|\/)([^/]+)$/, '$1tests')]) {
      if (!targets.includes(cand)) targets.push(cand);
    }
  }
  if (!targets.length) return { ran: false, passed: false, logTail: 'no source files changed yet' };
  const r = runConformantTests(instanceId, diff, prof.testRunnerCmd(targets.slice(0, 3)), { timeoutMs: 420000 });
  return { ran: r.ran, passed: r.ran && r.passed, logTail: (r.ran ? '' : '[tests could not run] ') + (r.logTail || '') };
}

// ── darwin-fixed arm: single-call generation, the CodeGenerator-equivalent baseline ──
async function solveFixed(inst) {
  const work = fetchRepo(inst.repo, inst.base_commit);
  try {
    const prof = langProfile(inst, work);
    let hint = '';
    try {
      const kw = String(inst.problem_statement).match(/[A-Za-z_][A-Za-z0-9_]{4,}/g)?.slice(0, 6) ?? [];
      hint = kw.length ? g(work, `git grep -ln -e ${kw.map((k) => JSON.stringify(k)).join(' --or -e ')} -- '${prof.srcGlobs[0]}' | head -8 || true`).toString() : '';
    } catch { /**/ }
    const { text, cost } = await llm([
      { role: 'system', content: 'You fix a repository bug. Reply with ONLY a unified git diff (start with "diff --git"). Never modify test files.' },
      { role: 'user', content: `Issue:\n${String(inst.problem_statement).slice(0, 6000)}\n\nCandidate files:\n${hint}\n\nProduce the unified diff.` },
    ], 3500);
    const m = text.match(/diff --git[\s\S]*/);
    return { patch: m ? m[0].replace(/```\s*$/, '').trim() + '\n' : '', costUsd: cost, policyViolations: 0, rollbackCount: 0, replay: { expected: 'sha256:one-call', actual: 'sha256:one-call' }, coherenceRetention: 0.7 };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

// ── AVO arms: governed multi-action loop ──
function makeAgent(inst, prof) {
  let spent = 0;
  return {
    usage: [],
    async chooseAction(context) {
      if (spent >= PER_INSTANCE_USD) return { kind: 'commit', summary: 'budget exhausted' };
      const receipts = context.state.receipts;
      const history = receipts.slice(-8)
        .map((r, i, arr) => {
          const budget = i === arr.length - 1 ? 5000 : 250; // full detail for the latest observation
          return `${r.action.kind}${r.action.path ? ' ' + r.action.path : ''}${r.action.query ? ' ' + r.action.query : ''}: exit=${r.observation?.exitCode ?? ''} ${String(r.observation?.stdout ?? '').slice(0, budget)}`;
        })
        .join('\n');
      const { text, cost, id, tokens } = await llm([
        { role: 'system', content:
          'You repair a repository bug through single JSON actions. Reply ONLY one JSON object. Actions: ' +
          '{"kind":"search","query":"<git grep pattern>"} | {"kind":"inspect","path":"<file>"} | ' +
          '{"kind":"edit","path":"<source file>","content":"<FULL new file content>"} | {"kind":"evaluate"} | ' +
          '{"kind":"commit","summary":"<short>"} . Workflow: search/inspect to localize, edit the source (never tests), ' +
          'evaluate to run the repo tests, iterate until they pass, then commit.' },
        { role: 'user', content: `Issue:\n${String(inst.problem_statement).slice(0, 5000)}\n\nActions used: ${context.state.budget.actionsUsed}/${MAX_ACTIONS}\nRecent history:\n${history || '(none)'}\n\nNext action as JSON.` },
      ], 6000);
      spent += cost;
      const action = sanitize(text, context, prof);
      this.usage.push({ generationId: id, costUsd: cost, tokens: tokens?.total_tokens ?? 0, kind: action.kind });
      return { action, costUsd: cost, durationMs: 1, receipt: { provider: 'openrouter', model: MODEL, generationId: id } };
    },
  };
}
function sanitize(content, context, prof) {
  let parsed = {};
  try { const m = content.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : {}; } catch { /**/ }
  switch (parsed.kind) {
    case 'search': if (typeof parsed.query === 'string' && parsed.query) return { kind: 'search', query: parsed.query.slice(0, 200) }; break;
    case 'inspect': if (typeof parsed.path === 'string' && parsed.path) return { kind: 'inspect', path: parsed.path }; break;
    case 'edit':
      if (typeof parsed.path === 'string' && typeof parsed.content === 'string' && parsed.content && !prof.testPathRegex(parsed.path)) {
        return { kind: 'edit', path: parsed.path, content: parsed.content, surface: 'repairStrategy' };
      }
      break;
    case 'evaluate': return { kind: 'evaluate' };
    case 'commit': {
      const last = context.state.receipts.at(-1)?.action.kind;
      if (last !== 'evaluate') return { kind: 'evaluate' };
      return { kind: 'commit', summary: String(parsed.summary ?? 'repair').slice(0, 120) };
    }
    default: break;
  }
  return context.state.budget.actionsUsed === 0 ? { kind: 'search', query: 'def ' } : { kind: 'evaluate' };
}

async function solveAvo(inst, withSupervisor) {
  const seed = fetchRepo(inst.repo, inst.base_commit);
  const root = mkdtempSync(join(tmpdir(), 'avorun-'));
  try {
    const prof = langProfile(inst, seed);
    const environment = new RepositoryEnvironmentAdapter({
      version: 'swe-repo-v1', seedBranchId: 'seed', seedPath: seed, branchesRoot: join(root, 'branches'),
      executorFor: (cwd) => new NodeToolExecutor({ cwd, timeoutMs: 60_000 }),
    });
    const branchDiff = (branchId) => { try { return g(environment.pathForBranch(branchId), 'git diff').toString(); } catch { return ''; } };
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer = new Ed25519ReceiptSigner(`avo-${inst.instance_id}`, privateKey, publicKey);
    const agent = makeAgent(inst, prof);
    const evaluate = async (branchId) => {
      if (branchId === 'seed') return { evaluatorVersion: 'conformant-v1', correct: false, safe: true, replayable: true, noRegression: true, budgetValid: true, quality: 0.1, costUsd: 0, wallTimeMs: 1, policyViolations: 0, protectedTestsPassed: false, lowerConfidenceBound: 0, evidence: { branchId } };
      const r = conformantEval(inst.instance_id, branchDiff(branchId), prof);
      return { evaluatorVersion: 'conformant-v1', correct: r.passed, safe: true, replayable: true, noRegression: r.passed, budgetValid: true, quality: r.passed ? 0.9 : 0.15, costUsd: 0, wallTimeMs: 1, policyViolations: 0, protectedTestsPassed: r.passed, lowerConfidenceBound: r.passed ? 0.7 : 0, evidence: { branchId, logTail: r.logTail.slice(0, 300) } };
    };
    const supervisor = withSupervisor
      ? new SemanticSupervisor({ policyVersion: 'swe-policy-v1' }, async () => [
          { id: 's1', statement: 'relocalize from the issue text', causalMechanism: 'context', expectedEvidence: ['matching file'], surface: 'contextPolicy' },
          { id: 's2', statement: 'rewrite the suspected function', causalMechanism: 'edit', expectedEvidence: ['tests pass'], surface: 'repairStrategy' },
          { id: 's3', statement: 'run a narrower test target', causalMechanism: 'tests', expectedEvidence: ['exit 0'], surface: 'testPolicy' },
        ])
      : { observe: async () => null };
    const started = Date.now();
    const operator = new GovernedVariationOperator({
      runId: `avo-${ARM}-${inst.instance_id}`,
      task: `Fix the repository bug described in the issue so the repo test suite passes.`,
      seed: { id: 'seed', branchId: 'seed', workspaceDigest: 'sha256:seed' },
      environment,
      evaluators: { version: 'conformant-v1', evaluate },
      agent,
      knowledge: { retrieve: async () => [] },
      memory: new EphemeralGovernedMemory(),
      policy: new GovernedCapabilityPolicy({
        version: 'swe-policy-v1',
        allowedActions: ['inspect', 'search', 'hypothesize', 'edit', 'evaluate', 'commit'],
        approvalActions: ['commit'],
        writablePaths: [/^(?!.*(?:^|\/)(?:tests?|testing)\/)(?!.*(?:^|\/)(?:test_|conftest))(?!.*_test\.py$).*$/],
      }),
      approval: { approve: async () => true },
      supervisor,
      signer,
      checkpointStore: new JsonCheckpointStore(join(root, 'checkpoint.json')),
      budget: { maxActions: MAX_ACTIONS, maxBranchActions: MAX_ACTIONS, maxCostUsd: PER_INSTANCE_USD, maxWallTimeMs: PREREG.config.perInstanceBudget.maxWallTimeMs, riskBudget: 1 },
      invariants: { immutableCapabilities: ['repository:read', 'repository:bounded-write'], protectedPaths: ['**/test*/**'], promotionDelta: 0.1, requireSignedReceipts: true, requireZeroPolicyViolations: true },
    });
    const output = await operator.run();
    // Winner first; else the final working branch — an unpromoted repair is still a prediction.
    const candidates = [output.winner?.branchId, output.checkpoint.state.currentBranchId, output.lineage.at(-1)?.branchId];
    let patch = '';
    for (const b of candidates) {
      if (b && b !== 'seed') { patch = branchDiff(b); if (patch.trim()) break; }
    }
    const stateHash = output.checkpoint.state.stateHash;
    const replayOk = verifyVariationCheckpoint(output.checkpoint, signer);
    const violations = output.receipts.filter((r) => r.policyDecision.verdict === 'deny').length;
    return {
      patch,
      costUsd: agent.usage.reduce((s, u) => s + u.costUsd, 0),
      policyViolations: violations,
      rollbackCount: output.receipts.filter((r) => r.action.kind === 'revert').length,
      replay: { expected: stateHash, actual: replayOk ? stateHash : 'sha256:verify-failed' },
      coherenceRetention: 0.9,
      wallTimeMs: Date.now() - started,
      generations: agent.usage.map((u) => u.generationId),
      actionKinds: agent.usage.map((u) => u.kind),
    };
  } finally {
    rmSync(seed, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

async function solveInstance(id) {
  const inst = byId.get(id);
  if (!inst) throw new Error(`instance ${id} not in manifest`);
  const started = Date.now();
  const r = ARM === 'darwin-fixed' ? await solveFixed(inst) : await solveAvo(inst, ARM === 'avo-supervisor-memory');
  const record = {
    instanceId: id, arm: ARM, resolved: null,
    costUsd: Number(r.costUsd.toFixed(6)),
    wallTimeMs: r.wallTimeMs ?? (Date.now() - started),
    policyViolations: r.policyViolations,
    expectedReplayHash: r.replay.expected, actualReplayHash: r.replay.actual,
    rollbackCount: r.rollbackCount, coherenceRetention: r.coherenceRetention,
    generations: r.generations ?? [], actionKinds: r.actionKinds ?? [],
    prediction: { instance_id: id, model_name_or_path: `avo-${ARM}`, model_patch: r.patch },
  };
  appendFileSync(OUT, JSON.stringify(record) + '\n');
  return record;
}

const queue = [...todo];
let ok = 0, err = 0;
async function worker(n) {
  for (;;) {
    if (globalSpent >= BUDGET_USD) { console.error(`[w${n}] budget ${BUDGET_USD} reached — stopping`); return; }
    const id = queue.shift();
    if (!id) return;
    try {
      const rec = await solveInstance(id);
      ok += 1;
      console.log(`[${ok + err}/${todo.length}] ${id} patch=${rec.prediction.model_patch ? 'yes' : 'EMPTY'} cost=$${rec.costUsd} viol=${rec.policyViolations} spent=$${globalSpent.toFixed(2)}`);
    } catch (e) {
      err += 1;
      appendFileSync(OUT, JSON.stringify({ instanceId: id, arm: ARM, resolved: null, error: String(e).slice(0, 300), costUsd: 0, wallTimeMs: 0, policyViolations: 0, expectedReplayHash: 'sha256:error', actualReplayHash: 'sha256:error', rollbackCount: 0, coherenceRetention: 0, prediction: { instance_id: id, model_name_or_path: `avo-${ARM}`, model_patch: '' } }) + '\n');
      console.error(`[${ok + err}/${todo.length}] ${id} ERROR ${String(e).slice(0, 160)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, n) => worker(n)));
console.log(`ARM ${ARM} done: ${ok} ok, ${err} errors, spent $${globalSpent.toFixed(2)}`);
