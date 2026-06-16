// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import {
  rightsFromCapability,
  rightsFromPermission,
  defaultProofTier,
  buildCapabilityTable,
  buildCapabilityTableForSpec,
  defaultPartitionSpec,
  partitionToml,
  wasmGuestJson,
  installScript,
  adapter,
  HOST_NAME,
} from '../src/index.js';

describe('rightsFromCapability', () => {
  it('* expands to all 7 rights', () => {
    expect(rightsFromCapability('*')).toEqual([
      'READ', 'WRITE', 'GRANT', 'REVOKE', 'EXECUTE', 'PROVE', 'GRANT_ONCE',
    ]);
  });

  it('*.read -> [READ]', () => {
    expect(rightsFromCapability('memory.read')).toEqual(['READ']);
  });

  it('*.write -> [WRITE]', () => {
    expect(rightsFromCapability('memory.write')).toEqual(['WRITE']);
  });

  it('tool.invoke.* -> [EXECUTE]', () => {
    expect(rightsFromCapability('tool.invoke.memory.store')).toEqual(['EXECUTE']);
  });

  it('*.grant -> [GRANT]', () => {
    expect(rightsFromCapability('admin.grant')).toEqual(['GRANT']);
  });

  it('*.grant_once -> [GRANT_ONCE]', () => {
    expect(rightsFromCapability('special.grant_once')).toEqual(['GRANT_ONCE']);
  });

  it('memory.* prefix -> [READ, WRITE, EXECUTE]', () => {
    expect(rightsFromCapability('memory.*')).toEqual(['READ', 'WRITE', 'EXECUTE']);
  });

  it('unknown capability defaults to [READ]', () => {
    expect(rightsFromCapability('weird-thing')).toEqual(['READ']);
  });
});

describe('defaultProofTier', () => {
  it('GRANT / REVOKE / PROVE -> P3', () => {
    expect(defaultProofTier(['GRANT'])).toBe('P3');
    expect(defaultProofTier(['REVOKE'])).toBe('P3');
    expect(defaultProofTier(['PROVE'])).toBe('P3');
  });

  it('WRITE / EXECUTE -> P2', () => {
    expect(defaultProofTier(['WRITE'])).toBe('P2');
    expect(defaultProofTier(['EXECUTE'])).toBe('P2');
  });

  it('READ-only -> P1', () => {
    expect(defaultProofTier(['READ'])).toBe('P1');
  });

  it('mixed bag: highest tier wins', () => {
    expect(defaultProofTier(['READ', 'GRANT'])).toBe('P3');
  });
});

describe('buildCapabilityTable', () => {
  it('translates a list of claims to capability tokens', () => {
    const caps = buildCapabilityTable([
      { capability: 'memory.read', resource: 'ns/x', expires_at: 100 },
      { capability: 'tool.invoke.memory.store', resource: undefined, expires_at: 200 },
    ]);
    expect(caps).toHaveLength(2);
    expect(caps[0].rights).toEqual(['READ']);
    expect(caps[0].proof_tier).toBe('P1');
    expect(caps[0].resource).toBe('ns/x');
    expect(caps[1].rights).toEqual(['EXECUTE']);
    expect(caps[1].proof_tier).toBe('P2');
  });

  it('grant_once claim gets grant_once flag set', () => {
    const [cap] = buildCapabilityTable([
      { capability: 'admin.grant_once', expires_at: 100 },
    ]);
    expect(cap.grant_once).toBe(true);
  });

  it('non-grant_once claims have grant_once undefined', () => {
    const [cap] = buildCapabilityTable([
      { capability: 'memory.read', expires_at: 100 },
    ]);
    expect(cap.grant_once).toBeUndefined();
  });
});

describe('defaultPartitionSpec', () => {
  it('produces sensible defaults', () => {
    const p = defaultPartitionSpec('my-bot');
    expect(p.name).toBe('my-bot');
    expect(p.memory_tier).toBe('Warm');
    expect(p.deadline_urgency).toBe(0.5);
    expect(p.cut_pressure).toBe(0.3);
  });
});

describe('partitionToml', () => {
  it('emits valid TOML with partition + wasm_guest sections', () => {
    const out = partitionToml({ name: 'demo', description: 'a demo' });
    expect(out).toMatch(/\[partition\]/);
    expect(out).toMatch(/name = "demo"/);
    expect(out).toMatch(/memory_tier = "Warm"/);
    expect(out).toMatch(/\[wasm_guest\]/);
    expect(out).toMatch(/package = "@metaharness\/kernel"/);
    expect(out).toMatch(/\[metadata\]/);
    expect(out).toMatch(/description = "a demo"/);
  });

  it('honors override partition spec', () => {
    const out = partitionToml(
      { name: 'demo' },
      {
        name: 'demo', memory_tier: 'Hot',
        deadline_urgency: 0.9, cut_pressure: 0.8,
        witness_key_fingerprint: 'abc',
      },
    );
    expect(out).toMatch(/memory_tier = "Hot"/);
    expect(out).toMatch(/deadline_urgency = 0.90/);
    expect(out).toMatch(/witness_key_fingerprint = "abc"/);
  });

  it('always ends with newline', () => {
    expect(partitionToml({ name: 'x' }).endsWith('\n')).toBe(true);
  });
});

