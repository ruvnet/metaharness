/** Real local operations; small arithmetic task benchmark, not ARC/production acceptance. */
import { mkdtemp, writeFile, appendFile, stat, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { evaluateRuleLearning } from '../packages/darwin-mode/src/rule-learning-gate.ts';
import { executeRule, ruleHash, inferRuleCandidates } from '../../dream-machine/packages/compile/src/rule-learning.ts';

export const taskFamilies = ['file-append', 'sqlite-insert', 'deflate-length'];
export function splitForSeed(seed) {
  if (!Number.isInteger(seed) || seed < 1 || seed > 5) throw Error('seed out of range');
  return {
    training: [1, 2, 3].map(action => ({ state: { x: seed * 5 + action }, action })),
    heldout: [0, 3, 4, 7, 11, 16, 23, 31, 48].map(action => ({ state: { x: seed * 101 + action }, action })),
  };
}
export async function runOperation(family, input) {
  const { x } = input.state, { action } = input;
  if (![x, action].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 4096)) throw Error('operation bounds');
  if (family === 'file-append') {
    const dir = await mkdtemp(join(tmpdir(), 'rule-task-'));
    try { const file = join(dir, 'data'); await writeFile(file, Buffer.alloc(x)); await appendFile(file, Buffer.alloc(action)); return { x: (await stat(file)).size }; }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  if (family === 'sqlite-insert') {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE items (value INTEGER)');
      const insert = db.prepare('INSERT INTO items VALUES (?)');
      for (let i = 0; i < x; i++) insert.run(i);
      for (let i = 0; i < action; i++) insert.run(x + i);
      return { x: Number(db.prepare('SELECT COUNT(*) AS count FROM items').get().count) };
    } finally { db.close(); }
  }
  if (family === 'deflate-length') {
    const data = Buffer.from('abcde'.repeat(Math.ceil((x + action) / 5)).slice(0, x + action));
    return { x: deflateSync(data).length };
  }
  throw Error('unknown family');
}

