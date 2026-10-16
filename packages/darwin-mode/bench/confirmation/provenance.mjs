import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './dataset.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
function walk(path, suffix) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(path, entry.name), suffix) :
      entry.name.endsWith(suffix) ? [join(path, entry.name)] : []);
}
export function sourceState() {
  const paths = [
    ...walk(join(root, 'packages/darwin-mode/src/contrastive'), '.ts'),
    ...walk(join(root, 'packages/darwin-mode/dist/contrastive'), '.js'),
    ...walk(join(root, 'packages/darwin-mode/bench/confirmation'), '.mjs'),
    join(root, 'packages/darwin-mode/bench/confirmation/frozen-dataset.json'),
    join(root, 'packages/darwin-mode/package.json'), join(root, 'package-lock.json'),
  ].sort();
  const files = paths.map(path => ({ path: relative(root, path), sha256: hash(readFileSync(path)) }));
  return { gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceAndBuildSha256: hash(files), files, node: process.version };
}
