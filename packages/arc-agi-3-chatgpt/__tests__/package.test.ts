// SPDX-License-Identifier: MIT

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('private package artifact', () => {
  it('packs the server, exact widget, policies, and both frozen prompts', async () => {
    const npmArguments = ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'];
    const npmExecutable = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const npmExecutableArguments = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm', ...npmArguments]
      : npmArguments;
    const { stdout } = await execute(npmExecutable, npmExecutableArguments, {
      cwd: packageRoot,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        npm_config_audit: 'false',
        npm_config_cache: join(tmpdir(), 'arc-chatgpt-npm-cache'),
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
      },
    });
    const report = JSON.parse(stdout) as [{ files: Array<{ path: string }> }];
    const paths = report[0]!.files.map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining([
      'dist/server.js',
      'dist/tools.js',
      'public/arc-widget.html',
      'prompts/actor.md',
      'prompts/supervisor.md',
      '.harness/mcp-policy.json',
      '.harness/mcp-capabilities.json',
      'README.md',
      'LICENSE',
    ]));
  });

  it('has no OpenAI SDK dependency or server-side model credential', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      private?: boolean;
      dependencies?: Record<string, string>;
    };
    expect(manifest.private).toBe(true);
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('openai');
    for (const source of ['src/server.ts', 'src/tools.ts', 'src/cli.ts']) {
      const text = await readFile(join(packageRoot, source), 'utf8');
      expect(text).not.toContain('OPENAI_API_KEY');
      expect(text).not.toMatch(/from ['"]openai['"]/);
    }
  });

  it('states only the authentication, file, and approval controls it implements', async () => {
    const capabilities = JSON.parse(
      await readFile(join(packageRoot, '.harness/mcp-capabilities.json'), 'utf8'),
    ) as { auth?: string; privilegedCapabilities?: { fileWrite?: { roots?: string[] } } };
    const policy = JSON.parse(
      await readFile(join(packageRoot, '.harness/mcp-policy.json'), 'utf8'),
    ) as { fileWriteAllowlist?: string[]; requireApprovalForDangerous?: boolean };

    expect(capabilities.auth).toContain('oauth-2.1-scoped');
    expect(capabilities.privilegedCapabilities?.fileWrite?.roots)
      .toContain('configured-evidence-root');
    expect(policy.fileWriteAllowlist).toContain('configured-evidence-root');
    expect(policy.requireApprovalForDangerous).toBe(false);
  });

  it('freezes actor and supervisor operating constraints', async () => {
    const actor = await readFile(join(packageRoot, 'prompts/actor.md'), 'utf8');
    const supervisor = await readFile(join(packageRoot, 'prompts/supervisor.md'), 'utf8');
    expect(actor).toMatch(/arc_observe/);
    expect(actor).toMatch(/arc_memory_query/);
    expect(supervisor).toMatch(/exactly three/i);
    expect(supervisor).toMatch(/forbidden.*act|must not.*act/i);
  });
});
