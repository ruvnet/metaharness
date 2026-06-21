// SPDX-License-Identifier: MIT
//
// REAL Darwin escalation acceptance test (the project thesis + GLM-as-open-frontier
// lane). A genuine generate → VERIFY → escalate loop on small coding tasks with
// hidden unit tests, measured on the metric that matters: COST PER PASSING TASK,
// not raw benchmark score. Optional (skips with exit 0 when OPENROUTER_API_KEY is
// absent); not part of the deterministic suite; bounded request cap; key from env
// only (never logged). Generated code is run in an ISOLATED python subprocess
// (`python3 -I -B`, no network use, hard timeout, clean env without the API key).
//
// Lanes:
//   cheap-only     : the cheap model attempts every task.
//   frontier-only  : GLM-5.2 attempts every task (the open-frontier baseline).
//   escalation     : cheap first; only on a VERIFIER failure do we escalate to GLM.
//
// Run: npm run -w @metaharness/projects build && node bench/escalation-llm.bench.mjs
// Env: CHEAP_MODEL (default qwen/qwen-2.5-7b-instruct), FRONTIER_MODEL (default z-ai/glm-5.2)

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable, DEFAULT_FRONTIER_MODEL } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!openRouterAvailable()) {
  process.stdout.write('OPENROUTER_API_KEY absent — skipping the real escalation bench.\n');
  process.exit(0);
}

// Per-model pricing ($/M tokens), from OpenRouter at time of writing (for cost math).
const PRICING = {
  'qwen/qwen-2.5-7b-instruct': { in: 0.04, out: 0.10 },
  'qwen/qwen3-235b-a22b-2507': { in: 0.09, out: 0.10 },
  'z-ai/glm-5.2': { in: 1.2, out: 4.1 },
};
const CHEAP = process.env.CHEAP_MODEL || 'qwen/qwen-2.5-7b-instruct';
const FRONTIER = process.env.FRONTIER_MODEL || DEFAULT_FRONTIER_MODEL;

// ── Tasks: small, objectively checkable Python functions; mixed difficulty so the
//    cheap model nails the easy ones and an open-frontier model earns its cost on
//    the hard ones. tests are [args, expected]. ──
const TASKS = [
  { fn: 'factorial', desc: 'factorial(n): the factorial of a non-negative integer n', tests: [[[0], 1], [[5], 120], [[1], 1]] },
  { fn: 'reverse_string', desc: 'reverse_string(s): s reversed', tests: [[['abc'], 'cba'], [[''], ''], [['ab'], 'ba']] },
  { fn: 'is_prime', desc: 'is_prime(n): True iff n is prime', tests: [[[2], true], [[1], false], [[17], true], [[15], false]] },
  { fn: 'fibonacci', desc: 'fibonacci(n): the nth Fibonacci number, 0-indexed (fib(0)=0, fib(1)=1)', tests: [[[0], 0], [[1], 1], [[7], 13], [[10], 55]] },
  { fn: 'sum_list', desc: 'sum_list(xs): the sum of a list of integers (empty list -> 0)', tests: [[[[1, 2, 3]], 6], [[[]], 0], [[[-1, 1]], 0]] },
  { fn: 'is_palindrome', desc: 'is_palindrome(s): True iff s reads the same forwards and backwards', tests: [[['racecar'], true], [['ab'], false], [[''], true]] },
  { fn: 'gcd', desc: 'gcd(a, b): the greatest common divisor of two positive integers', tests: [[[12, 8], 4], [[17, 5], 1], [[100, 10], 10]] },
  { fn: 'roman_to_int', desc: 'roman_to_int(s): convert a Roman numeral string to an integer', tests: [[['III'], 3], [['IV'], 4], [['MCMXciv'.toUpperCase()], 1994], [['LVIII'], 58]] },
  { fn: 'longest_common_prefix', desc: 'longest_common_prefix(strs): the longest common prefix of a list of strings ("" if none)', tests: [[[['flower', 'flow', 'flight']], 'fl'], [[['dog', 'cat']], ''], [[['a']], 'a']] },
  { fn: 'two_sum', desc: 'two_sum(nums, target): return indices [i, j] (i<j) of the two numbers that add to target; exactly one solution exists', tests: [[[[2, 7, 11, 15], 9], [0, 1]], [[[3, 2, 4], 6], [1, 2]], [[[3, 3], 6], [0, 1]]] },
];

const cheap = new OpenRouterClient({ model: CHEAP, maxRequests: 60, temperature: 0 });
const frontier = new OpenRouterClient({ model: FRONTIER, maxRequests: 60, temperature: 0 });
const SYSTEM = { role: 'system', content: 'You are an expert programmer. Output ONLY a single self-contained Python function definition — no prose, no tests, no markdown fences.' };