describe('wasmGuestJson', () => {
  it('references the kernel bundle and lists F1-F4 recovery', () => {
    const out = wasmGuestJson({ name: 'demo' });
    const parsed = JSON.parse(out);
    expect(parsed.partition).toBe('demo');
    expect(parsed.guest.package).toBe('@metaharness/kernel');
    expect(parsed.guest.entrypoint).toMatch(/ruflo_kernel_wasm/);
    expect(parsed.failure_class_recovery.F1).toBe('restart-guest');
    expect(parsed.failure_class_recovery.F4).toBe('partition-evict');
  });

  it('declares @ruvector/rvf as the recommended vector-format companion', () => {
    const out = wasmGuestJson({ name: 'demo' });
    const parsed = JSON.parse(out);
    expect(parsed.companion?.vector_format?.package).toBe('@ruvector/rvf');
    expect(parsed.companion?.vector_format?.wasm_addon).toBe('@ruvector/rvf-wasm');
    expect(parsed.companion?.vector_format?.recommended).toBe(true);
  });
});

describe('installScript', () => {
  it('starts with shebang', () => {
    expect(installScript({ name: 'x' }).startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  it('registers partition + installs caps + boots guest', () => {
    const s = installScript({ name: 'my-bot' });
    expect(s).toMatch(/rvm-loader partition register/);
    expect(s).toMatch(/rvm-loader caps install/);
    expect(s).toMatch(/rvm-loader guest boot --partition "my-bot"/);
  });

  it('falls back to source build if rvm-loader is not on crates.io', () => {
    const s = installScript({ name: 'x' });
    expect(s).toMatch(/git clone --recurse-submodules https:\/\/github\.com\/ruvnet\/rvm/);
  });
});

describe('adapter', () => {
  it('name is rvm', () => {
    expect(adapter.name).toBe(HOST_NAME);
    expect(adapter.name).toBe('rvm');
  });

  it('generateConfig returns 4 expected files', () => {
    const out = adapter.generateConfig({ name: 'x' });
    expect(Object.keys(out).sort()).toEqual([
      'capability-table.json',
      'install-rvm.sh',
      'rvm-partition.toml',
      'wasm-guest.json',
    ]);
  });
});

// ADR-044 — capability table is no longer always-empty.
describe('rightsFromPermission (ADR-044)', () => {
  it('* expands to all 7 rights', () => {
    expect(rightsFromPermission('*')).toEqual([
      'READ', 'WRITE', 'GRANT', 'REVOKE', 'EXECUTE', 'PROVE', 'GRANT_ONCE',
    ]);
  });
  it('Read(...) -> [READ]', () => {
    expect(rightsFromPermission('Read(./src/**)')).toEqual(['READ']);
  });
  it('Edit/Write -> [READ, WRITE]', () => {
    expect(rightsFromPermission('Edit(./src/**)')).toEqual(['READ', 'WRITE']);
    expect(rightsFromPermission('Write')).toEqual(['READ', 'WRITE']);
  });
  it('MCP tool + Bash -> [EXECUTE]', () => {
    expect(rightsFromPermission('mcp__codeindex__*')).toEqual(['EXECUTE']);
    expect(rightsFromPermission('Bash(git status)')).toEqual(['EXECUTE']);
  });
});

describe('buildCapabilityTableForSpec (ADR-044)', () => {
  it('derives tokens from spec.permissions.allow (no longer empty)', () => {
    const table = buildCapabilityTableForSpec({
      name: 'demo',
      permissions: { allow: ['mcp__mem__*', 'Read(./README.md)'], deny: [] },
    } as any);
    expect(table.length).toBe(2);
    expect(table[0]!.rights).toEqual(['EXECUTE']);
    expect(table[0]!.proof_tier).toBe('P2');
    expect(table[1]!.rights).toEqual(['READ']);
    expect(table[1]!.proof_tier).toBe('P1');
  });

  it('prefers an explicit spec.claims extension when present', () => {
    const table = buildCapabilityTableForSpec({
      name: 'demo',
      permissions: { allow: ['mcp__mem__*'] },
      claims: [{ capability: 'admin.grant_once', expires_at: 500 }],
    } as any);
    expect(table.length).toBe(1);
    expect(table[0]!.rights).toEqual(['GRANT_ONCE']);
    expect(table[0]!.grant_once).toBe(true);
    expect(table[0]!.expires_at).toBe(500);
  });

  it('empty when no permissions and no claims', () => {
    expect(buildCapabilityTableForSpec({ name: 'x' } as any)).toEqual([]);
  });

  it('derived claims are deterministic (witness-stable, ADR-011)', () => {
    const spec = { name: 'd', permissions: { allow: ['mcp__a__*', 'Bash(ls)'] } } as any;
    expect(JSON.stringify(buildCapabilityTableForSpec(spec)))
      .toBe(JSON.stringify(buildCapabilityTableForSpec(spec)));
  });

  it('generateConfig now emits a non-empty capability table for a harness with perms', () => {
    const out = adapter.generateConfig({
      name: 'real', permissions: { allow: ['mcp__mem__*'] },
    } as any);
    const table = JSON.parse(out['capability-table.json']!);
    expect(table.length).toBe(1);
    expect(table[0]!.rights).toEqual(['EXECUTE']);
  });
});

describe('partitionToml system_prompt (ADR-044)', () => {
  it('emits system_prompt in [metadata] when present', () => {
    const toml = partitionToml({ name: 'h', systemPrompt: 'You are h.' } as any);
    expect(toml).toContain('[metadata]');
    expect(toml).toContain('system_prompt = "You are h."');
  });
});
