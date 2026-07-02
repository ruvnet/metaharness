import { describe, it, expect } from 'vitest';
import { loadMidstream, inflightAvailable } from '../src/midstream/firewall';

describe('midstream optional-dependency firewall (ADR-203 §3.5)', () => {
  it('degrades to Option B today (@midstream/wasm 404 on npm)', async () => {
    // The dynamic import must fail gracefully, not throw — Option B is the operative state.
    await expect(loadMidstream()).resolves.toBeNull();
    await expect(inflightAvailable()).resolves.toBe(false);
  });
});
