import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeToolExecutor } from '@metaharness/horizon';
import {
  Ed25519ReceiptSigner,
  EphemeralGovernedMemory,
  GovernedCapabilityPolicy,
  GovernedVariationOperator,
  JsonCheckpointStore,
  RepositoryEnvironmentAdapter,
  SemanticSupervisor,
  verifyReceipt,
  verifyVariationCheckpoint,
  type ActionObservation,
  type Candidate,
  type EnvironmentAdapter,
  type EvaluationResult,
  type VariationAction,
  type VariationContext,
  type VariationState,
} from '../src/index.js';

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return new Ed25519ReceiptSigner('test-key', privateKey, publicKey);
}

function result(branchId: string): EvaluationResult {
  const quality = branchId === 'seed' ? 0.5 : 0.9;
  return {
    evaluatorVersion: 'eval-v1', correct: true, safe: true, replayable: true,
    noRegression: true, budgetValid: true, quality, costUsd: 0,
    wallTimeMs: 1, policyViolations: 0, protectedTestsPassed: true,
    lowerConfidenceBound: 0.4, evidence: { branchId },
  };
}

class DeterministicEnvironment implements EnvironmentAdapter {
  readonly version = 'env-v1';
  executions = 0;
  async fork(parent: Candidate) {
    return { branchId: `${parent.id}-working`, workspaceDigest: `sha256:fork-${parent.id}` };
  }
  async execute(action: VariationAction, state: Readonly<VariationState>): Promise<ActionObservation> {
    this.executions += 1;
    return {
      ok: true, stdout: `${action.kind}:observed`, exitCode: 0, durationMs: 1, costUsd: 0,
      workspaceDigest: `sha256:${state.budget.actionsUsed + 1}-${action.kind}`,
    };
  }
  async quarantine(): Promise<void> {}
}

const strategies = async () => [
  { id: 's1', statement: 'change context', causalMechanism: 'context', expectedEvidence: ['a'], surface: 'contextPolicy' as const },
  { id: 's2', statement: 'change retrieval', causalMechanism: 'retrieval', expectedEvidence: ['b'], surface: 'retrievalPolicy' as const },
  { id: 's3', statement: 'change tests', causalMechanism: 'tests', expectedEvidence: ['c'], surface: 'testPolicy' as const },
] as const;

function actionFor(context: VariationContext): VariationAction {
  const sequence: VariationAction[] = [
    { kind: 'hypothesize', hypothesis: { id: 'h1', statement: 'repair routing', causalMechanism: 'route selection', expectedEvidence: ['tests pass'], surface: 'modelRouting' } },
    { kind: 'inspect', path: 'routing.ts' },
    { kind: 'edit', path: 'routing.ts', content: 'export const fixed = true;\n', surface: 'modelRouting' },
    { kind: 'execute', command: 'npm test' },
    { kind: 'evaluate' },
    { kind: 'commit', summary: 'verified routing repair' },
  ];
  return sequence[context.state.budget.actionsUsed % sequence.length];
}

async function options(root: string, environment = new DeterministicEnvironment()) {
  const receiptSigner = signer();
  return {
    receiptSigner,
    environment,
    value: {
      runId: 'run-1', task: 'repair model routing', seed: { id: 'seed', branchId: 'seed', workspaceDigest: 'sha256:seed' },
      environment,
      evaluators: { version: 'eval-v1', evaluate: async (branchId: string) => result(branchId) },
      agent: { chooseAction: async (context: VariationContext) => actionFor(context) },
      knowledge: { retrieve: async () => [] }, memory: new EphemeralGovernedMemory(),
      policy: new GovernedCapabilityPolicy({
        version: 'policy-v1',
        allowedActions: ['inspect', 'search', 'hypothesize', 'edit', 'execute', 'evaluate', 'revert', 'branch', 'consultMemory', 'commit'],
        approvalActions: ['execute', 'commit'], allowedCommands: [/^npm test$/], writablePaths: [/^routing\.ts$/],
      }),
      approval: { approve: async () => true },
      supervisor: new SemanticSupervisor({ policyVersion: 'policy-v1' }, strategies),
      signer: receiptSigner, checkpointStore: new JsonCheckpointStore(join(root, 'checkpoint.json')),
      budget: { maxActions: 6, maxBranchActions: 6, maxCostUsd: 1, maxWallTimeMs: 100, riskBudget: 1 },
      invariants: { immutableCapabilities: ['repository:read', 'repository:bounded-write', 'tool:npm-test'], protectedPaths: ['security/**'], promotionDelta: 0.1, requireSignedReceipts: true, requireZeroPolicyViolations: true },
      now: () => '2026-08-21T00:00:00.000Z',
    },
  };
}

