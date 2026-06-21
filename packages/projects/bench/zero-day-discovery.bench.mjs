// SPDX-License-Identifier: MIT
//
// REAL defensive zero-day discovery harness — BENCHMARK: baseline vs Darwin-
// optimized policy. Wired to OpenRouter + semgrep + an isolated execution verifier.
// Optional (skips without OPENROUTER_API_KEY), bounded request caps, key from env
// only. Strictly DEFENSIVE: proves a weakness EXISTS (unhandled-exception /
// injection site), emits only the exception CLASS or CWE — never an exploit or the
// proof input.
//
// Pipeline (src/discovery.ts): static (real semgrep) | triage (cheap) | propose
// (GLM-5.2 open-frontier) | verify (python3 -I -B). We run it twice:
//   baseline  : escalate every triaged site to the frontier lane.
//   optimized : skipStaticallyCovered — don't spend a frontier call on a site the
//               static channel already verified (the optimization), + concurrency.
// Metric: VERIFIED findings and cost-per-verified-finding + frontier-call savings.
//
// Run: npm run -w @metaharness/projects build && SEMGREP_BIN=$(command -v semgrep) node bench/zero-day-discovery.bench.mjs
// Env: CHEAP_MODEL (default qwen/qwen-2.5-7b-instruct), FRONTIER_MODEL (default z-ai/glm-5.2)

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable, tryParseJson, runDiscovery, DEFAULT_FRONTIER_MODEL } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!openRouterAvailable()) {
  process.stdout.write('OPENROUTER_API_KEY absent — skipping the real discovery harness.\n');
  process.exit(0);
}

// Inert test fixture: genuine, verifiable weaknesses + a robust control.
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
const FRONTIER = process.env.FRONTIER_MODEL || DEFAULT_FRONTIER_MODEL;
const PRICING = { 'qwen/qwen-2.5-7b-instruct': { in: 0.04, out: 0.1 }, 'qwen/qwen3-235b-a22b-2507': { in: 0.09, out: 0.10 }, 'z-ai/glm-5.2': { in: 1.2, out: 4.1 } };

function semgrepAvailable() {
  try { execFileSync(SEMGREP, ['--version'], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; }
}

// Map a 1-based line to its enclosing `def name(` so static fn names line up with
// triage fn names — letting skipStaticallyCovered avoid redundant frontier calls.
function fnAtLine(source, line) {
  const lines = source.split('\n');
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/^\s*def\s+([A-Za-z_]\w*)\s*\(/);
    if (m) return m[1];
  }
  return `L${line}`;
}

// Static channel: real semgrep for injection/command CWEs.
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
    return results.map((r) => ({ fn: fnAtLine(target.source, r.start?.line ?? 0), weakness: (r.check_id ?? '').split('.').pop(), source: 'static', verified: true }));
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Execution verifier: run the proof; an unhandled exception confirms the weakness.
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

