// $0 STUB solver for the D1-S3 CLI-plumbing test — a stand-in for solve.mjs. Reads the same args
// (--manifest/--out/--report) and the SWE_POLICY_SYSTEM env seam, then writes canned predictions with
// NO network / no repo clone / no model. A synthetic instance carries a `difficulty`; it "resolves"
// (non-empty patch) iff the policy quality (count of '#' in SWE_POLICY_SYSTEM) ≥ difficulty — so a
// better policy commits more, mirroring the real solver's behavior for the plumbing test.
import { readFileSync, writeFileSync } from 'node:fs';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const instances = JSON.parse(readFileSync(arg('--manifest'), 'utf-8')).instances;
const quality = (process.env.SWE_POLICY_SYSTEM || '').split('#').length - 1;
const out = arg('--out'), report = arg('--report');
const lines = instances.map((it) => {
  const patch = quality >= (it.difficulty ?? 1) ? `--- a\n+++ b\n@@ ${it.instance_id}` : '';
  return JSON.stringify({ instance_id: it.instance_id, model_name_or_path: 'stub', model_patch: patch });
});
writeFileSync(out, lines.join('\n') + '\n');
writeFileSync(report, JSON.stringify({ totalCost: instances.length * 0.01, n: instances.length }));
