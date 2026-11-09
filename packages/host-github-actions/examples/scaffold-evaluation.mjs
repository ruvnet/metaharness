// SPDX-License-Identifier: MIT
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import adapter from '@metaharness/host-github-actions';

// Reuse the published host adapter's file layout. Replace the generic
// autonomous workflow and example output with a read-only evaluation.
const slug = 'agent-evaluation';
const scaffold = adapter.generateConfig({ name: slug, permissions: { allow: [] } });
const workflow = '.github/workflows/' + slug + '.yml';
const action = '.github/actions/' + slug + '/action.yml';
const runner = '.github/actions/' + slug + '/evaluate.mjs';
if (typeof scaffold[workflow] !== 'string' || typeof scaffold[action] !== 'string') {
  throw new Error('Unsupported host adapter layout');
}

const workflowText = [
  'name: Agent evaluation',
  'on:',
  '  workflow_dispatch: {}',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  evaluate:',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 5',
  '    steps:',
  '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  '        with:',
  '          persist-credentials: false',
  '      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  '        with:',
  "          node-version: '22'",
  '      - uses: ./.github/actions/' + slug,
  '',
].join('\n');

const actionText = [
  'name: Compare agent policies',
  'description: Run deterministic baseline and candidate checks against labeled cases',
  'runs:',
  '  using: composite',
  '  steps:',
  '    - name: Evaluate candidate policy',
  '      shell: bash',
  '      run: node "$GITHUB_ACTION_PATH/evaluate.mjs"',
  '',
].join('\n');

const runnerText = [
  '// Illustrative, local policy fixture. No model, network or secrets.',
  'const cases = [',
  "  ['read', true, 'allow'],",
  "  ['read', false, 'deny'],",
  "  ['write', true, 'approval'],",
  "  ['write', false, 'deny'],",
  "  ['unknown', true, 'deny'],",
  '];',
  "const baseline = (operation) => operation === 'write' ? 'approval' : 'allow';",
  "const candidate = (operation, trusted) => {",
  "  if (!trusted) return 'deny';",
  "  if (operation === 'read') return 'allow';",
  "  if (operation === 'write') return 'approval';",
  "  return 'deny';",
  '};',
  'const baselineCorrect = cases.filter(([op, trusted, expected]) => baseline(op, trusted) === expected).length;',
  'const candidateCorrect = cases.filter(([op, trusted, expected]) => candidate(op, trusted) === expected).length;',
  "const unsafeAllows = cases.filter(([op, trusted, expected]) => expected !== 'allow' && candidate(op, trusted) === 'allow').length;",
  'const pass = candidateCorrect >= baselineCorrect && unsafeAllows === 0;',
  'console.log(JSON.stringify({ cases: cases.length, baselineCorrect, candidateCorrect, unsafeAllows, pass }));',
  'if (!pass) process.exitCode = 1;',
  '',
].join('\n');

const files = new Map([[workflow, workflowText], [action, actionText], [runner, runnerText]]);
function readStat(path) {
  try { return lstatSync(path); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
}
for (const file of files.keys()) {
  if (readStat(file)) throw new Error('Refusing to overwrite ' + file);
  for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) {
    const stat = readStat(dir);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error('Expected a real directory: ' + dir);
    }
  }
}
for (const [file, contents] of files) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(resolve(file), contents, { flag: 'wx' });
  console.log('Created ' + file);
}
