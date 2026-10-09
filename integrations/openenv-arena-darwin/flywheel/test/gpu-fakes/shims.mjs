// Builds a throwaway bin dir with fake `vastai`, `gcloud` and `ssh` wrappers for one test.
// Nothing here can reach Vast, Google or a real host: every binary the code under test resolves by name
// comes first on the PATH it is given, and tests assert the fake call logs are non-empty.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DUMMY_KEY = 'DUMMYVASTKEY-0123456789abcdef-NOTREAL';
export const DUMMY_KEY_SHA = createHash('sha256').update(DUMMY_KEY).digest('hex').slice(0, 12);
export const SENTINEL_IAK = 'SENTINEL-INSTANCE-API-KEY-7f3a9c11';
export const SENTINEL_JUP = 'SENTINEL-JUPYTER-TOKEN-55aa01';
export const SECRETS = [DUMMY_KEY, SENTINEL_IAK, SENTINEL_JUP];

const readJsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function makeShims({ scenario = {}, gcloud = 'ok', ssh = 'ok' } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gpu-shims-'));
  const bin = path.join(dir, 'bin');
  const stateDir = path.join(dir, 'state');
  mkdirSync(bin);
  const f = { scenario: path.join(dir, 'scenario.json'), vast: path.join(dir, 'vast-calls.jsonl'),
    gcloud: path.join(dir, 'gcloud-calls.log'), ssh: path.join(dir, 'ssh-calls.jsonl') };
  const write = (name, body) => { const p = path.join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); };
  write('vastai', `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(path.join(HERE, 'fake-vastai.mjs'))} ${sh(f.scenario)} ${sh(f.vast)} "$@"\n`);
  write('ssh', `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(path.join(HERE, 'fake-ssh.mjs'))} ${sh(f.ssh)} ${sh(ssh)} "$@"\n`);
  write('gcloud', `#!/bin/sh\nprintf '%s\\n' "$*" >> ${sh(f.gcloud)}\n${gcloud === 'ok'
    ? `printf '%s\\n' ${sh(DUMMY_KEY)}\n` : `echo 'ERROR: (gcloud.secrets.versions.access) PERMISSION_DENIED' >&2\nexit 1\n`}`);
  const keyPath = path.join(dir, 'id_test');
  writeFileSync(keyPath, 'fake private key for tests\n', { mode: 0o600 });
  writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAAC3NzaFAKEFAKEFAKE test@shim\n');
  const shims = {
    dir, bin, stateDir, keyPath, files: f,
    pathEnv: `${bin}:${process.env.PATH}`,
    setScenario(s) { writeFileSync(f.scenario, JSON.stringify(s)); rmSync(`${f.scenario}.state`, { force: true }); },
    vastCalls: (cmd) => readJsonl(f.vast).filter(c => !cmd || c.cmd === cmd),
    gcloudCalls: () => (existsSync(f.gcloud) ? readFileSync(f.gcloud, 'utf8').split('\n').filter(Boolean) : []),
    sshCalls: () => readJsonl(f.ssh),
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
  shims.setScenario(scenario);
  return shims;
}

/** Every vastai call: --raw, key in env (the dummy), no update check, no key-leaking flags, minimal env. */
export function assertCleanVastCalls(assert, calls, { minimalEnv = true } = {}) {
  assert.ok(calls.length > 0, 'the fake vastai was never called (PATH shadowing failed?)');
  const allowed = new Set(['PATH', 'HOME', 'LANG', 'VAST_API_KEY', 'VASTAI_NO_UPDATE_CHECK']);
  for (const c of calls) {
    assert.ok(c.argv.includes('--raw'), `${c.cmd}: --raw missing`);
    assert.ok(!c.argv.some(a => ['--api-key', '--explain', '--curl'].includes(a.split('=')[0])), `${c.cmd}: forbidden flag`);
    assert.ok(c.argv.every(a => !a.includes(DUMMY_KEY)), `${c.cmd}: key in argv`);
    assert.equal(c.hasKey, true, `${c.cmd}: VAST_API_KEY not in env`);
    assert.equal(c.keySha, DUMMY_KEY_SHA, `${c.cmd}: wrong key`);
    assert.equal(c.noUpdateCheck, true, `${c.cmd}: update check not disabled`);
    if (minimalEnv) assert.deepEqual(c.envKeys.filter(k => !allowed.has(k)), [], `${c.cmd}: extra env vars`);
  }
}

/** No secret value appears in any of the given texts. */
export function assertNoSecrets(assert, ...texts) {
  for (const t of texts) for (const s of SECRETS) assert.ok(!String(t).includes(s), `secret leaked: ${s.slice(0, 12)}...`);
}
