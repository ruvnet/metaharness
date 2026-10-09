// Fitness for Darwin evolution of the Arena environment: reward cells whose GRPO groups are
// MIXED (non-zero reward spread) because of genuine reasoning outcomes, not truncation or format slips.
//
// classifyEpisode rules (checked against real calibration rows in test/fixtures/real-rows.jsonl):
//   1. reward === 1                                   -> 'solved'
//   2. failure === null && 0 < reward < 1             -> 'partial'   (valid answer, partial credit)
//   3. failure === null && reward === 0               -> 'reasoning' (valid answer, wrong)
//   4. failure in TRUNCATION_CODES                    -> 'truncation' (token/context budget, finish_reason=length,
//      and step_budget_exhausted: the runner's 8-step cap is an artefact, the env's own cap is 16)
//   5. failure in INFRA_CODES                         -> 'infra'     (provider/network/harness, not the policy)
//   6. failure in LENGTH_DEPENDENT_CODES (invalid_json_action, missing_action_content, ValidationError):
//      v2 rows (trajectory.provider_metrics present): truncation iff the last reply was length-limited
//        (finish_reason 'length', completion_tokens >= request_max_tokens, or finish_reason unknown),
//        otherwise 'format' (a format error from a reply that finished on its own: learnable, not reasoning).
//      v1 rows (no provider_metrics; the failing reply is not even retained): 'format' only when
//        total_tokens_reported < the per-request max_tokens cap (taken from the plan row), which PROVES the
//        failing reply never reached the cap; otherwise 'truncation' (a length cut cannot be ruled out).
//   7. any other failure code                         -> 'infra' (fail closed: unknown never counts as reasoning)
// Invalid rows (non-finite reward, reward outside [0,1], negative or missing token counts) throw.
//
// Cell signal (exact, unbiased U-statistic): eligible = solved | partial | reasoning.
//   signal = #{4-episode subsets that are all eligible AND not all-equal reward} / C(n, 4)
//          = P(a random arena group of 4 from this cell carries a purely reasoning-driven gradient).
// Any truncation / format / infra episode in a group voids that group. At n = 4 the signal is 0 or 1.

export const TRUNCATION_CODES = Object.freeze(['completion_truncated', 'episode_completion_budget_exhausted',
  'episode_completion_budget_exceeded', 'episode_context_budget_exhausted', 'episode_context_budget_exceeded',
  'step_budget_exhausted']);
export const INFRA_CODES = Object.freeze(['request_timeout', 'provider_request_failed', 'invalid_provider_response',
  'provider_content_filter', 'provider_exceeded_generation_cap', 'provider_exceeded_reservation',
  'credential_redacted_from_provider_reply', 'environment_step_failed', 'global_token_budget_exhausted']);
export const LENGTH_DEPENDENT_CODES = Object.freeze(['invalid_json_action', 'missing_action_content', 'ValidationError']);
export const CLASSES = Object.freeze(['solved', 'partial', 'reasoning', 'format', 'truncation', 'infra']);
export const ELIGIBLE = Object.freeze(['solved', 'partial', 'reasoning']);
export const FAIL_CLOSED_COST = Number.MAX_SAFE_INTEGER;
export const COST_EPSILON = 1e-6;

const fail = (msg) => { throw new Error(msg); };
const isCount = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isUnit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
/** C(k, 4), exact for every k this code sees (attempts <= 64). */
export const choose4 = (k) => (k < 4 ? 0 : (k * (k - 1) * (k - 2) * (k - 3)) / 24);

function checkRow(row) {
  if (!row || typeof row !== 'object' || row.type !== 'episode') fail('invalid_episode_row: not an episode row');
  if (!isUnit(row.reward)) fail(`invalid_episode_row: reward ${row.reward} not a finite number in [0,1]`);
  if (row.failure !== null && row.failure !== undefined && typeof row.failure !== 'string') fail('invalid_episode_row: failure');
}

function lastReplyLengthLimited(metrics) {
  const m = metrics.at(-1);
  if (!m || typeof m !== 'object') return { limited: true, why: 'no_provider_metric' };
  if (m.finish_reason === 'length') return { limited: true, why: 'finish_reason_length' };
  if (isCount(m.completion_tokens) && isCount(m.request_max_tokens) && m.completion_tokens >= m.request_max_tokens) {
    return { limited: true, why: 'completion_reached_request_cap' };
  }
  if (m.finish_reason === 'stop' || m.finish_reason === 'tool_calls') return { limited: false, why: 'finished_below_cap' };
  return { limited: true, why: 'finish_reason_unknown' };
}