function extractCode(raw) {
  const fenced = raw.match(/```(?:python)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}

/** Run generated code against the task's hidden tests in an isolated subprocess. */
function verify(code, task) {
  const dir = mkdtempSync(join(tmpdir(), 'darwin-escal-'));
  const file = join(dir, 'cand.py');
  const driver = `${code}

import json
TESTS = ${JSON.stringify(task.tests)}
try:
    ok = True
    for args, expected in TESTS:
        if ${task.fn}(*args) != expected:
            ok = False
            break
    print(json.dumps({"passed": bool(ok)}))
except Exception as e:
    print(json.dumps({"passed": False, "error": type(e).__name__}))
`;
  writeFileSync(file, driver);
  try {
    const out = execFileSync('python3', ['-I', '-B', file], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' }, // clean env — no API key in the child
    });
    return JSON.parse(out.trim().split('\n').pop()).passed === true;
  } catch {
    return false; // timeout / crash / syntax error => not passing
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function attempt(client, task) {
  const r = await client.chatJSON([SYSTEM, { role: 'user', content: `Write Python: ${task.desc}. The function must be named exactly \`${task.fn}\`.` }], { maxTokens: 500 });
  return verify(extractCode(r.raw), task);
}

const costOf = (client) => {
  const s = client.stats();
  const p = PRICING[client.model] ?? { in: 0, out: 0 };
  return +((s.promptTokens / 1e6) * p.in + (s.completionTokens / 1e6) * p.out).toFixed(6);
};

// ── Lane 1: cheap-only. ──
let cheapPass = 0;
const cheapFailed = [];
for (const t of TASKS) {
  const ok = await attempt(cheap, t);
  if (ok) cheapPass += 1; else cheapFailed.push(t);
}
const cheapOnlyCost = costOf(cheap);

// ── Lane 2: frontier-only (GLM-5.2). ──
let frontierPass = 0;
for (const t of TASKS) if (await attempt(frontier, t)) frontierPass += 1;
const frontierOnlyCost = costOf(frontier);

// ── Lane 3: escalation — cheap already attempted all; escalate ONLY the failures. ──
// (cheap cost already spent above; escalation adds GLM calls only for cheapFailed.)
const frontierBefore = { ...frontier.stats() };
let escalatedPass = cheapPass; // tasks cheap already passed
let escalatedRecovered = 0;
for (const t of cheapFailed) if (await attempt(frontier, t)) { escalatedPass += 1; escalatedRecovered += 1; }
// Escalation GLM cost = GLM tokens spent in this phase only.
const sNow = frontier.stats();
const pGlm = PRICING[FRONTIER];
const escalationGlmCost = +(((sNow.promptTokens - frontierBefore.promptTokens) / 1e6) * pGlm.in + ((sNow.completionTokens - frontierBefore.completionTokens) / 1e6) * pGlm.out).toFixed(6);
const escalationCost = +(cheapOnlyCost + escalationGlmCost).toFixed(6);

const cpp = (cost, passes) => (passes > 0 ? +(cost / passes).toFixed(6) : null);
const n = TASKS.length;
const receipt = {
  experiment: 'real Darwin escalation acceptance test — cost per passing task',
  cheapModel: CHEAP,
  frontierModel: FRONTIER,
  tasks: n,
  lanes: {
    cheapOnly: { passed: cheapPass, of: n, costUSD: cheapOnlyCost, costPerPassingTaskUSD: cpp(cheapOnlyCost, cheapPass) },
    frontierOnly: { passed: frontierPass, of: n, costUSD: frontierOnlyCost, costPerPassingTaskUSD: cpp(frontierOnlyCost, frontierPass) },
    escalation: { passed: escalatedPass, of: n, recoveredByFrontier: escalatedRecovered, costUSD: escalationCost, costPerPassingTaskUSD: cpp(escalationCost, escalatedPass) },
  },
  note: 'Real LLM calls; single non-deterministic run. "Passing" = generated function passes hidden unit tests run in an isolated python subprocess. Cost from token usage x OpenRouter pricing.',
};
writeFileSync(join(here, 'results', 'escalation-llm.json'), JSON.stringify(receipt, null, 2) + '\n');

const L = receipt.lanes;
process.stdout.write(`Darwin escalation acceptance test (${n} tasks): cheap=${CHEAP} frontier=${FRONTIER}\n`);
process.stdout.write(`  cheap-only    : ${L.cheapOnly.passed}/${n} pass, $${L.cheapOnly.costUSD} → $${L.cheapOnly.costPerPassingTaskUSD}/passing\n`);
process.stdout.write(`  frontier-only : ${L.frontierOnly.passed}/${n} pass, $${L.frontierOnly.costUSD} → $${L.frontierOnly.costPerPassingTaskUSD}/passing\n`);
process.stdout.write(`  escalation    : ${L.escalation.passed}/${n} pass (+${escalatedRecovered} recovered), $${L.escalation.costUSD} → $${L.escalation.costPerPassingTaskUSD}/passing\n`);
process.stdout.write(`  receipt → bench/results/escalation-llm.json\n`);
