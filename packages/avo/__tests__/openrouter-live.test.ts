// SPDX-License-Identifier: MIT
// Live OpenRouter validation of the governed variation loop (ADR-251 release evidence).
// Gated on OPENROUTER_API_KEY so the deterministic suite stays green without credentials.
// Writes auditable usage receipts (generation ids + token counts + cost) to
// bench/results/openrouter-live-receipts.json.

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  type AgentActionDecision,
  type EvaluationResult,
  type VariationAction,
  type VariationContext,
} from '../src/index.js';

const apiKey = process.env.OPENROUTER_API_KEY;
const baseUrl = process.env.AVO_LIVE_BASE_URL ?? 'https://openrouter.ai/api/v1';
const model = process.env.AVO_LIVE_MODEL ?? 'qwen/qwen3-8b';
const MAX_LIVE_COST_USD = 0.25;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface LiveUsageReceipt {
  generationId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  actionKind: string;
}

class OpenRouterVariationAgent {
  readonly usage: LiveUsageReceipt[] = [];
  #spentUsd = 0;

  async chooseAction(context: VariationContext): Promise<AgentActionDecision> {
    if (this.#spentUsd >= MAX_LIVE_COST_USD) {
      throw new Error(`live cost cap exceeded: ${this.#spentUsd} >= ${MAX_LIVE_COST_USD}`);
    }
    const startedAt = Date.now();
    const history = context.state.receipts
      .map((entry) => `${entry.action.kind}: exit=${entry.observation?.exitCode ?? ''} stdout=${(entry.observation?.stdout ?? '').slice(0, 200)}`)
      .join('\n');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 900,
        usage: { include: true },
        messages: [
          {
            role: 'system',
            content:
              'You repair a repository through single JSON actions. Respond with ONLY a JSON object, no prose. ' +
              'Allowed actions: {"kind":"inspect","path":"fix.mjs"} | {"kind":"edit","path":"fix.mjs","content":"<full new file content>"} | ' +
              '{"kind":"execute","command":"node test.mjs"} | {"kind":"evaluate"} | {"kind":"commit","summary":"<short>"} . ' +
              'Workflow: inspect first, then edit the bug, then execute the test, then evaluate, then commit.',
          },
          {
            role: 'user',
            content:
              `Task: ${context.task}\nActions used: ${context.state.budget.actionsUsed}\nHistory:\n${history || '(none)'}\n` +
              'The file fix.mjs must export add(a, b) returning the sum. Choose the single next action as JSON.',
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const body = (await response.json()) as {
      id: string;
      model: string;
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; cost?: number };
    };
    const costUsd = body.usage?.cost ?? 0;
    this.#spentUsd += costUsd;
    const action = this.#sanitize(body.choices[0]?.message?.content ?? '', context);
    const receipt: LiveUsageReceipt = {
      generationId: body.id,
      model: body.model,
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      costUsd,
      actionKind: action.kind,
    };
    this.usage.push(receipt);
    return {
      action,
      costUsd,
      durationMs: Date.now() - startedAt,
      receipt: { provider: 'openrouter', ...receipt },
    };
  }

  /** Constrain model output to the policy surface; malformed output degrades to a safe inspect. */
  #sanitize(content: string, context: VariationContext): VariationAction {
    const match = content.match(/\{[\s\S]*\}/);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    switch (parsed.kind) {
      case 'edit':
        if (typeof parsed.content === 'string' && parsed.content.length > 0) {
          return { kind: 'edit', path: 'fix.mjs', content: parsed.content, surface: 'repairStrategy' };
        }
        break;
      case 'execute':
        return { kind: 'execute', command: 'node test.mjs' };
      case 'evaluate':
        return { kind: 'evaluate' };
      case 'commit': {
        // Promotion requires fresh evaluation evidence; route a premature commit through evaluate.
        const lastKind = context.state.receipts.at(-1)?.action.kind;
        if (lastKind !== 'evaluate') return { kind: 'evaluate' };
        return { kind: 'commit', summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 120) : 'live repair' };
      }
      case 'inspect':
        return { kind: 'inspect', path: 'fix.mjs' };
      default:
        break;
    }
    // Malformed output: keep the loop moving without widening authority.
    return context.state.budget.actionsUsed === 0 ? { kind: 'inspect', path: 'fix.mjs' } : { kind: 'evaluate' };
  }
}

