// SPDX-License-Identifier: MIT
//
// Terminal-Bench HARDEST-FIRST harness — the crack-the-tail scheduler. Reads the hardest-first
// manifest (build-manifest.mjs) and drives the OFFICIAL `tb` harness over a chosen slice, hardest
// tasks FIRST, then walks up the difficulty ladder. We do NOT re-implement scoring — `tb` builds
// the task containers, runs OUR agent (darwin_terminal_agent), then runs each task's OWN hidden
// tests and writes the authoritative results.json. After each band, score.py joins results +
// the $ sidecar into a Pareto row.
//
// WHY hardest-first: the proven pattern is to attack the residual tail first — if a cheap model
// can crack the hardest band at all, the easier bands are gravy; if it can't, we learn the ceiling
// cheaply without spending the easy-task budget. Bands run sequentially so the budget breaker can
// stop the climb the moment the spend cap is hit.
//
// Usage (local):
//   OPENROUTER_API_KEY=$(cat /tmp/.orkey) node hardest-first.mjs \
//     --manifest tbench-manifest.json --model deepseek/deepseek-chat \
//     --n 6 [--band hard] [--max-steps 30] [--max-cost 4] [--out runs/hardest-ds] \
//     [--concurrent 1] [--per-task-cost 1.5]
//
// --n N        : run the hardest N tasks (default 6). 0 = whole selected band(s).
// --band X     : restrict to a difficulty band (hard|medium|easy). default: all (still hardest-first).
// --ladder     : run band-by-band (hard, then medium, then easy), scoring after each (the climb).
// --dry        : print the plan + the exact `tb` command(s), run nothing.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const MANIFEST = rel(argv('--manifest', 'tbench-manifest.json'));
const MODEL = argv('--model', 'deepseek/deepseek-chat');
const N = parseInt(argv('--n', '6'), 10);
const BAND = argv('--band', '');
const MAX_STEPS = argv('--max-steps', '30');
const MAX_COST = parseFloat(argv('--max-cost', '4'));        // overall climb budget breaker (USD)
const PER_TASK_COST = argv('--per-task-cost', '1.5');         // per-task agent budget (passed to the agent)
const CONCURRENT = argv('--concurrent', '1');
const BASE_URL = argv('--base-url', '');                      // OpenAI-compatible endpoint override ($0 local ollama, etc.)
const OUT = rel(argv('--out', `runs/hardest-${MODEL.split('/').pop().replace(/[.:]/g, '-')}`));
const DRY = has('--dry');
const LADDER = has('--ladder');

const BANDS_ORDER = ['hard', 'medium', 'easy'];

function curSpendAbs() {
  try {
    const key = readFileSync('/tmp/.orkey', 'utf8').trim();
    const j = JSON.parse(execFileSync('curl', ['-sS', '-m12', 'https://openrouter.ai/api/v1/auth/key', '-H', `Authorization: Bearer ${key}`], { encoding: 'utf8' }));
    return +(+j.data.usage).toFixed(4);
  } catch { return null; }
}

function runBand(tasks, runDir, label) {
  if (!tasks.length) { console.log(`  (band ${label}: no tasks)`); return; }
  const taskArgs = tasks.flatMap((t) => ['-t', t.task_id]);
  const tbArgs = [
    'run', '-d', 'terminal-bench-core==0.1.1',
    ...taskArgs,
    '--agent-import-path', 'darwin_terminal_agent:DarwinTerminalAgent',
    '-k', `model=${MODEL}`, '-k', `max_steps=${MAX_STEPS}`, '-k', `max_cost=${PER_TASK_COST}`,
    ...(BASE_URL ? ['-k', `base_url=${BASE_URL}`] : []),
    '--n-concurrent', String(CONCURRENT),
    '--output-path', runDir, '--cleanup',
  ];
  console.log(`\n=== BAND ${label}: ${tasks.length} tasks (hardest-first) → ${runDir} ===`);
  for (const t of tasks) console.log(`   #${t.rank} ${t.task_id} [${t.difficulty}/${t.category}]`);
  if (DRY) { console.log(`   [dry] tb ${tbArgs.join(' ')}`); return; }
  try {
    execFileSync('tb', tbArgs, { stdio: 'inherit', env: process.env });
  } catch (e) {
    console.error(`   tb exited non-zero (band ${label}) — partial results may still be scored: ${e.message}`);
  }
  // score this band
  try {
    execFileSync('python3', [join(HERE, 'score.py'), runDir], { stdio: 'inherit', env: process.env });
  } catch (e) { console.error(`   score failed: ${e.message}`); }
}

function main() {
  if (!existsSync(MANIFEST)) { console.error(`manifest not found: ${MANIFEST} — run: node build-manifest.mjs`); process.exit(1); }
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  let tasks = m.tasks; // already hardest-first
  if (BAND) tasks = tasks.filter((t) => t.difficulty === BAND);
  if (N > 0) tasks = tasks.slice(0, N);

  if (!DRY) mkdirSync(OUT, { recursive: true });
  const startSpend = curSpendAbs();
  console.log(`HARDEST-FIRST  model=${MODEL}  band=${BAND || 'all'}  n=${tasks.length}  maxSteps=${MAX_STEPS}  perTask$=${PER_TASK_COST}  climbCap=$${MAX_COST}`);
  console.log(`start-spend abs $${startSpend} (probe budget breaker: stop the climb when delta >= $${MAX_COST})`);

  if (LADDER) {
    // run band-by-band, hardest band first; stop the climb if the spend breaker trips
    for (const band of BANDS_ORDER) {
      const bandTasks = tasks.filter((t) => t.difficulty === band);
      if (!bandTasks.length) continue;
      const s = curSpendAbs();
      if (s != null && startSpend != null && s - startSpend >= MAX_COST) {
        console.log(`\nBUDGET BREAKER: climb spend $${(s - startSpend).toFixed(2)} >= cap $${MAX_COST} — stopping before band ${band}.`);
        break;
      }
      runBand(bandTasks, join(OUT, band), band);
    }
  } else {
    runBand(tasks, OUT, BAND || `hardest-${tasks.length}`);
  }

  const endSpend = curSpendAbs();
  if (startSpend != null && endSpend != null) {
    console.log(`\n=== CLIMB SPEND: $${(endSpend - startSpend).toFixed(4)} (abs $${startSpend} → $${endSpend}) ===`);
  }
}

main();
