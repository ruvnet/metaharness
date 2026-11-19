// Wasm artifacts that a package promises to ship.
//
// A package that ships wasm declares the files in its package.json:
//   "metaharness": { "wasmArtifacts": ["wasm/horizon_core.wasm"] }
// and has a `build:wasm` script that produces them. The wasm is gitignored, so
// nothing produces it unless the release job runs that script. @metaharness/horizon
// 0.2.1 went out without it (its loader then failed with ENOENT on
// wasm/horizon_core.wasm); this module is what stops that from happening again.
//
//   node scripts/wasm-artifacts.mjs needs-wasm   -> prints true|false for RELEASE_PACKAGES
//   node scripts/wasm-artifacts.mjs build        -> runs build:wasm for each RELEASE_PACKAGES
//                                                   dir that declares wasm, then checks the files
// scripts/dream-release.mjs calls checkWasmInPack() on every packed tarball.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The wasm files a package.json declares (empty when it ships no wasm). */
export function declaredWasm(pkg) {
  const list = pkg?.metaharness?.wasmArtifacts ?? [];
  if (!Array.isArray(list) || list.some(f => typeof f !== 'string' || !f || f.startsWith('/') || f.includes('..'))) {
    throw new Error(`${pkg?.name}: metaharness.wasmArtifacts must be a list of relative paths`);
  }
  return list.map(f => f.replace(/^\.\//, ''));
}

/** Declared wasm files missing from an `npm pack --json` file list. */
export function missingFromPack(pkg, packedFiles) {
  const shipped = new Set(packedFiles.map(f => (typeof f === 'string' ? f : f.path).replace(/^package\//, '')));
  return declaredWasm(pkg).filter(f => !shipped.has(f));
}

/** Throw when a tarball lacks any wasm file its package.json declares. */
export function checkWasmInPack(pkg, packedFiles) {
  const missing = missingFromPack(pkg, packedFiles);
  if (missing.length) {
    throw new Error(`${pkg.name}@${pkg.version}: tarball is missing declared wasm artifacts: ${missing.join(', ')} ` +
      '(run `npm run build:wasm` in the package before packing)');
  }
}

function releaseDirs() {
  return (process.env.RELEASE_PACKAGES ?? '').split(/\s+/).filter(Boolean);
}

function readPkg(root, dir) {
  return JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.cwd();
  const mode = process.argv[2];
  const dirs = releaseDirs();
  if (mode === 'needs-wasm') {
    console.log(dirs.some(d => declaredWasm(readPkg(root, d)).length > 0) ? 'true' : 'false');
  } else if (mode === 'build') {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    for (const dir of dirs) {
      const pkg = readPkg(root, dir);
      const files = declaredWasm(pkg);
      if (!files.length) continue;
      if (!pkg.scripts?.['build:wasm']) throw new Error(`${pkg.name}: declares wasm but has no build:wasm script`);
      console.log(`building wasm for ${pkg.name}`);
      execFileSync(npm, ['run', 'build:wasm'], { cwd: join(root, 'packages', dir), stdio: 'inherit', shell: process.platform === 'win32' });
      const absent = files.filter(f => !existsSync(join(root, 'packages', dir, f)));
      if (absent.length) throw new Error(`${pkg.name}: build:wasm did not produce ${absent.join(', ')}`);
      console.log(`${pkg.name}: ${files.join(', ')}`);
    }
  } else {
    throw new Error(`usage: node scripts/wasm-artifacts.mjs needs-wasm|build (got ${mode})`);
  }
}
