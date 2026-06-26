// SPDX-License-Identifier: MIT
//
// LiveCodeBench SOLVER (ADR-LCB). Competitive-programming code generation, mirroring the official
// `lcb_runner` codegeneration prompt (SYSTEM_MESSAGE_GENERIC + generic question template). The emitted
// `code_list` is RAW EXECUTABLE PYTHON that the official `custom_evaluator` runs verbatim against hidden
// tests (it does NOT re-extract markdown), so the extractor here must produce the SAME executable string
// the official `extract_code` would.
//
// Two arms (same instances, clean delta):
//   (A) single-shot  : one cheap-base call per problem (the leaderboard-comparable baseline).
//   (B) --cascade    : cheap base on ALL problems; escalate to a REASONING model ONLY when the base
//                      (a) emits an empty/no-code extraction, OR (b) FAILS the problem's PUBLIC example
//                      tests. CONFORMANCE: public example tests = the ones shipped IN the problem statement
//                      (manifest.public_test_cases). The HIDDEN grading tests are NEVER run here — they
//                      belong to custom_evaluator for FINAL scoring only. Leakage-free by construction.
//
// Robust extraction (the §46 fix): cheap/reasoning models sometimes emit reasoning-prose with the real
// code NOT in the LAST fenced block (2 of the n=25 misses were exactly this). Instead of "last fenced
// block", pick the BEST python block: prefer the largest block that PARSES (py_compile via python3),
// falling back to the largest python-tagged block, falling back to the official last-fenced-block rule.
// Still byte-comparable to the official contract on the common case (single trailing block).
//
// Reuses the SWE-bench solver's OpenRouter client verbatim: --model, --base-url, --api-key-env,
// --concurrency worker pool, --max-cost budget cap, per-call usage.cost capture, JSON streaming.
//
// Output shape (custom_evaluator --custom_output_file): [{question_id, code_list:[code]}]
// Cost report: {model, escalateModel, n, totalCost_usd, escalatedCount, perProblem:[...]}
//
// Run (single-shot baseline, fixed extractor):
//   OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
//     solve-lcb.mjs --manifest lcb-v5.json --model deepseek/deepseek-chat \
//     --concurrency 4 --max-cost 6 --out lcb-single.json --cost-report lcb-single-cost.json
//
// Run (cascade, escalate to reasoner on empty-extraction OR public-test failure):
//   OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
//     solve-lcb.mjs --manifest lcb-v5.json --model deepseek/deepseek-chat \
//     --cascade --escalate-model deepseek/deepseek-r1-0528 \
//     --concurrency 4 --max-cost 12 --out lcb-cascade.json --cost-report lcb-cascade-cost.json
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync as wf, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const MODEL = argv('--model', 'deepseek/deepseek-chat');
const CASCADE = args.includes('--cascade');
const ESCALATE_MODEL = argv('--escalate-model', 'deepseek/deepseek-r1-0528');
const CONC = +argv('--concurrency', 4);
const MAX_COST = +argv('--max-cost', 12);
const LIMIT = +argv('--limit', 0); // 0 = all
const MAX_TOKENS = +argv('--max-tokens', 4096);
const ESCALATE_MAX_TOKENS = +argv('--escalate-max-tokens', 16384); // reasoner needs room for the CoT
const OUT = rel(argv('--out', 'lcb-out.json'));
const COST_REPORT = rel(argv('--cost-report', 'lcb-cost.json'));
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const CHAT_URL = `${BASE_URL}/chat/completions`;
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();

let manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'lcb-v5.json')), 'utf8')).instances;
if (LIMIT > 0) manifest = manifest.slice(0, LIMIT);

// --- official prompt mirror (lcb_runner/prompts/code_generation.py, OpenAIChat/DeepSeekAPI style) ---
const SYSTEM_MESSAGE_GENERIC = 'You are an expert Python programmer. You will be given a question (problem specification) and will generate a correct Python program that matches the specification and passes all tests.';
const FORMATTING_WITH_STARTER = 'You will use the following starter code to write the solution to the problem and enclose your code within delimiters.';
const FORMATTING_WITHOUT_STARTER = 'Read the inputs from stdin solve the problem and write the answer to stdout (do not directly test on the sample inputs). Enclose your code within delimiters as follows. Ensure that when the python program runs, it reads the inputs, runs the algorithm and writes output to STDOUT.';

