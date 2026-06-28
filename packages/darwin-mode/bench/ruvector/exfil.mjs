// SPDX-License-Identifier: MIT
//
// exfil.mjs — per-task prediction exfil, mirroring the FRAMES/cve-bench Firestore REST pattern
// (cve-bench/gcp-cascade-dispatch.mjs: curl + `gcloud auth print-access-token`). Predictions must
// NOT live only on ephemeral disk during a fleet run.
//
// $0 / NO-GCP DEFAULT: when --exfil is not set (or FIRESTORE_PROJECT is unset) this writes a local
// JSONL stream only. When exfil IS enabled, each prediction is ALSO POSTed to a Firestore
// collection via the REST API using the gcloud access token. This keeps Phase-0 fully $0 while
// the exact exfil seam the paid fleet run needs is present and exercised.

import { appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

/** Convert a plain JS object to a Firestore REST `fields` document (shallow; scalars + strings). */
function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) fields[k] = { nullValue: null };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (typeof v === 'number') fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else if (typeof v === 'object') fields[k] = { stringValue: JSON.stringify(v) };
    else fields[k] = { stringValue: String(v) };
  }
  return { fields };
}

/**
 * Create an exfil sink.
 *   opts.outPath   local JSONL path (always written)
 *   opts.enabled   when true, ALSO POST to Firestore
 *   opts.project   GCP project (default $FIRESTORE_PROJECT or cognitum-20260110)
 *   opts.collection Firestore collection (default 'ruvector_ablation')
 *   opts.runId     groups docs from one run
 * Returns { write(pred), enabled }.
 */
export function makeExfil({ outPath, enabled = false, project, collection = 'ruvector_ablation', runId } = {}) {
  const proj = project || process.env.FIRESTORE_PROJECT || 'cognitum-20260110';
  let token = null;
  if (enabled) {
    try { token = sh('gcloud auth print-access-token').trim(); }
    catch { console.error('[exfil] WARN: gcloud token unavailable — Firestore exfil disabled, local JSONL only.'); enabled = false; }
  }
  return {
    enabled,
    write(pred) {
      const rec = { runId, ts: Date.now(), ...pred };
      if (outPath) { try { appendFileSync(outPath, JSON.stringify(rec) + '\n'); } catch (e) { console.error('[exfil] local write failed:', e.message); } }
      if (enabled && token) {
        const docId = `${runId || 'run'}__${pred.arm || 'x'}__${pred.id || Math.random().toString(36).slice(2)}`;
        const body = JSON.stringify(toFirestoreFields(rec)).replace(/'/g, "'\\''");
        const url = `https://firestore.googleapis.com/v1/projects/${proj}/databases/(default)/documents/${collection}?documentId=${encodeURIComponent(docId)}`;
        try { sh(`curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" "${url}" -d '${body}' >/dev/null`); }
        catch (e) { console.error('[exfil] firestore POST failed:', e.message); }
      }
    },
  };
}
