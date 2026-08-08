// Build crate/ for wasm32-unknown-unknown and place the artifact in wasm/.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const crate = join(here, '..', 'crate');
execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], {
  cwd: crate,
  stdio: 'inherit',
});
mkdirSync(join(here, '..', 'wasm'), { recursive: true });
copyFileSync(
  join(crate, 'target', 'wasm32-unknown-unknown', 'release', 'ooa_cell_vm.wasm'),
  join(here, '..', 'wasm', 'ooa_cell_vm.wasm'),
);
console.log('built wasm/ooa_cell_vm.wasm');
