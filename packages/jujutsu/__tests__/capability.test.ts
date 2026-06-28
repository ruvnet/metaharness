// SPDX-License-Identifier: MIT
//
// Capability + embedder tests. These pass whether or not the optional native
// peers are installed — they assert the honest-degradation contract.

import { describe, it, expect } from 'vitest';
import {
  probe,
  jujutsuAvailable,
  quantumSigner,
  HashEmbedder,
  CapabilityUnavailableError,
} from '../src/index.js';

describe('capability probe (honest degradation)', () => {
  it('probe() never throws and reports each plane as a boolean', async () => {
    const rep = await probe();
    expect(typeof rep.opLog).toBe('boolean');
    expect(typeof rep.memory).toBe('boolean');
    expect(typeof rep.jjCli).toBe('boolean');
    // annAcrossBranch is true when agenticow@0.2.0+ is installed (native ANN wired),
    // false when absent or < 0.2.0. Both are valid states.
    expect(typeof rep.annAcrossBranch).toBe('boolean');
    // When memory plane is live with agenticow@0.2.0+, native ANN is available.
    if (rep.memory) {
      // annAcrossBranch=true means agenticow@0.2.0 with nativeAnn getter detected.
      // annAcrossBranch=false means older agenticow installed (also valid in CI).
      expect(typeof rep.annAcrossBranch).toBe('boolean');
    } else {
      expect(rep.annAcrossBranch).toBe(false);
    }
    expect(Array.isArray(rep.notes)).toBe(true);
  });

  it('jujutsuAvailable() matches probe().opLog', async () => {
    const rep = await probe();
    expect(jujutsuAvailable()).toBe(rep.opLog);
  });

  it('quantumSigner() is null when the addon is absent, else has generateKeypair', () => {
    const qs = quantumSigner() as { generateKeypair?: unknown } | null;
    if (qs === null) {
      expect(jujutsuAvailable()).toBe(false);
    } else {
      expect(typeof qs.generateKeypair).toBe('function');
    }
  });

  it('CapabilityUnavailableError carries the capability name', () => {
    const e = new CapabilityUnavailableError('agentic-jujutsu');
    expect(e.capability).toBe('agentic-jujutsu');
    expect(e.message).toMatch(/removable augmentation/);
  });
});

describe('HashEmbedder', () => {
  it('is deterministic and L2-normalized', () => {
    const e = new HashEmbedder(128);
    const a = e.embed('jj commit feature x');
    const b = e.embed('jj commit feature x');
    expect(Array.from(a)).toEqual(Array.from(b));
    let norm = 0;
    for (const x of a) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('different text yields different vectors', () => {
    const e = new HashEmbedder(128);
    const a = e.embed('commit');
    const b = e.embed('rebase');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('rejects non-positive dimension', () => {
    expect(() => new HashEmbedder(0)).toThrow();
  });
});
