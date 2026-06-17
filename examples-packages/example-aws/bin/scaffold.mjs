#!/usr/bin/env node
// @metaharness/example-aws — one-command scaffold.
// Delegates host wiring to the metaharness CLI, then prints aws-specific
// next steps. Read-only / sandbox by default; mutations need --allow-mutations.
import { execSync } from 'node:child_process';
import process from 'node:process';

const PKG = '@metaharness/example-aws';
const SDK = "@aws-sdk/client-s3 @aws-sdk/client-ec2 @aws-sdk/credential-providers";
const ENV_VARS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"];
const COMMAND = "/aws-infra";
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
  const cmd = ['npx --yes metaharness@latest', JSON.stringify(name), '--template minimal', `--host ${h}`, '--force']
    .filter(Boolean)
    .join(' ');
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    console.error(`\n[${PKG}] metaharness failed to scaffold "${name}" for host "${h}".`);
    process.exit(typeof err?.status === 'number' ? err.status : 1);
  }
}

console.log(`\n${PKG} — scaffolded "${name}" for: ${hosts.join(', ')}`);
console.log('\nNext steps:');
console.log(`  cd ${name} && npm install`);
console.log(`  npm install ${SDK}`);
console.log(`  # set env (never commit secrets): ${ENV_VARS.join(', ')}`);
console.log('  npm run doctor');
console.log(`  # then in your host run:  ${COMMAND} "<your request>"`);
if (!allowMutations) {
  console.log('\nRead-only / sandbox by default. Re-run with --allow-mutations to enable writes (see README → Safety).');
}
