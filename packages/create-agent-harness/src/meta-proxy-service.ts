// Supervised lifecycle for the Meta-Proxy sidecar (cognitum-one/meta-proxy#82).
//
// `metaharness proxy start` launches the sidecar for the life of that invocation
// only. Nothing starts it at login and nothing restarts it if it exits, so after
// a reboot `proxy status` reports "not running" and every tool pointed at
// 127.0.0.1:11435 — the VS Code console, the configured terminal, any
// Anthropic-compatible client — fails until someone remembers a CLI command.
// The failure lands on whatever the user was doing at the time, not at a moment
// when they are thinking about proxy lifecycle.
//
// ## Opt-in, always
//
// Installing something that survives reboots is not done silently. There is no
// implicit enable inside `proxy install`; the user runs `proxy enable` and the
// command says exactly which file it wrote and how to undo it.
//
// ## Shape
//
// Every unit-file renderer is a pure string function, and the OS commands go
// through an injected runner, so the whole matrix is testable on one machine
// without touching launchctl/systemctl/schtasks. That mirrors `installFromSource`
// in meta-proxy.ts, which already takes an injected `run`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { metaProxyBinaryPath, metaProxyDataDir } from './meta-proxy.js';

/** Reverse-DNS label, shared by the launchd job and the scheduled task. */
export const SERVICE_LABEL = 'one.cognitum.meta-proxy';

export interface ServiceCommand {
  command: string;
  args: string[];
}

export interface CommandOutcome {
  ok: boolean;
  output: string;
}

export type CommandRunner = (invocation: ServiceCommand) => CommandOutcome;

export interface ServiceResult {
  ok: boolean;
  message: string;
  /** The unit/plist/task definition written, when one was. */
  unitPath?: string;
}

export interface ServiceState {
  supported: boolean;
  /** A definition exists on disk (macOS/Linux) or the task is registered (Windows). */
  installed: boolean;
  unitPath: string | null;
}

function defaultRunner(invocation: ServiceCommand): CommandOutcome {
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error) return { ok: false, output: result.error.message };
  return { ok: result.status === 0, output };
}

// --- unit file locations ----------------------------------------------------

export function launchAgentPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function systemdUnitPath(home = homedir()): string {
  return join(home, '.config', 'systemd', 'user', 'meta-proxy.service');
}

/** The XML definition handed to `schtasks /create /xml`. */
export function scheduledTaskPath(home = homedir()): string {
  return join(metaProxyDataDir(home), 'meta-proxy-task.xml');
}

export function serviceUnitPath(platform: NodeJS.Platform, home = homedir()): string | null {
  if (platform === 'darwin') return launchAgentPath(home);
  if (platform === 'linux') return systemdUnitPath(home);
  if (platform === 'win32') return scheduledTaskPath(home);
  return null;
}

// --- pure renderers ---------------------------------------------------------

/** Minimal XML escaping — a home directory can legitimately contain `&`. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * launchd job. `RunAtLoad` covers start-at-login and `KeepAlive.SuccessfulExit
 * = false` covers restart-after-crash while still letting a deliberate
 * `proxy stop` (SIGTERM, exit 0) stay stopped — a plain `KeepAlive: true` would
 * fight the user's own stop command forever.
 */
export function renderLaunchAgent(binaryPath: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(binaryPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/**
 * systemd **user** unit. `default.target` is the user-session target, so this is
 * start-at-login rather than start-at-boot; booting a machine nobody has logged
 * into should not run a user's proxy. `Restart=on-failure` matches the launchd
 * choice: a clean stop stays stopped.
 */
export function renderSystemdUnit(binaryPath: string): string {
  return `[Unit]
Description=Cognitum Meta-Proxy sidecar
Documentation=https://github.com/cognitum-one/meta-proxy
After=network-online.target

[Service]
Type=simple
ExecStart=${binaryPath}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** Task Scheduler definition — Windows has no launchd/systemd equivalent. */
export function renderScheduledTask(binaryPath: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Cognitum Meta-Proxy sidecar</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(binaryPath)}</Command>
    </Exec>
  </Actions>
</Task>
`;
}

// --- the OS commands, as data so they can be asserted -----------------------

export function enableCommands(platform: NodeJS.Platform, unitPath: string): ServiceCommand[] {
  if (platform === 'darwin') {
    // `bootstrap` is the modern replacement for `load -w`; `kickstart` starts it
    // now so the user does not have to log out and back in to get a daemon.
    return [
      { command: 'launchctl', args: ['bootstrap', `gui/${process.getuid?.() ?? 0}`, unitPath] },
      { command: 'launchctl', args: ['kickstart', `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`] },
    ];
  }
  if (platform === 'linux') {
    return [
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'meta-proxy.service'] },
    ];
  }
  if (platform === 'win32') {
    return [
      { command: 'schtasks', args: ['/create', '/tn', SERVICE_LABEL, '/xml', unitPath, '/f'] },
      { command: 'schtasks', args: ['/run', '/tn', SERVICE_LABEL] },
    ];
  }
  return [];
}

