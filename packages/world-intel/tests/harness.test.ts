import { describe, it, expect } from 'vitest';
import { runIntelObservation } from '../src/harness.js';
const observation = {data: [], provenance: {source:'usgs' as const, url:'https://earthquake.usgs.gov/fdsnws/event/1/query', fetchedAt:'2026-01-01T00:00:00Z', cacheAgeMs:0, stale:false, warnings:[]}};
describe('MetaHarness integration', () => {
  it('verifies and records a cited observation', async () => {
    const run = await runIntelObservation(async () => observation);
    expect(run.success).toBe(true); expect(run.receiptsValid).toBe(true); expect(run.receipts).toHaveLength(1);
  });
  it('denies before invoking the provider', async () => {
    let calls=0;
    const run=await runIntelObservation(async () => {calls++;return observation;}, {allowNetwork:false});
    expect(calls).toBe(0); expect(run.success).toBe(false); expect(run.receiptsValid).toBe(true);
  });
  it('rejects stale observations for current brief promotion', async () => {
    const run=await runIntelObservation(async () => ({...observation,provenance:{...observation.provenance,stale:true}}));
    expect(run.success).toBe(false);expect(run.receiptsValid).toBe(true);
  });
});
