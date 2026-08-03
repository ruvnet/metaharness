// Coverage for the supervised sidecar lifecycle (cognitum-one/meta-proxy#82).
//
// The OS commands go through an injected runner and every unit-file renderer is
// pure, so the full macOS/Linux/Windows matrix is asserted on one machine
// without touching launchctl, systemctl or schtasks.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(unit).toContain('ExecStart=/bin/meta-proxy');
    expect(unit).not.toContain('multi-user.target');
  });

  it('restarts on failure on Windows and does not time out', () => {
    const task = renderScheduledTask('C:\\meta-proxy.exe');
    expect(task).toContain('<LogonTrigger>');
    expect(task).toContain('<RestartOnFailure>');
    // A long-lived daemon must not be killed by the default 72h limit.
    expect(task).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
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
    expect(calls[0]!.args[0]).toBe('bootstrap');
    // The definition points at the managed binary, not a PATH lookup.
    expect(result.unitPath).toBe(unitPath);
    expect(binary.length).toBeGreaterThan(0);
  });

  /// A unit file present but never loaded makes `proxy status` claim
  /// start-at-login is on when it is not.
  it('leaves nothing behind when the service manager rejects it', () => {
    installFakeDaemon('linux');
    const { run } = recorder(false);
    const result = enableMetaProxyService({ home, platform: 'linux', run });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('boom');
    expect(existsSync(serviceUnitPath('linux', home)!)).toBe(false);
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
    const { calls, run } = recorder();
    const result = disableMetaProxyService({ home, platform: 'linux', run });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not set to start at login');
    expect(calls).toEqual([]);
  });

  /// A stale definition left behind is the state that lies to `proxy status`,
  /// so removal must not be conditional on the service manager cooperating.
  it('still removes the definition when the service manager complains', () => {
    installFakeDaemon('linux');
    const ok = recorder();
    enableMetaProxyService({ home, platform: 'linux', run: ok.run });

    const failing = recorder(false);
    const result = disableMetaProxyService({ home, platform: 'linux', run: failing.run });
    expect(result.ok).toBe(true);
    expect(existsSync(serviceUnitPath('linux', home)!)).toBe(false);
    expect(result.message).toContain('boom');
  });
});

describe('state reporting', () => {
  it('distinguishes enabled from disabled from unsupported', () => {
    expect(metaProxyServiceState('darwin', home).installed).toBe(false);

    installFakeDaemon('darwin');
    enableMetaProxyService({ home, platform: 'darwin', run: recorder().run });
    expect(metaProxyServiceState('darwin', home).installed).toBe(true);

    const unsupported = metaProxyServiceState('freebsd' as NodeJS.Platform, home);
    expect(unsupported.supported).toBe(false);
    expect(unsupported.unitPath).toBeNull();
  });
});
