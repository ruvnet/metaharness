#!/usr/bin/env node
// @metaharness/example-web3 — one-command scaffold + bespoke agent bundle.
// Delegates host wiring to the metaharness CLI, then drops this example's
// bespoke showcase files (agents/, .harness/mcp-policy.json, commands/, .env.example)
// into the project. Read-only / sandbox by default; mutations need --allow-mutations.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const PKG = '@metaharness/example-web3';
const SDK = "viem";
const ENV_VARS = ["RPC_URL (testnet)", "WALLET_PRIVATE_KEY (optional, testnet only)"];
const COMMAND = "/web3-read";
const ALL_HOSTS = ['claude-code', 'codex', 'copilot', 'github-actions', 'hermes', 'openclaw', 'opencode', 'pi-dev', 'rvm'];
const __dir = dirname(fileURLToPath(import.meta.url));

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

// Write this example's bespoke showcase bundle into a scaffolded project.
function writeBundle(projectDir) {
  const bundlePath = join(__dir, '..', 'assets', 'bundle.json');
  if (!existsSync(bundlePath)) return 0;
  let files;
  try { files = JSON.parse(readFileSync(bundlePath, 'utf8')).files || []; } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const dest = join(projectDir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
    n++;
  }
  return n;
}

let totalBundle = 0;
for (const h of hosts) {
  const projectDir = host === 'all' ? join(name, h) : name;
  const cmd = [
    'npx --yes metaharness@latest',
    JSON.stringify(name),
    '--template minimal',
    `--host ${h}`,
    host === 'all' ? `--target ${JSON.stringify(projectDir)}` : '',
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
  totalBundle += writeBundle(projectDir);
}

const root = host === 'all' ? `${name}/<host>` : name;
console.log(`\n${PKG} — scaffolded "${name}" for: ${hosts.join(', ')}`);
console.log(`Wrote ${totalBundle} bespoke showcase file(s) per project (agents/, .harness/mcp-policy.json, commands/, .env.example).`);
console.log('\nNext steps:');
console.log(`  cd ${root} && npm install`);
console.log(`  npm install ${SDK}`);
console.log(`  cp .env.example .env   # then fill in: ${ENV_VARS.join(', ')}`);
console.log('  npm run doctor');
console.log(`  # then in your host run:  ${COMMAND} "<your request>"`);
if (!allowMutations) {
  console.log('\nRead-only / sandbox by default. Re-run with --allow-mutations to enable writes (see README -> Safety).');
}
