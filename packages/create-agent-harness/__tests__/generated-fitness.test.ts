// SPDX-License-Identifier: MIT
// Mechanism acceptance, not a model-performance benchmark: execute policy code in
// child processes, then feed actual paired outcomes to independent confirmation.
import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { scaffold } from '../src/index.js';
import { profileRepo } from '../../darwin-mode/src/repo_profiler.js';
import { generateBaselineHarness } from '../../darwin-mode/src/generator.js';
import { runVariantTaskAgent, type AgentTask } from '../../darwin-mode/src/tier2-sandbox.js';
import { runVariantTasks } from '../../darwin-mode/src/sandbox.js';
import { scoreVariant } from '../../darwin-mode/src/scorer.js';
import { confirmContrastive } from '../../darwin-mode/src/contrastive/confirmation.js';
import type { HarnessDocument } from '../../darwin-mode/src/contrastive/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, {recursive: true, force: true}))); });
const supported = Number(process.versions.node.split('.')[0]) >= 22 && process.platform !== 'win32';
const tasks: AgentTask[] = Array.from({length: 7}, (_, index) => {
  const buggyFile = `src/case${index}_target.ts`;
  const before = index === 0 ? 0 : 30 + index;
  const task = {prompt: `fix case${index} target`, files: [...Array.from({length: before}, (_, n) => `src/case${index}_target_${n}.ts`), buggyFile],
    buggyFile, classification: 'transient' as const, failAttempts: 0, backoffMs: 1, difficulty: 3 as const};
  return {...task, id: createHash('sha256').update(JSON.stringify(task)).digest('hex')};
});
async function fixture(change: (source: string) => string) {
  const root = await mkdtemp(join(tmpdir(), 'generated-fitness-')); roots.push(root);
  const repo = join(root, 'harness');
  await scaffold({name: 'fitness-bot', template: 'minimal', host: 'claude-code', targetDir: repo, generatorVersion: 'test', darwin: false});
  const profile = await profileRepo(repo);
  const baseline = await generateBaselineHarness(profile, join(root, 'work'));
  const candidate = {...baseline, id: 'candidate', parentId: baseline.id, generation: 1, dir: join(root, 'candidate')};
  await cp(baseline.dir, candidate.dir, {recursive: true});
  const source = await readFile(join(baseline.dir, 'context_builder.ts'), 'utf8');
  await writeFile(join(candidate.dir, 'context_builder.ts'), change(source));
  // Pin all executable surfaces, not merely the edited component.
  async function document(dir: string): Promise<HarnessDocument> {
    const names = ['planner.ts', 'context_builder.ts', 'reviewer.ts', 'retry_policy.ts', 'tool_policy.ts', 'memory_policy.ts', 'score_policy.ts'];
    return {components: await Promise.all(names.map(async id => ({id, scope: 'domain' as const, content: await readFile(join(dir, id), 'utf8')})))};
  }
  async function confirm() {
    return confirmContrastive({tenantId: 'test', projectId: 'generated-fitness', environment: {kind: 'scripted-policy-mechanism', node: process.versions.node},
      envelope: {network: false, shell: false, promotion: false}, baseline: await document(baseline.dir), candidate: await document(candidate.dir),
      developmentTaskIds: ['development-only'], confirmationTaskIds: tasks.map(t => t.id),
      policy: {minCases: 7, minWins: 5, maxRegressions: 0, minGain: 0.05, alpha: 0.05},
      budget: {maxUsd: 0, maxCalls: 7, pairUsd: 0, timeoutMs: 30000},
      evaluator: {surfaceAware: true, async evaluatePair(input) {
        const task = tasks.find(t => t.id === input.taskId)!;
        // Bind the exact frozen documents to the files actually executed.
        for (const [variant, doc] of [[baseline, input.baseline], [candidate, input.candidate]] as const)
          for (const component of doc.components) expect(await readFile(join(variant.dir, component.id), 'utf8')).toBe(component.content);
        const [a, b] = await Promise.all([runVariantTaskAgent(baseline, task), runVariantTaskAgent(candidate, task)]);
        return {tenantId: input.tenantId, projectId: input.projectId, environmentDigest: input.environmentDigest, envelopeDigest: input.envelopeDigest,
          taskId: input.taskId, appliedBaselineDigest: input.baselineDigest, appliedCandidateDigest: input.candidateDigest,
          baselinePassed: a.exitCode === 0, candidatePassed: b.exitCode === 0, costUsd: 0};
      }}});
  }
  return {root, baseline, candidate, profile, confirm};
}

describe.skipIf(!supported)('generated harness fitness with executed policies', () => {
  it('confirms a context change only after actual additional task successes', async () => {
    const fx = await fixture(s => s.replace('.slice(0, 30)', '.slice(0, 90)'));
    const result = await fx.confirm();
    expect(result.verdict).toBe('confirmed');
    expect(result.stats).toMatchObject({cases: 7, wins: 6, losses: 0, baselinePassed: 1, candidatePassed: 7});
    expect(result.promotion).toBe('not-authorized');
  }, 45000);
  it('rejects a text-only change that has no behavioral effect', async () => {
    const result = await (await fixture(s => s + '\n// changed wording only\n')).confirm();
    expect(result.verdict).toBe('rejected');
    expect(result.stats).toMatchObject({wins: 0, losses: 0, ties: 7});
  }, 45000);
  it('rejects a candidate that gains six tasks but loses a previously passing task', async () => {
    const fx = await fixture(s => s.replace('return scored.slice(0, 30)', "return scored.filter(item => item.path !== 'src/case0_target.ts').slice(0, 90)"));
    const result = await fx.confirm();
    expect(result.stats).toMatchObject({wins: 6, losses: 1, candidatePassed: 6});
    expect(result.verdict).toBe('rejected');
    expect(result.reason).toBe('regression-limit');
  }, 45000);
  it('does not infer fitness improvement from an unrelated always-passing repository test', async () => {
    const fx = await fixture(s => s.replace('.slice(0, 30)', '.slice(0, 90)'));
    await writeFile(join(fx.profile.root, 'regression-only.cjs'), 'process.stdout.write("regression-only\\n");');
    const profile = {...fx.profile, testCommand: 'node regression-only.cjs'};
    const a = await runVariantTasks(fx.baseline, profile, ['regression']);
    const b = await runVariantTasks(fx.candidate, profile, ['regression']);
    const parent = scoreVariant(fx.baseline.id, a, null, 0.05);
    const child = scoreVariant(fx.candidate.id, b, parent, 0.05);
    expect(child.finalScore).toBe(parent.finalScore);
    expect(child.promoted).toBe(false);
  });
});
