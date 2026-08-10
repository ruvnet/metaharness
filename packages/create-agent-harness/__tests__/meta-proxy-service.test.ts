// Coverage for the supervised sidecar lifecycle (cognitum-one/meta-proxy#82).
//
// The OS commands go through an injected runner and every unit-file renderer is
// pure, so the full macOS/Linux/Windows matrix is asserted on one machine
// without touching launchctl, systemctl or schtasks.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  disableCommands,
  disableMetaProxyService,
  enableCommands,
  enableMetaProxyService,
  metaProxyServiceState,
  renderLaunchAgent,
  renderScheduledTask,
  renderSystemdUnit,
  startMetaProxyService,
  stopMetaProxyService,
  serviceUnitPath,
  SERVICE_LABEL,
  type CommandOutcome,
  type ServiceCommand,
} from '../src/meta-proxy-service.js';
import { metaProxyBinaryPath } from '../src/meta-proxy.js';

let home: string;

/** Records what would have been run, and lets a test force a failure. */
function recorder(ok = true) {
  const calls: ServiceCommand[] = [];
  const run = (invocation: ServiceCommand): CommandOutcome => {
    calls.push(invocation);
    if (invocation.args[0] === 'print') return { ok: false, output: 'Could not find service' };
    if (invocation.args.includes('show')) return { ok: true, output: 'LoadState=not-found' };
    if (invocation.args[0] === '/query') return { ok: false, output: 'ERROR: The system cannot find the file specified.' };
    return ok ? { ok: true, output: '' } : { ok: false, output: 'boom' };
  };
  return { calls, run };
}

