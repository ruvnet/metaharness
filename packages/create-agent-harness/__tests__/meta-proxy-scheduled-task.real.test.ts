import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';

import {
  disableMetaProxyService,
  enableMetaProxyService,
  metaProxyServiceState,
  serviceUnitPath,
} from '../src/meta-proxy-service.js';
import { metaProxyBinaryPath } from '../src/meta-proxy.js';

const real = process.platform === 'win32' && process.env.RUN_REAL_SCHEDULED_TASK_ACCEPTANCE === '1';

function schtasks(...args: string[]) {
  return spawnSync('schtasks', args, { encoding: 'utf8', timeout: 15_000 });
}

async function eventually<T>(read: () => T, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = read();
  }
  return value;
}

it.runIf(real)('proves an isolated Scheduled Task starts, reports, stops, and deletes cleanly', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mh-scheduled-task-real-'));
  const label = `CognitumMetaProxyQE-${process.pid}-${Date.now()}`;
  const binary = metaProxyBinaryPath('win32', home);
  const source = join(home, 'fixture.cs');
  try {
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(source, 'using System.Threading; public class Program { public static void Main(string[] args) { while (true) Thread.Sleep(1000); } }');
    const compile = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $env:FIXTURE_SOURCE) -OutputAssembly $env:FIXTURE_BINARY -OutputType ConsoleApplication'],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, FIXTURE_SOURCE: source, FIXTURE_BINARY: binary } },
    );
    expect(compile.status, `${compile.stdout}${compile.stderr}`).toBe(0);

    const enabled = enableMetaProxyService({ home, platform: 'win32', label });
    expect(enabled.ok, enabled.message).toBe(true);
    const running = await eventually(
      () => metaProxyServiceState('win32', home, undefined, label),
      (state) => state.running === true,
    );
    expect(running).toMatchObject({ managerState: 'enabled', running: true, definitionPresent: true });

    const disabled = disableMetaProxyService({ home, platform: 'win32', label });
    expect(disabled.ok, disabled.message).toBe(true);
    expect(existsSync(serviceUnitPath('win32', home, label)!)).toBe(false);
    expect(metaProxyServiceState('win32', home, undefined, label).managerState).toBe('disabled');
  } finally {
    schtasks('/end', '/tn', label);
    schtasks('/delete', '/tn', label, '/f');
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
