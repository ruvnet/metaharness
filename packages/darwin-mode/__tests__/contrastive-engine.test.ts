import { describe, expect, it, vi } from 'vitest';
import { digestDocument, runContrastive, validateDocument } from '../src/contrastive/index.js';
import type { ContrastiveOptions, JsonValue, ProbeInput, ProbeOutput } from '../src/contrastive/index.js';

function fixture(): ContrastiveOptions {
  return {
    tenantId: 'tenant-a', projectId: 'project-a', task: { inputs: ['dev-only'] }, environment: { seed: 7 },
    library: { tenantId: 'tenant-a', projectId: 'project-a', entries: [] }, envelope: { tools: ['parse'], maxNetwork: 0 },
    baseline: { components: [
      { id: 'parse', scope: 'invariant', content: { enabled: false } },
      { id: 'units', scope: 'domain', content: { enabled: false } },
    ] },
    budget: { maxUsd: 7, maxCalls: 7, timeoutMs: 1000, probeUsd: 1, proposeUsd: 1, composeUsd: 1 },
    evaluator: { surfaceAware: true, async probe(input) {
      // The evaluator executes the actual candidate's declarative configuration.
      const enabled = input.candidate.components.filter(c => (c.content as { enabled: boolean }).enabled).length;
      return { appliedDigest: digestDocument(input.candidate), score: enabled / 2, costUsd: 0.001,
        observations: input.candidate.components.map(c => ({ id: `e:${c.id}`, componentId: c.id, message: 'Observed behavior' })) };
    } },
    proposer: { async propose(input) {
      const component = input.baseline.components.find(c => c.scope === input.scope)!;
      return { edits: [{ componentId: component.id, content: { enabled: true }, citations: [`e:${component.id}`] }], costUsd: 0.001 };
    } },
    composer: { async compose(input) { return { edits: input.supportedEdits, costUsd: 0.001 }; } },
  };
}

