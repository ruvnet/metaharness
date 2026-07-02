// claude -p (headless Claude Code) as a SWE-bench solver — the CLEAN COMPARATOR.
// Runs Fable inside Claude Code's own agent loop (its real tools + prompt), isolating
// whether the darwin harness's text-JSON/step-cap is the bottleneck vs Fable's capability.
// Cost is on the Anthropic/Claude account (NOT OpenRouter). Bound via --max-turns + timeout.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const MANIFEST = argv('--manifest', 'pilot-sample-25.json');
const START = +argv('--start', 0);
const N = +argv('--n', 5);
const MODEL = argv('--model', 'claude-fable-5');
const MAX_TURNS = +argv('--max-turns', 40);
const TIMEOUT_MS = +argv('--timeout', 900) * 1000;
const OUT = argv('--out', 'predictions-claudep-fable.jsonl');

const insts = JSON.parse(readFileSync(MANIFEST, 'utf8')).instances.slice(START, N);
writeFileSync(OUT, ''); // truncate
let totalCost = 0;
const rows = [];

for (const inst of insts) {
  const work = mkdtempSync(join(tmpdir(), 'claudep-'));
  const t0 = Date.now();
  let patch = '', cost = 0, turns = 0, err = '';
  try {
    // shallow-fetch the repo at base_commit (fallback to deeper history)
    const g = (c) => execSync(c, { cwd: work, shell: '/bin/bash', stdio: 'ignore', timeout: 300000, maxBuffer: 1 << 28 });
    g('git init -q && git remote add origin https://github.com/' + inst.repo);
    try { g(`git fetch --depth 1 -q origin ${inst.base_commit} && git checkout -q FETCH_HEAD`); }
    catch { g(`git fetch --depth 200 -q origin && git checkout -q ${inst.base_commit}`); }

    const prompt = `You are fixing a bug in this repository. Edit the source code to resolve the issue below. Make the minimal change that fixes it. Do NOT edit test files. Do not run the test suite.\n\n--- ISSUE ---\n${inst.problem_statement}`;
    // Custom-endpoint routing (e.g. OpenRouter Anthropic API): set ANTHROPIC_MODEL via env + drop --model.
    const BASE = argv('--anthropic-base-url', '');
    const KEYFILE = argv('--api-key-file', '');            // x-api-key (meta-llm cog_ key)
    const AUTHFILE = argv('--auth-token-file', '');         // Bearer (OpenRouter key)
    const ORMODEL = argv('--anthropic-model', '');          // exact model via ANTHROPIC_MODEL (custom endpoint)
    const modelArg = ORMODEL ? '' : `--model ${MODEL}`;
    const cmd = `claude -p ${JSON.stringify(prompt)} ${modelArg} --max-turns ${MAX_TURNS} --dangerously-skip-permissions --output-format json`;
    const childEnv = { ...process.env };
    if (BASE) childEnv.ANTHROPIC_BASE_URL = BASE;
    if (KEYFILE) childEnv.ANTHROPIC_API_KEY = readFileSync(KEYFILE, 'utf8').trim();
    if (AUTHFILE) childEnv.ANTHROPIC_AUTH_TOKEN = readFileSync(AUTHFILE, 'utf8').trim();
    if (ORMODEL) childEnv.ANTHROPIC_MODEL = ORMODEL;
    const out = execSync(cmd, { cwd: work, shell: '/bin/bash', timeout: TIMEOUT_MS, maxBuffer: 1 << 28, env: childEnv }).toString();
    const res = JSON.parse(out);
    cost = res.total_cost_usd || 0; turns = res.num_turns || 0;
    patch = execSync('git diff', { cwd: work, shell: '/bin/bash', maxBuffer: 1 << 28 }).toString();
  } catch (e) {
    err = String(e.message || e).slice(0, 200);
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /**/ }
  }
  totalCost += cost;
  const sec = Math.round((Date.now() - t0) / 1000);
  rows.push({ instance_id: inst.instance_id, nonempty: !!patch.trim(), cost, turns, sec, err });
  writeFileSync(OUT, JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: 'claudep-fable', model_patch: patch }) + '\n', { flag: 'a' });
  console.error(`[${rows.length}/${N}] ${inst.instance_id} patch=${patch.trim() ? patch.length + 'ch' : 'EMPTY'} turns=${turns} $${cost.toFixed(3)} ${sec}s ${err ? 'ERR:' + err : ''}`);
}
writeFileSync(argv('--report', 'claudep-fable-report.json'), JSON.stringify({ model: MODEL, maxTurns: MAX_TURNS, n: rows.length, nonempty: rows.filter((r) => r.nonempty).length, totalCost_usd: +totalCost.toFixed(4), rows }, null, 2));
console.error(`\nDONE ${rows.length} | non-empty ${rows.filter((r) => r.nonempty).length}/${rows.length} | total $${totalCost.toFixed(2)} (on Anthropic account) | preds → ${OUT}`);
