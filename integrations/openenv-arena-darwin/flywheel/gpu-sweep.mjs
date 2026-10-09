// GPU cleanup over the flywheel journal and the spend ledger. Never rents, never submits. Shared by every tick's
// preflight and by the recovery-only unit (recover.mjs, hourly + at boot), both under the flywheel lock.
import { redact } from './journal.mjs';

/** GPU instances journaled as up without a confirmed down (a crashed earlier run): destroy them first. */
export function orphanInstances(entries) {
  const open = new Map();
  for (const e of entries) { // our own up/down events plus gpu.mjs's created/destroyed (covers a crash inside provisionGpu)
    if (e.phase !== 'gpu' || !Number.isSafeInteger(e.instanceId)) continue;
    if (e.event === 'up' || e.event === 'gpu.created') open.set(e.instanceId, e);
    else if (e.event === 'gpu.destroyed' || ((e.event === 'down' || e.event === 'orphan-destroyed') && e.confirmed === true)) open.delete(e.instanceId);
  }
  return [...open.values()].map(e => ({ instanceId: e.instanceId, date: e.date, runId: e.runId ?? null }));
}

/**
 * Instances journaled up without a confirmed down are destroyed by id (their ledger run, if still open, is settled at
 * its real duration), then spend-ledger runs left open (reboot dropped the watchdog unit, a create that never returned
 * an id) are looked up by label, destroyed and closed. `x` = {j (journal), deps: {gpu: {destroy, recover}, nowMs}}.
 * -> notes for the report.
 */
export async function sweepGpus(x) {
  const { j, deps } = x;
  const notes = [];
  for (const o of orphanInstances(j.all())) {
    try {
      const r = await deps.gpu.destroy(o.instanceId, { runId: o.runId });
      j.append('gpu', 'orphan-destroyed', { instanceId: o.instanceId, fromDate: o.date, runId: o.runId, confirmed: r?.confirmed === true });
    } catch (e) { j.append('gpu', 'orphan-destroy-error', { instanceId: o.instanceId, error: redact(e?.message) }); }
    notes.push(`orphan GPU instance ${o.instanceId} from ${o.date}: destroy attempted`);
  }
  try {
    const swept = await deps.gpu.recover?.(deps.nowMs());
    if (swept?.length) { j.append('gpu', 'stale-runs-swept', { runs: swept }); notes.push(`stale ledger runs swept: ${swept.map(r => r.runId).join(', ')}`); }
  } catch (e) { j.append('gpu', 'stale-sweep-error', { error: redact(e?.message) }); notes.push(`stale-run sweep failed: ${redact(e?.message)}`); }
  return notes;
}
