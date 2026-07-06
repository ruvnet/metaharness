// $0 STUB solver for the structural-capability-lever test. Echoes the capability flags it ACTUALLY
// received on argv (in order) as each prediction's model_patch, so the test can assert the allowlisted
// flags reached the solver — and that non-allowlisted junk never did. No network, no repo, no model.
import { readFileSync, writeFileSync } from 'node:fs';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const KNOWN = ['--repro-gate', '--reviewer']; // the only structural flags the real agentic solver reads
const received = process.argv.filter((a) => KNOWN.includes(a)).join(' ');
const instances = JSON.parse(readFileSync(arg('--manifest'), 'utf-8')).instances;
const lines = instances.map((it) => JSON.stringify({ instance_id: it.instance_id, model_name_or_path: 'stub', model_patch: received }));
writeFileSync(arg('--out'), lines.join('\n') + '\n');
writeFileSync(arg('--report'), JSON.stringify({ totalCost: 0, n: instances.length }));
