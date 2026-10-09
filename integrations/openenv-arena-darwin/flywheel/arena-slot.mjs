// Pure 24h-slot and leaderboard-standing logic for the arena flywheel. No I/O and no clock: the caller passes
// nowMs. Observed live (2026-10-09, GET /submissions): each entry carries `queued_at` (epoch s) and
// `slot.window_ends_at` (epoch s, = queued_at + 24 h). The arena's own window end wins; without it a small set of
// accepted-at fields + 24 h is used, and any counting submission without a parseable time makes the slot NOT free.

export const SLOT_WINDOW_MS = 24 * 3600 * 1000;
export const ACCEPTED_AT_FIELDS = Object.freeze(['accepted_at', 'created_at', 'submitted_at', 'queued_at']);

/** Parse an epoch-seconds float, epoch-ms number, or an ISO string WITH timezone. Anything else -> null. */
export function parseTimestampMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[^ ]+(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Pure 24h rolling-slot decision. `nowMs` is passed in; every ambiguity makes the slot NOT free. */
export function slotStatus({ submissions, nowMs, quota = null } = {}) {
  if (!Number.isFinite(nowMs)) throw new TypeError('slotStatus needs a finite nowMs from the caller');
  const reasons = [];
  const counted = [];
  let freeAtMs = null;
  const later = t => { freeAtMs = Math.max(freeAtMs ?? 0, t); };
  if (!Array.isArray(submissions)) reasons.push('submissions_list_unavailable');
  for (const s of Array.isArray(submissions) ? submissions : []) {
    if (!s || typeof s !== 'object') { reasons.push('submission_entry_malformed'); continue; }
    const slot = s.slot?.state;
    const counts = slot === 'returned' ? false : slot === 'held' || slot === 'used' ? true
      : !(s.state === 'rejected' && s.error_origin === 'platform'); // unknown slot semantics count
    if (!counts) continue;
    const id0 = typeof s.submission_id === 'string' ? s.submission_id : '?';
    const endsMs = parseTimestampMs(s.slot?.window_ends_at); // the arena's own end of this submission's 24 h window
    if (endsMs !== null) {
      if (endsMs > nowMs) { counted.push({ submission_id: id0, field: 'slot.window_ends_at', window_ends_at_ms: endsMs }); later(endsMs); }
      continue;
    }
    const field = ACCEPTED_AT_FIELDS.find(f => s[f] !== undefined && s[f] !== null);
    const t = field ? parseTimestampMs(s[field]) : null;
    const id = typeof s.submission_id === 'string' ? s.submission_id : '?';
    if (t === null) { reasons.push(`slot_timestamp_unknown:${id}`); continue; }
    if (nowMs - t < SLOT_WINDOW_MS) { counted.push({ submission_id: id, field, accepted_at_ms: t }); later(t + SLOT_WINDOW_MS); }
  }
  if (counted.length) reasons.push('slot_in_use');
  if (quota) {
    const { retryAfterS: r, observedAtMs: at } = quota;
    if (!Number.isFinite(r) || r < 0 || !Number.isFinite(at)) reasons.push('quota_retry_after_unknown');
    else if (at + r * 1000 > nowMs) { reasons.push('quota_exceeded'); later(at + r * 1000); }
  }
  return { free: reasons.length === 0, reasons, freeAtMs, freeAt: freeAtMs === null ? null : new Date(freeAtMs).toISOString(), counted,
    latestValidatedId: latestValidatedId(submissions) };
}

/**
 * The account's latest `validated` submission id from its own GET /submissions (documented newest first; when every
 * validated entry carries a parseable accepted-at time, the newest by time wins). null = none was ever validated,
 * undefined = the list is unavailable or malformed (unknown, never "none").
 */
export function latestValidatedId(submissions) {
  if (!Array.isArray(submissions) || submissions.some(s => !s || typeof s !== 'object')) return undefined;
  const validated = submissions.filter(s => s.state === 'validated');
  if (validated.some(s => typeof s.submission_id !== 'string' || !s.submission_id)) return undefined;
  if (!validated.length) return null;
  const times = validated.map(s => { const f = ACCEPTED_AT_FIELDS.find(k => s[k] !== undefined && s[k] !== null); return f ? parseTimestampMs(s[f]) : null; });
  if (times.every(t => t !== null)) return validated[times.indexOf(Math.max(...times))].submission_id;
  return validated[0].submission_id;
}

/** Day-1 detection. A truncated board that does not show the user is "unknown" (null), never "no incumbent". */
export function userStanding(board, user) {
  if (!board || !Array.isArray(board.entries) || !Array.isArray(board.runs)) throw new TypeError('UNEXPECTED_LEADERBOARD_SHAPE');
  const idx = board.entries.findIndex(e => e?.user === user);
  const entry = idx >= 0 ? board.entries[idx] : null;
  const runs = board.runs.filter(r => r?.user === user);
  const truncated = board.next_cursor !== null && board.next_cursor !== undefined;
  const hasIncumbent = entry || runs.length ? true : truncated ? null : false;
  return { user, hasIncumbent, rank: entry ? idx + 1 : null, average: entry?.average ?? null, entry, runs, truncated };
}
