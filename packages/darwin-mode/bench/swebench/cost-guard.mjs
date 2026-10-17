// SPDX-License-Identifier: MIT
//
// Shared `--max-cost` parsing for the bench/swebench solve-*.mjs family (solve-advisor,
// solve-agentic, solve-fusion, solve-mcts, solve-repair). Each previously did its own
// `+argv('--max-cost', Infinity)`, then gated real OpenRouter spend with
// `if (totalCost >= MAX_COST) { stop }`. A malformed flag (`--max-cost abc`, a stray
// quoted empty string, `--max-cost NaN`) makes `+raw` evaluate to `NaN`; IEEE-754 defines
// `NaN >= anything` as `false`, so the stop condition silently NEVER fires and the run
// burns real API spend for the entire manifest instead of refusing to start. The same
// idiom's sibling bug (weight-eft's `--params-b`/`--max-tokens`, PR #360, disclosed-not-
// fixed `learn`/solve-advisor.mjs sibling) is the precedent for this fix; CVE-2026-54235
// (vLLM) is the external precedent for the exact `NaN < x`/`NaN > x` → both-false shape.
//
// Deliberately scoped to `--max-cost` only, across just this file family (same directory,
// identical idiom, identical real-money blast radius) — not a repo-wide
// `assertFiniteNumber` extraction (disclosed separately in PR #360 as a lower-priority,
// not-yet-≥3-instance follow-up; it has since cleared that threshold here, across these
// 5 files, but a broader sweep — cve-bench, ruvector, gaia, livecodebench, cognition,
// terminal-bench — is out of scope for tonight's diff).

/**
 * Parse a `--max-cost` CLI flag into a finite, non-negative spend cap.
 * Throws instead of returning `NaN`/negative, so a malformed flag refuses to run
 * rather than silently disabling the cap it was meant to enforce.
 * @param {string[]} args - the raw CLI args (e.g. `process.argv.slice(2)`)
 * @param {string} [flag]
 * @param {number} [fallback] - returned verbatim when the flag is absent (default: no cap)
 */
export function parseMaxCost(args, flag = '--max-cost', fallback = Infinity) {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const raw = args[i + 1];
  const n = +raw;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `${flag}: expected a finite, non-negative dollar amount, got ${JSON.stringify(raw)} — ` +
        `refusing to start with an unenforceable real-money spend cap.`,
    );
  }
  return n;
}
