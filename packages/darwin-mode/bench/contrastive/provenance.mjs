import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
function walk(dir, suffix) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name), suffix)
      : entry.name.endsWith(suffix) ? [join(dir, entry.name)] : []);
}
export function provenance() {
  const paths = [
    ...walk(join(root, 'packages/darwin-mode/src/contrastive'), '.ts'),
    ...walk(join(root, 'packages/darwin-mode/dist/contrastive'), '.js'),
    ...walk(join(root, 'packages/darwin-mode/bench/contrastive'), '.mjs'),
    join(root, 'package-lock.json'),
  ].sort();
  const files = paths.map(path => ({ path: relative(root, path),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
  return {
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceAndBuildSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files, node: process.version, platform: process.platform, arch: process.arch,
  };
}
export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { n: sorted.length, medianMs: at(.5), p95Ms: at(.95), minMs: sorted[0] };
}