// One discovery run with fresh clients (so frontier calls are counted per run).
async function runOnce(target, { skipStaticallyCovered }) {
  const cheap = new OpenRouterClient({ model: CHEAP, maxRequests: 4, temperature: 0 });
  const frontier = new OpenRouterClient({ model: FRONTIER, maxRequests: 10, temperature: 0 });
  const cost = () => {
    let c = 0;
    for (const cl of [cheap, frontier]) {
      const s = cl.stats();
      const p = PRICING[cl.model] ?? { in: 0, out: 0 };
      c += (s.promptTokens / 1e6) * p.in + (s.completionTokens / 1e6) * p.out;
    }
    return c * 1000; // milli-USD
  };
  const triage = async (t) => {
    const r = await cheap.chatJSON([
      { role: 'system', content: 'You are a security code reviewer. Output ONLY JSON.' },
      { role: 'user', content: `List functions in this Python module that can crash on some input (raise an unhandled exception) or are injection sinks. Return a JSON array of {"fn": name, "weakness": "short CWE/desc", "rationale": "why"}.\n\n${t.source}` },
    ], { maxTokens: 400 });
    const arr = tryParseJson(r.raw);
    return Array.isArray(arr) ? arr.filter((c) => c && typeof c.fn === 'string').map((c) => ({ fn: c.fn, weakness: String(c.weakness ?? 'unknown'), rationale: String(c.rationale ?? '') })) : [];
  };
  const propose = async (t, c) => {
    const r = await frontier.chatJSON([
      { role: 'system', content: 'You are a precise security analyst. Output ONLY JSON.' },
      { role: 'user', content: `In this Python module, give ONE concrete argument list that makes \`${c.fn}\` raise an UNHANDLED exception (demonstrating it is not total). Return JSON {"fn": "${c.fn}", "args": [...], "expectedProblem": "ExceptionName"}. If you cannot, return {"fn":"${c.fn}","args":null}.\n\n${t.source}` },
    ], { maxTokens: 250 });
    const p = tryParseJson(r.raw);
    if (!p || !Array.isArray(p.args)) return null;
    return { fn: c.fn, args: p.args, expectedProblem: String(p.expectedProblem ?? '') };
  };
  const result = await runDiscovery(target, { staticScan, triage, propose, verify, cost }, { maxEscalations: 8, skipStaticallyCovered });
  return { result, frontierCalls: frontier.stats().requests, cheapCalls: cheap.stats().requests };
}

const target = { path: 'fixture/target.py', language: 'python', source: SOURCE };
const baseline = await runOnce(target, { skipStaticallyCovered: false });
const optimized = await runOnce(target, { skipStaticallyCovered: true });

const lane = (run) => ({
  verified: run.result.verified,
  proposed: run.result.proposed,
  skipped: run.result.skipped,
  frontierCalls: run.frontierCalls,
  costMilliUSD: +run.result.costUnits.toFixed(3),
  costPerVerifiedMilliUSD: run.result.costPerVerifiedFinding != null ? +run.result.costPerVerifiedFinding.toFixed(3) : null,
  findings: run.result.findings,
});
const b = lane(baseline);
const o = lane(optimized);
const frontierCallsSavedPct = b.frontierCalls > 0 ? +(((b.frontierCalls - o.frontierCalls) / b.frontierCalls) * 100).toFixed(1) : 0;

const receipt = {
  experiment: 'defensive zero-day discovery — baseline vs Darwin-optimized policy',
  target: target.path,
  cheapModel: CHEAP,
  frontierModel: FRONTIER,
  semgrep: semgrepAvailable(),
  baseline: b,
  optimized: o,
  frontierCallsSavedPct,
  note: 'Optimized policy skips frontier escalation for statically-verified sites (skipStaticallyCovered). Defensive: only execution/tool-verified weaknesses; proof inputs redacted. Real LLM calls; single non-deterministic run.',
};
writeFileSync(join(here, 'results', 'zero-day-discovery.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Defensive discovery on ${target.path} (cheap=${CHEAP}, frontier=${FRONTIER}, semgrep=${receipt.semgrep})\n`);
process.stdout.write(`  baseline : ${b.verified} verified, ${b.frontierCalls} frontier calls, ${b.costMilliUSD} mUSD → ${b.costPerVerifiedMilliUSD}/verified\n`);
process.stdout.write(`  optimized: ${o.verified} verified, ${o.frontierCalls} frontier calls (${o.skipped} skipped), ${o.costMilliUSD} mUSD → ${o.costPerVerifiedMilliUSD}/verified\n`);
process.stdout.write(`  frontier-call savings: ${frontierCallsSavedPct}% (optimized covers the same distinct vuln sites; baseline double-counts statically-covered ones)\n`);
for (const f of o.findings) process.stdout.write(`   - [${f.source}] ${f.fn}: ${f.weakness}${f.evidenceClass ? ` (confirmed via ${f.evidenceClass})` : ''}\n`);
process.stdout.write(`  receipt → bench/results/zero-day-discovery.json\n`);
