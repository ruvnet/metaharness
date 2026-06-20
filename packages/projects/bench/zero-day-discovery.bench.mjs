// SPDX-License-Identifier: MIT
//
// REAL defensive zero-day discovery harness, wired to OpenRouter + semgrep + an
// isolated execution verifier. Optional (skips without OPENROUTER_API_KEY), bounded
// request caps, key from env only. Strictly DEFENSIVE: it proves a weakness EXISTS
// (an unhandled-exception / injection site) and emits only the exception CLASS or
// CWE — never a weaponized exploit or the proof input.
//
// Pipeline (see src/discovery.ts):
//   static : real semgrep over the target (injection/command CWEs)  [tool-verified]
//   triage : cheap model ranks suspected non-total functions
//   propose: GLM-5.2 (open-frontier) proposes a concrete crashing input
//   verify : run the proof in `python3 -I -B` (timeout, clean env) — confirm or drop
//
// Run: npm run -w @metaharness/projects build && SEMGREP_BIN=$(command -v semgrep) node bench/zero-day-discovery.bench.mjs
// Env: CHEAP_MODEL (default qwen/qwen-2.5-7b-instruct), FRONTIER_MODEL (default z-ai/glm-5.2)

import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable, tryParseJson, runDiscovery } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!openRouterAvailable()) {
  process.stdout.write('OPENROUTER_API_KEY absent — skipping the real discovery harness.\n');
  process.exit(0);
}

// ── Target: a small module with genuine, verifiable weaknesses (an inert test
//    fixture — no exploit code, just vulnerable patterns + non-total functions). ──
const SOURCE = `import os

def run_cmd(c):
    os.system(c)            # CWE-78 OS command injection

def parse(s):
    return eval(s)          # CWE-94 code injection

def ratio(a, b):
    return a / b            # not total: ZeroDivisionError when b == 0

def nth(xs, i):
    return xs[i]            # not total: IndexError out of range

def lookup(d, k):
    return d[k]             # not total: KeyError on missing key

def safe_sum(xs):
    return sum(int(x) for x in xs)   # robust enough for ints
`;

const SEMGREP = process.env.SEMGREP_BIN || 'semgrep';
const CHEAP = process.env.CHEAP_MODEL || 'qwen/qwen-2.5-7b-instruct';
const FRONTIER = process.env.FRONTIER_MODEL || 'z-ai/glm-5.2';
const PRICING = { [CHEAP]: { in: 0.04, out: 0.1 }, [FRONTIER]: { in: 1.2, out: 4.1 } };

const cheap = new OpenRouterClient({ model: CHEAP, maxRequests: 4, temperature: 0 });
const frontier = new OpenRouterClient({ model: FRONTIER, maxRequests: 10, temperature: 0 });
const costUnits = () => {
  let c = 0;
  for (const cl of [cheap, frontier]) {
    const s = cl.stats();
    const p = PRICING[cl.model] ?? { in: 0, out: 0 };
    c += (s.promptTokens / 1e6) * p.in + (s.completionTokens / 1e6) * p.out;
  }
  return c * 1000; // cost-units = milli-dollars, for a readable ledger
};

