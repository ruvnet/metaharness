// SPDX-License-Identifier: MIT
//
// iter 116 — verifies the @ruvnet/agent-harness-generator library wrapper
// re-exports the openharness API surface cleanly. The wrapper has no
// implementation; if any of these imports fail at type-check time, the
// dual-package model is broken.

import { describe, it, expect } from 'vitest';

describe('@ruvnet/agent-harness-generator (iter 116)', () => {
  it('re-exports the core scaffold API', async () => {
    const mod = await import('@ruvnet/agent-harness-generator');
    expect(typeof mod.scaffold).toBe('function');
    expect(typeof mod.validateHarnessName).toBe('function');
    expect(typeof mod.detectRufloProject).toBe('function');
    expect(typeof mod.templateDir).toBe('function');
  });

  it('re-exports the catalog surface', async () => {
    const mod = await import('@ruvnet/agent-harness-generator');
    expect(Array.isArray(mod.HOSTS)).toBe(true);
    expect(mod.HOSTS).toContain('claude-code');
    expect(mod.HOSTS).toContain('rvm');
    expect(Array.isArray(mod.TEMPLATES)).toBe(true);
    expect(mod.TEMPLATES).toContain('vertical:coding');
    expect(mod.TEMPLATES).toContain('vertical:repo-maintainer'); // iter 113
    expect(typeof mod.loadCatalog).toBe('function');
    expect(typeof mod.formatCatalog).toBe('function');
  });

  it('re-exports the rendering + manifest primitives', async () => {
    const mod = await import('@ruvnet/agent-harness-generator');
    expect(typeof mod.render).toBe('function');
    expect(typeof mod.extractVarReferences).toBe('function');
    expect(typeof mod.walkTemplate).toBe('function');
    expect(typeof mod.asFileMap).toBe('function');
    expect(typeof mod.writeAtomic).toBe('function');
    expect(typeof mod.emptyManifest).toBe('function');
    expect(typeof mod.sha256).toBe('function');
    expect(typeof mod.fingerprintFiles).toBe('function');
    expect(typeof mod.diffFingerprints).toBe('function');
  });

  it('validateHarnessName accepts/rejects expected names', async () => {
    const { validateHarnessName } = await import('@ruvnet/agent-harness-generator');
    expect(validateHarnessName('my-bot').valid).toBe(true);
    expect(validateHarnessName('bad name').valid).toBe(false);
  });

  it('TEMPLATES length matches the canonical 20', async () => {
    const { TEMPLATES, loadCatalog } = await import('@ruvnet/agent-harness-generator');
    expect(TEMPLATES.length).toBe(20);
    expect(loadCatalog().length).toBe(20);
  });
});