/** The proposal callback sees only the training transitions, never held-out data. */
export async function benchmarkLocalTasks(propose = inferRuleCandidates) {
  const rows = [];
  let trainingOracleCalls = 0, initialHeldoutOracleCalls = 0;
  const locked = new Map();
  for (const family of taskFamilies) for (let seed = 1; seed <= 5; seed++) {
    const split = splitForSeed(seed);
    const observations = [];
    for (const input of split.training) { observations.push({ ...input, nextState: await runOperation(family, input) }); trainingOracleCalls++; }
    const last = observations.at(-1);
    const baseline = { schemaVersion: 1, candidateId: `baseline-${family}-${seed}`, rulebook: 'Reuse the last observed change.', program: [{ op: 'add', key: 'x', value: last.nextState.x - last.state.x }] };
    // No choice or tuning uses hidden results. An unrepresentable task falls back.
    const proposal = propose(structuredClone(observations));
    const selected = proposal.candidates[0] ?? baseline;
    locked.set(`${family}:${seed}`, { selected, baseline, observations, split });
    let candidateSuccesses = 0, baselineSuccesses = 0, domainBaselineSuccesses = 0, replayMismatches = 0;
    const domainBaseline = { schemaVersion: 1, candidateId: 'hand-authored-addition', rulebook: 'Add the requested count.', program: [{ op: 'addAction', key: 'x' }] };
    const traces = [];
    for (const input of split.heldout) {
      const expected = await runOperation(family, input); initialHeldoutOracleCalls++;
      const prediction = executeRule(selected, input.state, input.action);
      const parentPrediction = executeRule(baseline, input.state, input.action);
      const domainPrediction = executeRule(domainBaseline, input.state, input.action);
      domainBaselineSuccesses += Number(ruleHash(domainPrediction) === ruleHash(expected));
      const replay = executeRule(selected, input.state, input.action);
      candidateSuccesses += Number(ruleHash(prediction) === ruleHash(expected));
      baselineSuccesses += Number(ruleHash(parentPrediction) === ruleHash(expected));
      replayMismatches += Number(ruleHash(prediction) !== ruleHash(replay));
      traces.push({ input, expected, prediction, parentPrediction, replay });
    }
    rows.push({ family, seed, trainingInteractions: observations.length, heldoutInteractions: split.heldout.length, probeInteractions: 0, samples: split.heldout.length,
      // Both methods receive exactly the same training observations and held-out oracle calls.
      candidateInteractions: observations.length + split.heldout.length,
      baselineInteractions: observations.length + split.heldout.length,
      candidateSuccesses, baselineSuccesses, domainBaselineSuccesses, domainBaselineLabel: 'hand-authored action-aware addition', replayMismatches,
      proposalFound: proposal.candidates.length > 0, testedHypotheses: proposal.testedHypotheses,
      searchComplete: proposal.searchComplete, candidateHash: ruleHash(selected), candidateProgramHash: ruleHash(selected.program), baselineProgramHash: ruleHash(baseline.program),
      trainingHash: ruleHash(observations), traceHash: ruleHash(traces) });
  }
  const families = taskFamilies.map(family => {
    const group = rows.filter(row => row.family === family);
    const sum = key => group.reduce((total, row) => total + row[key], 0);
    return { family, samples: sum('samples'), candidateSuccesses: sum('candidateSuccesses'), baselineSuccesses: sum('baselineSuccesses'), handAuthoredDomainSuccesses: sum('domainBaselineSuccesses'), gainOverDomainBaselinePoints: 100 * (sum('candidateSuccesses') - sum('domainBaselineSuccesses')) / sum('samples'),
      gainPoints: 100 * (sum('candidateSuccesses') - sum('baselineSuccesses')) / sum('samples'), candidateInteractions: sum('candidateInteractions'), baselineInteractions: sum('baselineInteractions') };
  });
  const bindings = { candidate: { candidateHash: ruleHash([...locked.values()].map(v => v.selected)), programHash: ruleHash([...locked.values()].map(v => v.selected.program)) }, baseline: { candidateHash: ruleHash([...locked.values()].map(v => v.baseline)), programHash: ruleHash([...locked.values()].map(v => v.baseline.program)) } };
  let gatePhysicalOracleCalls = 0;
  const gate = await evaluateRuleLearning({ ...bindings, runId: 'local-operations-v1', rulebookHash: ruleHash([...locked.values()].map(v => v.selected.rulebook)), datasetHash: ruleHash([...locked.values()].map(v => v.split)), families: taskFamilies, seeds: [1, 2, 3, 4, 5] }, async context => {
    const cell = locked.get(`${context.family}:${context.seed}`);
    const learned = context.candidateHash === bindings.candidate.candidateHash;
    const artifact = learned ? cell.selected : cell.baseline;
    const expectedBinding = learned ? bindings.candidate : bindings.baseline;
    if (context.candidateHash !== expectedBinding.candidateHash || context.programHash !== expectedBinding.programHash) throw Error('artifact binding mismatch');
    let successes = 0;
    const trace = [];
    for (const input of cell.split.heldout) {
      const expected = await runOperation(context.family, input); gatePhysicalOracleCalls++;
      const prediction = executeRule(artifact, input.state, input.action);
      successes += Number(ruleHash(expected) === ruleHash(prediction));
      trace.push({ input, expected, prediction });
    }
    // Host-owned independent operation at an additional unseen state/action pair.
    const probe = { state: { x: 701 + context.seed }, action: 5 };
    const expected = await runOperation(context.family, probe); gatePhysicalOracleCalls++;
    const prediction = executeRule(artifact, probe.state, probe.action);
    const failedHiddenProbes = Number(ruleHash(expected) !== ruleHash(prediction));
    let replayMismatches = 0;
    for (const t of cell.observations) replayMismatches += Number(ruleHash(executeRule(artifact, t.state, t.action)) !== ruleHash(t.nextState));
    return { successes, samples: cell.split.heldout.length, interactions: cell.observations.length + cell.split.heldout.length + 1, replaySteps: cell.observations.length, replayMismatches, independentProbes: 1, failedHiddenProbes, receiptHash: ruleHash({ trace, probe, expected, prediction }) };
  });
  return { schema: 'local-rule-task-benchmark/v1', limitation: 'Small local-operation benchmark. File and SQL tasks share an additive mechanism. No production-learning or promotion claim.', rows, families, gate,
    accounting: { sharedPhysicalTrainingCalls: trainingOracleCalls, initialPairedPhysicalHeldoutCalls: initialHeldoutOracleCalls, gatePhysicalOracleCalls, gateExecutions: 60, perMethodPerSeedTrainingObservations: 3, perMethodPerSeedHeldoutObservations: 9, perMethodPerSeedProbeObservations: 1, note: 'Initial comparison shares cached oracle observations. Gate reruns actual operations independently twice per method. Counts are environment transition calls, not SQL statements/syscalls.' }, interactionReduction: gate.interactionReduction, acceptance: gate.accepted, rejectionReasons: gate.reasons };

}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const start = performance.now();
  const report = await benchmarkLocalTasks();
  const source = async path => createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex');
  const output = { ...report, observedAt: new Date().toISOString(), provenance: { metaharnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dreamMachineCommit: execFileSync('git', ['-C', '../dream-machine', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), benchmarkSourceSha256: await source('./rule-learning-local-tasks.mjs'), proposalSourceSha256: await source('../../dream-machine/packages/compile/src/rule-learning.ts') }, measuredDurationMs: performance.now() - start, node: process.version };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ families: output.families, interactionReduction: output.interactionReduction, acceptance: output.acceptance, measuredDurationMs: output.measuredDurationMs }, null, 2));
}
