import { rememberContrastiveExperience, retrieveContrastiveExperiences } from '../src/contrastive/memory.js';
import { createContrastiveEditors } from '../src/contrastive/editors.js';
import { describe, expect, it, vi } from 'vitest';
import { runContrastive, digestDocument } from '../src/contrastive/index.js';
import type { ContrastiveOptions, ProbeInput, ProbeOutput } from '../src/contrastive/index.js';

function options(): ContrastiveOptions {
  return {
    tenantId: 'tenant-a', projectId: 'project-a', task: { prompt: 'Repair task' },
    environment: { runtime: 'test' }, envelope: { network: false, tools: ['read'] },
    library: { tenantId: 'tenant-a', projectId: 'project-a', entries: [] },
    baseline: { components: [
      { id: 'planner', scope: 'invariant', content: { mode: 'base' }, trigger: 'always' },
      { id: 'domain', scope: 'domain', content: { mode: 'base' }, trigger: 'always' },
    ] },
    budget: { maxUsd: 7, maxCalls: 7, timeoutMs: 1000, probeUsd: 1, proposeUsd: 1, composeUsd: 1 },
    evaluator: { surfaceAware: true, probe: async input => evidence(input) },
    proposer: { propose: async () => ({ edits: [], costUsd: 0.1 }) },
  };
}
function evidence(input: ProbeInput, overrides: Partial<ProbeOutput> = {}): ProbeOutput {
  return { appliedDigest: input.candidateDigest, score: 0.1, costUsd: 0.1,
    observations: input.candidate.components.map(c => ({ id: `obs-${c.id}`, componentId: c.id, message: 'Improve procedure' })), ...overrides };
}
function propose(input: { scope: string }) {
  const id = input.scope === 'invariant' ? 'planner' : 'domain';
  return { edits: [{ componentId: id, content: { mode: 'better' }, citations: [`obs-${id}`] }], costUsd: 0.1 };
}
async function rejectBeforeEffects(input: ContrastiveOptions) {
  const probe = vi.fn(input.evaluator.probe); const edit = vi.fn(input.proposer.propose);
  const args = { ...input, evaluator: { ...input.evaluator, probe }, proposer: { propose: edit } };
  let result;
  try { result = await runContrastive(args); } catch (err) { expect(err).toBeInstanceOf(Error); }
  if (result) expect(result.outcome).toBe('baseline');
  expect(probe).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
}

