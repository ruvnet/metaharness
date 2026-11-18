// Finite-grid, multivariate TPE for two ordered solver budgets. All choices
// and observations belong to one study. A new study starts with no evidence.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
  };
}

function orderedChoices(values, name) {
  if (!Array.isArray(values) || values.length === 0 ||
      values.some(value => !Number.isSafeInteger(value) || value < 1) ||
      new Set(values).size !== values.length) {
    throw new RangeError(`${name} must contain distinct positive integers`);
  }
  return [...values].sort((a, b) => a - b);
}

// Each Gaussian is normalized over the available grid, including at its edges.
// Rank distance gives a grid spaced in powers of two one unit per doubling.
function kernelRows(length, count) {
  const width = Math.max(1, length / Math.sqrt(count + 1));
  return Array.from({ length }, (_, center) => {
    const weights = Array.from({ length }, (_, i) =>
      Math.exp(-0.5 * ((i - center) / width) ** 2));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    return weights.map(weight => weight / total);
  });
}

function density(group, moveCount, restartCount) {
  const moveKernels = kernelRows(moveCount, group.length);
  const restartKernels = kernelRows(restartCount, group.length);
  const uniformPrior = 1 / (moveCount * restartCount);
  return candidate => {
    let mass = uniformPrior;
    for (const trial of group) {
      mass += moveKernels[trial.i][candidate.i] * restartKernels[trial.j][candidate.j];
    }
    return mass / (group.length + 1);
  };
}

/**
 * Create a reproducible proposer over a finite grid. Record one finite loss
 * per suggested configuration (smaller is better). No point is proposed
 * twice. Both methods use the same shuffled order during random warmup.
 */
export function createProposer({ method, seed, moves, restarts }) {
  if (method !== 'tpe' && method !== 'random') {
    throw new RangeError('method must be tpe or random');
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('seed must be a uint32');
  }
  const moveChoices = orderedChoices(moves, 'moves');
  const restartChoices = orderedChoices(restarts, 'restarts');
  const remaining = moveChoices.flatMap((moves, i) =>
    restartChoices.map((restarts, j) => ({ moves, restarts, i, j })));
  const random = seededRandom(seed);
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
  }

  const pending = new Map();
  const observations = [];
  const key = ({ moves, restarts }) => `${moves}:${restarts}`;

  function suggest() {
    if (remaining.length === 0) return null;
    let next = 0;
    if (method === 'tpe' && observations.length >= 4) {
      const ranked = [...observations].sort((a, b) => a.loss - b.loss);
      const split = Math.ceil(ranked.length / 4);
      // Tie groups stay together. If every trial ties, continue exploration.
      const threshold = ranked[split - 1].loss;
      const good = ranked.filter(trial => trial.loss <= threshold);
      const other = ranked.slice(good.length);
      if (other.length > 0) {
        const goodMass = density(good, moveChoices.length, restartChoices.length);
        const otherMass = density(other, moveChoices.length, restartChoices.length);
        let bestRatio = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const ratio = goodMass(remaining[i]) / otherMass(remaining[i]);
          if (ratio > bestRatio) {
            bestRatio = ratio;
            next = i;
          }
        }
      }
    }
    const [trial] = remaining.splice(next, 1);
    pending.set(key(trial), trial);
    return { moves: trial.moves, restarts: trial.restarts };
  }

  function observe(config, loss) {
    if (!Number.isFinite(loss)) throw new RangeError('loss must be finite');
    const id = key(config);
    const trial = pending.get(id);
    if (!trial) throw new Error('configuration has no pending trial');
    pending.delete(id);
    observations.push({ ...trial, loss });
  }

  return { suggest, observe };
}
