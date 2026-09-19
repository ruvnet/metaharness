// SPDX-License-Identifier: MIT
//
// ADR-280 real-install tier (ADR-046), zero model cost: write the adapter's
// output into a throwaway git repo and let the REAL `grok` binary read it with
// `grok inspect --json`. HOME and GROK_HOME point at a temp dir, so the
// user's ~/.grok is never read or written, and the trust store is created
// there. Skips when no grok binary is found (CI has none); set GROK_BIN to
// point at one explicitly.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { adapter } from '../src/index.js';
import { defaultSpec } from './fixtures.js';

function findGrok(): string | null {
  const candidates = [process.env.GROK_BIN, join(homedir(), '.grok', 'bin', 'grok')];
  try {
    candidates.push(execFileSync('sh', ['-c', 'command -v grok'], { encoding: 'utf-8' }).trim());
  } catch {
    // not on PATH
  }
  for (const c of candidates) {
    if (!c || !existsSync(c)) continue;
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 10_000 });
      return c;
    } catch {
      // not runnable
    }
  }
  return null;
}

const GROK = findGrok();

describe.skipIf(!GROK)('real grok binary reads the emitted harness (ADR-046 tier, no model call)', () => {
  let root: string;
  let repo: string;
  let home: string;

  const inspect = (extraEnv: Record<string, string> = {}): any => {
    const out = execFileSync(GROK!, ['inspect', '--json'], {
      cwd: repo,
      encoding: 'utf-8',
      timeout: 30_000,
      env: { HOME: home, GROK_HOME: join(home, '.grok'), PATH: '/usr/bin:/bin', TERM: 'dumb', ...extraEnv },
    });
    return JSON.parse(out);
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'host-grok-inspect-')));
    repo = join(root, 'demo');
    home = join(root, 'home');
    mkdirSync(join(home, '.grok'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    for (const [path, content] of Object.entries(adapter.generateConfig(defaultSpec))) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('untrusted (a fresh checkout): the project surfaces are inert — the premise of the trust banner', () => {
    const r = inspect();
    expect(r.projectTrusted).toBe(false);
    expect(r.projectInstructions).toEqual([]);
    expect(r.hooks).toEqual([]);
    expect(r.skills).toEqual([]);
    expect(r.permissions.loaded).toBe(0);
  });

  it('trusted via the trust store: every emitted surface loads', () => {
    writeFileSync(join(home, '.grok', 'trusted_folders.toml'), `[folders.${JSON.stringify(repo)}]\ntrusted = true\n`);
    const r = inspect();
    expect(r.projectTrusted).toBe(true);

    const instructions = r.projectInstructions.map((i: any) => i.path.toLowerCase());
    expect(instructions).toContain(join(repo, 'agents.md').toLowerCase());

    const servers = Object.fromEntries(r.mcpServers.map((s: any) => [s.name, s.transport]));
    expect(servers).toMatchObject({ codeindex: 'stdio', remote: 'http' });

    expect(r.agents.filter((a: any) => a.source?.type === 'project').map((a: any) => a.name)).toEqual(['reviewer']);
    expect(r.skills.map((s: any) => s.name).sort()).toEqual(['code-search', 'run-tests']);

    const hooks = r.hooks.filter((h: any) => h.source?.type === 'project');
    expect(hooks.map((h: any) => [h.event, h.hookType, h.matcher])).toEqual([
      ['session_start', 'command', null],
      ['pre_tool_use', 'command', 'Bash'],
      ['post_tool_use', 'http', 'Edit|Write'],
    ]);

    // All 5 [permission] rules (2 allow + 3 deny) load from .grok/config.toml.
    expect(r.permissions.loaded).toBe(5);
    expect(r.permissions.skipped).toEqual([]);
    expect(r.permissions.sources.some((s: string) => s.startsWith(join(repo, '.grok', 'config.toml')))).toBe(true);
  });

  it('GROK_FOLDER_TRUST=0 (the CI switch in install-grok.md) lifts the gate the same way', () => {
    rmSync(join(home, '.grok', 'trusted_folders.toml'), { force: true });
    const r = inspect({ GROK_FOLDER_TRUST: '0' });
    expect(r.projectTrusted).toBe(true);
    expect(r.permissions.loaded).toBe(5);
    expect(r.hooks.filter((h: any) => h.source?.type === 'project')).toHaveLength(3);
  });
});