/** Full classification with the rule that fired. ctx.maxTokensPerRequest is only needed for v1 rows. */
export function classifyEpisodeDetailed(row, ctx = {}) {
  checkRow(row);
  const failure = row.failure ?? null;
  if (row.reward === 1) return { cls: 'solved', reason: 'reward_1' };
  if (failure === null) return row.reward > 0 ? { cls: 'partial', reason: 'partial_credit' } : { cls: 'reasoning', reason: 'wrong_answer' };
  if (TRUNCATION_CODES.includes(failure)) return { cls: 'truncation', reason: failure };
  if (INFRA_CODES.includes(failure)) return { cls: 'infra', reason: failure };
  if (LENGTH_DEPENDENT_CODES.includes(failure)) {
    const metrics = row.trajectory?.provider_metrics;
    if (Array.isArray(metrics)) {
      const { limited, why } = lastReplyLengthLimited(metrics);
      return limited ? { cls: 'truncation', reason: `${failure}:${why}` } : { cls: 'format', reason: `${failure}:finished_reply` };
    }
    const cap = ctx.maxTokensPerRequest;
    if (isCount(cap) && cap > 0 && isCount(row.total_tokens_reported) && row.total_tokens_reported < cap) {
      return { cls: 'format', reason: `${failure}:legacy_total_below_request_cap` };
    }
    return { cls: 'truncation', reason: `${failure}:legacy_length_cut_not_excluded` };
  }
  return { cls: 'infra', reason: `unknown_failure:${failure}` };
}

/** 'solved' | 'partial' | 'reasoning' | 'format' | 'truncation' | 'infra' */
export function classifyEpisode(row, ctx = {}) {
  return classifyEpisodeDetailed(row, ctx).cls;
}

/** Generation tokens: v2 accounting.generation_tokens, else per-call charges, else v1 total (incl. prompt; overestimate).
 *  An episode that made provider calls but carries no token accounting at all throws (it would make cost look free). */
export function episodeGenTokens(row) {
  const t = row.trajectory ?? {};
  const acct = t.accounting?.generation_tokens;
  if (acct !== undefined && acct !== null) return isCount(acct) ? acct : fail('invalid_episode_row: generation_tokens');
  if (Array.isArray(t.provider_metrics) && t.provider_metrics.length > 0) {
    let sum = 0;
    for (const m of t.provider_metrics) {
      const v = m?.generation_charged ?? m?.completion_tokens;
      if (!isCount(v)) fail('invalid_episode_row: provider metric without a token count');
      sum += v;
    }
    return sum;
  }
  const total = row.total_tokens_reported;
  if (isCount(total)) return total;
  if ((total === undefined || total === null) && row.calls === 0) return 0; // no provider call: nothing generated
  return fail('invalid_episode_row: no token accounting for an episode with provider calls');
}

/** Per-request max_tokens cap from a runner plan row (v2 field, else v1 max_completion_tokens / max_calls). */
export function planContext(rows) {
  const plan = rows.find((r) => r && r.type === 'plan')?.plan;
  if (!plan) return {};
  if (isCount(plan.max_tokens_per_request)) return { maxTokensPerRequest: plan.max_tokens_per_request };
  if (isCount(plan.max_completion_tokens) && isCount(plan.max_calls) && plan.max_calls > 0
    && plan.max_completion_tokens % plan.max_calls === 0) {
    return { maxTokensPerRequest: plan.max_completion_tokens / plan.max_calls };
  }
  return {};
}

const valueCounts = (values) => { const m = new Map(); for (const v of values) m.set(v, (m.get(v) ?? 0) + 1); return [...m.values()]; };
const variance = (xs) => {
  if (xs.length === 0 || new Set(xs).size <= 1) return 0; // identical => exactly 0 (no float residue)
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
};

/** Score one cell (all runner rows for it; non-episode rows are used only for the plan context). */
export function scoreCell(rows, ctx = {}) {
  if (!Array.isArray(rows)) fail('scoreCell: rows must be an array');
  const context = { ...planContext(rows), ...ctx };
  const episodes = rows.filter((r) => r && r.type === 'episode');
  const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  const detail = [];
  const eligibleRewards = [];
  let genTokens = 0;
  for (const row of episodes) {
    const { cls, reason } = classifyEpisodeDetailed(row, context);
    counts[cls] += 1;
    if (ELIGIBLE.includes(cls)) eligibleRewards.push(row.reward);
    genTokens += episodeGenTokens(row);
    detail.push({ seed: row.seed, attempt: row.attempt, reward: row.reward, cls, reason });
  }
  const n = episodes.length;
  const m = eligibleRewards.length;
  const rewards = episodes.map((r) => r.reward);
  const meanReward = n === 0 ? 0 : rewards.reduce((a, b) => a + b, 0) / n;
  const groups = choose4(n);
  const pureMixed = choose4(m) - valueCounts(eligibleRewards).reduce((a, c) => a + choose4(c), 0);
  const signal = groups > 0 ? pureMixed / groups : 0;
  // Literal arena zero-gradient rate: P(a group of 4 has identical rewards), truncation/infra counted as reward 0.
  const deadGroupRate = groups > 0 ? valueCounts(rewards).reduce((a, c) => a + choose4(c), 0) / groups
    : (new Set(rewards).size <= 1 ? 1 : 0);
  const reasoningFailures = counts.reasoning + counts.partial;
  const share = (k) => (n === 0 ? 0 : k / n);
  return {
    n, solved: counts.solved, partial: counts.partial, reasoning: counts.reasoning, format: counts.format,
    truncation: counts.truncation, infra: counts.infra, eligible: m,
    meanReward, rewardVar: variance(rewards),
    truncShare: share(counts.truncation), reasoningShare: share(reasoningFailures), infraShare: share(counts.infra),
    formatShare: share(counts.format),
    signal,
    varSignal: Math.min(1, variance(eligibleRewards) / 0.25) * share(m), // secondary: eligible-only variance x eligible share
    deadGroupRate,
    mixedFromReasoning: counts.solved > 0 && counts.solved < n && signal > 0 && reasoningFailures >= counts.truncation + counts.format,
    dead: signal === 0,
    genTokens,
    episodes: detail,
  };
}

