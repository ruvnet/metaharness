// Synthetic integration fixture. Not a real ARC benchmark or a promotion claim.
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { evaluateRuleLearning } from '../packages/darwin-mode/src/rule-learning-gate.ts';
import { executeRule, ruleHash } from '../../dream-machine/packages/compile/src/rule-learning.ts';
const candidate = { schemaVersion: 1, candidateId: 'candidate', rulebook: 'Add the action to x.', program: [{ op: 'addAction', key: 'x' }] };
const parent = { schemaVersion: 1, candidateId: 'parent', rulebook: 'Preserve x.', program: [{ op: 'add', key: 'x', value: 0 }] };
const candidateManifest = { schema: 'synthetic-manifest/v1', artifactHash: ruleHash(candidate), programHash: ruleHash(candidate.program) };
const parentManifest = { schema: 'synthetic-manifest/v1', artifactHash: ruleHash(parent), programHash: ruleHash(parent.program) };
const families = ['counting', 'navigation', 'inventory'];
const seeds = [1, 2, 3, 4, 5];
// Answers remain host-owned. Only initial state/action reach the interpreter.
const corpus = families.flatMap(family => seeds.map(seed => ({ family, seed,
  tasks: Array.from({ length: 10 }, (_, i) => ({ state: { x: seed }, action: i < 5 ? 0 : 1, nextState: { x: seed + (i < 5 ? 0 : 1) } })) })));
const request = { runId: 'synthetic-ecosystem-smoke', rulebookHash: ruleHash(candidate.rulebook), candidate: { candidateHash: ruleHash(candidateManifest), programHash: ruleHash(candidate.program) }, baseline: { candidateHash: ruleHash(parentManifest), programHash: ruleHash(parent.program) }, datasetHash: ruleHash(corpus), families, seeds };
const runner = async context => {
  if (context.signal.aborted) throw Error('aborted');
  const artifact = context.candidateHash === ruleHash(candidateManifest) ? candidate : parent;
  const manifest = artifact === candidate ? candidateManifest : parentManifest;
  if (manifest.artifactHash !== ruleHash(artifact) || context.candidateHash !== ruleHash(manifest) || context.programHash !== ruleHash(artifact.program) || context.datasetHash !== ruleHash(corpus)) throw Error('binding mismatch');
  const tasks = corpus.find(t => t.family === context.family && t.seed === context.seed).tasks;
  let successes = 0, interactions = 0;
  const outputs = [];
  for (const task of tasks) {
    const result = executeRule(artifact, task.state, task.action); interactions++;
    outputs.push(result);
    if (ruleHash(result) === ruleHash(task.nextState)) successes++;
    else { executeRule(artifact, task.state, task.action); interactions++; } // counted retry
  }
  // Independent invariants and replay use action zero; both programs must pass.
  const probe = executeRule(artifact, { x: context.seed }, 0);
  const replay = executeRule(artifact, { x: context.seed }, 0);
  return { successes, samples: tasks.length, interactions, replaySteps: 1, independentProbes: 1,
    replayMismatches: ruleHash(probe) === ruleHash(replay) ? 0 : 1,
    failedHiddenProbes: probe.x === context.seed ? 0 : 1,
    receiptHash: ruleHash({ outputs, interactions, probe, replay }) };
};
const start = performance.now();
const accepted = await evaluateRuleLearning(request, runner);
const durationMs = performance.now() - start;
const rejected = await evaluateRuleLearning(request, async c => ({ ...await runner(c), failedHiddenProbes: 1 }));
if (!accepted.accepted || rejected.accepted || rejected.ruleLearningEvidence) throw Error('integration contract failed');
const result = { fixtureOnly: true, durationMs, accepted, rejected };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
