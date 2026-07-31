// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';

describe('@metaharness/agntcy', () => {
  it('the package entry point loads with no side effects and re-exports every ADR-237 subpath', async () => {
    const mod = await import('../src/index.js');
    // identity/, oasf/, observability/, and casa/ have all landed (ADR-237
    // §2.1/§2.2/§2.3/§4) and are re-exported as namespaces from this barrel.
    expect(Object.keys(mod).sort()).toEqual(
      [
        'casa',
        'identity',
        'identityBadges',
        'identityWitness',
        'oasf',
        'oasfProject',
        'oasfPublish',
        'observability',
        'observabilityMap',
      ].sort(),
    );
  });
});
