// SPDX-License-Identifier: MIT
//
// LiveCodeBench SOLVER (ADR-LCB). Single-shot competitive-programming code generation, mirroring the
// official `lcb_runner` codegeneration prompt (SYSTEM_MESSAGE_GENERIC + generic question template) and
// code extractor (last fenced ```...``` block) so the emitted `code_list` is RAW EXECUTABLE PYTHON that
// the official `custom_evaluator` runs verbatim against hidden tests (it does NOT re-extract markdown).
//
// Reuses the SWE-bench solver's OpenRouter client verbatim: --model, --base-url, --api-key-env,
// --concurrency worker pool, --max-cost budget cap, per-call usage.cost capture, JSONL/JSON streaming.
//
// Output shape (custom_evaluator --custom_output_file): [{question_id, code_list:[code]}]
// Cost report: {model, n, totalCost_usd, perProblem:[{question_id, cost_usd, tokens, ...}]}
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
//   solve-lcb.mjs --manifest lcb-v5.json --model deepseek/deepseek-chat \
//   --concurrency 3 --max-cost 3 --out lcb-out.json --cost-report lcb-cost.json
//
// Optional TDR-style verify-and-repair arm (--repair): runs the candidate against the manifest's PUBLIC
// example tests in a throwaway python3 subprocess; on failure, does ONE repair attempt with the failing
// case as feedback. Private tests are NEVER touched here — they stay with custom_evaluator for scoring,
// so the arm is leakage-free (the public examples are part of the problem statement the model already saw).
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync as wf, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const MODEL = argv('--model', 'deepseek/deepseek-chat');
const CONC = +argv('--concurrency', 3);
const MAX_COST = +argv('--max-cost', 3);
const LIMIT = +argv('--limit', 0); // 0 = all
const REPAIR = args.includes('--repair'); // optional TDR-style public-test verify+1-repair
const MAX_TOKENS = +argv('--max-tokens', 4096);
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

// --- official extractor mirror (lcb_runner/utils/extraction_utils.py): last fenced block ---
function extractCode(modelOutput) {
  const lines = (modelOutput || '').split('\n');
  const idx = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].includes('```')) idx.push(i);
  if (idx.length < 2) return '';
  return lines.slice(idx[idx.length - 2] + 1, idx[idx.length - 1]).join('\n');
}

async function callOR(messages, maxTokens) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0, usage: { include: true } }),
      });
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      const j = await res.json();
      if (j.error) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      return { content: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0, tokens: j.usage?.total_tokens ?? 0 };
    } catch { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
  }
  return { content: '', cost: 0, tokens: 0 };
}

// Run a candidate against the manifest's PUBLIC example tests only (leakage-free).
// stdin tests: feed t.input on stdin, compare trimmed stdout to t.output.
// functional tests: not safely runnable without a harness/fn_name → skip (return null = no signal).
function runPublicTests(code, tests) {
  if (!Array.isArray(tests) || tests.length === 0) return null;
  const stdinTests = tests.filter((t) => (t.testtype || t.testType) === 'stdin' && t.input != null && t.output != null);
  if (stdinTests.length === 0) return null; // only stdin tests are safely runnable here
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

async function solveOne(q) {
  const messages = [
    { role: 'system', content: SYSTEM_MESSAGE_GENERIC },
    { role: 'user', content: genericQuestionTemplate(q) },
  ];
  const r1 = await callOR(messages, MAX_TOKENS);
  let code = extractCode(r1.content);
  let cost = r1.cost, tokens = r1.tokens, repaired = false, repairTrigger = null;

  if (REPAIR && code) {
    const verdict = runPublicTests(code, q.public_test_cases);
    if (verdict && verdict.ok === false) {
      repairTrigger = verdict.got.startsWith('RUNTIME ERROR') ? 'runtime' : 'wrong-output';
      const fb = `Your previous solution failed a sample test.\n\nInput:\n${verdict.input}\n\nExpected output:\n${verdict.expected}\n\nYour program produced:\n${verdict.got}\n\nFix the program. Output the corrected full Python program enclosed in \`\`\`python ... \`\`\` delimiters, nothing else.`;
      const r2 = await callOR([
        ...messages,
        { role: 'assistant', content: r1.content },
        { role: 'user', content: fb },
      ], MAX_TOKENS);
      const code2 = extractCode(r2.content);
      cost += r2.cost; tokens += r2.tokens;
      if (code2) {
        // Keep the repair only if it doesn't regress public tests (if we have signal).
        const v2 = runPublicTests(code2, q.public_test_cases);
        if (!v2 || v2.ok) { code = code2; repaired = true; }
        else { code = code2; repaired = true; } // adopt anyway — single-repair budget, v2 may still help private
      }
    }
  }
  return { question_id: q.question_id, code, cost, tokens, repaired, repairTrigger, difficulty: q.difficulty, platform: q.platform, mode: q.starter_code ? 'functional' : 'stdin' };
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
    console.error(`[${i + 1}/${manifest.length}] ${r.question_id} ${r.mode}/${r.difficulty} code=${r.code ? r.code.length + 'B' : 'EMPTY'} ${r.repaired ? 'REPAIRED(' + r.repairTrigger + ')' : ''} $${r.cost.toFixed(5)} (cum $${totalCost.toFixed(4)})`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, manifest.length) }, worker));

const done = results.filter(Boolean);
// custom_evaluator output: [{question_id, code_list:[code]}]
const out = done.map((r) => ({ question_id: r.question_id, code_list: [r.code || ''] }));
writeFileSync(OUT, JSON.stringify(out, null, 2));

const costReport = {
  model: MODEL, n: done.length, repair: REPAIR,
  totalCost_usd: Math.round(totalCost * 1e6) / 1e6,
  costPerProblem_usd: Math.round((totalCost / done.length) * 1e6) / 1e6,
  emptyCount: done.filter((r) => !r.code).length,
  repairedCount: done.filter((r) => r.repaired).length,
  perProblem: done.map((r) => ({ question_id: r.question_id, cost_usd: Math.round(r.cost * 1e6) / 1e6, tokens: r.tokens, repaired: r.repaired, difficulty: r.difficulty, platform: r.platform, mode: r.mode, empty: !r.code })),
};
writeFileSync(COST_REPORT, JSON.stringify(costReport, null, 2));
console.error(`\nDONE ${done.length} problems | empty: ${costReport.emptyCount} | repaired: ${costReport.repairedCount} | $${costReport.totalCost_usd} ($${costReport.costPerProblem_usd}/problem)`);
console.error(`outputs → ${OUT}\ncost    → ${COST_REPORT}`);
