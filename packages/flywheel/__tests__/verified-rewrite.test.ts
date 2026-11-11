import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  successPrioritizedReward, terminalOutcomesToScore, verifyTrajectoryRewrite,
  createVerifiedRewriteProposer, runFlywheelGenerations, makeSigner,
  verifyReplayBundle, meetsPromotionRule,
  type TerminalOutcome, type VerifiedRewriteConfig,
} from '../src/index.js';

const good: TerminalOutcome = { strictSuccess: true, passedChecks: 2, totalChecks: 2,
  reportValid: true, cost: 1, safetyViolation: false };
const hash = 'a'.repeat(64);
function config(): VerifiedRewriteConfig {
  let id = 0;
  return {
    task: { split: 'development', id: 'development-only', instruction: 'Repair addition', snapshotDigest: hash,
      publicSteps: ['Inspect implementation', 'Replace subtraction with addition', 'Run public examples'] },
    discoveryOutcome: { ...good }, signal: new AbortController().signal, maxReplayCost: 4,
    rewrite: async task => task.publicSteps.join('\n'), review: async () => true,
    open: async () => ({ id: `fresh-${++id}`, snapshotDigest: hash,
      execute: async () => {}, verify: async () => ({ ...good }), close: async () => {} }),
  };
}

describe('completion and bounded diagnostic reward', () => {
  it('every failure stays below every success, including numerical saturation', () => {
    const fail = { ...good, strictSuccess: false, passedChecks: Number.MAX_SAFE_INTEGER, totalChecks: Number.MAX_SAFE_INTEGER };
    expect(successPrioritizedReward(fail, Number.MIN_VALUE)).toBeLessThan(1);
    expect(successPrioritizedReward({ ...good, passedChecks: 0 }, 82)).toBe(1);
    expect(successPrioritizedReward(good, 82)).toBeLessThan(2);
  });
  it('does not turn invalid reports or safety failures into positive completion evidence', () => {
    expect(successPrioritizedReward({ ...good, reportValid: false }, 82)).toBe(1);
    expect(successPrioritizedReward({ ...good, strictSuccess: false, reportValid: false }, 82)).toBe(0);
    expect(successPrioritizedReward({ ...good, safetyViolation: true }, 82)).toBeLessThan(1);
  });
  it.each([NaN, Infinity, -1, 0])('rejects invalid divisor %s', divisor => {
    expect(() => successPrioritizedReward(good, divisor)).toThrow();
  });
  it.each([
    { cost: NaN }, { cost: -1 }, { cost: Infinity }, { passedChecks: -1 },
    { passedChecks: 3 }, { totalChecks: 1.5 }, { strictSuccess: 'true' },
    { reportValid: undefined }, { safetyViolation: undefined },
  ])('rejects malformed outcome %j', patch => {
    expect(() => terminalOutcomesToScore([{ ...good, ...patch } as TerminalOutcome])).toThrow();
  });
  it('projects only protected completion to primary and supplies paired item outcomes', () => {
    const score = terminalOutcomesToScore([good, { ...good, strictSuccess: false }, { ...good, safetyViolation: true }]);
    expect(score).toEqual({ primary: 1 / 3, noopRate: 0, costPerWin: 3, regressed: true, itemWins: [true, false, false] });
    expect(() => terminalOutcomesToScore([])).toThrow();
    expect(terminalOutcomesToScore([{ ...good, strictSuccess: false }]).costPerWin).toBe(Number.MAX_VALUE);
    expect(() => terminalOutcomesToScore([{ ...good, cost: Number.MAX_VALUE }, { ...good, cost: Number.MAX_VALUE }])).toThrow();
  });
});

