// Runner subprocesses for evaluator.mjs: one calibrate.py call = one 4-seed block of one cell.
//  - Each runner is spawned as its own process GROUP (detached), so a timeout, a SIGTERM/SIGINT of the evaluator,
//    or the evaluator's own --deadline-ms kills the runner and anything it started, instead of leaving it on the GPU.
//  - A block is accepted only if the runner exited 0, wrote an orchestration receipt with available === true, and
//    has no infra episode (timeouts/provider failures are not policy outcomes; the arena trains on valid episodes).
//    Such a block is re-run once (fresh output file); if it still fails the cell fails and NOTHING is cached.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { knobArgs } from './cells.mjs';
import { scoreCell } from './fitness.mjs';
import { fakeRunnerRows } from './fake-rows.mjs';
import { RUNNER_FIXED } from './provenance.mjs';

const KILL_GRACE_MS = 10_000;
const groups = new Set();
let stopped = false;
const log = (msg) => process.stderr.write(`[darwin-eval] ${msg}\n`);

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

/** Send `signal` to every live runner process group. Returns the pids signalled. */
export function killRunnerGroups(signal = 'SIGTERM') {
  return [...groups].filter((pid) => signalGroup(pid, signal));
}
export const liveRunnerGroups = () => [...groups];

/** Abort path: refuse every further spawn (retries included), then signal the live groups. */
export function stopRunners(signal = 'SIGTERM') {
  stopped = true;
  return killRunnerGroups(signal);
}

/** Run one runner as its own process group; on timeout SIGTERM the group, SIGKILL it after a grace period. */
export function runProcess(cmd, args, env, timeoutMs) {
  if (stopped) return Promise.resolve({ code: -1, tail: 'aborted: evaluator is shutting down' });
  return new Promise((done) => {
    const child = spawn(cmd, args, { env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) groups.add(child.pid);
    let tail = ''; let timedOut = false; let hard = null;
    const keep = (chunk) => { tail = (tail + chunk.toString('utf8')).slice(-2000); };
    child.stdout.on('data', (c) => { keep(c); process.stderr.write(c); });
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, 'SIGTERM');
      hard = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    const finish = (result) => {
      clearTimeout(timer); clearTimeout(hard);
      if (timedOut) signalGroup(child.pid, 'SIGKILL'); // stragglers left in the group after the leader exited
      groups.delete(child.pid);
      done(result);
    };
    child.on('error', (e) => finish({ code: -1, tail: `spawn failed: ${e.message}` }));
    child.on('close', (code, signal) => finish({ code: code ?? -1, tail: timedOut ? `timed out after ${timeoutMs}ms` : signal ? `killed by ${signal}` : tail }));
  });
}

export function runnerArgv(o, cell, seed, output) {
  return [o.runner, '--execute', '--base-url', o.baseUrl, '--model', o.model, '--model-revision', o.modelRevision,
    '--task-id', cell.family, '--difficulty', String(cell.difficulty), '--max-steps', String(RUNNER_FIXED.maxSteps),
    '--max-tokens', String(Math.min(cell.budget, RUNNER_FIXED.maxTokensCap)), '--request-timeout', String(RUNNER_FIXED.requestTimeoutS),
    '--max-total-tokens', String(o.maxTotalTokens), '--accounting', RUNNER_FIXED.accounting,
    '--episode-completion-tokens', String(cell.budget), '--episode-context-tokens', String(o.contextTokens),
    '--tokenizer-json', o.tokenizerJson, '--tokenizer-sha256', o.tokenizerSha256, '--seed', String(seed),
    '--thinking', o.thinking, '--output', output, ...knobArgs(cell)];
}

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Deterministic problems (wrong rows for the cell) throw; transient ones (infra, no receipt) are returned for a retry. */
export function blockProblem(rows, cell, o) {
  const episodes = rows.filter((r) => r.type === 'episode');
  if (episodes.length !== 4) throw new Error(`runner block has ${episodes.length} episodes, expected 4`);
  if (episodes.some((e) => e.task_id !== cell.family || e.difficulty !== cell.difficulty)) throw new Error('episode rows do not match the cell');
  const plans = rows.filter((r) => r.type === 'plan').map((r) => r.plan);
  if (plans.length !== 1) throw new Error(`runner block has ${plans.length} plan rows, expected 1`);
  const budget = plans[0]?.task_token_budgets?.[cell.family];
  if (plans[0]?.difficulty !== cell.difficulty || budget?.completion_tokens !== cell.budget || budget?.context_tokens !== o.contextTokens) {
    throw new Error('runner plan does not match the requested cell');
  }
  const receipt = rows.find((r) => r.type === 'orchestration_receipt');
  if (receipt?.available !== true) return 'orchestration_receipt_unavailable';
  const infra = scoreCell(rows).infra;
  return infra > 0 ? `infra_episodes_${infra}` : null;
}

/**
 * Measure one cell: attempts/4 runner calls (seeds seedBase+4k..+3), each retried up to o.infraRetries times on a
 * transient failure. Returns { rows, runnerCalls }. Throws (with err.runnerCalls set) when a block never succeeds.
 */
export async function measureCell(o, cell, key, prov) {
  const rows = [{ type: 'darwin_cell', key, cell, provenance: prov, dryRun: o.dryRun, measuredAt: new Date().toISOString() }];
  const maxTokens = Math.min(cell.budget, RUNNER_FIXED.maxTokensCap);
  let runnerCalls = 0;
  for (let k = 0; k < o.attempts / 4; k++) {
    const seed = o.seedBase + 4 * k;
    let accepted = null; let last = null;
    for (let tryNo = 0; tryNo <= o.infraRetries && !accepted && !stopped; tryNo++) {
      runnerCalls += 1;
      let block;
      if (o.dryRun) {
        block = (o.fakeRows ?? fakeRunnerRows)(cell, { seed, maxTokens, contextTokens: o.contextTokens, tryNo });
      } else {
        mkdirSync(o.runsDir, { recursive: true });
        const output = join(o.runsDir, `${key}.s${seed}.${Date.now()}.${randomBytes(4).toString('hex')}.jsonl`);
        log(`measuring ${cell.family} d${cell.difficulty} budget=${cell.budget} seeds ${seed}..${seed + 3}${tryNo ? ` (retry ${tryNo})` : ''}`);
        const { code, tail } = await runProcess(o.python, runnerArgv(o, cell, seed, output), { ...process.env, PYTHONPATH: o.envDir },
          o.cellTimeoutS * 1000);
        if (code !== 0) { last = `runner exit ${code} (seed ${seed}; raw output kept at ${output}): ${tail.trim().slice(-400)}`; continue; }
        block = readJsonl(output);
      }
      let problem;
      try { problem = blockProblem(block, cell, o); } catch (error) { error.runnerCalls = runnerCalls; throw error; }
      if (problem) { last = `${problem} (seed ${seed})`; log(`${cell.family}: ${last}`); continue; }
      accepted = block;
    }
    if (!accepted) {
      const error = new Error(`${last}; gave up after ${o.infraRetries + 1} runner call(s) for this block; nothing cached`);
      error.runnerCalls = runnerCalls;
      throw error;
    }
    rows.push(...accepted);
  }
  return { rows, runnerCalls };
}