/** A scorecard that can never win or promote: finite (JSON-safe) but strictly below any measured primary (>= 0). */
export function failClosed(reason, raw = {}) {
  return { primary: -1, noopRate: 1, costPerWin: FAIL_CLOSED_COST, regressed: true,
    evaluatorError: reason, raw: { ...raw, evaluatorError: reason } };
}

function checkCellScore(s, i) {
  const where = `cell[${i}]`;
  if (!s || typeof s !== 'object') fail(`${where} not an object`);
  for (const k of ['n', 'solved', 'infra', 'genTokens']) if (!isCount(s[k])) fail(`${where}.${k} must be a non-negative integer`);
  for (const k of ['meanReward', 'rewardVar', 'truncShare', 'reasoningShare', 'infraShare', 'signal', 'deadGroupRate']) {
    if (!isUnit(s[k])) fail(`${where}.${k}=${s[k]} must be finite in [0,1]`);
  }
  for (const k of ['mixedFromReasoning', 'dead']) if (typeof s[k] !== 'boolean') fail(`${where}.${k} must be boolean`);
  if (s.solved > s.n || s.infra > s.n) fail(`${where} class count > n`);
}

/**
 * Aggregate cell scores into a NumericScoreCard body (variantId is added by the evaluator).
 *   primary    = sum of cell signal (expected number of cells whose arena group carries a pure reasoning gradient)
 *   noopRate   = 1 - mean signal (P(a group carries no reasoning gradient)); linear in primary for a fixed cell count
 *   costPerWin = generated tokens / max(1e-6, sum signal) (tokens per unit of reasoning signal)
 *   regressed  = any cell with < 4 episodes, any infra episode, or a runner error
 */
export function scoreGenome(cellScores) {
  try {
    if (!Array.isArray(cellScores) || cellScores.length === 0) fail('no cell scores');
    cellScores.forEach(checkCellScore);
    const reasons = [];
    let primary = 0; let gen = 0; let reward = 0; let mixed = 0; let dead = 0; let deadGroups = 0;
    for (const [i, s] of cellScores.entries()) {
      primary += s.signal;
      gen += s.genTokens;
      reward += s.meanReward * s.n;
      mixed += s.mixedFromReasoning ? 1 : 0;
      dead += s.dead ? 1 : 0;
      deadGroups += s.deadGroupRate;
      if (s.n < 4) reasons.push(`cell[${i}]:too_few_episodes_${s.n}`);
      if (s.infra > 0) reasons.push(`cell[${i}]:infra_episodes_${s.infra}`);
      if (s.error) reasons.push(`cell[${i}]:${s.error}`);
    }
    const cells = cellScores.length;
    const noopRate = Math.min(1, Math.max(0, 1 - primary / cells));
    const costPerWin = gen / Math.max(COST_EPSILON, primary);
    if (![primary, noopRate, costPerWin].every(Number.isFinite)) fail('non-finite aggregate');
    const total = (k) => cellScores.reduce((a, s) => a + (s[k] ?? 0), 0);
    return {
      primary, noopRate, costPerWin, regressed: reasons.length > 0,
      raw: {
        cells: cellScores, cellCount: cells, mixedFromReasoningCount: mixed, deadCells: dead,
        deadGroupRate: deadGroups / cells, varSignal: total('varSignal'),
        episodes: total('n'), solved: total('solved'), partial: total('partial'), reasoning: total('reasoning'),
        format: total('format'), truncation: total('truncation'), infra: total('infra'), genTokens: gen, totalReward: reward,
        regressedReasons: reasons,
        definitions: 'primary=sum P(group all-eligible & mixed); noopRate=1-primary/cells; costPerWin=genTokens/max(1e-6,primary)',
      },
    };
  } catch (error) {
    return failClosed(`scoreGenome: ${error.message}`);
  }
}
