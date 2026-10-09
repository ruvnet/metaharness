#!/usr/bin/env node
// Fake `docker` CLI for render-and-check tests. State lives in $FAKE_DOCKER_DIR:
//   calls.jsonl            every invocation: argv, DOCKER_CONFIG and its entries, whether any secret env leaked in
//   containers/<name>.json one per "running container": {pid, hostPort, labels}
// $FAKE_DOCKER_MODE: ok | real-env | pull-fail | arm64 | no-health | flaky-schema | port-missing | stop-fails | dies
// `run` starts a detached server that outlives this process like a container would: the real env lane server
// from source (real-env: $FAKE_ENV_PYTHON -m uvicorn arena_env.app:app in $FAKE_ENV_DIR) or fake-env-server.mjs.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE = process.env.FAKE_DOCKER_DIR;
const MODE = process.env.FAKE_DOCKER_MODE ?? 'ok';
const CDIR = join(STATE, 'containers');
mkdirSync(CDIR, { recursive: true });
const argv = process.argv.slice(2);
const cfg = process.env.DOCKER_CONFIG;
appendFileSync(join(STATE, 'calls.jsonl'), JSON.stringify({ argv, dockerConfig: cfg ?? null,
  dockerConfigEntries: cfg && existsSync(cfg) ? readdirSync(cfg) : null,
  secretEnv: Object.keys(process.env).filter(k => /TOKEN|API_KEY|SECRET/i.test(k)) }) + '\n');

const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const all = name => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const load = n => (existsSync(join(CDIR, `${n}.json`)) ? JSON.parse(readFileSync(join(CDIR, `${n}.json`), 'utf8')) : null);
const die = (msg, code = 1) => { process.stderr.write(msg + '\n'); process.exit(code); };
const kill = n => {
  const c = load(n);
  if (!c) return false;
  if (c.pid) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ } }
  rmSync(join(CDIR, `${n}.json`), { force: true });
  return true;
};
const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const [cmd, sub] = argv;
if (cmd === 'pull') {
  if (MODE === 'pull-fail') die('Error response from daemon: denied: requested access to the resource is denied');
  process.stdout.write(`Status: Image is up to date for ${argv.at(-1)}\n`);
} else if (cmd === 'image' && sub === 'inspect') {
  const image = argv.at(-1);
  process.stdout.write(JSON.stringify({ Id: 'sha256:' + image.split('@sha256:')[1], Os: 'linux', Architecture: MODE === 'arm64' ? 'arm64' : 'amd64',
    RepoDigests: [image], Config: { ExposedPorts: { '8000/tcp': {} }, WorkingDir: '/app', Entrypoint: ['/usr/bin/tini', '--'], Cmd: ['python', '-m', 'uvicorn', 'arena_env.app:app'] } }) + '\n');
} else if (cmd === 'cp') { // cp <container>:/app/<rel> <dest>: the "image" filesystem is $FAKE_IMAGE_SRC (default $FAKE_ENV_DIR)
  const [src, dest] = argv.slice(1);
  const [name, p] = src.split(':');
  if (!load(name)) die(`Error response from daemon: No such container: ${name}`);
  if (MODE === 'cp-fail' || !p.startsWith('/app/')) die(`Error response from daemon: Could not find the file ${p} in container ${name}`);
  const from = join(process.env.FAKE_IMAGE_SRC ?? process.env.FAKE_ENV_DIR, p.slice('/app/'.length));
  if (!existsSync(from)) die(`Error response from daemon: Could not find the file ${p} in container ${name}`);
  writeFileSync(dest, readFileSync(from));
} else if (cmd === 'run') {
  const name = flag('--name');
  const labels = Object.fromEntries(all('--label').map(l => l.split('=')));
  const hostPort = await freePort();
  const real = MODE === 'real-env';
  const [bin, args, cwd] = real
    ? [process.env.FAKE_ENV_PYTHON, ['-m', 'uvicorn', 'arena_env.app:app', '--host', '127.0.0.1', '--port', String(hostPort), '--workers', '1'], process.env.FAKE_ENV_DIR]
    : [process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'fake-env-server.mjs'), String(hostPort), MODE], undefined];
  const child = spawn(bin, args, { cwd, detached: true, stdio: 'ignore', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ENABLE_WEB_INTERFACE: 'false' } });
  child.unref();
  writeFileSync(join(CDIR, `${name}.json`), JSON.stringify({ pid: child.pid, hostPort, labels, publish: flag('-p') }));
  process.stdout.write('f'.repeat(64) + '\n');
} else if (cmd === 'port') {
  const c = load(argv[1]);
  if (!c) die(`Error: No such container: ${argv[1]}`);
  if (MODE !== 'port-missing') process.stdout.write(`127.0.0.1:${c.hostPort}\n`);
} else if (cmd === 'stop' || cmd === 'rm') {
  const name = argv.at(-1);
  if (MODE === 'stop-fails') die('Error response from daemon: cannot stop container');
  if (!kill(name)) die(`Error response from daemon: No such container: ${name}`);
  process.stdout.write(name + '\n');
} else if (cmd === 'ps') {
  const wantDeadline = (flag('--format') ?? '').includes('deadline');
  for (const f of readdirSync(CDIR).filter(x => x.endsWith('.json'))) {
    const c = JSON.parse(readFileSync(join(CDIR, f), 'utf8'));
    if (c.labels?.['arena-flywheel.check'] !== '1') continue;
    if (c.pid) { try { process.kill(c.pid, 0); } catch { rmSync(join(CDIR, f), { force: true }); continue; } } // --rm: a dead container is gone
    const name = f.slice(0, -5);
    process.stdout.write(wantDeadline ? `${name}\t${c.labels['arena-flywheel.deadline'] ?? ''}\n` : `${name}\n`);
  }
} else {
  die(`fake docker: unsupported ${argv.join(' ')}`, 125);
}
