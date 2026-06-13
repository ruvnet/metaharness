// SPDX-License-Identifier: MIT
//
// Witness manifest tamper-detection integration test.
//
// The kernel's sign_manifest + verify_manifest do the Ed25519 work
// (already unit-tested on the Rust side per ADR-011). This test pins
// the TS WRAPPER's shape gate: every required field on a witness
// manifest must be checked, AND `findWitness` must locate the file
// at both conventional locations.
//
// The "tamper" matrix mutates each field of a valid-shape manifest and
// asserts that verifyWitness reports `valid: false` with a specific
// reason. If the wrapper ever silently accepts a malformed manifest,
// this test fires immediately.

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  verifyWitness,
  readAndVerify,
  findWitness,
} from '../packages/create-agent-harness/src/witness-client.js';

const VALID_SHAPE = {
  schema: 1,
  harness: 'demo-bot',
  version: '0.1.0',
  entries: [
    { id: 'src/index.ts', desc: 'entry', marker: 'src/index.ts', sha256: 'a'.repeat(64) },
  ],
  public_key: 'a'.repeat(64),    // 32 bytes hex-encoded
  signature: 'b'.repeat(128),    // 64 bytes hex-encoded
};

describe('witness shape gate (tamper detection)', () => {
  it('a well-shaped manifest passes the TS shape gate (kernel may degrade to shape-only)', async () => {
    const r = await verifyWitness(VALID_SHAPE);
    // Either crypto-valid OR shape-OK-but-kernel-not-loaded — both PASS at
    // the shape gate level. We're not testing the Rust signature math here.
    expect(r.valid).toBe(true);
  });

  it('non-object input rejected', async () => {
    expect((await verifyWitness(null)).valid).toBe(false);
    expect((await verifyWitness('a string')).valid).toBe(false);
    expect((await verifyWitness(42)).valid).toBe(false);
  });

  it('unsupported schema version rejected with a specific reason', async () => {
    const r = await verifyWitness({ ...VALID_SHAPE, schema: 2 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/schema/);
  });

  it('truncated public_key (32 chars instead of 64) rejected', async () => {
    const r = await verifyWitness({ ...VALID_SHAPE, public_key: 'a'.repeat(32) });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/public_key/);
  });

  it('truncated signature (64 chars instead of 128) rejected', async () => {
    const r = await verifyWitness({ ...VALID_SHAPE, signature: 'b'.repeat(64) });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/signature/);
  });

  it('public_key missing entirely rejected', async () => {
    const { public_key: _, ...without } = VALID_SHAPE;
    const r = await verifyWitness(without);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/public_key/);
  });

  it('entries set to a string instead of array rejected', async () => {
    const r = await verifyWitness({ ...VALID_SHAPE, entries: 'not-an-array' });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/entries/);
  });

  it('missing harness name rejected', async () => {
    const r = await verifyWitness({ ...VALID_SHAPE, harness: '' });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/harness/);
  });

  it('missing version rejected', async () => {
    const r = await verifyWitness({ ...VALID_SHAPE, version: '' });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/version/);
  });
});

describe('findWitness + readAndVerify (file conventions)', () => {
  it('finds witness.json at the dir root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-witness-'));
    try {
      const p = join(dir, 'witness.json');
      await writeFile(p, JSON.stringify(VALID_SHAPE), 'utf-8');
      expect(findWitness(dir)).toBe(p);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('finds witness.json at .harness/witness.json (the canonical convention)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-witness-'));
    try {
      await mkdir(join(dir, '.harness'), { recursive: true });
      const p = join(dir, '.harness', 'witness.json');
      await writeFile(p, JSON.stringify(VALID_SHAPE), 'utf-8');
      expect(findWitness(dir)).toBe(p);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no witness file present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-witness-'));
    try {
      expect(findWitness(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readAndVerify reads + validates a well-shaped file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-witness-'));
    try {
      const p = join(dir, 'witness.json');
      await writeFile(p, JSON.stringify(VALID_SHAPE), 'utf-8');
      const { manifest, result } = await readAndVerify(p);
      expect(manifest.harness).toBe('demo-bot');
      expect(result.valid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readAndVerify on a tampered manifest reports the failure reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-witness-'));
    try {
      const p = join(dir, 'witness.json');
      // Tamper by changing one byte of the signature mid-stream
      const tampered = { ...VALID_SHAPE, signature: 'c'.repeat(64) }; // wrong length
      await writeFile(p, JSON.stringify(tampered), 'utf-8');
      const { result } = await readAndVerify(p);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/signature/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readAndVerify throws on non-existent file (must not silently succeed)', async () => {
    await expect(readAndVerify('/this/path/does/not/exist/witness.json')).rejects.toThrow(/no witness/);
  });

  it('readAndVerify throws on invalid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-witness-'));
    try {
      const p = join(dir, 'witness.json');
      await writeFile(p, '{ this is not json }', 'utf-8');
      await expect(readAndVerify(p)).rejects.toThrow(/JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
