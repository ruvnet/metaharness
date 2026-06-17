#!/usr/bin/env node
// @metaharness/example-fhir — one-command scaffold.
// Delegates host wiring to the metaharness CLI, then prints fhir-specific
// next steps. Read-only / sandbox by default; mutations need --allow-mutations.
import { execSync } from 'node:child_process';
import process from 'node:process';

const PKG = '@metaharness/example-fhir';
const SDK = "fhir-kit-client";
const ENV_VARS = ["FHIR_BASE_URL (public sandbox EHR)"];
const COMMAND = "/fhir-query";
// metaharness is one-host-per-invocation; --host all writes each host into its
// own <name>/<host> subdir so every host's config is emitted side by side.
const ALL_HOSTS = ['claude-code', 'codex', 'copilot', 'github-actions', 'hermes', 'openclaw', 'opencode', 'pi-dev', 'rvm'];

const argv = process.argv.slice(2);
const hostIdx = argv.indexOf('--host');
const host = hostIdx !== -1 && argv[hostIdx + 1] ? argv[hostIdx + 1] : 'claude-code';
const allowMutations = argv.includes('--allow-mutations');
const nameArg = argv.find((a, i) => !a.startsWith('-') && i !== hostIdx + 1);
const name = nameArg || 'my-bot';

if (host !== 'all' && !ALL_HOSTS.includes(host)) {
  console.error(`[${PKG}] unknown --host "${host}". Valid: ${ALL_HOSTS.join(', ')}, all`);
  process.exit(2);
}
const hosts = host === 'all' ? ALL_HOSTS : [host];

for (const h of hosts) {
  const target = host === 'all' ? `${name}/${h}` : name;
  const cmd = [
    'npx --yes metaharness@latest',
    JSON.stringify(name),
    '--template minimal',
    `--host ${h}`,
    host === 'all' ? `--target ${JSON.stringify(target)}` : '',
    '--force',
  ]
    .filter(Boolean)
    .join(' ');
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    console.error(`\n[${PKG}] metaharness failed to scaffold "${name}" for host "${h}".`);
    process.exit(typeof err?.status === 'number' ? err.status : 1);
  }
}

const root = host === 'all' ? `${name}/<host>` : name;
console.log(`\n${PKG} — scaffolded "${name}" for: ${hosts.join(', ')}`);
console.log('\nNext steps:');
console.log(`  cd ${root} && npm install`);
console.log(`  npm install ${SDK}`);
console.log(`  # set env (never commit secrets): ${ENV_VARS.join(', ')}`);
console.log('  npm run doctor');
console.log(`  # then in your host run:  ${COMMAND} "<your request>"`);
if (!allowMutations) {
  console.log('\nRead-only / sandbox by default. Re-run with --allow-mutations to enable writes (see README -> Safety).');
}