function genericQuestionTemplate(q) {
  let prompt = `### Question:\n${q.question_content}\n\n`;
  if (q.starter_code) {
    prompt += `### Format: ${FORMATTING_WITH_STARTER}\n`;
    prompt += `\`\`\`python\n${q.starter_code}\n\`\`\`\n\n`;
  } else {
    prompt += `### Format: ${FORMATTING_WITHOUT_STARTER}\n`;
    prompt += '```python\n# YOUR CODE HERE\n```\n\n';
  }
  prompt += '### Answer: (use the provided format with backticks)\n\n';
  return prompt;
}

// --- ROBUST extractor (the §46 fix) ----------------------------------------------------------------
// Collect ALL fenced blocks (```...```), prefer python-tagged ones, then among candidates prefer the
// one that PARSES (py_compile) and is largest; fall back to the official last-fenced-block rule.
// Byte-identical to the official extractor on the common single-trailing-block case.

// Official last-fenced-block rule (lcb_runner/utils/extraction_utils.py) — exact fallback.
function extractLastFenced(modelOutput) {
  const lines = (modelOutput || '').split('\n');
  const idx = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].includes('```')) idx.push(i);
  if (idx.length < 2) return '';
  return lines.slice(idx[idx.length - 2] + 1, idx[idx.length - 1]).join('\n');
}

