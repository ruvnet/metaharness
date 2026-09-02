import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeToolExecutor, digestWorkspace } from '@metaharness/horizon';
import {
  Ed25519ReceiptSigner,
  EphemeralGovernedMemory,
  GovernedCapabilityPolicy,
  GovernedVariationOperator,
  INVALID_AGENT_ACTION,
  JsonCheckpointStore,
  RepositoryEnvironmentAdapter,
  SemanticSupervisor,
  createCheckpoint,
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
  forks = 0;
  readonly actions: VariationAction[] = [];
  async fork(parent: Candidate) {
    return { branchId: `${parent.id}-working-${++this.forks}`, workspaceDigest: parent.workspaceDigest };
  }
  async execute(action: VariationAction, state: Readonly<VariationState>): Promise<ActionObservation> {
    this.executions += 1;
    this.actions.push(action);
    const priorDigest = state.receipts.at(-1)?.workspaceDigest ?? 'sha256:seed';
    return {
      ok: true, stdout: `${action.kind}:observed`, exitCode: 0, durationMs: 1, costUsd: 0,
      workspaceDigest: action.kind === 'edit'
        ? `sha256:edit-${state.budget.actionsUsed + 1}`
        : priorDigest,
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

async function options(root: string, environment: EnvironmentAdapter = new DeterministicEnvironment()) {
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

  it('snapshots Proxy-backed data once and never authorizes through dynamic property reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-proxy-action-'));
    try {
      const environment = new DeterministicEnvironment();
      const configured = await options(root, environment);
      let dynamicReads = 0;
      const returned = new Proxy<VariationAction>({ kind: 'inspect', path: 'routing.ts' }, {
        get(target, property, receiver) {
          if (property === 'kind') {
            dynamicReads += 1;
            return dynamicReads === 1 ? 'inspect' : 'execute';
          }
          return Reflect.get(target, property, receiver);
        },
      });
      configured.value.agent = { chooseAction: async () => returned };
      configured.value.budget.maxActions = 1;

      const output = await new GovernedVariationOperator(configured.value).run();

      expect(dynamicReads).toBe(0);
      expect(environment.actions).toHaveLength(1);
      expect(environment.actions[0]).toEqual({ kind: 'inspect', path: 'routing.ts' });
      expect(environment.actions[0]).not.toBe(returned);
      expect(environment.actions[0]).toBe(output.receipts[0].action);
      expect(Object.isFrozen(environment.actions[0])).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects accessor-backed actions without invoking the accessor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-accessor-action-'));
    try {
      const environment = new DeterministicEnvironment();
      const configured = await options(root, environment);
      let getterReads = 0;
      const returned: Record<string, unknown> = { path: 'routing.ts' };
      Object.defineProperty(returned, 'kind', {
        enumerable: true,
        get() {
          getterReads += 1;
          return getterReads === 1 ? 'inspect' : 'execute';
        },
      });
      configured.value.agent = {
        chooseAction: async () => returned as unknown as VariationAction,
      };
      configured.value.budget.maxActions = 1;

      await expect(new GovernedVariationOperator(configured.value).run())
        .rejects.toThrowError(new RegExp(`^${INVALID_AGENT_ACTION}$`));
      expect(getterReads).toBe(0);
      expect(environment.executions).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the same frozen action after the caller mutates its returned object during approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-mutated-action-'));
    try {
      const environment = new DeterministicEnvironment();
      const configured = await options(root, environment);
      const returned: { kind: 'execute'; command: string } = { kind: 'execute', command: 'npm test' };
      let approvalAction: VariationAction | undefined;
      configured.value.agent = { chooseAction: async () => returned };
      configured.value.approval = {
        approve: async (action) => {
          approvalAction = action;
          returned.command = 'curl https://evil.example';
          return true;
        },
      };
      configured.value.budget.maxActions = 1;

      const output = await new GovernedVariationOperator(configured.value).run();

      expect(returned.command).toBe('curl https://evil.example');
      expect(environment.actions).toHaveLength(1);
      expect(environment.actions[0]).toEqual({ kind: 'execute', command: 'npm test' });
      expect(environment.actions[0]).toBe(approvalAction);
      expect(output.receipts[0].action).toBe(approvalAction);
      expect(Object.isFrozen(output.receipts[0].action)).toBe(true);
      expect(output.receipts[0].policyDecision.verdict).toBe('require-approval');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unexpected fields with the stable invalid-action error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-action-schema-'));
    try {
      const environment = new DeterministicEnvironment();
      const configured = await options(root, environment);
      configured.value.agent = {
        chooseAction: async () => ({ kind: 'evaluate', command: 'npm test' }) as unknown as VariationAction,
      };
      configured.value.budget.maxActions = 1;

      await expect(new GovernedVariationOperator(configured.value).run())
        .rejects.toThrowError(new RegExp(`^${INVALID_AGENT_ACTION}$`));
      expect(environment.executions).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires a bounded positive safe integer for consultMemory.limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-memory-limit-'));
    try {
      const environment = new DeterministicEnvironment();
      const configured = await options(root, environment);
      configured.value.agent = {
        chooseAction: async () => ({ kind: 'consultMemory', query: 'evidence', limit: 1_001 }),
      };
      configured.value.budget.maxActions = 1;

      await expect(new GovernedVariationOperator(configured.value).run())
        .rejects.toThrowError(new RegExp(`^${INVALID_AGENT_ACTION}$`));
      expect(environment.executions).toBe(0);
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

  it('rejects commit with a stable signature after an edit invalidates evaluation evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-stale-edit-'));
    try {
      const environment = new DeterministicEnvironment();
      const configured = await options(root, environment);
      const actions: VariationAction[] = [
        { kind: 'evaluate' },
        { kind: 'edit', path: 'routing.ts', content: 'changed\n', surface: 'modelRouting' },
        { kind: 'commit', summary: 'must not promote stale evidence' },
      ];
      configured.value.agent = {
        chooseAction: async (context) => actions[context.state.budget.actionsUsed]!,
      };
      configured.value.budget = { ...configured.value.budget, maxActions: 3, maxBranchActions: 3 };
      const output = await new GovernedVariationOperator(configured.value).run();
      const rejected = output.receipts.at(-1)!;
      expect(rejected.action.kind).toBe('commit');
      expect(rejected.observation).toMatchObject({
        ok: false,
        failureSignature: 'STALE_EVALUATION',
      });
      expect(rejected.observation.stderr).toContain('invalidating edit');
      expect(output.checkpoint.state.candidates).toHaveLength(1);
      expect(environment.executions).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects commit when the active branch differs from the evaluated branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-stale-branch-'));
    try {
      const environment = new DeterministicEnvironment();
      const configured = await options(root, environment);
      const actions: VariationAction[] = [
        { kind: 'evaluate' },
        { kind: 'branch', parentCandidateId: 'seed' },
        { kind: 'commit', summary: 'must not reuse another branch evaluation' },
      ];
      configured.value.agent = {
        chooseAction: async (context) => actions[context.state.budget.actionsUsed]!,
      };
      configured.value.budget = { ...configured.value.budget, maxActions: 3, maxBranchActions: 3 };
      const output = await new GovernedVariationOperator(configured.value).run();
      const rejected = output.receipts.at(-1)!;
      expect(rejected.action.kind).toBe('commit');
      expect(rejected.observation).toMatchObject({
        ok: false,
        failureSignature: 'STALE_EVALUATION',
      });
      expect(rejected.observation.stderr).toContain('branch differs');
      expect(output.checkpoint.state.candidates).toHaveLength(1);
      expect(environment.executions).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('overwrites evaluator-supplied binding metadata with operator evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-forged-binding-'));
    try {
      const configured = await options(root);
      configured.value.evaluators = {
        version: 'eval-v1',
        evaluate: async (branchId: string) => ({
          ...result(branchId),
          binding: {
            branchId: 'forged-branch',
            workspaceDigest: 'sha256:forged',
            stateHash: 'forged-state',
            sequence: 999,
          },
        }),
      };
      configured.value.agent = { chooseAction: async () => ({ kind: 'evaluate' }) };
      configured.value.budget = { ...configured.value.budget, maxActions: 1, maxBranchActions: 1 };
      const output = await new GovernedVariationOperator(configured.value).run();
      const binding = output.evaluatorEvidence.at(-1)?.binding;
      expect(binding).toEqual({
        branchId: output.checkpoint.state.currentBranchId,
        workspaceDigest: 'sha256:seed',
        stateHash: 'genesis:run-1',
        sequence: 1,
      });
      expect(output.evaluatorEvidence.every((evaluation) => evaluation.binding?.branchId !== 'forged-branch')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a commit snapshot aliases the mutable branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-alias-snapshot-'));
    try {
      class AliasingEnvironment extends DeterministicEnvironment {
        override async fork(parent: Candidate) {
          const branch = await super.fork(parent);
          return this.forks === 1
            ? branch
            : { branchId: 'seed-working-1', workspaceDigest: parent.workspaceDigest };
        }
      }
      const environment = new AliasingEnvironment();
      const configured = await options(root, environment);
      const actions: VariationAction[] = [{ kind: 'evaluate' }, { kind: 'commit', summary: 'must snapshot' }];
      configured.value.agent = {
        chooseAction: async (context) => actions[context.state.budget.actionsUsed]!,
      };
      configured.value.budget = { ...configured.value.budget, maxActions: 2, maxBranchActions: 2 };
      const output = await new GovernedVariationOperator(configured.value).run();
      expect(output.receipts.at(-1)?.observation).toMatchObject({
        ok: false,
        failureSignature: 'COMMIT_SNAPSHOT_FAILED',
        stderr: 'commit snapshot aliases the mutable working branch',
      });
      expect(output.checkpoint.state.candidates).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads a legacy schema 1 checkpoint but requires fresh bound evidence to promote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-legacy-binding-'));
    try {
      const configured = await options(root);
      configured.value.budget = { ...configured.value.budget, maxActions: 0, maxBranchActions: 2 };
      const initialized = await new GovernedVariationOperator(configured.value).run();
      const legacyState = structuredClone(initialized.checkpoint.state);
      legacyState.budget.maxActions = 2;
      for (const evaluation of legacyState.evaluations) delete evaluation.binding;
      for (const candidate of legacyState.candidates) delete candidate.evaluation.binding;
      const legacy = createCheckpoint({
        runtimeVersion: initialized.checkpoint.runtimeVersion,
        policyVersion: initialized.checkpoint.policyVersion,
        evaluatorVersion: initialized.checkpoint.evaluatorVersion,
        state: legacyState,
        signer: configured.receiptSigner,
      });
      await configured.value.checkpointStore.save(legacy);

      const actions: VariationAction[] = [{ kind: 'evaluate' }, { kind: 'commit', summary: 'fresh evidence' }];
      configured.value.agent = {
        chooseAction: async (context) => actions[context.state.budget.actionsUsed]!,
      };
      configured.value.memory = new EphemeralGovernedMemory();
      const resumed = await new GovernedVariationOperator(configured.value).run();
      expect(resumed.receipts.map((receipt) => receipt.action.kind)).toEqual(['evaluate', 'commit']);
      expect(resumed.winner?.id).toBe('run-1/candidate/1');
      expect(resumed.winner?.evaluation.binding).toMatchObject({ sequence: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('promotes an immutable snapshot that later working-branch edits cannot mutate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-immutable-lineage-'));
    try {
      const seed = join(root, 'seed');
      const branches = join(root, 'branches');
      await mkdir(seed, { recursive: true });
      await writeFile(join(seed, 'routing.ts'), 'export const version = 1;\n');
      const environment = new RepositoryEnvironmentAdapter({
        version: 'repo-v1',
        seedBranchId: 'seed',
        seedPath: seed,
        branchesRoot: branches,
        executorFor: (cwd) => new NodeToolExecutor({ cwd, timeoutMs: 5_000 }),
      });
      const configured = await options(root, environment);
      configured.value.seed.workspaceDigest = await digestWorkspace(seed);
      const actions: VariationAction[] = [{ kind: 'evaluate' }, { kind: 'commit', summary: 'snapshot v1' }];
      configured.value.agent = {
        chooseAction: async (context) => actions[context.state.budget.actionsUsed]!,
      };
      configured.value.budget = { ...configured.value.budget, maxActions: 2, maxBranchActions: 2 };
      configured.value.stopOnVerifiedWinner = true;
      const output = await new GovernedVariationOperator(configured.value).run();
      const winner = output.winner!;
      const workingBranchId = output.checkpoint.state.currentBranchId;
      expect(winner.branchId).not.toBe(workingBranchId);
      expect(winner.workspaceDigest).toBe(winner.evaluation.binding?.workspaceDigest);

      await environment.execute({
        kind: 'edit',
        path: 'routing.ts',
        content: 'export const version = 2;\n',
        surface: 'modelRouting',
      }, output.checkpoint.state);
      const restored = await environment.fork(winner);
      const inspected = await environment.execute(
        { kind: 'inspect', path: 'routing.ts' },
        { ...output.checkpoint.state, currentBranchId: restored.branchId },
      );
      expect(inspected.stdout).toBe('export const version = 1;\n');
      expect(restored.workspaceDigest).toBe(winner.workspaceDigest);
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
