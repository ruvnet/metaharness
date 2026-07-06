// swebench-endpoint.mjs — pure endpoint/auth resolution for the D1 SWE-bench runner (d1s4-live-run.mjs).
//
// Two endpoint shapes, one resolver:
//   • HOSTED (default, e.g. OpenRouter) — needs an API key from its env var, with a /tmp/.orkey fallback.
//   • LOCAL NO-AUTH — a `ruvllm serve` or an ollama OpenAI-compatible server at localhost, OR any endpoint
//     the caller explicitly marks keyless with `--api-key-env NONE`. It needs no key and costs $0.
//
// WHY THIS EXISTS: the D1 positive-compounding run (agentic solver, REAL official-harness gold-scoring) was
// gated ONLY on budget — a hosted cheap model costs real $. A local model at localhost removes that gate:
// SAME real solver, SAME real gold-scoring (the official swebench Docker harness is the ONLY scorer — a
// local model changes the $, never the honesty), $0 inference. This resolver is the seam that lets the
// runner target either without a key requirement blocking the local case. Pure + injected env so it is
// unit-testable at $0 (no network, no process.env coupling).

/** True when the endpoint needs no API key: an explicit `NONE` sentinel, or a localhost base URL. */
export function isLocalNoAuth(apiKeyEnv, baseUrl) {
  if (apiKeyEnv === 'NONE') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(baseUrl || '');
}

/**
 * Resolve { noAuth, key } for a run. Injected `env`/`orkey` keep it pure (no process.env / fs coupling).
 * @param {object} o
 * @param {string} [o.apiKeyEnv='OPENROUTER_API_KEY'] env var holding the key (or 'NONE' for a keyless endpoint)
 * @param {string} [o.baseUrl='']  the chat-completions base URL (localhost ⇒ no-auth)
 * @param {Record<string,string>} [o.env={}]  the environment to read the key from
 * @param {string} [o.orkey='']  a fallback key (e.g. the contents of /tmp/.orkey); ignored for no-auth
 * @returns {{ noAuth: boolean, key: string }}
 */
export function resolveEndpointAuth({ apiKeyEnv = 'OPENROUTER_API_KEY', baseUrl = '', env = {}, orkey = '' } = {}) {
  const noAuth = isLocalNoAuth(apiKeyEnv, baseUrl);
  // A local no-auth endpoint never carries a key — not even a stale /tmp/.orkey — so the run's spend and
  // provenance stay honestly $0/keyless.
  const key = noAuth ? '' : (env[apiKeyEnv] || orkey || '').trim();
  return { noAuth, key };
}