// Parse all fenced blocks; return [{lang, code}] in document order.
function allFencedBlocks(modelOutput) {
  const lines = (modelOutput || '').split('\n');
  const fences = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*```(.*)$/);
    if (m) fences.push({ i, lang: m[1].trim().toLowerCase() });
  }
  const blocks = [];
  for (let k = 0; k + 1 < fences.length; k += 2) {
    const open = fences[k], close = fences[k + 1];
    blocks.push({ lang: open.lang, code: lines.slice(open.i + 1, close.i).join('\n') });
  }
  return blocks;
}

// Does this code parse as Python? (py_compile via python3 -c, no execution). Cheap, leakage-free.
function pyParses(code) {
  if (!code || !code.trim()) return false;
  try {
    const r = spawnSync('python3', ['-c', 'import sys,py_compile,tempfile,os\nf=tempfile.NamedTemporaryFile("w",suffix=".py",delete=False);f.write(sys.stdin.read());f.close()\ntry:\n py_compile.compile(f.name,doraise=True)\n print("OK")\nexcept Exception as e:\n sys.exit(1)\nfinally:\n os.unlink(f.name)'], { input: code, timeout: 8000, encoding: 'utf8' });
    return r.status === 0;
  } catch { return false; }
}

// Heuristic "looks like the solution program" score so we don't pick a tiny snippet over the real answer.
function looksLikeSolution(code, isFunctional) {
  if (!code) return 0;
  let s = code.length; // bigger blocks usually the full program
  if (isFunctional) { if (/class\s+Solution\b/.test(code)) s += 100000; }
  else { if (/\b(input\(|sys\.stdin|stdin\.read|readline)\b/.test(code)) s += 100000; if (/\bprint\(/.test(code)) s += 50000; }
  if (/\bdef\b/.test(code)) s += 10000;
  return s;
}

function extractCode(modelOutput, isFunctional) {
  const official = extractLastFenced(modelOutput);
  const blocks = allFencedBlocks(modelOutput);
  if (blocks.length === 0) return official; // (== '' on <2 fences)

  // Candidate pool: python-tagged blocks if any, else all blocks.
  const py = blocks.filter((b) => b.lang === 'python' || b.lang === 'py' || b.lang === 'python3');
  const pool = py.length ? py : blocks;

  // 1) Prefer the official last-fenced block IF it parses and looks like a solution — keeps the common
  //    case byte-identical to the official contract.
  if (official && pyParses(official) && looksLikeSolution(official, isFunctional) >= 10000) return official;

  // 2) Among pool blocks that PARSE, take the highest solution-score (size + structure).
  const parsing = pool.filter((b) => pyParses(b.code));
  if (parsing.length) {
    parsing.sort((a, b) => looksLikeSolution(b.code, isFunctional) - looksLikeSolution(a.code, isFunctional));
    return parsing[0].code;
  }

  // 3) Nothing parses: take the highest solution-score block (size+structure), else official.
  const scored = [...pool].sort((a, b) => looksLikeSolution(b.code, isFunctional) - looksLikeSolution(a.code, isFunctional));
  if (scored.length && scored[0].code.trim()) return scored[0].code;
  return official;
}

async function callOR(model, messages, maxTokens) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0, usage: { include: true } }),
      });
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      const j = await res.json();
      if (j.error) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      return { content: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0, tokens: j.usage?.total_tokens ?? 0 };
    } catch { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
  }
  return { content: '', cost: 0, tokens: 0 };
}

// --- PUBLIC-test gate (leakage-free; mirrors the official testing_util I/O contracts) ---------------
// stdin: feed t.input on stdin, compare trimmed stdout to t.output.
// functional: parse fn_name from starter, args = [json.loads(line) for line in input.split("\n")],
//   expected = json.loads(output), normalize tuple->list, compare (== official grade_call).
// Returns {ok:true} | {ok:false, input, expected, got} | null (no safely-runnable signal).
const IMPORT_PRELUDE = 'import sys\nsys.setrecursionlimit(50000)\nfrom typing import *\nimport collections, heapq, bisect, math, itertools, functools, re, string\n';

function fnNameFor(q) {
  if (q.metadata && typeof q.metadata === 'object' && q.metadata.func_name) return q.metadata.func_name;
  // derive from starter: first "def <name>(" inside class Solution
  const m = (q.starter_code || '').match(/def\s+([A-Za-z_]\w*)\s*\(/);
  return m ? m[1] : null;
}

function runFunctionalTests(code, q, tests) {
  const fn = fnNameFor(q);
  if (!fn) return null;
  const dir = mkdtempSync(join(tmpdir(), 'lcb-fn-'));
  const f = join(dir, 'sol.py');
  // harness: load solution, instantiate Solution, call method per test, print PASS/FAIL JSON.
  const harness = `${IMPORT_PRELUDE}
import json
${code}

_tests = json.loads(sys.stdin.read())
for _i, _t in enumerate(_tests):
    try:
        _args = [json.loads(_l) for _l in _t["input"].split("\\n")]
        _exp = json.loads(_t["output"])
        _sol = Solution()
        _got = getattr(_sol, ${JSON.stringify(fn)})(*_args)
        if isinstance(_got, tuple):
            _got = list(_got)
        if _got != _exp:
            print(json.dumps({"ok": False, "input": _t["input"], "expected": _t["output"], "got": str(_got)[:500]}))
            sys.exit(0)
    except Exception as _e:
        print(json.dumps({"ok": False, "input": _t["input"], "expected": _t["output"], "got": "RUNTIME ERROR: " + repr(_e)[:400]}))
        sys.exit(0)
print(json.dumps({"ok": True}))
`;
  wf(f, harness);
  try {
    const out = execFileSync('python3', [f], { input: JSON.stringify(tests), timeout: 8000, maxBuffer: 1 << 24 }).toString();
    const last = out.trim().split('\n').filter(Boolean).pop();
    return JSON.parse(last);
  } catch (e) {
    return { ok: false, input: '(harness)', expected: '(see tests)', got: `HARNESS ERROR: ${String(e.stderr || e.message || e).slice(0, 300)}` };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

function runStdinTests(code, tests) {
  const stdinTests = tests.filter((t) => (t.testtype || t.testType) === 'stdin' && t.input != null && t.output != null);
  if (stdinTests.length === 0) return null;
  const dir = mkdtempSync(join(tmpdir(), 'lcb-pub-'));
  const f = join(dir, 'sol.py'); wf(f, code);
  try {
    for (const t of stdinTests) {
      try {
        const out = execFileSync('python3', [f], { input: String(t.input), timeout: 6000, maxBuffer: 1 << 24 }).toString();
        if (out.trim() !== String(t.output).trim()) return { ok: false, input: t.input, expected: t.output, got: out.trim().slice(0, 500) };
      } catch (e) {
        return { ok: false, input: t.input, expected: t.output, got: `RUNTIME ERROR: ${String(e.stderr || e.message || e).slice(0, 400)}` };
      }
    }
    return { ok: true };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// Run PUBLIC example tests only. Returns the same shape regardless of mode; null = no runnable signal.
function runPublicTests(code, q) {
  const tests = q.public_test_cases;
  if (!Array.isArray(tests) || tests.length === 0 || !code) return null;
  const isFunctional = !!q.starter_code;
  return isFunctional ? runFunctionalTests(code, q, tests) : runStdinTests(code, tests);
}

async function solveOne(q) {
  const isFunctional = !!q.starter_code;
  const messages = [
    { role: 'system', content: SYSTEM_MESSAGE_GENERIC },
    { role: 'user', content: genericQuestionTemplate(q) },
  ];
  const r1 = await callOR(MODEL, messages, MAX_TOKENS);
  let code = extractCode(r1.content, isFunctional);
  let cost = r1.cost, tokens = r1.tokens;
  let escalated = false, escalateTrigger = null, escalateModel = null;
  let baseEmpty = !code;
  let basePublic = null; // {ok} of the cheap base, for reporting

  if (CASCADE) {
    // Decide escalation: (a) empty extraction, OR (b) fails public example tests.
    let needEscalate = false;
    if (!code) { needEscalate = true; escalateTrigger = 'empty-extraction'; }
    else {
      basePublic = runPublicTests(code, q);
      if (basePublic && basePublic.ok === false) {
        needEscalate = true;
        escalateTrigger = (basePublic.got || '').startsWith('RUNTIME ERROR') || (basePublic.got || '').startsWith('HARNESS ERROR') ? 'public-runtime' : 'public-wrong';
      }
    }
    if (needEscalate) {
      const r2 = await callOR(ESCALATE_MODEL, messages, ESCALATE_MAX_TOKENS);
      const code2 = extractCode(r2.content, isFunctional);
      cost += r2.cost; tokens += r2.tokens;
      escalated = true; escalateModel = ESCALATE_MODEL;
      if (code2) {
        // Prefer the escalated candidate when it (i) is non-empty and the base was empty, OR
        // (ii) passes public tests where the base failed. If the base passed public but we still
        // escalated (we don't — gate is failure-only), this branch never overrides a passing base.
        if (baseEmpty) { code = code2; }
        else {
          const v2 = runPublicTests(code2, q);
          // Adopt the reasoner candidate if it now passes public (or we have no signal — give the
          // stronger model the benefit on the no-signal functional case, since base already failed).
          if (!v2 || v2.ok) code = code2;
          else code = code2; // base failed public too; reasoner is the stronger prior → adopt anyway
        }
      } else if (baseEmpty) {
        // reasoner also produced nothing extractable — keep empty (will FAIL scoring honestly)
        code = code || '';
      }
      // if reasoner gave nothing AND base had non-empty (failing) code, keep base code (already in `code`).
    }
  }

  return {
    question_id: q.question_id, code, cost, tokens,
    escalated, escalateTrigger, escalateModel,
    baseEmpty, basePublicOk: basePublic ? basePublic.ok : null,
    difficulty: q.difficulty, platform: q.platform, mode: isFunctional ? 'functional' : 'stdin',
  };
}

// --- concurrency worker pool with --max-cost budget cap ---
const results = new Array(manifest.length);
let totalCost = 0, next = 0, stopped = false;
async function worker() {
  while (true) {
    if (stopped) return;
    const i = next++;
    if (i >= manifest.length) return;
    if (totalCost >= MAX_COST) { stopped = true; console.error(`!! max-cost $${MAX_COST} reached — stopping (solved ${i}/${manifest.length})`); return; }
    const q = manifest[i];
    const r = await solveOne(q);
    totalCost += r.cost;
    results[i] = r;
    const esc = r.escalated ? `ESCALATED(${r.escalateTrigger})` : '';
    console.error(`[${i + 1}/${manifest.length}] ${r.question_id} ${r.mode}/${r.difficulty} code=${r.code ? r.code.length + 'B' : 'EMPTY'} ${esc} $${r.cost.toFixed(5)} (cum $${totalCost.toFixed(4)})`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, manifest.length) }, worker));

const done = results.filter(Boolean);
// custom_evaluator output: [{question_id, code_list:[code]}]
const out = done.map((r) => ({ question_id: r.question_id, code_list: [r.code || ''] }));
writeFileSync(OUT, JSON.stringify(out, null, 2));

const costReport = {
  model: MODEL, cascade: CASCADE, escalateModel: CASCADE ? ESCALATE_MODEL : null,
  n: done.length,
  totalCost_usd: Math.round(totalCost * 1e6) / 1e6,
  costPerProblem_usd: Math.round((totalCost / done.length) * 1e6) / 1e6,
  emptyCount: done.filter((r) => !r.code).length,
  escalatedCount: done.filter((r) => r.escalated).length,
  escalationRate: Math.round((done.filter((r) => r.escalated).length / done.length) * 1000) / 1000,
  perProblem: done.map((r) => ({
    question_id: r.question_id, cost_usd: Math.round(r.cost * 1e6) / 1e6, tokens: r.tokens,
    escalated: r.escalated, escalateTrigger: r.escalateTrigger,
    difficulty: r.difficulty, platform: r.platform, mode: r.mode, empty: !r.code,
  })),
};
writeFileSync(COST_REPORT, JSON.stringify(costReport, null, 2));
console.error(`\nDONE ${done.length} problems | empty: ${costReport.emptyCount} | escalated: ${costReport.escalatedCount} (${(costReport.escalationRate * 100).toFixed(0)}%) | $${costReport.totalCost_usd} ($${costReport.costPerProblem_usd}/problem)`);
console.error(`outputs → ${OUT}\ncost    → ${COST_REPORT}`);
