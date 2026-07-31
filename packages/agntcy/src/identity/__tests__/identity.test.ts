// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  AGNTCY_DID_PREFIX,
  isAgntcyIdentity,
  validateAgntcyIdentity,
  type AgntcyIdentity,
} from '../schema.js';
import { MCP_SCAN_BADGE, deriveBadgesFromMcpScan } from '../from-mcp-scan.js';
import {
  canonicalizeIdentity,
  identityToWitnessEntry,
  signIdentityBlock,
  type WitnessEntry,
  type WitnessManifest,
  type WitnessSigningFn,
} from '../sign.js';

const VALID_IDENTITY: AgntcyIdentity = {
  subject: 'did:agntcy:cognitum:researcher',
  issuer: 'cognitum.one',
  badges: ['code.read', 'tests.execute'],
  tenant: 'customer_117',
};

// ---------------------------------------------------------------------------
// schema.ts
// ---------------------------------------------------------------------------

describe('schema.ts -- AgntcyIdentity (ADR-237 S2.1)', () => {
  it('accepts the exact ADR-237 S2.1 worked example', () => {
    const result = validateAgntcyIdentity(VALID_IDENTITY);
    expect(result).toEqual({ valid: true });
    expect(isAgntcyIdentity(VALID_IDENTITY)).toBe(true);
  });

  it('AGNTCY_DID_PREFIX matches the ADR-237 subject format', () => {
    expect(AGNTCY_DID_PREFIX).toBe('did:agntcy:');
    expect(VALID_IDENTITY.subject.startsWith(AGNTCY_DID_PREFIX)).toBe(true);
  });

  it('rejects non-object values', () => {
    expect(validateAgntcyIdentity(null).valid).toBe(false);
    expect(validateAgntcyIdentity(undefined).valid).toBe(false);
    expect(validateAgntcyIdentity('not an object').valid).toBe(false);
    expect(validateAgntcyIdentity(42).valid).toBe(false);
  });

  it('rejects a missing or empty subject', () => {
    const { subject: _subject, ...rest } = VALID_IDENTITY;
    expect(validateAgntcyIdentity(rest).valid).toBe(false);
    expect(validateAgntcyIdentity({ ...VALID_IDENTITY, subject: '' }).valid).toBe(false);
  });

  it('rejects a subject that is not a did:agntcy: DID', () => {
    const result = validateAgntcyIdentity({ ...VALID_IDENTITY, subject: 'did:web:example.com' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('did:agntcy:');
  });

  it('rejects a missing or empty issuer', () => {
    expect(validateAgntcyIdentity({ ...VALID_IDENTITY, issuer: '' }).valid).toBe(false);
    const { issuer: _issuer, ...rest } = VALID_IDENTITY;
    expect(validateAgntcyIdentity(rest).valid).toBe(false);
  });

  it('rejects badges that are not a string[]', () => {
    expect(validateAgntcyIdentity({ ...VALID_IDENTITY, badges: 'not-an-array' }).valid).toBe(false);
    expect(validateAgntcyIdentity({ ...VALID_IDENTITY, badges: ['ok', 42] }).valid).toBe(false);
  });

  it('accepts an empty badges array (no capabilities granted is still a valid identity)', () => {
    expect(validateAgntcyIdentity({ ...VALID_IDENTITY, badges: [] }).valid).toBe(true);
  });

  it('rejects a missing or empty tenant', () => {
    expect(validateAgntcyIdentity({ ...VALID_IDENTITY, tenant: '' }).valid).toBe(false);
    const { tenant: _tenant, ...rest } = VALID_IDENTITY;
    expect(validateAgntcyIdentity(rest).valid).toBe(false);
  });

  it('isAgntcyIdentity narrows the type for a valid identity', () => {
    const value: unknown = VALID_IDENTITY;
    if (isAgntcyIdentity(value)) {
      // Compile-time: value is narrowed to AgntcyIdentity here.
      expect(value.subject).toBe(VALID_IDENTITY.subject);
    } else {
      throw new Error('expected isAgntcyIdentity to accept a valid identity');
    }
  });
});

// ---------------------------------------------------------------------------
// from-mcp-scan.ts
// ---------------------------------------------------------------------------

describe('from-mcp-scan.ts -- deriveBadgesFromMcpScan (ADR-237 S2.1)', () => {
  it('returns [] for non-object / unrecognized input', () => {
    expect(deriveBadgesFromMcpScan(null)).toEqual([]);
    expect(deriveBadgesFromMcpScan(undefined)).toEqual([]);
    expect(deriveBadgesFromMcpScan('nope')).toEqual([]);
    expect(deriveBadgesFromMcpScan({ unrelated: true })).toEqual([]);
  });

  // Realistic ScanReport fixture, shaped exactly like
  // packages/create-agent-harness/src/mcp-scan.ts::scanMcp()'s real return
  // value for a harness with shell + network access granted but no
  // file-write, plus one unrelated risk finding that must NOT become a
  // badge.
  it('derives shell + network + mcp.read badges from a real-shaped ScanReport', () => {
    const scanReport = {
      dir: '/tmp/some-harness',
      mcpEnabled: true,
      findings: [
        {
          id: 'allow-shell',
          severity: 'high',
          title: 'Shell access granted',
          detail: 'allowShell=true lets tools run arbitrary commands.',
        },
        {
          id: 'allow-network',
          severity: 'medium',
          title: 'Network access granted',
          detail: 'allowNetwork=true widens the exfiltration surface.',
        },
        {
          id: 'wildcard-tool-perm',
          severity: 'high',
          title: 'Over-broad tool permission: *',
          detail: 'Wildcard MCP permissions grant every tool on every server.',
        },
      ],
      worst: 'high',
    };

    const badges = deriveBadgesFromMcpScan(scanReport);

    expect(badges).toEqual(
      [MCP_SCAN_BADGE.MCP_READ, MCP_SCAN_BADGE.NETWORK_ACCESS, MCP_SCAN_BADGE.SHELL_EXECUTE].sort(),
    );
    // The risky-but-non-scope 'wildcard-tool-perm' finding must not leak
    // through as an invented badge.
    expect(badges).not.toContain('wildcard-tool-perm');
  });

  it('a clean ScanReport with MCP disabled derives no badges', () => {
    const scanReport = {
      dir: '/tmp/clean-harness',
      mcpEnabled: false,
      findings: [
        {
          id: 'mcp-disabled',
          severity: 'info',
          title: 'No MCP surface',
          detail: 'No MCP policy or server registered -- nothing to scan.',
        },
      ],
      worst: 'info',
    };

    expect(deriveBadgesFromMcpScan(scanReport)).toEqual([]);
  });

  // Realistic ThreatModel fixture, shaped exactly like
  // packages/create-agent-harness/src/threat-model.ts::buildThreatModel()'s
  // real return value for a harness with only file-write granted.
  it('derives mcp.read + file.write badges from a real-shaped ThreatModel', () => {
    const threatModel = {
      schema: 1,
      generatedAt: '2026-07-30T00:00:00.000Z',
      dir: '/tmp/some-harness',
      mcpInUse: true,
      allowedTools: 3,
      deniedTools: 14,
      dangerousPermissions: 1,
      secretsReachable: false,
      networkAccess: false,
      shellAccess: false,
      fileWrite: true,
      policyDefaultDeny: true,
      auditLog: true,
      findings: [],
      worst: 'medium',
      verdict: 'medium',
      exitCode: 1,
    };

    const badges = deriveBadgesFromMcpScan(threatModel);
    expect(badges).toEqual([MCP_SCAN_BADGE.FILE_WRITE, MCP_SCAN_BADGE.MCP_READ].sort());
  });

  it('a clean ThreatModel with MCP not in use derives no badges', () => {
    const threatModel = {
      schema: 1,
      generatedAt: '2026-07-30T00:00:00.000Z',
      dir: '/tmp/clean-harness',
      mcpInUse: false,
      allowedTools: 0,
      deniedTools: 0,
      dangerousPermissions: 0,
      secretsReachable: false,
      networkAccess: false,
      shellAccess: false,
      fileWrite: false,
      policyDefaultDeny: null,
      auditLog: null,
      findings: [],
      worst: 'info',
      verdict: 'clean',
      exitCode: 0,
    };

    expect(deriveBadgesFromMcpScan(threatModel)).toEqual([]);
  });

  it('badges are de-duplicated and sorted regardless of input shape', () => {
    const threatModel = {
      schema: 1,
      generatedAt: '2026-07-30T00:00:00.000Z',
      dir: '/tmp/full-grant-harness',
      mcpInUse: true,
      allowedTools: 5,
      deniedTools: 2,
      dangerousPermissions: 3,
      secretsReachable: false,
      networkAccess: true,
      shellAccess: true,
      fileWrite: true,
      policyDefaultDeny: true,
      auditLog: true,
      findings: [],
      worst: 'high',
      verdict: 'high',
      exitCode: 2,
    };

    const badges = deriveBadgesFromMcpScan(threatModel);
    expect(badges).toEqual(
      [...new Set(badges)].sort((a, b) => a.localeCompare(b)),
    );
    expect(badges).toEqual(
      [
        MCP_SCAN_BADGE.FILE_WRITE,
        MCP_SCAN_BADGE.MCP_READ,
        MCP_SCAN_BADGE.NETWORK_ACCESS,
        MCP_SCAN_BADGE.SHELL_EXECUTE,
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// sign.ts
// ---------------------------------------------------------------------------

describe('sign.ts -- canonicalizeIdentity / identityToWitnessEntry', () => {
  it('canonicalizeIdentity is deterministic regardless of badge array order', () => {
    const a = canonicalizeIdentity(VALID_IDENTITY);
    const b = canonicalizeIdentity({
      ...VALID_IDENTITY,
      badges: [...VALID_IDENTITY.badges].reverse(),
    });
    expect(a).toBe(b);
  });

  it('canonicalizeIdentity output changes when any field changes', () => {
    const base = canonicalizeIdentity(VALID_IDENTITY);
    expect(canonicalizeIdentity({ ...VALID_IDENTITY, tenant: 'other_tenant' })).not.toBe(base);
    expect(canonicalizeIdentity({ ...VALID_IDENTITY, badges: [] })).not.toBe(base);
  });

  it('identityToWitnessEntry produces a WitnessEntry whose sha256 matches the canonical form', () => {
    const entry = identityToWitnessEntry(VALID_IDENTITY);
    const expectedSha = createHash('sha256')
      .update(canonicalizeIdentity(VALID_IDENTITY), 'utf-8')
      .digest('hex');

    expect(entry.id).toBe('agntcy-identity');
    expect(entry.marker).toBe(VALID_IDENTITY.subject);
    expect(entry.sha256).toBe(expectedSha);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.desc).toContain(VALID_IDENTITY.subject);
    expect(entry.desc).toContain(VALID_IDENTITY.tenant);
  });
});

describe('sign.ts -- signIdentityBlock composes into the existing witness signing call', () => {
  /**
   * Test double standing in for the real signing function this file's
   * top-of-file TODO documents (crates/kernel/src/witness.rs::sign_manifest,
   * once bound to JS). It is intentionally NOT a production Ed25519
   * implementation -- per this task's constraint not to invent one -- it
   * only records what entries it was asked to sign, so the test can assert
   * signIdentityBlock composed correctly rather than building a parallel
   * signature scheme.
   */
  function fakeWitnessSigner(harness: string, version: string): WitnessSigningFn {
    return (entries: WitnessEntry[]): WitnessManifest => ({
      schema: 1,
      harness,
      version,
      entries,
      public_key: '0'.repeat(64),
      signature: '0'.repeat(128),
    });
  }

  it('appends the identity as one more WitnessEntry rather than a parallel signature', async () => {
    const priorEntries: WitnessEntry[] = [
      { id: 'fix-1', desc: 'Some prior fix', marker: 'src/foo.ts', sha256: 'a'.repeat(64) },
    ];
    const signer = fakeWitnessSigner('@acme/acme-support', '1.2.0');

    const manifest = await signIdentityBlock(VALID_IDENTITY, signer, priorEntries);

    expect(manifest.schema).toBe(1);
    expect(manifest.harness).toBe('@acme/acme-support');
    expect(manifest.version).toBe('1.2.0');
    // The existing entries are preserved, and the identity is appended --
    // one signature covers both (ADR-237 S2.1: "not a third independent
    // signature scheme").
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0]).toEqual(priorEntries[0]);
    expect(manifest.entries[1]).toEqual(identityToWitnessEntry(VALID_IDENTITY));
  });

  it('works with no prior entries (a harness signing identity for the first time)', async () => {
    const signer = fakeWitnessSigner('@acme/fresh-harness', '0.1.0');
    const manifest = await signIdentityBlock(VALID_IDENTITY, signer);

    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].id).toBe('agntcy-identity');
  });

  it('supports an async existingWitnessSigningFn (the real binding will be async)', async () => {
    const asyncSigner: WitnessSigningFn = async (entries) => {
      await Promise.resolve();
      return {
        schema: 1,
        harness: '@acme/async-harness',
        version: '2.0.0',
        entries,
        public_key: '1'.repeat(64),
        signature: '1'.repeat(128),
      };
    };

    const manifest = await signIdentityBlock(VALID_IDENTITY, asyncSigner);
    expect(manifest.harness).toBe('@acme/async-harness');
    expect(manifest.entries).toHaveLength(1);
  });

  it('rejects an invalid identity BEFORE calling the signing function', async () => {
    let called = false;
    const signer: WitnessSigningFn = (entries) => {
      called = true;
      return {
        schema: 1,
        harness: 'h',
        version: '1.0.0',
        entries,
        public_key: '0'.repeat(64),
        signature: '0'.repeat(128),
      };
    };

    const badIdentity = { ...VALID_IDENTITY, subject: 'not-a-did' };
    await expect(signIdentityBlock(badIdentity, signer)).rejects.toThrow(/invalid identity block/);
    expect(called).toBe(false);
  });

  it('derived badges from mcp-scan flow end-to-end into a signed identity entry', async () => {
    const threatModel = {
      schema: 1,
      generatedAt: '2026-07-30T00:00:00.000Z',
      dir: '/tmp/some-harness',
      mcpInUse: true,
      allowedTools: 2,
      deniedTools: 10,
      dangerousPermissions: 0,
      secretsReachable: false,
      networkAccess: false,
      shellAccess: false,
      fileWrite: false,
      policyDefaultDeny: true,
      auditLog: true,
      findings: [],
      worst: 'info',
      verdict: 'clean',
      exitCode: 0,
    };

    const badges = deriveBadgesFromMcpScan(threatModel);
    const identity: AgntcyIdentity = {
      subject: 'did:agntcy:cognitum:researcher',
      issuer: 'cognitum.one',
      badges,
      tenant: 'customer_117',
    };

    expect(validateAgntcyIdentity(identity).valid).toBe(true);

    const signer = fakeWitnessSigner('@acme/acme-support', '1.2.0');
    const manifest = await signIdentityBlock(identity, signer);

    expect(manifest.entries[0].id).toBe('agntcy-identity');
    // Changing the derived badge set changes the signed hash -- badges are
    // load-bearing on the signature, not decorative.
    const differentBadges = deriveBadgesFromMcpScan({ ...threatModel, shellAccess: true });
    const differentManifest = await signIdentityBlock(
      { ...identity, badges: differentBadges },
      signer,
    );
    expect(differentManifest.entries[0].sha256).not.toBe(manifest.entries[0].sha256);
  });
});
