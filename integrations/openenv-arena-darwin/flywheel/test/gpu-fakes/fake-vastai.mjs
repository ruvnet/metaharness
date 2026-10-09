// Fake `vastai` for tests, installed on PATH by makeShims() as a wrapper:
//   exec node fake-vastai.mjs <scenario.json> <calls.jsonl> "$@"
// Scenario: { "<cmd>": [ {stdout?, stderr?, exit?}, ... ] } consumed in order per command (the last entry
// repeats). stdout/stderr may be objects (printed as JSON). Commands: user search create attach show
// showAll destroy. Every call is logged WITHOUT the key value (only presence and a short hash).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [scenarioPath, logPath, ...argv] = process.argv.slice(2);
const words = argv.filter(a => !a.startsWith('-'));
const table = { 'show user': 'user', 'search offers': 'search', 'create instance': 'create', 'attach ssh': 'attach',
  'show instance': 'show', 'show instances': 'showAll', 'destroy instance': 'destroy' };
const cmd = table[`${words[0]} ${words[1]}`] ?? 'unknown';
const key = process.env.VAST_API_KEY;
const ignorable = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
appendFileSync(logPath, `${JSON.stringify({
  cmd, argv, hasKey: typeof key === 'string' && key.length > 0,
  keySha: key ? createHash('sha256').update(key).digest('hex').slice(0, 12) : null,
  noUpdateCheck: process.env.VASTAI_NO_UPDATE_CHECK === '1',
  envKeys: Object.keys(process.env).filter(k => !ignorable.has(k)).sort(),
})}\n`);

if (argv.some(a => ['--api-key', '--explain', '--curl'].includes(a.split('=')[0]))) { process.stderr.write('forbidden flag\n'); process.exit(64); }
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const statePath = `${scenarioPath}.state`;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const list = scenario[cmd];
if (!Array.isArray(list) || list.length === 0) { process.stderr.write(`fake-vastai: no scenario for ${cmd}\n`); process.exit(70); }
const n = state[cmd] ?? 0;
state[cmd] = n + 1;
writeFileSync(statePath, JSON.stringify(state));
const r = list[Math.min(n, list.length - 1)];
// Like the real CLI: stdout objects are json.dumps(indent=1); the --raw error object is one line on stderr.
if (r.stdout !== undefined) process.stdout.write(typeof r.stdout === 'string' ? r.stdout : `${JSON.stringify(r.stdout, null, 1)}\n`);
if (r.stderr !== undefined) process.stderr.write(typeof r.stderr === 'string' ? r.stderr : `${JSON.stringify(r.stderr)}\n`);
process.exitCode = r.exit ?? 0;
