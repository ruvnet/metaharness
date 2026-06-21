#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// darwin-discover — thin CLI over the end-to-end discovery PIPELINE (src/pipeline.ts).
//
// Takes a single .py file, builds REAL discovery lanes from OpenRouter (cheap
// triage + frontier propose) and an ISOLATED `python3 -I -B` execution verifier
// (the anti-hallucination spine), runs the pipeline on that one target, and prints
// the verified findings + total cost + cost ledger by kind.
//
// Strictly DEFENSIVE: it proves a weakness EXISTS and emits only the exception
// CLASS — never the proof input / exploit. Optional: with no OPENROUTER_API_KEY it
// prints a clear message and exits 0. The lane wiring mirrors
// bench/zero-day-discovery.bench.mjs.
//
// Usage: node bin/darwin-discover.mjs path/to/target.py
// Env:   OPENROUTER_API_KEY (required to run), CHEAP_MODEL, FRONTIER_MODEL

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  OpenRouterClient,
  openRouterAvailable,
  tryParseJson,
  runDiscoveryPipeline,
  DEFAULT_CHEAP_MODEL,
  DEFAULT_FRONTIER_MODEL,
} from '../dist/index.js';

const file = process.argv[2];
if (!file) {
  process.stderr.write('Usage: node bin/darwin-discover.mjs <path/to/target.py>\n');
  process.exit(2);
}
if (!file.endsWith('.py')) {
  process.stderr.write(`Expected a .py file, got: ${file}\n`);
  process.exit(2);
}

if (!openRouterAvailable()) {
  process.stdout.write(
    'OPENROUTER_API_KEY absent — set it to run the real discovery pipeline. Exiting cleanly.\n',
  );
  process.exit(0);
}

const source = readFileSync(file, 'utf8');
const CHEAP = process.env.CHEAP_MODEL || DEFAULT_CHEAP_MODEL;
const FRONTIER = process.env.FRONTIER_MODEL || DEFAULT_FRONTIER_MODEL;
// Milli-USD pricing for the cost ledger (prompt/completion per 1M tokens).
const PRICING = {
  'qwen/qwen-2.5-7b-instruct': { in: 0.04, out: 0.1 },
  'qwen/qwen3-235b-a22b-2507': { in: 0.09, out: 0.1 },
  'z-ai/glm-5.2': { in: 1.2, out: 4.1 },
};

// Cheap + frontier OpenRouter clients (budget-guarded, temperature 0 = deterministic-ish).
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

// Cheap triage lane: rank functions that may crash or are injection sinks.
const triage = async (t) => {
  const r = await cheap.chatJSON(
    [
      { role: 'system', content: 'You are a security code reviewer. Output ONLY JSON.' },
      {
        role: 'user',
        content: `List functions in this Python module that can crash on some input (raise an unhandled exception) or are injection sinks. Return a JSON array of {"fn": name, "weakness": "short CWE/desc", "rationale": "why"}.\n\n${t.source}`,
      },
    ],
    { maxTokens: 400 },
  );
  const arr = tryParseJson(r.raw);
  return Array.isArray(arr)
    ? arr
        .filter((c) => c && typeof c.fn === 'string')
        .map((c) => ({ fn: c.fn, weakness: String(c.weakness ?? 'unknown'), rationale: String(c.rationale ?? '') }))
    : [];
};

// Frontier propose lane: ONE concrete argument list that makes the fn raise.
const propose = async (t, c) => {
  const r = await frontier.chatJSON(
    [
      { role: 'system', content: 'You are a precise security analyst. Output ONLY JSON.' },
      {
        role: 'user',
        content: `In this Python module, give ONE concrete argument list that makes \`${c.fn}\` raise an UNHANDLED exception (demonstrating it is not total). Return JSON {"fn": "${c.fn}", "args": [...], "expectedProblem": "ExceptionName"}. If you cannot, return {"fn":"${c.fn}","args":null}.\n\n${t.source}`,
      },
    ],
    { maxTokens: 250 },
  );
  const p = tryParseJson(r.raw);
  if (!p || !Array.isArray(p.args)) return null;
  return { fn: c.fn, args: p.args, expectedProblem: String(p.expectedProblem ?? '') };
};

// Isolated execution verifier: run the proof under `python3 -I -B` in a temp dir
// with a clean env (no API key in the child). An unhandled exception confirms the
// weakness; we keep only the exception CLASS (defensive — proof input discarded).
const verify = (t, proof) => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-verify-'));
  const candidate = join(dir, 'cand.py');
  writeFileSync(
    candidate,
    `${t.source}

import json, sys
ARGS = json.loads(sys.argv[1])
try:
    ${proof.fn}(*ARGS)
    print(json.dumps({"triggered": False}))
except Exception as e:
    print(json.dumps({"triggered": True, "evidenceClass": type(e).__name__}))
`,
  );
  try {
    const out = execFileSync('python3', ['-I', '-B', candidate, JSON.stringify(proof.args)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
    });
    const res = JSON.parse(out.trim().split('\n').pop());
    return { triggered: res.triggered === true, evidenceClass: res.evidenceClass };
  } catch {
    return { triggered: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const target = { path: basename(file), language: 'python', source };
const result = await runDiscoveryPipeline(
  [{ id: target.path, target }],
  { triage, propose, verify, cost },
);

const t0 = result.perTarget[0];
process.stdout.write(`\nDefensive discovery on ${target.path} (cheap=${CHEAP}, frontier=${FRONTIER})\n`);
process.stdout.write(`  lane: ${t0.lane}   verified findings: ${t0.verified}\n`);
if (t0.findings.length === 0) {
  process.stdout.write('  (no execution-verified weaknesses found)\n');
} else {
  for (const f of t0.findings) {
    const ev = f.evidenceClass ? ` (confirmed via ${f.evidenceClass})` : '';
    const sev = f.severity ? ` [${f.severity}]` : '';
    process.stdout.write(`   - [${f.source}]${sev} ${f.fn}: ${f.weakness}${ev}\n`);
  }
}
process.stdout.write(`  total cost: ${result.totalCostUnits.toFixed(3)} mUSD\n`);
process.stdout.write(`  cost ledger by kind: ${JSON.stringify(result.ledgerByKind)}\n`);
process.stdout.write('  (defensive: proof inputs redacted; only the exception class is emitted)\n');
