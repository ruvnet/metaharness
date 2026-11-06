// SPDX-License-Identifier: MIT
// Real npm consumer acceptance. No registry publication or native binary claims.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = resolve('.');
const scratch = mkdtempSync(join(tmpdir(), 'kernel npm consumer '));
// npm.cmd needs a shell, which splits the deliberate spaces in this fixture's
// tarball path. Invoke npm's JS entry directly on Windows instead.
const windowsNpmCli = process.env.npm_execpath?.endsWith('npm-cli.js')
  ? process.env.npm_execpath : join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const run = (command, args, cwd = scratch) => {
  const npmOnWindows = process.platform === 'win32' && command === 'npm';
  return execFileSync(npmOnWindows ? process.execPath : command, npmOnWindows ? [windowsNpmCli,...args] : args, {
    cwd, encoding:'utf8', timeout:120000, stdio:['ignore','pipe','pipe'],
  });
};
const npmVersion = run('npm',['--version']).trim();
assert.equal(npmVersion.split('.')[0],'11','Consumer qualification requires npm 11');
const registry = process.argv.includes('--registry');
const sourceManifest = JSON.parse(readFileSync(join(root,'packages/kernel-js/package.json'),'utf8'));
const packed = registry ? undefined : JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',scratch],join(root,'packages/kernel-js')))[0];
const installSpec = registry ? `${sourceManifest.name}@${sourceManifest.version}` : join(scratch,packed.filename);
const consumer = join(scratch,'consumer'); mkdirSync(consumer);
writeFileSync(join(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
run('npm',['install','--no-audit','--no-fund',installSpec],consumer);
run('npm',['ci','--no-audit','--no-fund'],consumer);
const installed = join(consumer,'node_modules/@metaharness/kernel');
const manifest = JSON.parse(readFileSync(join(installed,'package.json'),'utf8'));
assert.equal(manifest.version,sourceManifest.version);
const result = JSON.parse(run(process.execPath,['--input-type=module','-e',
  `const {loadKernel}=await import(${JSON.stringify(pathToFileURL(join(installed,'dist/index.js')).href)});const k=await loadKernel();console.log(JSON.stringify({backend:k.backend,version:k.version(),info:k.kernelInfo()}));`],consumer));
assert(['native','wasm','js'].includes(result.backend));
// Rust/WASM use their Cargo version, independently of the npm wrapper version.
assert.match(result.version,/^\d+\.\d+\.\d+/);
assert.equal(result.info.version,result.version);
console.log(JSON.stringify({status:'PASS',source:registry?'registry':'tarball',package:`${manifest.name}@${manifest.version}`,npm:npmVersion,backend:result.backend,runtimeVersion:result.version,consumer,...(!registry?{tarball:installSpec}:{})}));
