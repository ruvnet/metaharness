import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';

import {
  disableMetaProxyService,
  enableMetaProxyService,
  metaProxyServiceState,
  serviceUnitPath,
  startMetaProxyService,
  stopMetaProxyService,
} from '../src/meta-proxy-service.js';
import { metaProxyBinaryPath } from '../src/meta-proxy.js';

const real = process.platform === 'darwin' && process.env.RUN_REAL_LAUNCHD_ACCEPTANCE === '1';

function launchctl(...args: string[]) {
  return spawnSync('launchctl', args, { encoding: 'utf8', timeout: 15_000 });
}

function pidFor(target: string): number | null {
  const result = launchctl('print', target);
  const match = result.stdout.match(/\bpid = (\d+)/);
  return match ? Number.parseInt(match[1]!, 10) : null;
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

it.runIf(real)('proves isolated LaunchAgent login start, crash restart, clean stop, and disable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mh-launchagent-real-'));
  const label = `one.cognitum.meta-proxy.qe.${process.pid}.${Date.now()}`;
  const target = `gui/${process.getuid?.() ?? 0}/${label}`;
  const binary = metaProxyBinaryPath('darwin', home);
  try {
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, '#!/bin/sh\ntrap "exit 0" TERM INT\nwhile true; do sleep 1; done\n');
    chmodSync(binary, 0o700);

    const enabled = enableMetaProxyService({ home, platform: 'darwin', label });
    expect(enabled.ok, enabled.message).toBe(true);
    const firstPid = await eventually(() => pidFor(target), (pid) => pid !== null);
    expect(firstPid).not.toBeNull();
    expect(metaProxyServiceState('darwin', home, undefined, label).managerState).toBe('enabled');

    expect(launchctl('kill', 'SIGKILL', target).status).toBe(0);
    const restartedPid = await eventually(
      () => pidFor(target),
      (pid) => pid !== null && pid !== firstPid,
    );
    expect(restartedPid).not.toBe(firstPid);

    const stopped = stopMetaProxyService({ home, platform: 'darwin', label });
    expect(stopped.ok, stopped.message).toBe(true);
    expect(await eventually(() => pidFor(target), (pid) => pid === null, 20_000)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    expect(pidFor(target)).toBeNull();

    const started = startMetaProxyService({ home, platform: 'darwin', label });
    expect(started.ok, started.message).toBe(true);
    expect(await eventually(() => pidFor(target), (pid) => pid !== null)).not.toBeNull();

    const disabled = disableMetaProxyService({ home, platform: 'darwin', label });
    expect(disabled.ok, disabled.message).toBe(true);
    expect(existsSync(serviceUnitPath('darwin', home, label)!)).toBe(false);
    expect(metaProxyServiceState('darwin', home, undefined, label).managerState).toBe('disabled');
  } finally {
    const cleanup = launchctl('bootout', target);
    const alreadyGone = /could not find service|no such process/i.test(`${cleanup.stdout}${cleanup.stderr}`);
    expect(cleanup.status === 0 || alreadyGone, `${cleanup.stdout}${cleanup.stderr}`).toBe(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
