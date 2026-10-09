// Child-process hygiene shared by render-and-check.mjs (docker, the env lane's python scripts, openenv) and
// darwin-steps.mjs (run-darwin, evaluator, calibrate.py): no secret-shaped variable is ever inherited.
import { spawn } from 'node:child_process';

/** Every credential-shaped name (HF_TOKEN, VAST_API_KEY, OPENAI_API_KEY, AWS_*, ...) and every HF_* / HUGGING* setting. */
export const SECRET_ENV = /TOKEN|SECRET|PASSW|CREDENTIAL|API_KEY|_KEY$|^AWS_|^GOOGLE_APPLICATION_CREDENTIALS$|^OPENAI|^OPENROUTER|^ANTHROPIC|^HF_|^HUGGING/i;

/** Child processes never inherit anything secret-shaped; loopback is never proxied. */
export function childEnv(base = process.env, extra = {}) {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !SECRET_ENV.test(k)));
  // PYTHONDONTWRITEBYTECODE: the env lane worktree is read-only to us; never drop .pyc files into it.
  return { ...env, NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1', PYTHONDONTWRITEBYTECODE: '1', ...extra };
}

export function runCmd(argv, { cwd, env, timeoutMs = 120_000, maxBytes = 8 << 20 } = {}) {
  return new Promise(done => {
    let settled = false;
    const finish = r => { if (!settled) { settled = true; clearTimeout(timer); done(r); } };
    const out = []; const err = []; let n = 0; let timedOut = false;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = arr => d => { n += d.length; if (n <= maxBytes) arr.push(d); };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', e => finish({ code: null, stdout: '', stderr: `spawn failed: ${e.code ?? e.message}`, timedOut }));
    child.on('close', code => finish({ code: timedOut ? null : code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), timedOut }));
  });
}
