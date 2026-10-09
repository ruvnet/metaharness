// Flywheel preflight (no GPU rented yet): orphan GPUs from crashed runs, stale spend-ledger runs, a pending
// submission from an earlier date, the public arena status + leaderboard standing, the 24 h slot and the
// spend pre-check. `x` is the run context built by flywheel.mjs runFlywheel().
import { follow, slotNow } from './finish.mjs';
import { sweepGpus } from './gpu-sweep.mjs';
import { readPending } from './incumbent.mjs';
import { redact } from './journal.mjs';

export { boardAgrees } from './decide.mjs'; // pure; lives with the flags that use it
export { orphanInstances, sweepGpus } from './gpu-sweep.mjs'; // shared with the recovery-only unit (recover.mjs)

/** Does this run rent a GPU? A dry-run evaluator rents only as an explicit rehearsal (it can never submit). */
export const rentsGpu = config => !config.evaluator.dryRun || config.evaluator.rentGpuInDryRun === true;

/** Public, unauthenticated reads. Any failure is recorded and leaves `hasIncumbent` unknown (fail closed later). */
async function boardNow(x) {
  const out = { connected: null, user: x.config.arena.user, hasIncumbent: null, rank: null, runs: null, truncated: null, error: null };
  try { out.connected = (await x.deps.arena.status())?.connected === true; } catch (e) { out.error = `status: ${redact(e?.message ?? e)}`; }
  try {
    const s = await x.deps.arena.standing(x.config.arena.user);
    Object.assign(out, { hasIncumbent: typeof s?.hasIncumbent === 'boolean' ? s.hasIncumbent : null, rank: s?.rank ?? null,
      runs: Array.isArray(s?.runs) ? s.runs.length : null, truncated: s?.truncated ?? null });
  } catch (e) { out.error = [out.error, `leaderboard: ${redact(e?.message ?? e)}`].filter(Boolean).join('; '); }
  return out;
}

export async function preflight(x, { gpuWorkPending }) {
  const { j, st, deps, config } = x;
  j.append('preflight', 'start');
  st.notes.push(...await sweepGpus(x));
  const pending = readPending(x.stateDir);
  if (pending && pending.date !== x.date) await follow(x, pending, 0); // one GET; the incumbent moves only on validated
  st.arena = await boardNow(x);
  j.append('preflight', 'arena', { ...st.arena });
  st.slot.preflight = await slotNow(x);
  const s = st.slot.preflight;
  st.arena.latestValidatedId = s.latestValidatedId; // own GET /submissions: the day-1 / incumbent cross-check
  j.append('preflight', 'own-submissions', { latestValidatedId: s.latestValidatedId ?? 'unknown' });
  const soon = Number.isFinite(s.freeAtMs) && s.freeAtMs - deps.nowMs() <= config.slot.proceedIfFreeWithinS * 1000;
  if (gpuWorkPending && !s.free && config.slot.skipGpuWhenBusy && !soon) {
    st.outcome = 'slot-busy';
    j.append('preflight', 'done', { outcome: st.outcome, slot: s });
    return;
  }
  if (gpuWorkPending && rentsGpu(config)) {
    try { await deps.gpu.precheck?.(deps.nowMs()); } catch (e) {
      if (e?.name !== 'SpendRefused') throw e;
      st.outcome = 'budget-refused';
      st.notes.push(redact(e.message));
    }
  }
  j.append('preflight', 'done', { outcome: st.outcome, slotFree: s.free });
}
