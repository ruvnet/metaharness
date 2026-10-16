import assert from 'node:assert/strict';
import { digestDocument } from '../../dist/contrastive/index.js';
import { BASELINE, clone, grade, observations } from './fixtures.mjs';

/**
 * A deterministic, offline adapter example. The evaluator closes over development
 * answers; neither proposer nor composer receives answer records or holdout rows.
 * This is callback separation in one trusted process, not a security sandbox.
 */
export function createSyntheticOptions(development, { noop = false, maxCalls = 7 } = {}) {
  const count = { probe: 0, propose: 0, compose: 0, executedRows: 0 };
  const options = {
    tenantId: 'benchmark', projectId: 'contrastive-invoice',
    baseline: clone(BASELINE),
    task: { kind: 'synthetic-invoice-extraction',
      description: 'Extract exact label, cents and currency from pipe-delimited invoices.',
      inputs: development.map(({ id, input }) => ({ id, input })) },
    environment: { parserVersion: 1, evaluatorVersion: 1 },
    library: { tenantId: 'benchmark', projectId: 'contrastive-invoice', entries: [] },
    envelope: { network: false, shell: false, promotion: false },
    budget: { maxUsd: 0, maxCalls, timeoutMs: 2000,
      probeUsd: 0, proposeUsd: 0, composeUsd: 0 },
    evaluator: {
      surfaceAware: true,
      async probe(input) {
        count.probe++;
        count.executedRows += development.length;
        // Bind evidence to the configuration actually passed to the interpreter.
        assert.equal(input.candidateDigest, digestDocument(input.candidate));
        const measured = grade(input.candidate, development);
        return { appliedDigest: digestDocument(input.candidate),
          score: measured.score,
          observations: observations(input.candidate, development, measured.failed), costUsd: 0 };
      },
    },
    proposer: {
      async propose(input) {
        count.propose++;
        assert.equal('score' in input, false);
        assert.equal(JSON.stringify(input).includes('"expected"'), false);
        const id = input.scope === 'invariant' ? 'split' : 'amount';
        const evidence = input.observations.filter(x => x.componentId === id);
        if (!evidence.length) return { edits: [], costUsd: 0 };
        const content = noop ? clone(BASELINE.components.find(x => x.id === id).content)
          : id === 'split' ? { quoted: true } : { decimalComma: true };
        return { edits: [{ componentId: id, content,
          citations: evidence.map(x => x.id) }], costUsd: 0 };
      },
    },
    composer: {
      async compose(input) {
        count.compose++;
        assert.equal('score' in input, false);
        return { edits: clone(input.supportedEdits), costUsd: 0 };
      },
    },
  };
  return { options, count };
}