export function disableCommands(platform: NodeJS.Platform, unitPath: string): ServiceCommand[] {
  if (platform === 'darwin') {
    return [{ command: 'launchctl', args: ['bootout', `gui/${process.getuid?.() ?? 0}`, unitPath] }];
  }
  if (platform === 'linux') {
    return [
      { command: 'systemctl', args: ['--user', 'disable', '--now', 'meta-proxy.service'] },
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
    ];
  }
  if (platform === 'win32') {
    return [{ command: 'schtasks', args: ['/delete', '/tn', SERVICE_LABEL, '/f'] }];
  }
  return [];
}

// --- public API -------------------------------------------------------------

export function metaProxyServiceState(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): ServiceState {
  const unitPath = serviceUnitPath(platform, home);
  if (!unitPath) return { supported: false, installed: false, unitPath: null };
  return { supported: true, installed: existsSync(unitPath), unitPath };
}

export interface ServiceOptions {
  home?: string;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
}

export function enableMetaProxyService(options: ServiceOptions = {}): ServiceResult {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;

  const unitPath = serviceUnitPath(platform, home);
  if (!unitPath) {
    return { ok: false, message: `Start-at-login is not supported on ${platform}.` };
  }

  const binaryPath = metaProxyBinaryPath(platform, home);
  if (!existsSync(binaryPath)) {
    return {
      ok: false,
      message: 'Meta-Proxy is not installed. Run `metaharness proxy install --yes` first.',
    };
  }

  const logPath = join(metaProxyDataDir(home), 'meta-proxy.log');
  const definition =
    platform === 'darwin'
      ? renderLaunchAgent(binaryPath, logPath)
      : platform === 'linux'
        ? renderSystemdUnit(binaryPath)
        : renderScheduledTask(binaryPath);

  mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
  writeFileSync(unitPath, definition, { encoding: 'utf8', mode: 0o600 });

  for (const invocation of enableCommands(platform, unitPath)) {
    const outcome = run(invocation);
    if (!outcome.ok) {
      // Leave nothing half-installed: a unit file present but never loaded
      // would make `proxy status` claim start-at-login is on when it is not.
      rmSync(unitPath, { force: true });
      return {
        ok: false,
        message: `Could not enable start-at-login (${invocation.command} ${invocation.args.join(' ')}): ${outcome.output || 'command failed'}`,
      };
    }
  }

  return {
    ok: true,
    message: `Meta-Proxy will start at login. Definition: ${unitPath}\nDisable with: metaharness proxy disable`,
    unitPath,
  };
}

export function disableMetaProxyService(options: ServiceOptions = {}): ServiceResult {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;

  const unitPath = serviceUnitPath(platform, home);
  if (!unitPath) {
    return { ok: true, message: `Start-at-login is not supported on ${platform}; nothing to disable.` };
  }
  if (!existsSync(unitPath)) {
    return { ok: true, message: 'Meta-Proxy is not set to start at login.' };
  }

  // Best-effort: the unit file is removed even if the OS command complains,
  // because a stale definition left behind is the state that lies to
  // `proxy status`. The daemon binary is untouched — disabling supervision is
  // not uninstalling the proxy.
  const failures: string[] = [];
  for (const invocation of disableCommands(platform, unitPath)) {
    const outcome = run(invocation);
    if (!outcome.ok) failures.push(outcome.output || `${invocation.command} failed`);
  }
  rmSync(unitPath, { force: true });

  if (failures.length > 0) {
    return {
      ok: true,
      message: `Removed ${unitPath}, but the service manager reported: ${failures.join('; ')}. The Meta-Proxy binary is untouched.`,
    };
  }
  return { ok: true, message: `Meta-Proxy will no longer start at login. Removed ${unitPath}.` };
}