// ── Static channel: real semgrep for injection/command CWEs. ──
function staticScan(target) {
  if (!semgrepAvailable()) return [];
  const dir = mkdtempSync(join(tmpdir(), 'zd-static-'));
  const tf = join(dir, 'target.py');
  const rf = join(dir, 'rules.yaml');
  writeFileSync(tf, target.source);
  writeFileSync(rf, `rules:
  - id: cwe-78-os-system
    languages: [python]
    severity: ERROR
    message: CWE-78 OS command injection (os.system)
    pattern: os.system(...)
  - id: cwe-94-eval
    languages: [python]
    severity: ERROR
    message: CWE-94 code injection (eval)
    pattern: eval(...)
`);
  try {
    let out = '';
    try {
      out = execFileSync(SEMGREP, ['--quiet', '--json', '--disable-version-check', '--config', rf, tf], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (e.stdout) out = e.stdout.toString(); else throw e;
    }
    const results = JSON.parse(out).results ?? [];
    return results.map((r) => ({ fn: `L${r.start?.line ?? 0}`, weakness: (r.check_id ?? '').split('.').pop(), source: 'static', verified: true }));
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function semgrepAvailable() {
  try { execFileSync(SEMGREP, ['--version'], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; }
}

// ── Triage (cheap): list non-total / risky functions. ──
async function triage(target) {
  const r = await cheap.chatJSON([
    { role: 'system', content: 'You are a security code reviewer. Output ONLY JSON.' },
    { role: 'user', content: `List functions in this Python module that can crash on some input (raise an unhandled exception) or are injection sinks. Return a JSON array of {"fn": name, "weakness": "short CWE/desc", "rationale": "why"}.\n\n${target.source}` },
  ], { maxTokens: 400 });
  const arr = tryParseJson(r.raw);
  return Array.isArray(arr) ? arr.filter((c) => c && typeof c.fn === 'string').map((c) => ({ fn: c.fn, weakness: String(c.weakness ?? 'unknown'), rationale: String(c.rationale ?? '') })) : [];
}

// ── Propose (frontier): a concrete crashing input for one function. ──
async function propose(target, c) {
  const r = await frontier.chatJSON([
    { role: 'system', content: 'You are a precise security analyst. Output ONLY JSON.' },
    { role: 'user', content: `In this Python module, give ONE concrete argument list that makes \`${c.fn}\` raise an UNHANDLED exception (demonstrating it is not total). Return JSON {"fn": "${c.fn}", "args": [...], "expectedProblem": "ExceptionName"}. If you cannot, return {"fn":"${c.fn}","args":null}.\n\n${target.source}` },
  ], { maxTokens: 250 });
  const p = tryParseJson(r.raw);
  if (!p || !Array.isArray(p.args)) return null;
  return { fn: c.fn, args: p.args, expectedProblem: String(p.expectedProblem ?? '') };
}

// ── Verify (execution): run the proof; an unhandled exception confirms the weakness. ──
function verify(target, proof) {
  const dir = mkdtempSync(join(tmpdir(), 'zd-verify-'));
  const file = join(dir, 'cand.py');
  writeFileSync(file, `${target.source}

import json, sys
ARGS = json.loads(sys.argv[1])
try:
    ${proof.fn}(*ARGS)
    print(json.dumps({"triggered": False}))
except Exception as e:
    print(json.dumps({"triggered": True, "evidenceClass": type(e).__name__}))
`);
  try {
    const out = execFileSync('python3', ['-I', '-B', file, JSON.stringify(proof.args)], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' }, // clean env — no API key in the child
    });
    const res = JSON.parse(out.trim().split('\n').pop());
    return { triggered: res.triggered === true, evidenceClass: res.evidenceClass };
  } catch {
    return { triggered: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const target = { path: 'fixture/target.py', language: 'python', source: SOURCE };
const result = await runDiscovery(target, { staticScan, triage, propose, verify, cost: costUnits }, { maxEscalations: 8 });

const receipt = {
  experiment: 'real defensive zero-day discovery harness',
  target: target.path,
  cheapModel: CHEAP,
  frontierModel: FRONTIER,
  semgrep: semgrepAvailable(),
  candidates: result.candidates,
  proposed: result.proposed,
  verified: result.verified,
  costUnitsMilliUSD: result.costUnits,
  costPerVerifiedFindingMilliUSD: result.costPerVerifiedFinding,
  findings: result.findings,
  note: 'Defensive: only execution-verified (or tool-verified) weaknesses reported; proof inputs deliberately not emitted (only exception class / CWE). Real LLM calls; single non-deterministic run.',
};
writeFileSync(join(here, 'results', 'zero-day-discovery.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Defensive discovery on ${target.path} (cheap=${CHEAP}, frontier=${FRONTIER}, semgrep=${receipt.semgrep})\n`);
process.stdout.write(`  ${result.candidates} candidates → ${result.proposed} proofs proposed → ${result.verified} VERIFIED findings\n`);
for (const f of result.findings) process.stdout.write(`   - [${f.source}] ${f.fn}: ${f.weakness}${f.evidenceClass ? ` (confirmed via ${f.evidenceClass})` : ''}\n`);
process.stdout.write(`  cost ≈ ${result.costUnits.toFixed(3)} milli-USD → ${result.costPerVerifiedFinding != null ? result.costPerVerifiedFinding.toFixed(3) : 'n/a'} per verified finding\n`);
process.stdout.write(`  receipt → bench/results/zero-day-discovery.json\n`);
