// SPDX-License-Identifier: MIT
import { AgentPool, AlgorithmRouter, HarnessKernel, PolicyGate, allowTools, VerifierRegistry, predicateVerifier, type RunResult } from '@metaharness/harness';
import type { Observation } from './core.js';

/** The provider is fixed by the caller, never selected from untrusted observation text.
 * Integrity/freshness verification is not factual corroboration of publisher claims. */
export async function runIntelObservation<T>(query: () => Promise<Observation<T>>, options: { allowNetwork?: boolean } = {}): Promise<RunResult> {
  const tool = 'public-intel-read';
  const pool = new AgentPool([{ id: 'world-intel', model: 'deterministic-public-api', handles: [tool], run: async () => {
    const start = performance.now();
    try {
      const observation = await query();
      return { output: observation, quality: 1, confidence: 1, risk: 0.1, costUsd: 0, latencyMs: performance.now() - start };
    } catch (error) {
      return { output: { error: error instanceof Error ? error.message : 'Source request failed' }, quality: 0, confidence: 0, risk: 0.1, costUsd: 0, latencyMs: performance.now() - start };
    }
  }}]);
  const verifiers = new VerifierRegistry().register(predicateVerifier('fresh-cited-observation', 'schema', value => {
    if (typeof value !== 'object' || value === null || !('data' in value) || !('provenance' in value)) return false;
    const p = (value as Observation<T>).provenance;
    if (!p || typeof p !== 'object' || p.stale !== false || typeof p.fetchedAt !== 'string' || typeof p.url !== 'string' || !Array.isArray(p.warnings)) return false;
    const age = Date.now() - Date.parse(p.fetchedAt);
    if (!Number.isFinite(age) || age < -1000 || age > 300_000 || !Number.isFinite(p.cacheAgeMs) || p.cacheAgeMs < 0 || p.cacheAgeMs > 300_000) return false;
    try {
      const url = new URL(p.url);
      if (url.username || url.password || url.hash) return false;
      return (p.source === 'usgs' && url.origin === 'https://earthquake.usgs.gov' && url.pathname === '/fdsnws/event/1/query')
        || (p.source === 'noaa' && url.origin === 'https://api.weather.gov' && url.pathname === '/alerts/active')
        || (p.source === 'worldbank' && url.origin === 'https://api.worldbank.org' && /^\/v2\/country\/[A-Z]{2}\/indicator\/[A-Z0-9.]{1,64}$/.test(url.pathname));
    } catch { return false; }
  }, 'Missing provenance or stale observation; do not promote to a current brief'));
  const kernel = new HarnessKernel({
    pool, verifiers,
    router: new AlgorithmRouter({ intel: { intent: 'intel', steps: [{ kind: tool }] } }),
    policy: new PolicyGate(options.allowNetwork === false ? [] : [allowTools([tool], 0.1)]),
    budget: { costUsd: 0, risk: 0.1, retries: 0, confidence: 1 },
  });
  return kernel.run({ text: 'Retrieve a cited public observation', intent: 'intel' });
}