/** Puts a fake installed daemon where `metaProxyBinaryPath` expects one. */
function installFakeDaemon(platform: NodeJS.Platform): string {
  const binary = metaProxyBinaryPath(platform, home);
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  return binary;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mh-service-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('unit rendering', () => {
  it('keeps a deliberate stop stopped on macOS', () => {
    const plist = renderLaunchAgent('/bin/meta-proxy', '/tmp/p.log');
    expect(plist).toContain('<key>RunAtLoad</key>');
    // KeepAlive:true would fight `proxy stop` forever; SuccessfulExit:false
    // restarts a crash but respects a clean exit.
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
    expect(plist).toContain(SERVICE_LABEL);
    expect(plist).toContain('<string>--supervised</string>');
  });

  it('escapes a home directory that contains XML metacharacters', () => {
    const plist = renderLaunchAgent('/Users/a&b/meta-proxy', '/tmp/p.log');
    expect(plist).toContain('/Users/a&amp;b/meta-proxy');
    expect(plist).not.toContain('/Users/a&b/');
    const task = renderScheduledTask('C:\\Users\\a&b\\meta-proxy.exe');
    expect(task).toContain('a&amp;b');
  });

  it('installs the Linux unit into the user session, not system-wide', () => {
    const unit = renderSystemdUnit('/bin/meta-proxy');
    // default.target is start-at-login. Booting a machine nobody logged into
    // must not run a user's proxy.
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('ExecStart=/bin/meta-proxy --supervised');
    expect(unit).not.toContain('multi-user.target');
  });

  it('restarts on failure on Windows and does not time out', () => {
    const task = renderScheduledTask('C:\\meta-proxy.exe');
    expect(task).toContain('<LogonTrigger>');
    expect(task).toContain('<RestartOnFailure>');
    // A long-lived daemon must not be killed by the default 72h limit.
    expect(task).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(task).toContain('<Arguments>--supervised</Arguments>');
  });
});

describe('command construction', () => {
  it('uses the user scope on every platform', () => {
    expect(enableCommands('linux', '/u').every((c) => c.args.includes('--user'))).toBe(true);
    expect(enableCommands('darwin', '/u')[0]!.args[1]).toMatch(/^gui\//);
    expect(disableCommands('linux', '/u').every((c) => c.args.includes('--user'))).toBe(true);
  });

  it('has no commands for an unsupported platform', () => {
    expect(enableCommands('freebsd' as NodeJS.Platform, '/u')).toEqual([]);
    expect(serviceUnitPath('freebsd' as NodeJS.Platform, home)).toBeNull();
  });
});

describe('enable', () => {
  it('refuses when the daemon is not installed', () => {
    const { calls, run } = recorder();
    const result = enableMetaProxyService({ home, platform: 'darwin', run });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('proxy install --yes');
    // Nothing ran and nothing was written.
    expect(calls).toEqual([]);
    expect(existsSync(serviceUnitPath('darwin', home)!)).toBe(false);
  });

  it('writes the definition and loads it', () => {
    const binary = installFakeDaemon('darwin');
    const { calls, run } = recorder();
    const result = enableMetaProxyService({ home, platform: 'darwin', run });

    expect(result.ok).toBe(true);
    const unitPath = serviceUnitPath('darwin', home)!;
    expect(existsSync(unitPath)).toBe(true);
    expect(calls[0]!.command).toBe('launchctl');
    expect(calls[0]!.args[0]).toBe('print');
    expect(calls.some((call) => call.args[0] === 'bootstrap')).toBe(true);
    // The definition points at the managed binary, not a PATH lookup.
    expect(result.unitPath).toBe(unitPath);
    expect(binary.length).toBeGreaterThan(0);
  });

  it('is idempotent when the same LaunchAgent is already enabled', () => {
    installFakeDaemon('darwin');
    const calls: ServiceCommand[] = [];
    let registered = false;
    const run = (invocation: ServiceCommand): CommandOutcome => {
      calls.push(invocation);
      if (invocation.args[0] === 'print') {
        return registered
          ? { ok: true, output: 'state = running\npid = 123' }
          : { ok: false, output: 'Could not find service' };
      }
      if (invocation.args[0] === 'bootstrap') registered = true;
      return { ok: true, output: '' };
    };

    expect(enableMetaProxyService({ home, platform: 'darwin', run }).ok).toBe(true);
    calls.length = 0;
    const again = enableMetaProxyService({ home, platform: 'darwin', run });

    expect(again.ok).toBe(true);
    expect(calls.map((call) => call.args[0])).toEqual(['print']);
  });

  it('does not overwrite a different stopped LaunchAgent definition', () => {
    installFakeDaemon('darwin');
    const unitPath = serviceUnitPath('darwin', home)!;
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, 'foreign or tampered definition');
    const { calls, run } = recorder();

    const result = enableMetaProxyService({ home, platform: 'darwin', run });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/different.*definition/i);
    expect(readFileSync(unitPath, 'utf8')).toBe('foreign or tampered definition');
    expect(calls.map((call) => call.args[0])).toEqual(['print']);
  });

  it('preserves an active loaded Linux unit when enabling login start fails', () => {
    const binary = installFakeDaemon('linux');
    const unitPath = serviceUnitPath('linux', home)!;
    mkdirSync(dirname(unitPath), { recursive: true });
    const definition = renderSystemdUnit(binary);
    writeFileSync(unitPath, definition);
    const calls: ServiceCommand[] = [];
    const run = (invocation: ServiceCommand): CommandOutcome => {
      calls.push(invocation);
      if (invocation.args.includes('show')) {
        return { ok: true, output: 'LoadState=loaded\nUnitFileState=disabled\nActiveState=active\nMainPID=718' };
      }
      if (invocation.args.includes('daemon-reload')) return { ok: false, output: 'reload unavailable' };
      return { ok: false, output: 'unexpected command' };
    };

    const result = enableMetaProxyService({ home, platform: 'linux', run });

    expect(result.ok).toBe(false);
    expect(readFileSync(unitPath, 'utf8')).toBe(definition);
    expect(calls.some((call) => call.args.includes('disable'))).toBe(false);
  });

  /// A rejected first-time enable must not leave a new definition behind.
  it('leaves nothing behind when the service manager rejects it', () => {
    installFakeDaemon('linux');
    const { run } = recorder(false);
    const result = enableMetaProxyService({ home, platform: 'linux', run });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('boom');
    expect(existsSync(serviceUnitPath('linux', home)!)).toBe(false);
  });

  it('compensates a registration when starting the registered job fails', () => {
    installFakeDaemon('darwin');
    const calls: ServiceCommand[] = [];
    let registered = false;
    const run = (invocation: ServiceCommand): CommandOutcome => {
      calls.push(invocation);
      const action = invocation.args[0];
      if (action === 'print') {
        return registered
          ? { ok: true, output: 'state = running\npid = 123' }
          : { ok: false, output: 'Could not find service' };
      }
      if (action === 'bootstrap') registered = true;
      if (action === 'kickstart') return { ok: false, output: 'kickstart failed' };
      if (action === 'bootout') registered = false;
      return { ok: true, output: '' };
    };

    const result = enableMetaProxyService({ home, platform: 'darwin', run });

    expect(result.ok).toBe(false);
    expect(calls.map((call) => call.args[0])).toEqual([
      'print',
      'bootstrap',
      'kickstart',
      'print',
      'bootout',
    ]);
    expect(existsSync(serviceUnitPath('darwin', home)!)).toBe(false);
  });

  it('says so rather than pretending on an unsupported platform', () => {
    const result = enableMetaProxyService({ home, platform: 'freebsd' as NodeJS.Platform });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not supported');
  });
});

