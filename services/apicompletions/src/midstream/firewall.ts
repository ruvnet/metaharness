// Optional-dependency firewall for ruvnet/midstream (ADR-203 §3.5, ADR-150 removable
// augmentation). midstream is a REAL Rust/WASM inflight LLM-stream-analysis toolkit, but
// @midstream/wasm is NOT on npm today (404 verified 2026-06-29) — so this dynamic import
// fails and the service ALWAYS degrades to Option B (escalation:"stream_oneshot").
//
// The inflight path (Option C′: scan stream → early failure signal → SDK-safe truncation →
// higher-tier continuation) runs ONLY if `load()` returns non-null. Until the WASM is
// vendored from the repo's npm-wasm/ / wasm/ dir or published upstream, it stays dark.
//
// NOTE: the specifier is a runtime variable (not a string literal) so the TypeScript
// compiler does not try to resolve the (currently non-existent) module — this is the
// firewall: absence is the expected, non-error default state.

export interface MidstreamModule {
  // Written against midstream's ACTUAL API as a contract (inflight scan → escalation
  // signal → SDK-safe truncation → higher-tier continuation). Crate names in the proposal
  // (temporal-compare, midstreamer-scheduler, …) are UNVERIFIED / illustrative (§3.5 item 6).
  scanInflight?: unknown;
}

let cached: MidstreamModule | null | undefined;

/** Returns the midstream module if present, else null (→ degrade to Option B). */
export async function loadMidstream(): Promise<MidstreamModule | null> {
  if (cached !== undefined) return cached;
  try {
    const specifier = '@midstream/wasm'; // variable, not literal — see header note
    cached = (await import(specifier)) as MidstreamModule;
  } catch {
    cached = null; // 404 today → Option B is the operative state
  }
  return cached;
}

/** True only when inflight Option C′ is actually available. */
export async function inflightAvailable(): Promise<boolean> {
  return (await loadMidstream()) !== null;
}
