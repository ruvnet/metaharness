// The flywheel's one calendar: America/Toronto (the timer's zone and the per-day idempotency key). Pure: the
// instant is always passed in, never read from a clock here.
const FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 'YYYY-MM-DD' in America/Toronto for an epoch-ms instant (or an ISO string); null when it is not a valid instant. */
export function torontoDate(at) {
  const ms = typeof at === 'string' ? Date.parse(at) : at;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return FMT.format(new Date(ms));
}