describe('GovernedVariationOperator', () => {
  it('runs an evidence-driven multi-action variation and promotes only after evaluation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-operator-'));
    try {
      const configured = await options(root);
      const output = await new GovernedVariationOperator(configured.value).run();
      expect(output.receipts.map((receipt) => receipt.action.kind)).toEqual(['hypothesize', 'inspect', 'edit', 'execute', 'evaluate', 'commit']);
      expect(output.winner?.evaluation.quality).toBe(0.9);
      expect(output.lineage).toHaveLength(2);
      expect(output.memoryUpdates).toHaveLength(6);
      expect(output.failureReport).toBeUndefined();
      expect(output.receipts.every((receipt) => verifyReceipt(receipt, configured.receiptSigner))).toBe(true);
      expect(verifyVariationCheckpoint(output.checkpoint, configured.receiptSigner)).toBe(true);
      expect(output.checkpoint.rvfManifestPath).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stopOnVerifiedWinner halts the loop at the first verified commit instead of exhausting the budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-earlystop-'));
    try {
      const configured = await options(root);
      configured.value.stopOnVerifiedWinner = true;
      // Budget of 12 > the 6-action winning sequence: without early-stop the loop
      // would keep cycling to 12; with it, it halts at the first verified commit.
      configured.value.budget = { ...configured.value.budget, maxActions: 12, maxBranchActions: 12 };
      const output = await new GovernedVariationOperator(configured.value).run();
      const kinds = output.receipts.map((receipt) => receipt.action.kind);
      expect(kinds).toEqual(['hypothesize', 'inspect', 'edit', 'execute', 'evaluate', 'commit']);
      expect(output.checkpoint.state.budget.actionsUsed).toBe(6);
      expect(output.winner?.evaluation.quality).toBe(0.9);
      expect(output.receipts.every((receipt) => verifyReceipt(receipt, configured.receiptSigner))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records a denied command without invoking the environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-deny-'));
    try {
      const environment = new DeterministicEnvironment();
      const configured = await options(root, environment);
      configured.value.agent = { chooseAction: async () => ({ kind: 'execute', command: 'curl https://evil.example' }) };
      configured.value.budget.maxActions = 1;
      const output = await new GovernedVariationOperator(configured.value).run();
      expect(environment.executions).toBe(0);
      expect(output.receipts[0].policyDecision.verdict).toBe('deny');
      expect(output.receipts[0].observation.exitCode).toBe(126);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enforces protected paths independently and charges the model receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-protected-'));
    try {
      const environment = new DeterministicEnvironment();
      const configured = await options(root, environment);
      configured.value.policy = new GovernedCapabilityPolicy({
        version: 'policy-v1', allowedActions: ['edit'], approvalActions: [], writablePaths: [/.*/],
      });
      configured.value.agent = {
        chooseAction: async () => ({
          action: { kind: 'edit', path: 'security/authority.ts', content: 'expand()', surface: 'repairStrategy' },
          costUsd: 0.02, durationMs: 7, receipt: { model: 'fixed-test-model', tokens: 12 },
        }),
      };
      configured.value.budget.maxActions = 1;
      const output = await new GovernedVariationOperator(configured.value).run();
      expect(environment.executions).toBe(0);
      expect(output.receipts[0].policyDecision).toMatchObject({ verdict: 'deny' });
      expect(output.receipts[0].costUsd).toBe(0.02);
      expect(output.checkpoint.state.budget.wallTimeMsUsed).toBe(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('RepositoryEnvironmentAdapter', () => {
  it('executes in a copied workspace, reverts new files exactly, and blocks symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-repository-'));
    try {
      const seed = join(root, 'seed');
      const branches = join(root, 'branches');
      await mkdir(seed, { recursive: true });
      await writeFile(join(seed, 'safe.txt'), 'seed\n');
      await symlink('/etc/passwd', join(seed, 'escape'));
      const environment = new RepositoryEnvironmentAdapter({
        version: 'repo-v1', seedBranchId: 'seed', seedPath: seed, branchesRoot: branches,
        executorFor: (cwd) => new NodeToolExecutor({ cwd, timeoutMs: 5_000 }),
      });
      const branch = await environment.fork({
        id: 'seed', parentId: null, branchId: 'seed', workspaceDigest: 'sha256:seed',
        evaluation: result('seed'), novelty: 1, visits: 0, learningPotential: 1, risk: 0, committed: true,
      });
      const state = { currentBranchId: branch.branchId, budget: { actionsUsed: 0 } } as VariationState;
      const executed = await environment.execute({ kind: 'execute', command: "node -e \"process.stdout.write('real')\"" }, state);
      expect(executed.stdout).toBe('real');
      await environment.execute({ kind: 'edit', path: 'new.txt', content: 'new', surface: 'repairStrategy' }, state);
      await environment.execute({ kind: 'revert' }, state);
      await expect(readFile(join(environment.pathForBranch(branch.branchId), 'new.txt'), 'utf8')).rejects.toThrow();
      await expect(environment.execute({ kind: 'inspect', path: 'escape' }, state)).rejects.toThrow(/symbolic links/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
