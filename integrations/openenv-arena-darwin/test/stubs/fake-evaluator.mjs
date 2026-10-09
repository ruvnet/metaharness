// TEST STUB ONLY — stands in for evaluator.mjs to exercise run-darwin's
// ShellEvaluator path (stdin genome -> stdout NumericScoreCard) without any
// runner, model or GPU. Appends one JSON line per call to --log so tests can
// check the per-evaluation --max-new-cells allowance and flag passthrough.
//   --cells <path>  cells module (contract lib/cells.mjs)
//   --mode ok|bad   bad = emit an out-of-domain scorecard (noopRate 2)
//   --attempted N   report raw.attemptedNewCells = N (0 simulates an all-cache-hit evaluation)
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { mockScoreCells } from '../../lib/mock-evaluator.mjs';

const { values } = parseArgs({ strict: false, options: {
  cells: { type: 'string' }, log: { type: 'string' }, mode: { type: 'string' }, attempted: { type: 'string' },
  'max-new-cells': { type: 'string' }, 'dry-run': { type: 'boolean' } } });
const input = JSON.parse(readFileSync(0, 'utf8'));
const cells = await import(pathToFileURL(values.cells).href);
const card = mockScoreCells(cells.genomeToCells(input.genome), input.variantId);
if (values.mode === 'bad') card.noopRate = 2;
if (values.mode === 'failclosed') { // the lib/fitness.mjs failClosed shape evaluator.mjs emits
  Object.assign(card, { primary: -1, regressed: true, noopRate: 1, costPerWin: 1e12, evaluatorError: 'stub_refusal',
    raw: { evaluatorError: 'stub_refusal' } });
}
if (values.attempted !== undefined) card.raw.attemptedNewCells = Number(values.attempted);
appendFileSync(values.log, `${JSON.stringify({ variantId: input.variantId, maxNewCells: Number(values['max-new-cells']),
  dryRun: values['dry-run'] === true, argv: process.argv.slice(2) })}\n`);
process.stderr.write(`fake-evaluator: scored ${input.variantId}\n`);
process.stdout.write(JSON.stringify(card));
