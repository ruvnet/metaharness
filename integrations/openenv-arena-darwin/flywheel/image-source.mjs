// The environment source INSIDE the image under test, hashed exactly like lib/provenance.mjs hashes an env worktree
// (envSourceSha = sha256(arena_env/tasks.py bytes ‖ arena_env/environment.py bytes)). The decision compares it with
// the confirmation plan's envSourceSha, so the image that gets submitted is the environment that was measured.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './canonical-json.mjs';

export const ENV_SOURCE_FILES = Object.freeze(['tasks.py', 'environment.py']);

/**
 * Copy arena_env/{tasks,environment}.py out of `container` (a running container of the pinned digest) with
 * `docker cp` and hash them. docker(args, timeoutS) -> {code, stderr}; root = the image's arena_env directory.
 * -> {ok, envSourceSha, tasksPySha256, environmentPySha256, root} | {ok:false, reasons}
 */
export async function imageEnvSource({ docker, container, root, outDir, tail = s => String(s ?? '').slice(-200) }) {
  if (typeof root !== 'string' || !/^\/[A-Za-z0-9._/-]+$/.test(root) || root.includes('..')) return { ok: false, reasons: ['image_env_root_invalid'] };
  const dir = join(outDir, 'image-env-source');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const parts = [];
  for (const f of ENV_SOURCE_FILES) {
    const dest = join(dir, f);
    const r = await docker(['cp', `${container}:${root}/${f}`, dest], 60);
    if (r.code !== 0 || !existsSync(dest)) return { ok: false, reasons: [`image_env_source_unreadable:${f}:${tail(r.stderr)}`] };
    parts.push(readFileSync(dest));
  }
  return { ok: true, envSourceSha: sha256Hex(Buffer.concat(parts)), tasksPySha256: sha256Hex(parts[0]), environmentPySha256: sha256Hex(parts[1]), root };
}
