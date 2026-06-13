// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import {
  rightsFromCapability,
  defaultProofTier,
  buildCapabilityTable,
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
    expect(out).toMatch(/package = "@ruflo\/kernel"/);
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
    expect(parsed.guest.package).toBe('@ruflo/kernel');
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
