// Local SSH tunnel to the rented instance's vLLM port, and the /v1/models readiness probe.
// Direct SSH (public_ipaddr + ports['22/tcp'].HostPort) as root, key-only, no ssh config files, no agent,
// a per-run known_hosts file (Vast host keys are new every rental: trust on first use, then pinned).
// vLLM listens on the instance's port 8000, which is never published: the tunnel is the only way in.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { resolveBin } from './gpu-vast-cli.mjs';

/** Ask the kernel for a free loopback port. */
export function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export function sshTunnelArgs({ host, port, localPort, keyPath, knownHostsFile, remotePort = 8000 }) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new Error('tunnel: host must be an IPv4 address');
  for (const [n, v] of Object.entries({ port, localPort, remotePort })) {
    if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`tunnel: ${n} out of range`);
  }
  return ['-F', 'none', '-N', '-T',
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-i', keyPath,
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
    '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHostsFile}`,
    '-p', String(port), '-L', `127.0.0.1:${localPort}:localhost:${remotePort}`, `root@${host}`];
}

/**
 * Start ssh and give it `settleMs` to fail (bad key, refused, forward in use). -> handle or throws.
 * The handle is {localPort, alive(), close()}; close() is idempotent.
 */
export async function openTunnel({ host, port, keyPath, knownHostsFile, localPort, pathEnv = process.env.PATH,
  home = process.env.HOME, settleMs = 3000, sleep }) {
  const lp = localPort || await freeLocalPort();
  const args = sshTunnelArgs({ host, port, localPort: lp, keyPath, knownHostsFile });
  const proc = spawn(resolveBin('ssh', pathEnv), args, { env: { PATH: pathEnv, HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
  let exited = false; let stderr = '';
  proc.stderr.on('data', d => { if (stderr.length < 2000) stderr += d; });
  proc.on('exit', () => { exited = true; });
  proc.on('error', () => { exited = true; });
  await sleep(settleMs);
  const close = () => { if (!exited) { try { proc.kill('SIGTERM'); } catch { /* gone */ } } };
  if (exited) { close(); throw new Error(`tunnel: ssh exited early: ${stderr.trim().split('\n').pop()?.slice(0, 200) ?? ''}`); }
  return { localPort: lp, alive: () => !exited, close };
}

/** One probe: true when GET {baseUrl}/models lists `model`. Never throws. */
export async function probeModels(baseUrl, model, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  try {
    const r = await fetchImpl(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.status !== 200) return false;
    const j = await r.json();
    return Array.isArray(j?.data) && j.data.some(m => m && m.id === model);
  } catch { return false; }
}
