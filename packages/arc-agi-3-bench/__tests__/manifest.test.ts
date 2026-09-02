import { describe, expect, it } from 'vitest';

import { loadMechanismFixture } from '../src/fixture.js';
import { assertFrozenManifest, createDefaultManifest } from '../src/manifest.js';

describe('frozen benchmark manifest', () => {
  it('is reproducible and rejects post-freeze changes', async () => {
    const fixture = await loadMechanismFixture();
    const first = createDefaultManifest({
      fixtureSuiteId: fixture.suite.suiteId,
      fixtureSuiteHash: fixture.suiteHash,
    });
    const second = createDefaultManifest({
      fixtureSuiteId: fixture.suite.suiteId,
      fixtureSuiteHash: fixture.suiteHash,
    });
    expect(first).toEqual(second);
    expect(first.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertFrozenManifest({
      ...first,
      armOrderSeed: first.armOrderSeed + 1,
    })).toThrow(/manifest hash mismatch/);
  });
});
