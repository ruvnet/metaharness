#!/usr/bin/env node
// Fake `openenv` and fake `replay_native.py` for failure-path tests (behaviour from $FAKE_TOOL_MODE).
//   fake-tool.mjs validate --url U --json --output F --timeout N        modes: validate-ok | validate-fail
//   fake-tool.mjs --url U --output F --tasks-json REQUEST.json          modes: replay-fail | replay-subset | replay-lie
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = n => argv[argv.indexOf(n) + 1];
const mode = process.env.FAKE_TOOL_MODE ?? '';
// What an env-lane script would see: where HOME / the HF hub point, and any credential-shaped variable that got through.
if (process.env.FAKE_DOCKER_DIR) {
  const e = process.env;
  writeFileSync(join(e.FAKE_DOCKER_DIR, `tool-env-${argv[0] === 'validate' ? 'validate' : 'replay'}.json`), JSON.stringify({
    HOME: e.HOME, HF_HOME: e.HF_HOME, XDG_CACHE_HOME: e.XDG_CACHE_HOME, HF_HUB_OFFLINE: e.HF_HUB_OFFLINE,
    secretShaped: Object.keys(e).filter(k => /TOKEN|API_KEY|SECRET|^HF_TOKEN/i.test(k)) }));
}
if (argv[0] === 'validate') {
  const pass = mode !== 'validate-fail';
  writeFileSync(flag('--output'), JSON.stringify({ passed: pass, summary: { failed_criteria: pass ? [] : ['schema_endpoint'] } }));
  process.exit(pass ? 0 : 1);
}
const ids = JSON.parse(readFileSync(flag('--tasks-json'), 'utf8')).tasks.map(t => t.task_id);
const ep = c => ({ control: c, status: 'passed', terminal: true, reward: c === 'observed_file_oracle' ? 1 : 0 });
const shown = mode === 'replay-subset' ? ids.slice(0, 1) : ids;
const tasks = shown.map(task_id => ({ task_id, status: 'passed', episodes: ['declared_examples', 'observed_file_oracle', 'wrong_answer', 'seeded_reset_replay'].map(ep) }));
const failed = mode === 'replay-fail';
// replay-subset and replay-lie both exit 0 and claim success: the checker must not trust the exit code alone.
// Like replay_native.py: the example actions it replayed are ENV/example-actions.json (the env lane dir is its cwd).
const examples = existsSync('example-actions.json') ? createHash('sha256').update(readFileSync('example-actions.json')).digest('hex') : null;
const report = { status: failed ? 'failed' : 'passed', task_count: mode === 'replay-lie' ? ids.length : shown.length,
  episodes_expected: shown.length * 4, episodes_passed: failed ? 0 : shown.length * 4, tasks: mode === 'replay-lie' ? [] : tasks,
  source_sha256: { 'example-actions.json': examples } };
writeFileSync(flag('--output'), JSON.stringify(report));
process.exit(failed ? 1 : 0);
