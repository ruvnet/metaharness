// Run-wide GPU budget for a Darwin evolution (--max-total-new-cells).
//
// UNIT = one runner call = one 4-seed block of one cell (4 real-model episodes). A cell measured at A attempts
// costs A/4 units, so raising --attempts or --confirm-attempts is charged, not hidden. Each evaluation is wrapped
// so that, BEFORE anything is spawned, the cells the genome would add (relative to every cell already reserved
// in this run, per namespace = seed base + attempts) are reserved at unitsPerCell each. If the budget cannot
// cover them, the candidate is refused fail-closed: never evaluated, regressed worst-case scorecard.
//
// After the evaluation the charge is settled to what the evaluator reports it actually ran: raw.runnerCalls
// (cache hits refunded; an infra retry costs one extra call, so the cap can be overshot by at most one retry per
// failing block of an evaluation already in flight, and later candidates are then refused). Fallback for
// evaluators without raw.runnerCalls: raw.attemptedNewCells x unitsPerCell. A cell that FAILED is released from
// the reservation table (nothing was cached), so a later evaluation that needs it reserves and pays for it again;
// an evaluation that died without per-cell detail releases all of its fresh cells and keeps the full charge.
//
// Concurrency: reservation happens synchronously at call time (before the first await), so parallel
// evaluations never double-book. An evaluation that needs a cell another in-flight evaluation reserved waits for
// it to finish, so the same cell is never run twice concurrently. Waits only point at evaluations that started
// earlier, so they cannot deadlock.

/** Upstream ShellEvaluator's errorCard shape: never selectable, never promotable. */
export function failCard(variantId, message, raw) {
  return { variantId, primary: -Infinity, regressed: true, noopRate: 1, costPerWin: Infinity,
    evaluatorError: message, ...(raw === undefined ? {} : { raw }) };
}

/** True when every gate-relevant field is a finite, in-domain number. */
export function isFiniteCard(card) {
  return !!card && Number.isFinite(card.primary) &&
    Number.isFinite(card.noopRate) && card.noopRate >= 0 && card.noopRate <= 1 &&
    Number.isFinite(card.costPerWin) && card.costPerWin >= 0 && typeof card.regressed === 'boolean';
}

export function cellSignature(cell, namespace = '') {
  const knobs = cell.knobs ?? {};
  const sorted = Object.fromEntries(Object.keys(knobs).sort().map(k => [k, knobs[k]]));
  return JSON.stringify([namespace, cell.family, cell.difficulty, cell.budget, sorted]);
}

const isCount = v => Number.isSafeInteger(v) && v >= 0;

/**
 * @param {object} o
 * @param {(genome: object) => Array<object>} o.genomeToCells  contract lib/cells.mjs
 * @param {(genome: object, variantId: string, allowance: number) => Promise<object>} o.run  default runner
 * @param {number} o.maxTotalNewCells  budget in runner calls; Infinity allowed (mock only)
 * @param {number} [o.unitsPerCell=1] default runner calls per new cell (search attempts / 4)
 * @param {string} [o.namespace=''] default reservation namespace (search seed base + attempts)
 */