describe('contrastive independent adversarial review', () => {
  it('rejects a non surface aware evaluator before adapter effects', async () => {
    const o = options(); await rejectBeforeEffects({ ...o, evaluator: { ...o.evaluator, surfaceAware: false as true } });
  });
  it.each(['tenantId', 'projectId'] as const)('rejects mismatched library %s before adapter effects', async key => {
    const o = options(); await rejectBeforeEffects({ ...o, library: { ...o.library, [key]: 'other' } });
  });
  it.each([NaN, Infinity, -1])('rejects invalid budget %s before adapter effects', async maxUsd => {
    const o = options(); await rejectBeforeEffects({ ...o, budget: { ...o.budget, maxUsd } });
  });
  it('does not call adapters when first reservation exceeds remaining budget', async () => {
    const o = options(); await rejectBeforeEffects({ ...o, budget: { ...o.budget, maxUsd: 0.5 } });
  });
  it('rejects accessors without invoking them', async () => {
    let reads = 0; const task = Object.defineProperty({}, 'prompt', { enumerable: true, get() { reads++; return 'bad'; } });
    await rejectBeforeEffects({ ...options(), task }); expect(reads).toBe(0);
  });
  it.each(['__proto__', 'constructor', 'prototype'])('rejects dangerous JSON key %s', async key => {
    const task = JSON.parse('{"' + key + '":{"polluted":true}}');
    await rejectBeforeEffects({ ...options(), task }); expect(({} as any).polluted).toBeUndefined();
  });
  it('rejects an oversized task before adapters run', async () => {
    await rejectBeforeEffects({ ...options(), task: { prompt: 'x'.repeat(2 * 1024 * 1024) } });
  });
  it('rejects cyclic documents before adapters run', async () => {
    const task: any = {}; task.self = task; await rejectBeforeEffects({ ...options(), task });
  });
  it('rejects unknown and traversal component IDs before adapters run', async () => {
    const o = options(); await rejectBeforeEffects({ ...o, baseline: { components: [{ ...o.baseline.components[0], id: '../../outside' }] } });
  });
  it('rejects a probe which did not execute the supplied candidate digest', async () => {
    const o = options(); const edit = vi.fn(o.proposer.propose);
    const r = await runContrastive({ ...o, proposer: { propose: edit }, evaluator: { surfaceAware: true, probe: async i => evidence(i, { appliedDigest: 'different' }) } });
    expect(r.outcome).toBe('baseline'); expect(edit).not.toHaveBeenCalled(); expect(r.receipts[0].status).toBe('invalid');
  });
  it.each([NaN, Infinity, -1, 2])('rejects invalid or over-ceiling cost %s and charges reservation', async costUsd => {
    const o = options(); const edit = vi.fn(o.proposer.propose);
    const r = await runContrastive({ ...o, proposer: { propose: edit }, evaluator: { surfaceAware: true, probe: async i => evidence(i, { costUsd }) } });
    expect(r.outcome).toBe('baseline'); expect(edit).not.toHaveBeenCalled(); expect(r.reservedUsd).toBe(1); expect(r.reportedUsd).toBe(Number.isFinite(costUsd) && costUsd > 1 ? costUsd : 1);
  });
  it.each(['scope', 'citation', 'component'])('rejects %s escape from proposal before candidate execution', async escape => {
    const o = options(); const probe = vi.fn(o.evaluator.probe);
    const r = await runContrastive({ ...o, evaluator: { ...o.evaluator, probe }, proposer: { propose: async () => ({ costUsd: 0.1, edits: [{ componentId: escape === 'scope' ? 'domain' : escape === 'component' ? 'missing' : 'planner', content: 'changed', citations: [escape === 'citation' ? 'fake' : 'obs-domain'] }] }) } });
    expect(r.outcome).toBe('baseline'); expect(probe).toHaveBeenCalledTimes(1); expect(r.receipts.some(x => x.status === 'invalid')).toBe(true);
  });
  it('freezes adapter context deeply and preserves caller-owned inputs', async () => {
    const o = options(); let frozen = false; let mutationRejected = false;
    const r = await runContrastive({ ...o, evaluator: { surfaceAware: true, probe: async i => {
      frozen = Object.isFrozen(i) && Object.isFrozen(i.envelope) && Object.isFrozen((i.envelope as any).tools) && Object.isFrozen(i.candidate.components[0].content);
      try { (i.envelope as any).tools.push('shell'); } catch { mutationRejected = true; }
      return evidence(i);
    } } });
    expect(frozen).toBe(true); expect(mutationRejected).toBe(true); expect(o.envelope).toEqual({ network: false, tools: ['read'] }); expect(r.promotion).toBe('not-authorized');
  });
  it('snapshots caller input before first asynchronous boundary', async () => {
    const o = options(); const seen: unknown[] = [];
    const pending = runContrastive({ ...o, evaluator: { surfaceAware: true, probe: async i => { seen.push(i.envelope); return evidence(i); } } });
    (o.envelope as any).network = true; (o.envelope as any).tools.push('shell');
    await pending; expect(seen[0]).toEqual({ network: false, tools: ['read'] });
  });
  it('does not leak extra verifier configuration or promotion functions to adapters', async () => {
    const o = options(); const seen: unknown[] = []; let promoted = 0;
    const r = await runContrastive({ ...o, verifierSecret: 'heldout-marker', promote: () => promoted++,
      evaluator: { surfaceAware: true, probe: async (i: ProbeInput) => { seen.push(i); return evidence(i); } },
      proposer: { propose: async (i: any) => { seen.push(i); return { edits: [], costUsd: 0.1 }; } },
    } as ContrastiveOptions);
    expect(JSON.stringify(seen)).not.toContain('heldout-marker'); expect(seen.every(i => !Object.hasOwn(i as object, 'promote'))).toBe(true); expect(promoted).toBe(0); expect(r.promotion).toBe('not-authorized');
  });
  it('caps admitted calls and rolls back an earlier development winner when exhausted', async () => {
    const o = options(); const probe = vi.fn(async (i: ProbeInput) => evidence(i, { score: i.candidateDigest === digestDocument(o.baseline) ? 0.1 : 0.8 }));
    const r = await runContrastive({ ...o, budget: { ...o.budget, maxCalls: 3 }, evaluator: { surfaceAware: true, probe }, proposer: { propose: async i => propose(i) } });
    expect(r.calls).toBe(3); expect(r.outcome).toBe('baseline'); expect(r.receipts.at(-1)?.status).toBe('budget'); expect(r.reservedUsd).toBe(3);
  });
  it('aborts a timed out call, ignores late completion, and starts no siblings', async () => {
    const o = options(); let resolve!: (out: ProbeOutput) => void; let input!: ProbeInput;
    const edit = vi.fn(o.proposer.propose);
    const pending = runContrastive({ ...o, budget: { ...o.budget, timeoutMs: 10 }, proposer: { propose: edit }, evaluator: { surfaceAware: true, probe: i => { input = i; return new Promise(r => { resolve = r; }); } } });
    const r = await pending; const receipt = JSON.stringify(r);
    expect(input.signal.aborted).toBe(true); expect(r.reason).toBe('timeout'); expect(r.calls).toBe(1); expect(edit).not.toHaveBeenCalled();
    resolve(evidence(input, { score: 1 })); await Promise.resolve(); await Promise.resolve();
    expect(JSON.stringify(r)).toBe(receipt); expect(r.reportedUsd).toBe(1);
  });
  it('rejects a synchronously completed operation that blocked beyond its deadline', async () => {
    const o = options(); const r = await runContrastive({ ...o, budget: { ...o.budget, timeoutMs: 1 }, evaluator: { surfaceAware: true, probe: async i => {
      const until = performance.now() + 5; while (performance.now() < until) { /* bounded test */ }
      return evidence(i, { score: 1 });
    } } });
    expect(r.reason).toBe('timeout'); expect(r.outcome).toBe('baseline');
  });
  it('probes edited content with its matching digest before returning a development preference', async () => {
    const o = options(); const docs: string[] = [];
    const r = await runContrastive({ ...o, proposer: { propose: async i => propose(i) }, evaluator: { surfaceAware: true, probe: async i => {
      docs.push(JSON.stringify(i.candidate));
      return evidence(i, { appliedDigest: digestDocument(i.candidate), score: JSON.stringify(i.candidate).includes('better') ? 0.9 : 0.1 });
    } } });
    expect(docs.length).toBe(3); expect(docs.slice(1).every(x => x.includes('better'))).toBe(true);
    expect(r.outcome).toBe('candidate'); expect(r.candidateDigest).not.toBe(r.baselineDigest); expect(r.promotion).toBe('not-authorized');
  });
  it('rejects untested content invented by the composer', async () => {
    const o = options(); const probe = vi.fn(async (i: ProbeInput) => evidence(i, { score: i.candidateDigest === digestDocument(o.baseline) ? 0.1 : 0.8 }));
    const r = await runContrastive({ ...o, evaluator: { surfaceAware: true, probe }, proposer: { propose: async i => propose(i) }, composer: { compose: async i => ({ costUsd: 0.1, edits: [{ ...i.supportedEdits[0], content: 'invented' }] }) } });
    expect(r.outcome).toBe('baseline'); expect(probe).toHaveBeenCalledTimes(3); expect(r.receipts.at(-1)?.status).toBe('invalid');
  });
  it.each(['duplicate', 'unknown', 'empty-message', 'nonfinite-score', 'score-range'])('rejects malformed evidence: %s', async attack => {
    const o = options(); const edit = vi.fn(o.proposer.propose);
    const r = await runContrastive({ ...o, proposer: { propose: edit }, evaluator: { surfaceAware: true, probe: async i => {
      const out = evidence(i);
      if (attack === 'duplicate') return { ...out, observations: [out.observations[0], out.observations[0]] };
      if (attack === 'unknown') return { ...out, observations: [{ ...out.observations[0], componentId: 'absent' }] };
      if (attack === 'empty-message') return { ...out, observations: [{ ...out.observations[0], message: '' }] };
      return { ...out, score: attack === 'nonfinite-score' ? NaN : 2 };
    } } });
    expect(r.reason).toBe('invalid'); expect(r.outcome).toBe('baseline'); expect(edit).not.toHaveBeenCalled();
  });
  it('does not reuse probe evidence across tenant or task boundaries', async () => {
    const seen: string[] = []; const o = options();
    const probe = async (i: ProbeInput) => { seen.push(i.tenantId + ':' + JSON.stringify(i.task)); return evidence(i); };
    await runContrastive({ ...o, evaluator: { surfaceAware: true, probe } });
    await runContrastive({ ...o, tenantId: 'tenant-b', task: { prompt: 'Other task' }, library: { ...o.library, tenantId: 'tenant-b' }, evaluator: { surfaceAware: true, probe } });
    expect(seen).toEqual(['tenant-a:{"prompt":"Repair task"}', 'tenant-b:{"prompt":"Other task"}']);
  });
  async function savedExperience() {
    const o = options(); const result = await runContrastive({ ...o, proposer: { propose: async i => propose(i) }, evaluator: { surfaceAware: true, probe: async i => evidence(i, { score: i.candidateDigest === digestDocument(o.baseline) ? 0.1 : 0.9 }) } });
    const context = { tenantId: o.tenantId, projectId: o.projectId, environmentKey: 'executor-v1' };
    const library = rememberContrastiveExperience(o.library, { ...context, sourceTaskId: 'task-a', cue: 'repair parser', lesson: 'validate parser', result });
    return { library, context };
  }
  it('retains and retrieves scoped executed experiments without score fields', async () => {
    const { library, context } = await savedExperience();
    const found = retrieveContrastiveExperiences(library, { ...context, query: 'parser' });
    expect(found.entries).toHaveLength(1);
    expect(JSON.stringify(found)).not.toContain('selectedScore'); expect(JSON.stringify(found)).not.toContain('baselineScore');
    expect((found.entries[0] as any).promotion).toBe('not-authorized');
  });
  it.each(['selectedScore', 'verifierSecret', 'promotion', 'status'])('rejects contaminated persisted memory field %s', async key => {
    const { library, context } = await savedExperience();
    const changed = { ...library, entries: [{ ...library.entries[0] as object, [key]: key === 'selectedScore' ? 1 : 'not-allowed' }] };
    expect(retrieveContrastiveExperiences(changed, { ...context, query: 'parser' }).entries).toHaveLength(0);
  });
  it('rejects foreign memory namespaces and filters environment or digest drift', async () => {
    const { library, context } = await savedExperience();
    expect(() => retrieveContrastiveExperiences(library, { ...context, tenantId: 'tenant-b', query: 'parser' })).toThrow();
    expect(() => retrieveContrastiveExperiences(library, { ...context, projectId: 'project-b', query: 'parser' })).toThrow();
    expect(retrieveContrastiveExperiences(library, { ...context, environmentKey: 'executor-v2', query: 'parser' }).entries).toHaveLength(0);
    const changed = { ...library, entries: [{ ...library.entries[0] as object, candidateDigest: '0'.repeat(64) }] };
    expect(retrieveContrastiveExperiences(changed, { ...context, query: 'parser' }).entries).toHaveLength(0);
  });
  it('connects metered editors and charges executor usage rather than model assertions', async () => {
    const o = options(); const requests: any[] = [];
    const editors = createContrastiveEditors(async request => {
      requests.push(request); const scope = request.role === 'composer' ? 'domain' : request.role;
      const edits = request.role === 'composer' ? JSON.parse(request.prompt).supportedEdits : propose({ scope }).edits;
      return { text: JSON.stringify({ edits }), costUsd: 0.25 };
    });
    const r = await runContrastive({ ...o, ...editors, evaluator: { surfaceAware: true, probe: async i => evidence(i, { score: i.candidateDigest === digestDocument(o.baseline) ? 0.1 : 0.9 }) } });
    expect(requests.map(x => x.role)).toEqual(['invariant', 'domain', 'composer']);
    expect(requests.every(x => x.ceilingUsd === 1 && x.signal.aborted && Object.isFrozen(x))).toBe(true);
    expect(r.outcome).toBe('candidate'); expect(r.reportedUsd).toBeCloseTo(1.15); expect(r.promotion).toBe('not-authorized');
    expect(requests.every(x => !x.prompt.includes('baselineScore') && !x.prompt.includes('selectedScore'))).toBe(true);
  });
  it.each(['not json', '{"edits":[],"costUsd":0}', '{"edits":[{"componentId":"planner","content":{"__proto__":{"polluted":true}},"citations":["obs-planner"]}]}'])('fails closed and preserves charges for malicious editor JSON: %s', async body => {
    const o = options(); const execute = vi.fn(async () => ({ text: body, costUsd: 0.25 }));
    const r = await runContrastive({ ...o, ...createContrastiveEditors(execute) });
    expect(r.outcome).toBe('baseline'); expect(execute).toHaveBeenCalledTimes(1); expect(r.reservedUsd).toBe(2); expect(r.reportedUsd).toBeGreaterThanOrEqual(0.35); expect(({} as any).polluted).toBeUndefined();
  });
  it('fits seven decimal reservations exactly without an extra budget admission', async () => {
    const o = options(); const r = await runContrastive({ ...o,
      budget: { ...o.budget, maxUsd: 0.7, probeUsd: 0.1, proposeUsd: 0.1, composeUsd: 0.1 },
      proposer: { propose: async i => propose(i) }, composer: { compose: async i => ({ edits: i.supportedEdits, costUsd: 0.1 }) },
      evaluator: { surfaceAware: true, probe: async i => evidence(i, { score: i.candidateDigest === digestDocument(o.baseline) ? 0.1 : 0.9 }) },
    });
    expect(r.calls).toBe(7); expect(r.reservedUsd).toBe(0.7); expect(r.outcome).toBe('candidate');
  });
});
