// SPDX-License-Identifier: MIT
// Source-checkout benchmark only. Import the narrow Darwin build artifact to
// avoid initializing the rest of the harness or adding a solver dependency.
import { NumericArchive } from '../../darwin-mode/dist/numeric-archive.js';

/** Measured trials are independent proposals. Darwin resolves ties by insertion order. */
export function createLedger() {
  // NumericArchive touches the filesystem only when load() or save() is called.
  const archive = new NumericArchive('archive.json');
  return {
    append({ config, loss, trial }) {
      if (!Number.isSafeInteger(trial) || trial < 0 || !Number.isFinite(loss)) {
        throw new RangeError('A trial needs a nonnegative integer ID and a finite loss');
      }
      const id = `trial-${trial}`;
      if (archive.get(id)) throw new Error(`Duplicate trial ID: ${trial}`);
      archive.addVariant({
        id, parentId: null, generation: trial, genome: { ...config },
        mutatedParams: [], mutationSummary: 'Measured energy solver configuration',
        createdAt: new Date().toISOString(),
      });
      archive.setScore(id, {
        variantId: id, primary: -loss, regressed: false, noopRate: 0,
        costPerWin: 0, raw: { loss, trial },
      });
    },
    best() {
      const record = archive.best();
      if (!record) return null;
      return { config: { ...record.variant.genome }, ...record.score.raw };
    },
  };
}