describe('verified rewriting boundary', () => {
  it('replays twice, projects public fields, freezes inputs and binds task/runbook digests', async () => {
    const cfg = config();
    Object.assign(cfg.task, { protectedTests: 'SECRET', rawTrace: 'SECRET', credentials: 'SECRET' });
    cfg.rewrite = async task => {
      expect(Object.keys(task).sort()).toEqual(['id', 'instruction', 'publicSteps', 'snapshotDigest', 'split']);
      expect(Object.isFrozen(task)).toBe(true);
      expect(Object.isFrozen(task.publicSteps)).toBe(true);
      return 'public procedure';
    };
    const result = await verifyTrajectoryRewrite(cfg);
    expect(result.accepted).toBe(true);
    expect(result.sessions).toEqual(['fresh-1', 'fresh-2']);
    expect(result.replayCost).toBe(2);
    expect(result.taskDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.runbookDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('never rewrites an unverified or unsafe discovery', async () => {
    for (const patch of [{ strictSuccess: false }, { safetyViolation: true }]) {
      const cfg = config(); cfg.discoveryOutcome = { ...good, ...patch }; cfg.rewrite = vi.fn();
      expect((await verifyTrajectoryRewrite(cfg)).accepted).toBe(false);
      expect(cfg.rewrite).not.toHaveBeenCalled();
    }
  });
  it('requires exact true review before opening any session', async () => {
    const cfg = config(); cfg.review = async () => 'true' as unknown as boolean; cfg.open = vi.fn();
    expect((await verifyTrajectoryRewrite(cfg)).reason).toBe('review_rejected');
    expect(cfg.open).not.toHaveBeenCalled();
  });
  it.each(['duplicate', 'snapshot', 'failure', 'safety', 'invalid', 'execute', 'verify', 'cleanup'])('rejects %s and closes sessions', async mode => {
    const cfg = config(); const close = vi.fn(async () => { if (mode === 'cleanup') throw Error('private'); });
    cfg.open = async () => ({ id: 'same-id', snapshotDigest: mode === 'snapshot' ? 'b'.repeat(64) : hash,
      execute: async () => { if (mode === 'execute') throw Error('private'); },
      verify: async () => {
        if (mode === 'verify') throw Error('private');
        return { ...good, strictSuccess: mode !== 'failure', safetyViolation: mode === 'safety', cost: mode === 'invalid' ? NaN : 1 };
      }, close });
    const result = await verifyTrajectoryRewrite(cfg);
    expect(result.accepted).toBe(false); expect(result.runbook).toBeNull();
    expect(close).toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('private');
  });
  it('accounts for exact budget and refuses the next replay after exhaustion', async () => {
    const cfg = config(); cfg.maxReplayCost = 1;
    const result = await verifyTrajectoryRewrite(cfg);
    expect(result.reason).toBe('replay_budget_exhausted'); expect(result.sessions).toHaveLength(1);
    cfg.maxReplayCost = 2;
    expect((await verifyTrajectoryRewrite(cfg)).accepted).toBe(true);
  });
  it('rejects overspend on the last replay', async () => {
    const cfg = config(); cfg.maxReplayCost = 1.5;
    expect((await verifyTrajectoryRewrite(cfg)).reason).toBe('replay_budget_exhausted');
  });
  it('stops on cancellation and never accepts an adapter ignoring the signal', async () => {
    const cfg = config(); const controller = new AbortController(); cfg.signal = controller.signal;
    cfg.rewrite = async () => { controller.abort(); return 'procedure'; }; cfg.open = vi.fn();
    expect((await verifyTrajectoryRewrite(cfg)).reason).toBe('cancelled');
    expect(cfg.open).not.toHaveBeenCalled();
  });
  it.each([0, 9, NaN, 1.5])('bounds repeat count %s', async repeats => {
    await expect(verifyTrajectoryRewrite({ ...config(), repeats })).rejects.toThrow();
  });
  it('bounds and validates public task and generated runbook', async () => {
    const cfg = config(); cfg.task.snapshotDigest = 'not-a-digest';
    await expect(verifyTrajectoryRewrite(cfg)).rejects.toThrow();
    const cfg2 = config(); cfg2.rewrite = async () => 'x'.repeat(65537);
    expect((await verifyTrajectoryRewrite(cfg2)).accepted).toBe(false);
  });
  it('rejects confirmation data mislabeled at the runtime boundary', async () => {
    const cfg = config(); (cfg.task as { split: string }).split = 'confirmation';
    await expect(verifyTrajectoryRewrite(cfg)).rejects.toThrow();
  });
  it('rejected rewriting returns the parent unchanged and does not touch other levers', async () => {
    const cfg = config(); cfg.review = async () => false;
    const proposer = createVerifiedRewriteProposer('procedure', () => cfg);
    const base = { id: 'root', generation: 0, parents: [], policy: { procedure: 'parent', other: 'keep' } };
    expect(await proposer(base, 'procedure')).toBe('parent');
    expect(await proposer(base, 'other')).toBe('keep');
  });
});

describe('real process repair through existing Flywheel', () => {
  // A deterministic adapter tests integration, not model learning or benchmark generalization.
  const broken = 'export const add = (a, b) => a - b;\n';
  const snapshotDigest = createHash('sha256').update(broken).digest('hex');
  async function executeCase(runbook: string, cases: number[][]): Promise<TerminalOutcome> {
    const dir = await mkdtemp(join(tmpdir(), 'rewrite-case-'));
    try {
      const source = runbook.includes('Replace subtraction with addition') ? broken.replace('a - b', 'a + b') : broken;
      await writeFile(join(dir, 'impl.mjs'), source);
      await writeFile(join(dir, 'check.mjs'), `import { add } from './impl.mjs'; console.log(JSON.stringify(${JSON.stringify(cases)}.map(([a,b])=>add(a,b)===a+b)));`);
      const wins = JSON.parse(execFileSync(process.execPath, [join(dir, 'check.mjs')], { encoding: 'utf8', timeout: 3000 })) as boolean[];
      return { ...good, strictSuccess: wins.every(Boolean), passedChecks: wins.filter(Boolean).length, totalChecks: wins.length };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  it('clean filesystem replays yield a proposal; protected unseen cases gate and sign promotion', async () => {
    const cfg = config(); cfg.task.snapshotDigest = snapshotDigest;
    const dirs: string[] = []; const closed: string[] = [];
    cfg.open = async () => {
      const dir = await mkdtemp(join(tmpdir(), 'rewrite-discovery-')); dirs.push(dir);
      await writeFile(join(dir, 'impl.mjs'), broken);
      return { id: dir, snapshotDigest,
        execute: async runbook => {
          const before = await readFile(join(dir, 'impl.mjs'), 'utf8');
          if (runbook.includes('Replace subtraction with addition')) await writeFile(join(dir, 'impl.mjs'), before.replace('a - b', 'a + b'));
        },
        verify: async () => {
          await writeFile(join(dir, 'public.mjs'), "import { add } from './impl.mjs'; process.exit(add(2,3)===5?0:1);");
          try { execFileSync(process.execPath, [join(dir, 'public.mjs')], { timeout: 3000 }); return { ...good }; }
          catch { return { ...good, strictSuccess: false }; }
        },
        close: async () => { await rm(dir, { recursive: true, force: true }); closed.push(dir); } };
    };
    const heldout = [[-7, 4], [0, -9], [1.5, 2.25]];
    const signer = makeSigner();
    const result = await runFlywheelGenerations({ rootPolicy: { procedure: '' }, mutationTargets: ['procedure'],
      proposer: createVerifiedRewriteProposer('procedure', () => cfg),
      evaluator: async (policy, suite) => terminalOutcomesToScore([await executeCase(policy.procedure!, suite.items as number[][])]),
      holdout: { id: 'protected-confirmation', items: heldout }, anchor: { id: 'protected-anchor', items: [[12, 8]] },
      maxGenerations: 1, signer, dataSource: 'DETERMINISTIC_PROCESS_FIXTURE',
    });
    expect(result.promotions).toHaveLength(1);
    expect(result.liftCurve.map(x => x.primary)).toEqual([0, 1]);
    expect(result.promotions[0]!.mutation!.summary).toContain('verified-rewrite');
    expect(verifyReplayBundle(result.replayBundle, { promotionRule: meetsPromotionRule }).pass).toBe(true);
    expect(new Set(dirs).size).toBe(2); expect(closed).toEqual(dirs);
    // Equal-budget retry of the frozen procedure cannot repair the artifact.
    for (let i = 0; i < 2; i++) expect((await executeCase('', heldout)).strictSuccess).toBe(false);
  });
  it('a replay-qualified procedure still cannot promote partial-only confirmation', async () => {
    const result = await runFlywheelGenerations({ rootPolicy: { procedure: '' },
      proposer: createVerifiedRewriteProposer('procedure', config),
      evaluator: async () => terminalOutcomesToScore([{ ...good, strictSuccess: false, passedChecks: 1000, totalChecks: 1000 }]),
      holdout: { id: 'protected', items: [1] }, maxGenerations: 1, signer: makeSigner(), dataSource: 'FIXTURE',
    });
    expect(result.promotions).toHaveLength(0);
    expect(result.finalPolicy.procedure).toBe('');
    expect(verifyReplayBundle(result.replayBundle).pass).toBe(true);
  });
});