export function makeBudgetedEvaluator({ genomeToCells, run, maxTotalNewCells, unitsPerCell = 1, namespace = '' }) {
  if (!(maxTotalNewCells === Infinity || isCount(maxTotalNewCells))) throw new Error(`invalid maxTotalNewCells: ${maxTotalNewCells}`);
  const reserved = new Map(); // signature -> Promise that settles when its owner evaluation ends
  const ledger = [];
  let used = 0; let refused = 0; let attempted = 0; let runnerCalls = 0; let evaluatorRefused = 0; let failedCells = 0;

  async function evaluate(genome, variantId, opts = {}) {
    const units = opts.unitsPerCell ?? unitsPerCell;
    const ns = opts.namespace ?? namespace;
    const runFn = opts.run ?? run;
    if (!(Number.isSafeInteger(units) && units >= 1)) return failCard(variantId, `invalid unitsPerCell ${units}`);
    // ---- synchronous section: no await before the reservation is booked ----
    let cells;
    try {
      cells = genomeToCells(genome);
    } catch (error) {
      ledger.push({ variantId, reserved: 0, refused: false, error: error.message });
      return failCard(variantId, `genome_rejected: ${error.message}`);
    }
    const sigOf = new Map(cells.map(c => [cellSignature(c, ns), c]));
    const sigs = [...sigOf.keys()];
    const fresh = sigs.filter(s => !reserved.has(s));
    let need = fresh.length * units;
    if (used + need > maxTotalNewCells) {
      refused += 1;
      ledger.push({ variantId, namespace: ns, reserved: 0, refused: true });
      return failCard(variantId,
        `max_total_new_cells_exceeded: needs ${fresh.length} new cell(s) x ${units} runner call(s), ${used}/${maxTotalNewCells} already used`,
        { attemptedNewCells: 0, runnerCalls: 0 });
    }
    const waits = [...new Set(sigs.filter(s => reserved.has(s)).map(s => reserved.get(s)))];
    used += need;
    let release;
    const done = new Promise(resolve => { release = resolve; });
    for (const s of fresh) reserved.set(s, done);
    const entry = { variantId, namespace: ns, reserved: need, charged: need, refused: false };
    ledger.push(entry);
    // ---- end synchronous section ----
    let card;
    try {
      await Promise.all(waits);
      // A cell another evaluation reserved but FAILED to measure was released: reserve (and pay for) it now.
      const reclaimed = sigs.filter(s => !reserved.has(s));
      if (reclaimed.length > 0 && used + reclaimed.length * units > maxTotalNewCells) {
        refused += 1; entry.refused = true;
        card = failCard(variantId, `max_total_new_cells_exceeded: ${reclaimed.length} failed cell(s) to re-measure, ${used}/${maxTotalNewCells} used`,
          { attemptedNewCells: 0, runnerCalls: 0 });
      } else {
        for (const s of reclaimed) reserved.set(s, done);
        fresh.push(...reclaimed); need += reclaimed.length * units; used += reclaimed.length * units; entry.reserved = need;
        card = await runFn(genome, variantId, fresh.length);
      }
    } catch (error) {
      card = failCard(variantId, `evaluator_threw: ${error.message}`);
    }
    try {
      const raw = card?.raw;
      const ran = isCount(raw?.runnerCalls) ? raw.runnerCalls
        : isCount(raw?.attemptedNewCells) ? raw.attemptedNewCells * units : null;
      if (ran !== null) {
        attempted += isCount(raw?.attemptedNewCells) ? raw.attemptedNewCells : 0;
        runnerCalls += ran;
        entry.charged = ran;
        used += ran - need; // refund cache hits, charge retries
      }
      if (typeof raw?.evaluatorError === 'string' && raw.evaluatorError.startsWith('max_new_cells_exceeded')) evaluatorRefused += 1;
      const cellRows = Array.isArray(raw?.cells) && raw.cells.every(c => c && typeof c.family === 'string') ? raw.cells : null;
      // Whole evaluation failed (refusal, crash, deadline): release every fresh cell (cached ones are refunded later).
      const wholeFailed = typeof (card?.evaluatorError ?? raw?.evaluatorError) === 'string';
      const failedSigs = wholeFailed ? fresh : cellRows ? cellRows.filter(c => c.error).map(c => cellSignature(c, ns)) : [];
      for (const s of failedSigs) if (reserved.get(s) === done) { reserved.delete(s); failedCells += 1; }
      // ShellEvaluator drops a top-level evaluatorError; evaluator.mjs mirrors it in raw. Lift it back so the
      // archive and gate.mjs (which rejects any card carrying evaluatorError) both see the failure.
      if (card && !card.evaluatorError && typeof raw?.evaluatorError === 'string') {
        card = { ...card, regressed: true, evaluatorError: raw.evaluatorError };
      }
      if (card && card.regressed && card.evaluatorError) return card;
      if (!isFiniteCard(card)) return failCard(variantId, 'scorecard_non_finite_or_out_of_domain', card?.raw);
      return card;
    } finally {
      release();
    }
  }

  return {
    evaluate,
    stats: () => ({ maxTotalNewCells, reservedNewCells: used, refusedEvaluations: refused,
      evaluatorRefusedEvaluations: evaluatorRefused, releasedFailedCells: failedCells,
      reportedAttemptedNewCells: attempted, reportedRunnerCalls: runnerCalls, ledger: [...ledger] }),
  };
}
