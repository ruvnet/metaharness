// SPDX-License-Identifier: MIT
// GH #4 HIGH-2: the bundle/export/score sanitisers must redact secret-shaped VALUES, not only
// secret-named KEYS. These tests pin looksLikeSecretValue's precision (real tokens redact; SHAs/UUIDs
// do not) and redactSecretsDeep's key + value behaviour, plus the diag-bundle integration.

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { looksLikeSecretValue, redactSecretsDeep } from '../src/redact.js';
import { buildSupportBundle } from '../src/diag.js';

describe('looksLikeSecretValue — real secrets (redact)', () => {
  const secrets = [
    ['OpenAI key', 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789'],
    ['GitHub PAT', 'ghp_16CharsOrMoreToken0123456789abcd'],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['Google API key', 'AIzaSyD-1234567890abcdEFGHijklMNOpqrstuv'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['base64 secret in a plain field', 'dGhpc0lzQVZlcnlMb25nQmFzZTY0U2VjcmV0VmFsdWUxMjM0NTY3ODkw'],
    ['PEM header', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...'],
  ];
  for (const [name, val] of secrets) {
    it(`redacts ${name}`, () => expect(looksLikeSecretValue(val)).toBe(true));
  }
});

describe('looksLikeSecretValue — non-secrets (keep, avoid false positives)', () => {
  const keep = [
    ['a git SHA (lowercase hex)', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
    ['a sha256 digest (lowercase hex)', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['a dashed UUID', '550e8400-e29b-41d4-a716-446655440000'],
    ['a short version string', '1.2.3-beta.4'],
    ['an ordinary sentence', 'the quick brown fox jumps over the lazy dog'],
    ['a file path', 'packages/create-agent-harness/src/redact.ts'],
    ['empty', ''],
  ];
  for (const [name, val] of keep) {
    it(`keeps ${name}`, () => expect(looksLikeSecretValue(val)).toBe(false));
  }
});

describe('redactSecretsDeep', () => {
  const opts = { keyRe: /(secret|token|key|password)/i, replacement: '[REDACTED]' };

  it('redacts by key name (existing behaviour preserved)', () => {
    const out = redactSecretsDeep({ api_key: 'anything', ok: 'fine' }, opts) as Record<string, unknown>;
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.ok).toBe('fine');
  });

  it('redacts a secret-shaped VALUE under a NON-secret key (the HIGH-2 fix)', () => {
    const out = redactSecretsDeep({ vars: { deploy_hook: 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789' } }, opts) as any;
    expect(out.vars.deploy_hook).toBe('[REDACTED]');
  });

  it('recurses through arrays and nested objects', () => {
    const out = redactSecretsDeep({ list: [{ note: 'ghp_16CharsOrMoreToken0123456789abcd' }] }, opts) as any;
    expect(out.list[0].note).toBe('[REDACTED]');
  });

  it('leaves ordinary values and non-strings untouched', () => {
    const out = redactSecretsDeep({ name: 'demo', count: 42, on: true }, opts) as any;
    expect(out).toEqual({ name: 'demo', count: 42, on: true });
  });

  it('honours the per-site replacement token', () => {
    const out = redactSecretsDeep({ password: 'x' }, { keyRe: /password/i, replacement: '<redacted>' }) as any;
    expect(out.password).toBe('<redacted>');
  });
});

describe('diag --bundle integration (GH #4 HIGH-2 leak)', () => {
  it('redacts a secret-shaped value pasted into a non-secret manifest field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cah-redact-'));
    await mkdir(join(dir, '.harness'), { recursive: true });
    const manifest = {
      schema: 1, generator: '0.3.1', template: 'minimal',
      // A token captured into a user-chosen `vars` entry — NOT a secret-named key.
      vars: { name: 'demo', webhook: 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789' },
      hosts: ['claude-code'], files: {},
    };
    await writeFile(join(dir, '.harness', 'manifest.json'), JSON.stringify(manifest));
    const bundle = await buildSupportBundle(dir);
    const blob = JSON.stringify(bundle);
    expect(blob).not.toContain('sk-ant-api03-AbCdEf0123456789AbCdEf0123456789');
    expect((bundle.manifest.content as any).vars.webhook).toBe('<redacted>');
    // ordinary value stays
    expect((bundle.manifest.content as any).vars.name).toBe('demo');
  });
});
