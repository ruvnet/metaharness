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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { metaProxyBinaryPath, metaProxyDataDir } from './meta-proxy.js';

/** Reverse-DNS label, shared by the launchd job and the scheduled task. */
export const SERVICE_LABEL = 'one.cognitum.meta-proxy';

function assertServiceLabel(label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(label)) {
    throw new Error('Invalid service label.');
  }
}

export interface ServiceCommand {
  command: string;
  args: string[];
}

export interface CommandOutcome {
  ok: boolean;
  output: string;
  error?: string;
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
  /** The service manager currently has the job/unit/task loaded. */
  installed: boolean;
  unitPath: string | null;
  managerState: 'enabled' | 'disabled' | 'unknown';
  definitionPresent: boolean;
  /** Whether the service manager currently has the job/unit/task loaded. */
  loaded: boolean | null;
  /** Whether the service remains configured to start on the user's next login. */
  enabledAtLogin: boolean;
  /** null means the manager answered but does not expose a portable run state. */
  running: boolean | null;
  pid: number | null;
}

function defaultRunner(invocation: ServiceCommand): CommandOutcome {
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error) return { ok: false, output: result.error.message, error: result.error.message };
  return { ok: result.status === 0, output };
}

// --- unit file locations ----------------------------------------------------

export function launchAgentPath(home = homedir(), label = SERVICE_LABEL): string {
  assertServiceLabel(label);
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function systemdUnitPath(home = homedir()): string {
  return join(home, '.config', 'systemd', 'user', 'meta-proxy.service');
}

/** The XML definition handed to `schtasks /create /xml`. */
export function scheduledTaskPath(home = homedir(), label = SERVICE_LABEL): string {
  assertServiceLabel(label);
  const filename = label === SERVICE_LABEL ? 'meta-proxy-task.xml' : `${label}-task.xml`;
  return join(metaProxyDataDir(home), filename);
}

export function serviceUnitPath(platform: NodeJS.Platform, home = homedir(), label = SERVICE_LABEL): string | null {
  if (platform === 'darwin') return launchAgentPath(home, label);
  if (platform === 'linux') return systemdUnitPath(home);
  if (platform === 'win32') return scheduledTaskPath(home, label);
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
export function renderLaunchAgent(binaryPath: string, logPath: string, label = SERVICE_LABEL): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(binaryPath)}</string>
    <string>--supervised</string>
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
ExecStart=${binaryPath} --supervised
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** Task Scheduler definition — Windows has no launchd/systemd equivalent. */
export function renderScheduledTask(binaryPath: string): string {
  // This string is persisted with Node's utf8 encoding. Keep the declaration
  // truthful or Task Scheduler may reject the definition on stricter hosts.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Cognitum Meta-Proxy sidecar</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
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
      <Arguments>--supervised</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// --- the OS commands, as data so they can be asserted -----------------------

export function enableCommands(platform: NodeJS.Platform, unitPath: string, label = SERVICE_LABEL): ServiceCommand[] {
  if (platform === 'darwin') {
    // `bootstrap` is the modern replacement for `load -w`; `kickstart` starts it
    // now so the user does not have to log out and back in to get a daemon.
    return [
      { command: 'launchctl', args: ['bootstrap', `gui/${process.getuid?.() ?? 0}`, unitPath] },
      { command: 'launchctl', args: ['kickstart', `gui/${process.getuid?.() ?? 0}/${label}`] },
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
      { command: 'schtasks', args: ['/create', '/tn', label, '/xml', unitPath, '/f'] },
      { command: 'schtasks', args: ['/run', '/tn', label] },
    ];
  }
  return [];
}

export function disableCommands(platform: NodeJS.Platform, unitPath: string, label = SERVICE_LABEL): ServiceCommand[] {
  if (platform === 'darwin') {
    return [{ command: 'launchctl', args: ['bootout', `gui/${process.getuid?.() ?? 0}/${label}`] }];
  }
  if (platform === 'linux') {
    return [
      { command: 'systemctl', args: ['--user', 'disable', '--now', 'meta-proxy.service'] },
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
    ];
  }
  if (platform === 'win32') {
    return [{ command: 'schtasks', args: ['/delete', '/tn', label, '/f'] }];
  }
  return [];
}

export function serviceStateCommand(platform: NodeJS.Platform, label = SERVICE_LABEL): ServiceCommand | null {
  if (platform === 'darwin') {
    return { command: 'launchctl', args: ['print', `gui/${process.getuid?.() ?? 0}/${label}`] };
  }
  if (platform === 'linux') {
    return {
      command: 'systemctl',
      args: ['--user', 'show', 'meta-proxy.service', '--property=LoadState,UnitFileState,ActiveState,MainPID'],
    };
  }
  if (platform === 'win32') {
    // LIST /v provides the stable `Status: Running|Ready` field consumed below;
    // the default table format is column-aligned and locale/width dependent.
    return { command: 'schtasks', args: ['/query', '/tn', label, '/fo', 'LIST', '/v'] };
  }
  return null;
}

function knownMissingService(platform: NodeJS.Platform, output: string): boolean {
  const text = output.toLowerCase();
  if (platform === 'darwin') {
    return text.includes('could not find service') || text.includes('service not found');
  }
  if (platform === 'linux') {
    return text.includes('loadstate=not-found') || text.includes('unit meta-proxy.service could not be found');
  }
  if (platform === 'win32') {
    return text.includes('cannot find the file specified') || text.includes('task does not exist');
  }
  return false;
}

function parseManagerState(
  platform: NodeJS.Platform,
  outcome: CommandOutcome,
  definitionPresent: boolean,
): Pick<ServiceState, 'managerState' | 'loaded' | 'enabledAtLogin' | 'running' | 'pid'> {
  if (outcome.error) return { managerState: 'unknown', loaded: null, enabledAtLogin: false, running: null, pid: null };
  if (!outcome.ok) {
    return knownMissingService(platform, outcome.output)
      ? { managerState: 'disabled', loaded: false, enabledAtLogin: platform === 'darwin' && definitionPresent, running: false, pid: null }
      : { managerState: 'unknown', loaded: null, enabledAtLogin: false, running: null, pid: null };
  }

  if (platform === 'darwin') {
    const pid = outcome.output.match(/\bpid\s*=\s*(\d+)/)?.[1];
    return {
      managerState: 'enabled',
      loaded: true,
      enabledAtLogin: definitionPresent,
      running: /\bstate\s*=\s*running\b/.test(outcome.output) || pid !== undefined,
      pid: pid ? Number.parseInt(pid, 10) : null,
    };
  }
  if (platform === 'linux') {
    if (/^LoadState=not-found$/m.test(outcome.output)) {
      return { managerState: 'disabled', loaded: false, enabledAtLogin: false, running: false, pid: null };
    }
    const enabled = /^UnitFileState=(?:enabled|enabled-runtime|linked|linked-runtime)$/m.test(outcome.output);
    const loaded = /^LoadState=loaded$/m.test(outcome.output);
    const pidText = outcome.output.match(/^MainPID=(\d+)$/m)?.[1];
    const pid = pidText && pidText !== '0' ? Number.parseInt(pidText, 10) : null;
    return {
      managerState: loaded ? 'enabled' : 'disabled',
      loaded,
      enabledAtLogin: enabled,
      running: /^ActiveState=active$/m.test(outcome.output),
      pid,
    };
  }
  if (platform === 'win32') {
    return {
      managerState: 'enabled',
      loaded: true,
      enabledAtLogin: true,
      running: /^Status:\s+Running\s*$/im.test(outcome.output)
        ? true
        : /^Status:\s+(?:Ready|Disabled)\s*$/im.test(outcome.output)
          ? false
          : null,
      pid: null,
    };
  }
  return { managerState: 'unknown', loaded: null, enabledAtLogin: false, running: null, pid: null };
}

// --- public API -------------------------------------------------------------

export function metaProxyServiceState(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  run: CommandRunner = defaultRunner,
  label = SERVICE_LABEL,
): ServiceState {
  const unitPath = serviceUnitPath(platform, home, label);
  if (!unitPath) return { supported: false, installed: false, unitPath: null, managerState: 'unknown', definitionPresent: false, loaded: null, enabledAtLogin: false, running: null, pid: null };
  const definitionPresent = existsSync(unitPath);
  const command = serviceStateCommand(platform, label);
  const outcome = command ? run(command) : { ok: false, output: '', error: 'unsupported' };
  const manager = parseManagerState(platform, outcome, definitionPresent);
  return { supported: true, installed: manager.loaded === true, unitPath, definitionPresent, ...manager };
}

export interface ServiceOptions {
  home?: string;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  /** Test/enterprise isolation hook; normal users always use SERVICE_LABEL. */
  label?: string;
  /** Bounded synchronous polling seam; production waits without spawning. */
  wait?: (milliseconds: number) => void;
}

function defaultWait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function enableMetaProxyService(options: ServiceOptions = {}): ServiceResult {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;
  const label = options.label ?? SERVICE_LABEL;

  const unitPath = serviceUnitPath(platform, home, label);
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
      ? renderLaunchAgent(binaryPath, logPath, label)
      : platform === 'linux'
        ? renderSystemdUnit(binaryPath)
        : renderScheduledTask(binaryPath);

  const before = metaProxyServiceState(platform, home, run, label);
  if (before.managerState === 'unknown') {
    return { ok: false, message: `Could not determine service-manager state; preserved ${unitPath}.`, unitPath };
  }
  if (before.definitionPresent && readFileSync(unitPath, 'utf8') !== definition) {
    return {
      ok: false,
      message: `A different Meta-Proxy service definition already exists at ${unitPath}. Disable it before replacement.`,
      unitPath,
    };
  }
  if (before.managerState === 'enabled' && before.enabledAtLogin) {
    if (before.definitionPresent) {
      return { ok: true, message: `Meta-Proxy is already set to start at login. Definition: ${unitPath}`, unitPath };
    }
    return {
      ok: false,
      message: `A Meta-Proxy service is already registered with a different or missing definition. Disable it before replacing ${unitPath}.`,
      unitPath,
    };
  }

  mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
  writeFileSync(unitPath, definition, { encoding: 'utf8', mode: 0o600 });

  for (const invocation of enableCommands(platform, unitPath, label)) {
    const outcome = run(invocation);
    if (!outcome.ok) {
      const state = metaProxyServiceState(platform, home, run, label);
      if (before.definitionPresent) {
        // This enable started from an existing owned definition. Never erase it
        // or stop a pre-existing active service while compensating a failed
        // attempt to change only its login-start state.
        if (platform === 'linux') {
          const restore: ServiceCommand[] = [];
          if (!before.enabledAtLogin && state.enabledAtLogin) {
            // Deliberately omit --now: a service that was already active must
            // remain active while only its prior login-enable bit is restored.
            restore.push({ command: 'systemctl', args: ['--user', 'disable', 'meta-proxy.service'] });
          }
          if (before.running === false && state.running === true) {
            restore.push({ command: 'systemctl', args: ['--user', 'stop', 'meta-proxy.service'] });
          }
          const restoreFailure = restore.map((command) => run(command)).find((result) => !result.ok);
          if (restoreFailure) {
            return {
              ok: false,
              message: `Could not enable start-at-login and restoring the prior service state failed: ${restoreFailure.output || 'command failed'}. Definition preserved at ${unitPath}.`,
              unitPath,
            };
          }
          const restored = metaProxyServiceState(platform, home, run, label);
          if (
            restored.managerState === 'unknown'
            || restored.enabledAtLogin !== before.enabledAtLogin
            || restored.running !== before.running
          ) {
            return {
              ok: false,
              message: `Could not prove the prior service state was restored. Definition preserved at ${unitPath}.`,
              unitPath,
            };
          }
        }
        if (before.loaded === false && state.managerState === 'enabled') {
          const cleanup = disableCommands(platform, unitPath, label)[0];
          const cleanupOutcome = cleanup ? run(cleanup) : { ok: false, output: 'cleanup command unavailable' };
          if (!cleanupOutcome.ok) {
            return {
              ok: false,
              message: `Could not enable start-at-login and compensating cleanup failed: ${cleanupOutcome.output || 'command failed'}. Definition preserved at ${unitPath}.`,
              unitPath,
            };
          }
        }
        return {
          ok: false,
          message: `Could not enable start-at-login (${invocation.command} ${invocation.args.join(' ')}): ${outcome.output || 'command failed'}. Definition preserved at ${unitPath}.`,
          unitPath,
        };
      }
      if (state.managerState === 'enabled') {
        const cleanupFailures = disableCommands(platform, unitPath, label)
          .map((cleanup) => run(cleanup))
          .filter((cleanup) => !cleanup.ok);
        if (cleanupFailures.length > 0) {
          return {
            ok: false,
            message: `Could not enable start-at-login and compensating cleanup failed: ${cleanupFailures.map((failure) => failure.output || 'command failed').join('; ')}. Definition preserved at ${unitPath}.`,
            unitPath,
          };
        }
      } else if (state.managerState === 'unknown') {
        return {
          ok: false,
          message: `Could not enable start-at-login and manager state is unknown. Definition preserved at ${unitPath}.`,
          unitPath,
        };
      }
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

function startCommand(platform: NodeJS.Platform, label = SERVICE_LABEL): ServiceCommand | null {
  if (platform === 'darwin') return { command: 'launchctl', args: ['kickstart', `gui/${process.getuid?.() ?? 0}/${label}`] };
  if (platform === 'linux') return { command: 'systemctl', args: ['--user', 'start', 'meta-proxy.service'] };
  if (platform === 'win32') return { command: 'schtasks', args: ['/run', '/tn', label] };
  return null;
}

function stopCommand(platform: NodeJS.Platform, label = SERVICE_LABEL): ServiceCommand | null {
  // `launchctl kill SIGTERM` may still be classified by launchd as an
  // unsuccessful termination and restarted under KeepAlive. Bootout unloads
  // the current job but deliberately leaves the plist in LaunchAgents, so the
  // explicit stop stays stopped now and remains configured for next login.
  if (platform === 'darwin') return { command: 'launchctl', args: ['bootout', `gui/${process.getuid?.() ?? 0}/${label}`] };
  if (platform === 'linux') return { command: 'systemctl', args: ['--user', 'stop', 'meta-proxy.service'] };
  if (platform === 'win32') return { command: 'schtasks', args: ['/end', '/tn', label] };
  return null;
}

export function startMetaProxyService(options: ServiceOptions = {}): ServiceResult {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;
  const label = options.label ?? SERVICE_LABEL;
  const state = metaProxyServiceState(platform, home, run, label);
  if (state.managerState === 'unknown') return { ok: false, message: 'Could not determine service-manager state.' };
  if (state.managerState !== 'enabled' && !(platform === 'darwin' && state.definitionPresent)) {
    return { ok: false, message: 'Meta-Proxy is not enabled at login.' };
  }
  if (state.running) return { ok: true, message: `Meta-Proxy is already running${state.pid ? ` (pid ${state.pid})` : ''}.` };
  const commands = platform === 'darwin' && state.managerState === 'disabled' && state.unitPath
    ? enableCommands(platform, state.unitPath, label)
    : [startCommand(platform, label)].filter((command): command is ServiceCommand => command !== null);
  if (commands.length === 0) return { ok: false, message: `Managed start is not supported on ${platform}.` };
  for (const command of commands) {
    const outcome = run(command);
    if (!outcome.ok) return { ok: false, message: `Could not start Meta-Proxy: ${outcome.output || 'command failed'}` };
  }
  return { ok: true, message: 'Meta-Proxy managed start requested.' };
}

export function stopMetaProxyService(options: ServiceOptions = {}): ServiceResult {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;
  const label = options.label ?? SERVICE_LABEL;
  const state = metaProxyServiceState(platform, home, run, label);
  if (state.managerState === 'unknown') return { ok: false, message: 'Could not determine service-manager state.' };
  if (state.managerState !== 'enabled') {
    return state.enabledAtLogin
      ? { ok: true, message: 'Meta-Proxy managed service is already stopped.' }
      : { ok: false, message: 'Meta-Proxy is not enabled at login.' };
  }
  if (state.running === false) return { ok: true, message: 'Meta-Proxy managed service is already stopped.' };
  const command = stopCommand(platform, label);
  if (!command) return { ok: false, message: `Managed stop is not supported on ${platform}.` };
  const outcome = run(command);
  return outcome.ok
    ? { ok: true, message: 'Meta-Proxy managed stop requested.' }
    : { ok: false, message: `Could not stop Meta-Proxy: ${outcome.output || 'command failed'}` };
}

export function disableMetaProxyService(options: ServiceOptions = {}): ServiceResult {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;
  const label = options.label ?? SERVICE_LABEL;
  const wait = options.wait ?? defaultWait;

  const unitPath = serviceUnitPath(platform, home, label);
  if (!unitPath) {
    return { ok: true, message: `Start-at-login is not supported on ${platform}; nothing to disable.` };
  }
  const state = metaProxyServiceState(platform, home, run, label);
  if (state.managerState === 'unknown') {
    return { ok: false, message: `Could not determine service-manager state; preserved ${unitPath}.`, unitPath };
  }
  if (state.managerState === 'disabled' && !state.definitionPresent) {
    return { ok: true, message: 'Meta-Proxy is not set to start at login.' };
  }

  if (platform === 'win32' && state.managerState === 'enabled') {
    // Deleting a running task loses the only manager handle while its child
    // can remain alive. End first and require an authoritative stopped state.
    const end = stopCommand(platform, label);
    if (!end) return { ok: false, message: 'Could not construct the Windows stop command.', unitPath };
    run(end);
    let stopped = metaProxyServiceState(platform, home, run, label);
    for (let attempt = 0; attempt < 20 && stopped.managerState !== 'unknown' && stopped.running !== false; attempt++) {
      wait(100);
      stopped = metaProxyServiceState(platform, home, run, label);
    }
    if (stopped.managerState === 'unknown' || stopped.running !== false) {
      return {
        ok: false,
        message: `Could not confirm the Meta-Proxy task stopped; preserved task and ${unitPath}.`,
        unitPath,
      };
    }
    const removeTask = disableCommands(platform, unitPath, label)[0];
    const removed = removeTask ? run(removeTask) : { ok: false, output: 'delete command unavailable' };
    if (!removed.ok) {
      return {
        ok: false,
        message: `Could not delete the stopped Meta-Proxy task: ${removed.output || 'command failed'}. Definition preserved at ${unitPath}.`,
        unitPath,
      };
    }
    rmSync(unitPath, { force: true });
    return { ok: true, message: `Meta-Proxy will no longer start at login. Removed ${unitPath}.` };
  }

  const unregister = state.managerState === 'enabled'
    ? disableCommands(platform, unitPath, label)[0]
    : undefined;
  if (unregister) {
    const outcome = run(unregister);
    if (!outcome.ok) {
      return {
        ok: false,
        message: `Could not disable start-at-login: ${outcome.output || `${unregister.command} failed`}. Definition preserved at ${unitPath}.`,
        unitPath,
      };
    }
  }

  const definition = state.definitionPresent ? readFileSync(unitPath, 'utf8') : null;
  rmSync(unitPath, { force: true });
  if (platform === 'linux') {
    const refresh = disableCommands(platform, unitPath, label)[1];
    const outcome = refresh ? run(refresh) : { ok: false, output: 'daemon-reload command unavailable' };
    if (!outcome.ok) {
      if (definition !== null) {
        mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
        writeFileSync(unitPath, definition, { encoding: 'utf8', mode: 0o600 });
      }
      return {
        ok: false,
        message: `Disabled service, but daemon-reload failed: ${outcome.output || 'command failed'}. Definition restored at ${unitPath}.`,
        unitPath,
      };
    }
  }
  return { ok: true, message: `Meta-Proxy will no longer start at login. Removed ${unitPath}.` };
}
