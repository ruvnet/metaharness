// SPDX-License-Identifier: MIT
//
// ADR-044 — first test suite for @metaharness/host-pi-dev (previously
// untested). Covers the extension/tool registration, AGENTS.md/SYSTEM.md,
// and the new trust.json emission.

import { describe, it, expect } from 'vitest';
import { extensionSource, agentsMarkdown, trustJson, adapter, HOST_NAME } from '../src/index.js';
import type { HarnessSpec } from '@metaharness/kernel';

const base: HarnessSpec = {
  name: 'my-pi-harness',
  description: 'a pi harness',
  systemPrompt: 'You are my-pi-harness.',
  tools: [{ name: 'search', description: 'search the repo', inputSchema: { type: 'object' } }],
  agents: [{ name: 'reviewer', systemPrompt: 'Review code.' }],
  permissions: { allow: ['tool.invoke.search'], deny: ['Read(./.env*)'] },
};

describe('@metaharness/host-pi-dev', () => {
  it('host name is pi-dev', () => {
    expect(HOST_NAME).toBe('pi-dev');
    expect(adapter.name).toBe('pi-dev');
  });

  describe('extensionSource', () => {
    it('registers each declared tool via pi.registerTool', () => {
      const src = extensionSource(base);
      expect(src).toContain('pi.registerTool(');
      expect(src).toContain('"search"');
      expect(src).toContain('kernel.invokeTool("search"');
    });
    it('handles a spec with no tools', () => {
      expect(extensionSource({ name: 'x' })).toContain('No tools declared');
    });
  });

  describe('agentsMarkdown', () => {
    it('carries name, description, and agents', () => {
      const md = agentsMarkdown(base);
      expect(md).toContain('# my-pi-harness');
      expect(md).toContain('### reviewer');
      expect(md).toContain('Review code.');
    });
  });

  // ADR-044 — trust.json was missing entirely.
  describe('trustJson (ADR-044)', () => {
    it('trusts the harness extension by package name', () => {
      const parsed = JSON.parse(trustJson(base));
      expect(parsed.schema).toBe(1);
      expect(parsed.trusted_extensions).toHaveLength(1);
      expect(parsed.trusted_extensions[0].name).toBe('my-pi-harness');
      expect(parsed.trusted_extensions[0].source).toBe('npm:my-pi-harness');
    });
    it('carries the default-deny posture (ADR-022)', () => {
      const parsed = JSON.parse(trustJson(base));
      expect(parsed.trusted_extensions[0].allow).toContain('tool.invoke.search');
      expect(parsed.trusted_extensions[0].deny).toContain('Read(./.env*)');
    });
    it('empty allow/deny when no permissions declared', () => {
      const parsed = JSON.parse(trustJson({ name: 'x' }));
      expect(parsed.trusted_extensions[0].allow).toEqual([]);
      expect(parsed.trusted_extensions[0].deny).toEqual([]);
    });
  });

  describe('adapter.generateConfig', () => {
    it('emits extension, AGENTS.md, SYSTEM.md, and trust.json', () => {
      const out = adapter.generateConfig(base);
      expect(Object.keys(out).sort()).toEqual([
        'AGENTS.md',
        'SYSTEM.md',
        'pi-extension/src/index.ts',
        'trust.json',
      ]);
    });
    it('is byte-deterministic (witness-stable, ADR-011)', () => {
      expect(JSON.stringify(adapter.generateConfig(base)))
        .toBe(JSON.stringify(adapter.generateConfig(base)));
    });
  });
});
