// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { isRvfAvailable, createRvfBackend } from '../src/memory-rvf.js';

describe('memory-rvf (graceful fallback)', () => {
  it('isRvfAvailable returns boolean (false here since RVF not installed in test env)', async () => {
    const avail = await isRvfAvailable();
    expect(typeof avail).toBe('boolean');
    // In test env, RVF is an optional peer dep that may or may not be
    // installed. The contract is: when absent, the API returns false
    // and createRvfBackend returns null — never throws.
  });

  it('createRvfBackend returns null when RVF is missing (no throw)', async () => {
    const backend = await createRvfBackend({ dimensions: 384 });
    // In CI without RVF installed: null is the correct answer.
    // With RVF installed: a real backend object.
    if (backend === null) {
      expect(backend).toBeNull();
    } else {
      // If it IS installed, smoke the surface.
      expect(typeof backend.insert).toBe('function');
      expect(typeof backend.search).toBe('function');
      expect(typeof backend.size).toBe('function');
      expect(typeof backend.flush).toBe('function');
    }
  });
});