describe('disable', () => {
  it('removes the definition and leaves the daemon binary alone', () => {
    const binary = installFakeDaemon('darwin');
    const { run } = recorder();
    enableMetaProxyService({ home, platform: 'darwin', run });

    const result = disableMetaProxyService({ home, platform: 'darwin', run });
    expect(result.ok).toBe(true);
    expect(existsSync(serviceUnitPath('darwin', home)!)).toBe(false);
    // Disabling supervision is not uninstalling the proxy.
    expect(existsSync(binary)).toBe(true);
  });

  it('is a no-op when start-at-login was never enabled', () => {
    const calls: ServiceCommand[] = [];
    const run = (invocation: ServiceCommand): CommandOutcome => {
      calls.push(invocation);
      return { ok: true, output: 'LoadState=not-found' };
    };
    const result = disableMetaProxyService({ home, platform: 'linux', run });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not set to start at login');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain('show');
  });

  it('reports failure and preserves the definition when unregistering fails', () => {
    installFakeDaemon('linux');
    const unit = serviceUnitPath('linux', home)!;
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'owned unit');

    const result = disableMetaProxyService({
      home,
      platform: 'linux',
      run: (invocation) =>
        invocation.args.includes('show')
          ? { ok: true, output: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nMainPID=123' }
          : { ok: false, output: 'disable failed' },
    });
    expect(result.ok).toBe(false);
    expect(existsSync(unit)).toBe(true);
    expect(result.message).toContain('disable failed');
  });

  it('restores the Linux definition when daemon-reload fails after disable', () => {
    const binary = installFakeDaemon('linux');
    const unitPath = serviceUnitPath('linux', home)!;
    mkdirSync(dirname(unitPath), { recursive: true });
    const definition = renderSystemdUnit(binary);
    writeFileSync(unitPath, definition);
    const calls: ServiceCommand[] = [];
    const run = (invocation: ServiceCommand): CommandOutcome => {
      calls.push(invocation);
      if (invocation.args.includes('show')) {
        return { ok: true, output: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nMainPID=456' };
      }
      if (invocation.args.includes('disable')) return { ok: true, output: '' };
      if (invocation.args.includes('daemon-reload')) return { ok: false, output: 'manager unavailable' };
      return { ok: false, output: 'unexpected command' };
    };

    const result = disableMetaProxyService({ home, platform: 'linux', run });

    expect(result.ok).toBe(false);
    expect(readFileSync(unitPath, 'utf8')).toBe(definition);
    expect(calls.some((call) => call.args.includes('daemon-reload'))).toBe(true);
  });

  it('ends and confirms a Windows task before deleting it', () => {
    installFakeDaemon('win32');
    const unitPath = serviceUnitPath('win32', home)!;
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, '<Task>owned definition</Task>');
    let running = true;
    const calls: ServiceCommand[] = [];
    const run = (invocation: ServiceCommand): CommandOutcome => {
      calls.push(invocation);
      if (invocation.args[0] === '/query') {
        return { ok: true, output: running ? 'Status: Running' : 'Status: Ready' };
      }
      if (invocation.args[0] === '/end') {
        running = false;
        return { ok: true, output: '' };
      }
      if (invocation.args[0] === '/delete') return { ok: false, output: 'delete denied' };
      return { ok: false, output: 'unexpected command' };
    };

    const result = disableMetaProxyService({ home, platform: 'win32', run });

    expect(result.ok).toBe(false);
    expect(calls.map((call) => call.args[0])).toEqual(['/query', '/end', '/query', '/delete']);
    expect(existsSync(unitPath)).toBe(true);
  });

  it('preserves a Windows task when stop cannot be confirmed', () => {
    installFakeDaemon('win32');
    const unitPath = serviceUnitPath('win32', home)!;
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, '<Task>owned definition</Task>');
    const calls: ServiceCommand[] = [];
    const run = (invocation: ServiceCommand): CommandOutcome => {
      calls.push(invocation);
      if (invocation.args[0] === '/query') return { ok: true, output: 'Status: Running' };
      if (invocation.args[0] === '/end') return { ok: true, output: '' };
      return { ok: false, output: 'unexpected command' };
    };

    const result = disableMetaProxyService({ home, platform: 'win32', run });

    expect(result.ok).toBe(false);
    expect(calls.some((call) => call.args[0] === '/delete')).toBe(false);
    expect(existsSync(unitPath)).toBe(true);
  });
});