describe('bounded contrastive development round', () => {
  it('executes both scoped candidates and composition under matched frozen inputs', async () => {
    const config = fixture();
    const digests: string[] = [];
    const probe = config.evaluator.probe;
    config.evaluator.probe = async input => {
      digests.push(input.candidateDigest);
      expect(input.task).toEqual({ inputs: ['dev-only'] });
      expect(Object.isFrozen(input.candidate.components[0].content)).toBe(true);
      expect(input.ceilingUsd).toBe(1);
      return probe(input);
    };
    const result = await runContrastive(config);
    expect(result.outcome).toBe('candidate');
    expect(result.baselineScore).toBe(0);
    expect(result.selectedScore).toBe(1);
    expect(new Set(digests).size).toBe(4);
    expect(result.calls).toBe(7);
    expect(result.reservedUsd).toBe(7);
    expect(result.reportedUsd).toBeCloseTo(0.007);
    expect(result.receipts.map(r => r.cumulativeReservedUsd)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.promotion).toBe('not-authorized');
  });

  it('does not pass scores or output verdicts to editors', async () => {
    const config = fixture();
    const propose = config.proposer.propose;
    config.proposer.propose = async input => {
      expect(Object.keys(input).sort()).toEqual(['baseline', 'candidateDigest', 'ceilingUsd', 'envelope', 'environment', 'library', 'observations', 'projectId', 'scope', 'signal', 'task', 'tenantId']);
      expect(input.observations.every(obs => !Object.hasOwn(obs, 'score'))).toBe(true);
      return propose(input);
    };
    expect((await runContrastive(config)).outcome).toBe('candidate');
  });

  it('isolates caller mutation and freezes policy against callbacks', async () => {
    const config = fixture();
    const probe = config.evaluator.probe;
    config.evaluator.probe = async input => {
      (config.environment as { seed: number }).seed = 99;
      (config.envelope as { maxNetwork: number }).maxNetwork = 99;
      expect((input.environment as { seed: number }).seed).toBe(7);
      expect(() => { (input.envelope as { maxNetwork: number }).maxNetwork = 99; }).toThrow();
      return probe(input);
    };
    expect((await runContrastive(config)).outcome).toBe('candidate');
  });

  it('deduplicates no-op candidates without spending probe or composition calls', async () => {
    const config = fixture();
    config.proposer.propose = async () => ({ edits: [], costUsd: 0.001 });
    const result = await runContrastive(config);
    expect(result.outcome).toBe('baseline');
    expect(result.calls).toBe(3);
    expect(result.deduplicated).toBe(2);
    expect(result.receipts.filter(r => r.status === 'deduplicated').every(r => r.reservedUsd === 0)).toBe(true);
  });

  it('reserves before effects and fails closed when a later call is denied', async () => {
    const config = fixture();
    (config.budget as { maxUsd: number }).maxUsd = 3;
    const result = await runContrastive(config);
    expect(result.calls).toBe(3);
    expect(result.reservedUsd).toBe(3);
    expect(result.outcome).toBe('baseline');
    expect(result.reason).toBe('budget');
    expect(result.receipts.at(-1)?.reservedUsd).toBe(0);
  });

  it('does not start even baseline when its ceiling cannot fit', async () => {
    const config = fixture();
    (config.budget as { maxUsd: number }).maxUsd = 0.5;
    const spy = vi.fn(config.evaluator.probe);
    config.evaluator.probe = spy;
    expect((await runContrastive(config)).calls).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('admits an exact decimal budget without floating point false denial', async () => {
    const result = await runContrastive({ ...fixture(), budget: {
      maxUsd: 0.7, maxCalls: 7, timeoutMs: 1000, probeUsd: 0.1, proposeUsd: 0.1, composeUsd: 0.1,
    } });
    expect(result.outcome).toBe('candidate');
    expect(result.calls).toBe(7);
    expect(result.reservedUsd).toBe(0.7);
  });

  it('rejects unsafe or unsupported budget precision before effects', async () => {
    for (const maxUsd of [1e20, 1e-10]) {
      const config = fixture();
      await expect(runContrastive({ ...config, budget: { ...config.budget, maxUsd } })).rejects.toThrow('nanodollar');
    }
  });

  it.each([NaN, Infinity, -1, 1.1])('rejects invalid or excessive costs %s', async costUsd => {
    const config = fixture();
    const probe = config.evaluator.probe;
    config.evaluator.probe = async input => ({ ...await probe(input), costUsd });
    const result = await runContrastive(config);
    expect(result.reason).toBe('invalid');
    expect(result.reportedUsd).toBe(Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : 1);
    expect(result.calls).toBe(1);
  });

  it('charges failed calls conservatively and cancels remaining work', async () => {
    const config = fixture();
    config.evaluator.probe = async () => { throw new Error('sensitive provider detail'); };
    const result = await runContrastive(config);
    expect(result.reason).toBe('failure');
    expect(result.reportedUsd).toBe(1);
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });

  it('aborts a timed out adapter and discards late completions', async () => {
    const config = fixture();
    (config.budget as { timeoutMs: number }).timeoutMs = 10;
    let input: ProbeInput | undefined;
    let complete: ((value: ProbeOutput) => void) | undefined;
    config.evaluator.probe = async request => { input = request; return new Promise(resolve => { complete = resolve; }); };
    const result = await runContrastive(config);
    expect(result.reason).toBe('timeout');
    expect(input?.signal.aborted).toBe(true);
    const before = JSON.stringify(result);
    complete!({ appliedDigest: input!.candidateDigest, score: 1, observations: [], costUsd: 0 });
    await Promise.resolve(); await Promise.resolve();
    expect(JSON.stringify(result)).toBe(before);
  });

  it('rejects a surface-independent evaluator and dishonest digest attestation', async () => {
    const config = fixture();
    (config.evaluator as { surfaceAware: boolean }).surfaceAware = false;
    await expect(runContrastive(config)).rejects.toThrow('Surface-aware');
    config.evaluator.surfaceAware = true;
    const probe = config.evaluator.probe;
    config.evaluator.probe = async input => ({ ...await probe(input), appliedDigest: 'ignored-candidate' });
    expect((await runContrastive(config)).reason).toBe('invalid');
  });

  it.each(['unknown-citation', 'wrong-component', 'wrong-scope'])('rejects unsupported edits %s', async mode => {
    const config = fixture();
    config.proposer.propose = async () => ({ edits: [{ componentId: mode === 'wrong-scope' ? 'units' : 'parse',
      content: { enabled: true }, citations: [mode === 'unknown-citation' ? 'missing' : 'e:units'] }], costUsd: 0 });
    const result = await runContrastive(config);
    expect(result.reason).toBe('invalid');
    expect(result.calls).toBe(2);
  });

  it('rejects compositions introducing unprobed edits', async () => {
    const config = fixture();
    config.composer!.compose = async () => ({ edits: [{ componentId: 'parse', content: { enabled: 'invented' }, citations: ['e:parse'] }], costUsd: 0 });
    const result = await runContrastive(config);
    expect(result.reason).toBe('invalid');
    expect(result.outcome).toBe('baseline');
    expect(result.calls).toBe(6);
  });

  it('keeps the best measured candidate when supported composition regresses', async () => {
    const config = fixture();
    const probe = config.evaluator.probe;
    config.evaluator.probe = async input => {
      const result = await probe(input);
      return { ...result, score: result.score === 1 ? 0.25 : result.score };
    };
    const result = await runContrastive(config);
    expect(result.outcome).toBe('candidate');
    expect(result.selectedScore).toBe(0.5);
    expect(result.calls).toBe(7);
  });

  it('reuses a measured candidate when composition chooses that same subset', async () => {
    const config = fixture();
    config.composer!.compose = async input => ({ edits: [input.supportedEdits[0]], costUsd: 0 });
    const result = await runContrastive(config);
    expect(result.outcome).toBe('candidate');
    expect(result.selectedScore).toBe(0.5);
    expect(result.calls).toBe(6);
    expect(result.deduplicated).toBe(1);
    expect(result.receipts.at(-1)?.status).toBe('deduplicated');
  });

  it('rejects cross-tenant, cross-project and oversized experience input', async () => {
    for (const library of [
      { tenantId: 'other', projectId: 'project-a', entries: [] },
      { tenantId: 'tenant-a', projectId: 'other', entries: [] },
      { tenantId: 'tenant-a', projectId: 'project-a', entries: Array(33).fill(null) },
    ]) await expect(runContrastive({ ...fixture(), library })).rejects.toThrow('scoped library');
  });

  it('rejects prototype keys, executable values, accessors and cycles before effects', async () => {
    const values: unknown[] = [JSON.parse('{"__proto__":{"tools":["shell"]}}'), () => 1, { x: Infinity }];
    const cyclic: { next?: unknown } = {}; cyclic.next = cyclic; values.push(cyclic);
    let invoked = false;
    values.push(Object.defineProperty({}, 'secret', { enumerable: true, get() { invoked = true; return 'bad'; } }));
    for (const task of values) await expect(runContrastive({ ...fixture(), task: task as JsonValue })).rejects.toThrow();
    expect(invoked).toBe(false);
  });

  it('validates dependency existence, reachability and cycles', () => {
    const component = fixture().baseline.components[0];
    expect(() => validateDocument({ components: [{ ...component, requires: ['missing'] }] })).toThrow('Missing');
    expect(() => validateDocument({ components: [{ ...component, trigger: 'dependency' }] })).toThrow('Unreachable');
    expect(() => validateDocument({ components: [{ ...component, requires: ['parse'] }] })).toThrow('Cyclic');
    expect(() => validateDocument({ components: [{ ...component, requires: ['helper'] },
      { id: 'helper', scope: 'domain', content: {}, trigger: 'dependency' }] })).not.toThrow();
  });
});
