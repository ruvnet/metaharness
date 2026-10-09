// Deterministic stand-in for ONE calibrate.py invocation (4 attempts), used only by --dry-run/tests.
// Rows follow the v2 runner schema (provider_metrics + accounting) so they exercise the exact same
// classify/score path as real rows, but every row is labelled evidence_kind 'dry_run_fake'.
//
// Toy world: each episode needs `need` generation tokens, drawn from (family, difficulty, seed) ONLY,
// so the same seeds are common random numbers across budgets: raising a cell's budget can only turn
// truncations into answers, never reshuffle which seeds are hard. Skill draws are likewise
// budget-independent. Nothing here is evidence about the real model.
import { createHash } from 'node:crypto';

const HARDNESS = Object.freeze({
  software_change: 0.0, industrial_schedule: 0.35, science_calibration: 0.1, office_reconciliation: 0.05,
  finance_ledger: 0.15, math_route: 0.0, security_triage: 0.25, media_timeline: 0.1,
});
const BASE_NEED = Object.freeze({
  software_change: 2600, industrial_schedule: 5200, science_calibration: 3200, office_reconciliation: 3600,
  finance_ledger: 3000, math_route: 3400, security_triage: 4600, media_timeline: 3800,
});

function unit(...parts) {
  const h = createHash('sha256').update(parts.join('|')).digest();
  return h.readUInt32BE(0) / 4294967296;
}

function episode(cell, seed, attempt, maxTokens) {
  const { family, difficulty: d, budget } = cell;
  const prompt = 600 + 150 * d;
  const observation = 500 + 200 * d;
  const need = Math.round(BASE_NEED[family] * (1 + 0.45 * (d - 1)) * (0.5 + unit(family, d, seed, 'len')));
  const skill = unit(family, d, seed, 'skill');
  const pSolve = Math.max(0.05, Math.min(0.98, 0.97 - 0.2 * (d - 1) - HARDNESS[family]));
  const firstGen = 25;
  const room = budget - firstGen - observation;
  const metrics = [{ request_max_tokens: Math.min(maxTokens, budget), finish_reason: 'stop', prompt_tokens: prompt,
    completion_tokens: firstGen, total_tokens: prompt + firstGen, generation_charged: firstGen, observation_tokens: observation }];
  let reward = 0; let failure = null; let gen = firstGen;
  if (need > room) {
    const cap = Math.max(1, Math.min(maxTokens, room));
    metrics.push({ request_max_tokens: cap, finish_reason: 'length', prompt_tokens: prompt + observation,
      completion_tokens: cap, total_tokens: prompt + observation + cap, generation_charged: cap });
    failure = 'completion_truncated'; gen += cap;
  } else {
    metrics.push({ request_max_tokens: Math.min(maxTokens, room), finish_reason: 'stop', prompt_tokens: prompt + observation,
      completion_tokens: need, total_tokens: prompt + observation + need, generation_charged: need, observation_tokens: 40 });
    gen += need;
    if (skill < pSolve) reward = 1;
    else if (skill < pSolve + (1 - pSolve) * 0.6) reward = unit(family, d, seed, 'partial') < 0.5 ? 0.5 : 0.75;
  }
  const trajectory = {
    seed,
    messages: [{ role: 'system', content: '[dry-run fake episode]' }, { role: 'assistant', content: failure ? '{"op": "sub' : '{"op": "submit"}' }],
    failure, provider_metrics: metrics,
    accounting: { mode: 'arena', generation_tokens: gen, completion_limit: budget, episode_completion_tokens: gen + observation },
  };
  return {
    type: 'episode', evidence_kind: 'dry_run_fake', task_id: family, difficulty: d, seed, attempt, reward,
    solved: reward === 1, trajectory, trajectoryDigest: createHash('sha256').update(JSON.stringify(trajectory)).digest('hex'),
    calls: metrics.length, total_tokens_reported: metrics.reduce((a, m) => a + m.total_tokens, 0), latency_s: 0, failure,
  };
}

/** Rows one fake runner call would write for `cell` with seeds seed..seed+3. */
export function fakeRunnerRows(cell, { seed, maxTokens, contextTokens }) {
  const plan = { type: 'plan', evidence_kind: 'dry_run_fake', plan: { model: 'dry-run-fake', families: [cell.family],
    attempts_per_family: 4, difficulty: cell.difficulty, seed, max_tokens_per_request: maxTokens, accounting: 'arena',
    task_token_budgets: { [cell.family]: { completion_tokens: cell.budget, context_tokens: contextTokens } } } };
  const episodes = [0, 1, 2, 3].map((a) => episode(cell, seed + a, a, maxTokens));
  const successes = episodes.filter((e) => e.solved).length;
  return [plan, ...episodes, { type: 'summary', evidence_kind: 'dry_run_fake',
    families: [{ task_id: cell.family, successes, attempts: 4, mixed_success: successes >= 1 && successes <= 3 }] },
    // calibrate.py writes this last; available:false (no receipt) means incomplete provider execution.
    { type: 'orchestration_receipt', evidence_kind: 'dry_run_fake', available: true, receipt: null, note: 'dry-run fake rows' }];
}