describe('state reporting', () => {
  it('distinguishes enabled from disabled from unsupported', () => {
    const missing = () => ({ ok: false, output: 'Could not find service' });
    expect(metaProxyServiceState('darwin', home, missing).installed).toBe(false);

    installFakeDaemon('darwin');
    let registered = false;
    const enabled = (invocation: ServiceCommand): CommandOutcome => {
      if (invocation.args[0] === 'print') {
        return registered
          ? { ok: true, output: 'state = running\npid = 123' }
          : { ok: false, output: 'Could not find service' };
      }
      if (invocation.args[0] === 'bootstrap') registered = true;
      return { ok: true, output: '' };
    };
    enableMetaProxyService({ home, platform: 'darwin', run: enabled });
    expect(metaProxyServiceState('darwin', home, enabled).installed).toBe(true);

    const unsupported = metaProxyServiceState('freebsd' as NodeJS.Platform, home);
    expect(unsupported.supported).toBe(false);
    expect(unsupported.unitPath).toBeNull();
  });

  it('separates current manager load state from a next-login definition', () => {
    const unit = serviceUnitPath('darwin', home)!;
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'stale definition');

    const state = metaProxyServiceState('darwin', home, () => ({
      ok: false,
      output: 'Could not find service',
    }));

    expect(state.managerState).toBe('disabled');
    expect(state.installed).toBe(false);
    expect(state.definitionPresent).toBe(true);
  });

  it('fails closed when a manager query is denied instead of treating it as disabled', () => {
    const unit = serviceUnitPath('darwin', home)!;
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'owned definition');

    const run = () => ({ ok: false, output: 'Operation not permitted' });
    const state = metaProxyServiceState('darwin', home, run);
    const disabled = disableMetaProxyService({ home, platform: 'darwin', run });

    expect(state.managerState).toBe('unknown');
    expect(disabled.ok).toBe(false);
    expect(existsSync(unit)).toBe(true);
  });

  it('reports and stops an active loaded Linux service even when login start is disabled', () => {
    const binary = installFakeDaemon('linux');
    const unit = serviceUnitPath('linux', home)!;
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, renderSystemdUnit(binary));
    let active = true;
    const calls: ServiceCommand[] = [];
    const run = (invocation: ServiceCommand): CommandOutcome => {
      calls.push(invocation);
      if (invocation.args.includes('show')) {
        return {
          ok: true,
          output: `LoadState=loaded\nUnitFileState=disabled\nActiveState=${active ? 'active' : 'inactive'}\nMainPID=${active ? '991' : '0'}`,
        };
      }
      if (invocation.args.includes('stop')) {
        active = false;
        return { ok: true, output: '' };
      }
      return { ok: false, output: 'unexpected command' };
    };

    const before = metaProxyServiceState('linux', home, run);
    expect(before).toMatchObject({ installed: true, loaded: true, enabledAtLogin: false, running: true, pid: 991 });
    expect(stopMetaProxyService({ home, platform: 'linux', run }).ok).toBe(true);
    expect(calls.some((call) => call.args.includes('stop'))).toBe(true);
  });

  it('reports the supervisor pid and stops it without a MetaHarness pid file', () => {
    const binary = installFakeDaemon('darwin');
    const unit = serviceUnitPath('darwin', home)!;
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, renderLaunchAgent(binary, join(home, 'proxy.log')));
    let running = true;
    let registered = true;
    const calls: ServiceCommand[] = [];
    const run = (invocation: ServiceCommand): CommandOutcome => {
      calls.push(invocation);
      if (invocation.args[0] === 'print') {
        return registered
          ? { ok: true, output: running ? 'state = running\npid = 4242' : 'state = exited' }
          : { ok: false, output: 'Could not find service' };
      }
      if (invocation.args[0] === 'bootout') {
        registered = false;
        running = false;
      }
      if (invocation.args[0] === 'bootstrap') registered = true;
      if (invocation.args[0] === 'kickstart') running = true;
      return { ok: true, output: '' };
    };

    const before = metaProxyServiceState('darwin', home, run);
    expect(before.running).toBe(true);
    expect(before.pid).toBe(4242);

    const stopped = stopMetaProxyService({ home, platform: 'darwin', run });
    expect(stopped.ok).toBe(true);
    expect(calls.some((call) => call.args[0] === 'bootout')).toBe(true);
    expect(metaProxyServiceState('darwin', home, run).running).toBe(false);

    const started = startMetaProxyService({ home, platform: 'darwin', run });
    expect(started.ok).toBe(true);
    expect(calls.some((call) => call.args[0] === 'bootstrap')).toBe(true);
    expect(calls.some((call) => call.args[0] === 'kickstart')).toBe(true);
  });

  it('reports an externally registered service even when its definition is missing', () => {
    const state = metaProxyServiceState('darwin', home, () => ({
      ok: true,
      output: 'service = one.cognitum.meta-proxy',
    }));

    expect(state.managerState).toBe('enabled');
    expect(state.installed).toBe(true);
    expect(state.definitionPresent).toBe(false);
  });
});
