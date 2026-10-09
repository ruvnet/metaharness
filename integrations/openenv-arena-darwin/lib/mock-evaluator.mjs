// Deterministic in-process evaluator for --mock runs and tests. NO model, NO
// GPU, NO evidence about the real arena: it is a closed-form toy landscape that
// only exists so the Darwin driver can be exercised end to end.
//
// Per cell, with h = a stable per-family hash in [0,1):
//   need     = (4000 + 5000h) * 1.5^(difficulty-1)       tokens a full answer needs
//   pTrunc   = logistic((need - budget) / (0.12 need))   reply cut off by the budget
//   pReason  = min(0.9, 0.04 + 0.22(difficulty-1) + 0.1h) genuine wrong answer
//   p        = (1 - pTrunc)(1 - pReason)                  solve probability
//   signal   = min(1, p(1-p)/0.25) * reasoningShareOfFailures
// Raising the budget removes truncation; raising difficulty adds reasoning
// failures — so single-knob moves change primary, and the optimum is interior.
// Scorecard fields follow the lib/fitness.mjs contract (primary = sum signal,
// noopRate = dead cells / cells, costPerWin = tokens / expected reward).

function unitHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) / 4294967296;
}

export const MOCK_ATTEMPTS = 4;

export function mockCellScore(cell) {
  const h = unitHash(cell.family);
  const need = (4000 + 5000 * h) * 1.5 ** (cell.difficulty - 1);
  const pTrunc = 1 / (1 + Math.exp((cell.budget - need) / (0.12 * need)));
  const pReason = Math.min(0.9, 0.04 + 0.22 * (cell.difficulty - 1) + 0.1 * h);
  const p = (1 - pTrunc) * (1 - pReason);
  const fail = 1 - p;
  const reasoningShare = fail > 1e-12 ? ((1 - pTrunc) * pReason) / fail : 0;
  const signal = Math.min(1, (p * (1 - p)) / 0.25) * reasoningShare;
  const genTokens = MOCK_ATTEMPTS * (pTrunc * cell.budget + (1 - pTrunc) * Math.min(need, cell.budget));
  return { family: cell.family, difficulty: cell.difficulty, budget: cell.budget,
    solveRate: p, truncShare: fail > 1e-12 ? pTrunc / fail : 0, reasoningShare, signal,
    dead: p < 0.01 || p > 0.99, genTokens, expectedReward: MOCK_ATTEMPTS * p };
}

export function mockScoreCells(cells, variantId) {
  if (!Array.isArray(cells) || cells.length === 0) throw new Error('mock evaluator: no cells');
  const per = cells.map(mockCellScore);
  const reward = per.reduce((s, c) => s + c.expectedReward, 0);
  const tokens = per.reduce((s, c) => s + c.genTokens, 0);
  return {
    variantId,
    primary: per.reduce((s, c) => s + c.signal, 0),
    regressed: false,
    noopRate: per.filter(c => c.dead).length / per.length,
    costPerWin: tokens / Math.max(1e-9, reward),
    raw: { mock: true, evidence: 'synthetic_toy_landscape_not_model_rollouts', cells: per },
  };
}

/** NumericEvaluator-compatible object backed by the toy landscape. */
export function makeMockEvaluator(genomeToCells) {
  return { evaluate: async (genome, variantId) => mockScoreCells(genomeToCells(genome), variantId) };
}