describe.skipIf(!apiKey)('OpenRouter live governed variation (auditable receipts)', () => {
  it(
    'drives the operator with a real model, signs every receipt, and persists usage evidence',
    { timeout: 300_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'avo-live-'));
      try {
        const seed = join(root, 'seed');
        await mkdir(seed, { recursive: true });
        await writeFile(join(seed, 'fix.mjs'), 'export function add(a, b) {\n  return a - b; // BUG: should be a + b\n}\n');
        await writeFile(
          join(seed, 'test.mjs'),
          "import { add } from './fix.mjs';\nif (add(2, 3) !== 5) { console.error('FAIL'); process.exit(1); }\nconsole.log('PASS');\n",
        );
        const environment = new RepositoryEnvironmentAdapter({
          version: 'live-repo-v1',
          seedBranchId: 'seed',
          seedPath: seed,
          branchesRoot: join(root, 'branches'),
          executorFor: (cwd) => new NodeToolExecutor({ cwd, timeoutMs: 30_000 }),
        });
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const receiptSigner = new Ed25519ReceiptSigner('live-key', privateKey, publicKey);
        const agent = new OpenRouterVariationAgent();
        const evaluate = async (branchId: string): Promise<EvaluationResult> => {
          const cwd = branchId === 'seed' ? seed : join(root, 'branches', branchId);
          const executor = new NodeToolExecutor({ cwd, timeoutMs: 30_000 });
          const command = 'node test.mjs';
          const run = await executor.execute({
            command,
            classification: {
              verdict: 'allow',
              segments: [{ text: command, exe: 'node', verdict: 'allow', reason: 'live evaluator test command' }],
              reasons: ['live evaluator test command'],
            },
            approved: true,
          });
          const correct = run.exitCode === 0;
          return {
            evaluatorVersion: 'live-eval-v1', correct, safe: true, replayable: true,
            noRegression: correct, budgetValid: true, quality: correct ? 0.95 : 0.1,
            costUsd: 0, wallTimeMs: run.durationMs ?? 1, policyViolations: 0,
            protectedTestsPassed: correct, lowerConfidenceBound: correct ? 0.8 : 0,
            evidence: { branchId, stdout: run.stdout.slice(0, 200) },
          };
        };
        const operator = new GovernedVariationOperator({
          runId: 'openrouter-live-1',
          task: 'fix.mjs add(a, b) subtracts instead of adding; repair it so node test.mjs prints PASS',
          seed: { id: 'seed', branchId: 'seed', workspaceDigest: 'sha256:seed' },
          environment,
          evaluators: { version: 'live-eval-v1', evaluate },
          agent,
          knowledge: { retrieve: async () => [] },
          memory: new EphemeralGovernedMemory(),
          policy: new GovernedCapabilityPolicy({
            version: 'live-policy-v1',
            allowedActions: ['inspect', 'edit', 'execute', 'evaluate', 'commit'],
            approvalActions: ['execute', 'commit'],
            allowedCommands: [/^node test\.mjs$/],
            writablePaths: [/^fix\.mjs$/],
          }),
          approval: { approve: async () => true },
          supervisor: new SemanticSupervisor({ policyVersion: 'live-policy-v1' }, async () => [
            { id: 's1', statement: 'reread the failing file', causalMechanism: 'context', expectedEvidence: ['file content'], surface: 'contextPolicy' },
            { id: 's2', statement: 'rewrite the arithmetic', causalMechanism: 'edit', expectedEvidence: ['test PASS'], surface: 'repairStrategy' },
            { id: 's3', statement: 'rerun the test', causalMechanism: 'tests', expectedEvidence: ['exit 0'], surface: 'testPolicy' },
          ]),
          signer: receiptSigner,
          checkpointStore: new JsonCheckpointStore(join(root, 'checkpoint.json')),
          budget: { maxActions: 10, maxBranchActions: 10, maxCostUsd: MAX_LIVE_COST_USD, maxWallTimeMs: 240_000, riskBudget: 1 },
          invariants: {
            immutableCapabilities: ['repository:read', 'repository:bounded-write', 'tool:node-test'],
            protectedPaths: ['test.mjs'],
            promotionDelta: 0.1,
            requireSignedReceipts: true,
            requireZeroPolicyViolations: true,
          },
        });
        const output = await operator.run();

        // Governance invariants hold under a real model.
        expect(output.receipts.length).toBeGreaterThanOrEqual(3);
        expect(output.receipts.every((receipt) => verifyReceipt(receipt, receiptSigner))).toBe(true);
        expect(verifyVariationCheckpoint(output.checkpoint, receiptSigner)).toBe(true);

        // Auditable usage: every model decision has a generation id and token accounting.
        expect(agent.usage.length).toBeGreaterThanOrEqual(3);
        for (const usage of agent.usage) {
          expect(usage.generationId.length).toBeGreaterThan(0);
          expect(usage.promptTokens).toBeGreaterThan(0);
        }
        const totalCostUsd = agent.usage.reduce((sum, usage) => sum + usage.costUsd, 0);
        expect(totalCostUsd).toBeLessThanOrEqual(MAX_LIVE_COST_USD);

        const evidencePath = join(
          packageRoot,
          'bench',
          'results',
          process.env.AVO_LIVE_EVIDENCE ?? 'openrouter-live-receipts.json',
        );
        await mkdir(dirname(evidencePath), { recursive: true });
        await writeFile(
          evidencePath,
          `${JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              model,
              baseUrl,
              keySource: process.env.AVO_LIVE_KEY_SOURCE ?? 'gcp-secret-manager:OPENROUTER_API_KEY',
              totalCostUsd,
              repaired: output.winner ? output.winner.evaluation.correct : false,
              actionReceipts: output.receipts.map((receipt) => ({
                kind: receipt.action.kind,
                verdict: receipt.policyDecision.verdict,
                exitCode: receipt.observation.exitCode,
                costUsd: receipt.costUsd,
              })),
              usage: agent.usage,
            },
            null,
            2,
          )}\n`,
          'utf8',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
