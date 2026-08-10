// SPDX-License-Identifier: MIT
//
// `harness secrets` — GCP Secret Manager integration for publish-time
// credential validation. Uses `gcloud` shell-outs (already a documented
// prereq) rather than the @google-cloud/secret-manager SDK to avoid
// pulling 12 MB of GCP client deps into every install.
//
// Commands:
//   harness secrets check               validate full GCP setup
//   harness secrets fetch <name>        fetch a secret value (stdout)
//   harness secrets validate-token      fetch NPM_TOKEN + npm whoami
//
// Auth path:
//   - Local dev: ADC via `gcloud auth application-default login`
//   - CI:       Workload Identity Federation (no long-lived keys)

import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

const execFile = promisify(execFileCb);

export type SubcommandResult = { code: number; lines: string[] };

export interface GcloudRunner {
  run(args: string[], opts?: { input?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Default runner — wraps gcloud subprocess. */
export const defaultRunner: GcloudRunner = {
  async run(args, _opts) {
    try {
      const { stdout, stderr } = await execFile('gcloud', args, {
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? (e.message ?? ''),
      };
    }
  },
};

export interface PathLookupProcess {
  once(event: string, listener: (value: unknown) => void): PathLookupProcess;
  kill(): boolean;
}

export type PathSpawner = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: boolean },
) => PathLookupProcess;

/** PATH discovery is diagnostic, so it must never hang the command or CI. */
export function commandOnPath(
  executable: string,
  platform: NodeJS.Platform = process.platform,
  spawnCommand: PathSpawner = (command, args, options) => spawn(command, args, options) as PathLookupProcess,
  timeoutMs = 2_000,
): Promise<boolean> {
  return new Promise(resolve => {
    const cmd = platform === 'win32' ? 'where' : 'which';
    const child = spawnCommand(cmd, [executable], { stdio: 'ignore', windowsHide: true });
    let settled = false;
    const finish = (found: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(found);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    child.once('error', () => finish(false));
    child.once('exit', code => finish(code === 0));
  });
}

/** Validate full GCP setup for publish-time secret fetch. */
export async function check(
  args: string[],
  runner: GcloudRunner = defaultRunner,
  pathProbe: () => Promise<boolean> = () => commandOnPath('gcloud'),
): Promise<SubcommandResult> {
  const lines: string[] = ['harness secrets check'];
  let problems = 0;
  const projectFromFlag = args.find(a => a.startsWith('--project='))?.slice('--project='.length);
  const secretName = args.find(a => a.startsWith('--secret='))?.slice('--secret='.length) ?? 'NPM_TOKEN';

  if (!(await pathProbe())) {
    lines.push('  FAIL gcloud CLI not on PATH');
    lines.push('       install: https://cloud.google.com/sdk/docs/install');
    return { code: 1, lines };
  }
  lines.push('  PASS gcloud is on PATH');

  // 1. Project
  let project = projectFromFlag;
  if (!project) {
    const r = await runner.run(['config', 'get-value', 'project']);
    project = r.stdout.trim();
    if (!project || project === '(unset)') {
      lines.push('  FAIL no active gcloud project (try --project=<id> or gcloud config set project)');
      problems++;
    } else {
      lines.push(`  PASS active project: ${project}`);
    }
  } else {
    lines.push(`  PASS project flag: ${project}`);
  }
  if (!project || problems > 0) return { code: 1, lines };

  // 2. Auth
  const auth = await runner.run(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  if (auth.code !== 0 || !auth.stdout.trim()) {
    lines.push('  FAIL no active gcloud auth (run: gcloud auth application-default login)');
    problems++;
  } else {
    lines.push(`  PASS active account: ${auth.stdout.trim()}`);
  }

  // 3. Secret exists
  const sec = await runner.run([
    'secrets', 'describe', secretName,
    `--project=${project}`,
    '--format=value(name)',
  ]);
  if (sec.code !== 0) {
    lines.push(`  FAIL secret '${secretName}' not found in project ${project}`);
    lines.push('       create with: gcloud secrets create ' + secretName + ' --replication-policy=automatic');
    problems++;
  } else {
    lines.push(`  PASS secret '${secretName}' exists`);
  }

  // 4. WIF pool (best-effort — skip if list errors)
  const pool = await runner.run([
    'iam', 'workload-identity-pools', 'list',
    '--location=global', `--project=${project}`,
    '--format=value(displayName)', '--filter=state:ACTIVE',
  ]);
  if (pool.code === 0 && pool.stdout.trim()) {
    lines.push(`  PASS workload-identity-pool present (${pool.stdout.trim().split('\n')[0]})`);
  } else {
    lines.push('  WARN no active workload-identity-pool found');
    lines.push('       CI cannot fetch this secret without WIF — see docs/setup/gcp-secrets.md');
  }

  if (problems === 0) {
    lines.push('', `Result: HEALTHY (project=${project}, secret=${secretName})`);
    return { code: 0, lines };
  }
  lines.push('', `Result: ${problems} issue${problems === 1 ? '' : 's'}`);
  return { code: 1, lines };
}

/** Fetch a secret's latest value and print to stdout. */
export async function fetch(args: string[], runner: GcloudRunner = defaultRunner): Promise<SubcommandResult> {
  const lines: string[] = [];
  const name = args.find(a => !a.startsWith('--'));
  if (!name) {
    return { code: 2, lines: ['Usage: harness secrets fetch <secret-name> [--project=<id>] [--version=latest]'] };
  }
  const project = args.find(a => a.startsWith('--project='))?.slice('--project='.length);
  const version = args.find(a => a.startsWith('--version='))?.slice('--version='.length) ?? 'latest';

  const cmd = ['secrets', 'versions', 'access', version, `--secret=${name}`];
  if (project) cmd.push(`--project=${project}`);

  const r = await runner.run(cmd);
  if (r.code !== 0) {
    return {
      code: 1,
      lines: [
        `Fetch failed for secret '${name}': ${r.stderr.trim() || 'unknown error'}`,
        'Try: harness secrets check --secret=' + name,
      ],
    };
  }
  // Print raw value to stdout for piping (no trailing newline added).
  process.stdout.write(r.stdout);
  return { code: 0, lines };
}

/**
 * Fetch NPM_TOKEN and run `npm whoami --registry=https://registry.npmjs.org/`.
 * No publish — just confirms the token is valid + non-revoked.
 */
export async function validateToken(args: string[], runner: GcloudRunner = defaultRunner): Promise<SubcommandResult> {
  const lines: string[] = ['harness secrets validate-token'];
  const project = args.find(a => a.startsWith('--project='))?.slice('--project='.length);
  const secret = args.find(a => a.startsWith('--secret='))?.slice('--secret='.length) ?? 'NPM_TOKEN';

  const cmd = ['secrets', 'versions', 'access', 'latest', `--secret=${secret}`];
  if (project) cmd.push(`--project=${project}`);

  const r = await runner.run(cmd);
  if (r.code !== 0) {
    lines.push(`  FAIL could not fetch '${secret}' — ${r.stderr.trim() || 'unknown error'}`);
    return { code: 1, lines };
  }
  const token = r.stdout.trim();
  if (!token) {
    lines.push(`  FAIL secret '${secret}' returned an empty value`);
    return { code: 1, lines };
  }
  lines.push(`  PASS fetched '${secret}' (${token.length} chars)`);

  // Run npm whoami with token injected via env. No persistent .npmrc rewrite.
  try {
    const { stdout, stderr } = await execFile('npm', ['whoami', '--registry=https://registry.npmjs.org/'], {
      env: { ...process.env, npm_config__authToken: token },
      windowsHide: true,
    });
    const who = stdout.trim();
    if (!who) {
      lines.push(`  FAIL npm whoami returned empty (stderr: ${stderr.trim()})`);
      return { code: 1, lines };
    }
    lines.push(`  PASS npm whoami: ${who}`);
    lines.push('', `Result: HEALTHY (secret=${secret}, npm_user=${who})`);
    return { code: 0, lines };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    lines.push(`  FAIL npm whoami failed: ${e.stderr?.trim() || e.message || 'unknown'}`);
    lines.push('       token is set but npm rejected it — may be expired or revoked');
    return { code: 1, lines };
  }
}

/** Top-level dispatcher for `harness secrets <subsub> ...`. */
export async function secretsDispatch(args: string[], runner: GcloudRunner = defaultRunner): Promise<SubcommandResult> {
  const [subsub = 'help', ...rest] = args;
  switch (subsub) {
    case 'check':
      return check(rest, runner);
    case 'fetch':
      return fetch(rest, runner);
    case 'validate-token':
      return validateToken(rest, runner);
    case 'help':
      return {
        code: 0,
        lines: [
          'Usage: harness secrets <subcommand> [options]',
          '',
          'Subcommands:',
          '  check           — validate full GCP Secret Manager setup',
          '  fetch <name>    — fetch a secret value (prints to stdout)',
          '  validate-token  — fetch NPM_TOKEN and run `npm whoami`',
          '',
          'Common options:',
          '  --project=<id>    override gcloud active project',
          '  --secret=<name>   override default secret name (NPM_TOKEN)',
          '  --version=latest  fetch a specific secret version',
          '',
          'CI usage (Workload Identity Federation):',
          '  see docs/setup/gcp-secrets.md',
        ],
      };
    default:
      return {
        code: 2,
        lines: [`Unknown secrets subcommand: ${subsub}`, `Run 'harness secrets help' for usage.`],
      };
  }
}
