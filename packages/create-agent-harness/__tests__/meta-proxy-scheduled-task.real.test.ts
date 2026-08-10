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
  type CommandOutcome,
  type ServiceCommand,
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

    // A successful /run whose response is lost is indistinguishable from a
    // failed start to the caller. Exercise the real manager, then lie only
    // about that response and require exact compensation.
    const ambiguousRun = (invocation: ServiceCommand): CommandOutcome => {
      const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', timeout: 15_000, windowsHide: true });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      if (invocation.args[0] === '/run' && result.status === 0) {
        return { ok: false, output: 'simulated lost /run response' };
      }
      return result.error
        ? { ok: false, output: result.error.message, error: result.error.message }
        : { ok: result.status === 0, output };
    };

    // First prove a task which existed in the disabled state is restored to
    // that same state rather than deleted or left running.
    const preexisting = enableMetaProxyService({ home, platform: 'win32', label });
    expect(preexisting.ok, preexisting.message).toBe(true);
    expect(schtasks('/end', '/tn', label).status).toBe(0);
    await eventually(
      () => metaProxyServiceState('win32', home, undefined, label),
      (state) => state.running === false,
    );
    expect(schtasks('/change', '/tn', label, '/disable').status).toBe(0);
    expect(metaProxyServiceState('win32', home, undefined, label)).toMatchObject({ loaded: true, enabledAtLogin: false, running: false });
    const restoredDisabled = enableMetaProxyService({ home, platform: 'win32', label, run: ambiguousRun });
    expect(restoredDisabled.ok).toBe(false);
    expect(restoredDisabled.message).toContain('simulated lost /run response');
    expect(metaProxyServiceState('win32', home, undefined, label)).toMatchObject({ loaded: true, enabledAtLogin: false, running: false });
    expect(existsSync(serviceUnitPath('win32', home, label)!)).toBe(true);
    const cleanupRestored = disableMetaProxyService({ home, platform: 'win32', label });
    expect(cleanupRestored.ok, cleanupRestored.message).toBe(true);

    // Then prove a task newly created by the ambiguous request is stopped and
    // removed, and that no process retains the daemon executable afterward.
    const ambiguous = enableMetaProxyService({ home, platform: 'win32', label, run: ambiguousRun });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.message).toContain('simulated lost /run response');
    expect(metaProxyServiceState('win32', home, undefined, label).managerState).toBe('disabled');
    expect(existsSync(serviceUnitPath('win32', home, label)!)).toBe(false);
    const binaryReleased = await eventually(
      () => {
        try {
          rmSync(binary);
          return true;
        } catch {
          return false;
        }
      },
      (released) => released,
      5_000,
    );
    expect(binaryReleased).toBe(true);
  } finally {
    schtasks('/end', '/tn', label);
    schtasks('/delete', '/tn', label, '/f');
    rmSync(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
}, 60_000);
