// SPDX-License-Identifier: MIT

import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { check, commandOnPath, fetch, secretsDispatch, type GcloudRunner } from '../src/secrets.js';

function mockRunner(table: Record<string, { code: number; stdout: string; stderr?: string }>): GcloudRunner {
  return {
    async run(args) {
      const key = args.join(' ');
      const hit = table[key] ?? table[Object.keys(table).find(k => key.startsWith(k)) ?? ''];
      if (!hit) return { code: 1, stdout: '', stderr: `mock: no match for: ${key}` };
      return { code: hit.code, stdout: hit.stdout, stderr: hit.stderr ?? '' };
    },
  };
}

describe('harness secrets check', () => {
  it('HEALTHY when project + auth + secret + pool all present', async () => {
    const runner = mockRunner({
      'config get-value project': { code: 0, stdout: 'my-proj\n' },
      'auth list --filter=status:ACTIVE --format=value(account)': { code: 0, stdout: 'me@example.com\n' },
      'secrets describe NPM_TOKEN': { code: 0, stdout: 'projects/123/secrets/NPM_TOKEN\n' },
      'iam workload-identity-pools list': { code: 0, stdout: 'GitHub Actions\n' },
    });
    const { code, lines } = await check([], runner, async () => true);
    expect(code).toBe(0);
    expect(lines.some(l => l.startsWith('Result: HEALTHY'))).toBe(true);
  });

  it('reports missing project explicitly', async () => {
    const runner = mockRunner({
      'config get-value project': { code: 0, stdout: '(unset)\n' },
    });
    const { code, lines } = await check([], runner, async () => true);
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/no active gcloud project/);
  });

  it('honors --project= override flag', async () => {
    const runner = mockRunner({
      'auth list --filter=status:ACTIVE --format=value(account)': { code: 0, stdout: 'me@example.com\n' },
      'secrets describe NPM_TOKEN --project=forced-proj --format=value(name)': {
        code: 0, stdout: 'projects/forced-proj/secrets/NPM_TOKEN\n',
      },
      'iam workload-identity-pools list --location=global --project=forced-proj': {
        code: 0, stdout: 'GitHub Actions\n',
      },
    });
    const { lines } = await check(['--project=forced-proj'], runner, async () => true);
    expect(lines.some(l => l.includes('forced-proj'))).toBe(true);
  });

  it('bounds a hung PATH lookup and terminates its child', async () => {
    class HungChild extends EventEmitter {
      killed = false;
      kill() { this.killed = true; return true; }
    }
    const child = new HungChild();
    const found = await commandOnPath('gcloud', 'win32', () => child, 5);
    expect(found).toBe(false);
    expect(child.killed).toBe(true);
  });
});

describe('harness secrets fetch', () => {
  it('requires a secret name argument', async () => {
    const { code, lines } = await fetch([], mockRunner({}));
    expect(code).toBe(2);
    expect(lines[0]).toMatch(/Usage: harness secrets fetch/);
  });

  it('returns non-zero when fetch fails', async () => {
    const runner = mockRunner({
      'secrets versions access latest --secret=MISSING': { code: 1, stdout: '', stderr: 'NOT_FOUND' },
    });
    const { code, lines } = await fetch(['MISSING'], runner);
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/Fetch failed/);
  });
});

describe('harness secrets dispatch', () => {
  it('routes unknown subcommands with exit 2', async () => {
    const { code, lines } = await secretsDispatch(['nope']);
    expect(code).toBe(2);
    expect(lines[0]).toMatch(/Unknown secrets subcommand/);
  });

  it('help is exit 0 and includes all three subcommands', async () => {
    const { code, lines } = await secretsDispatch(['help']);
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/check/);
    expect(text).toMatch(/fetch/);
    expect(text).toMatch(/validate-token/);
    expect(text).toMatch(/Workload Identity Federation/);
  });

  it('default (no args) shows help', async () => {
    const { code } = await secretsDispatch([]);
    expect(code).toBe(0);
  });
});
