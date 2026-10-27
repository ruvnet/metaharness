// Offline verification only. No model requests, secret reads, archive extraction or generated code execution.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyReplayBundle } from '../dist/index.js';
import { completionGate } from './live-openrouter-rewrite.mjs';

const archive = process.argv[2];
if (!archive) throw Error('usage: node verify-live-rewrite-evidence.mjs <evidence.zip>');
const decoded = execFileSync('python3', ['-c',
  'import sys,zipfile,json; z=zipfile.ZipFile(sys.argv[1]); assert len(z.infolist())<=256 and sum(i.file_size for i in z.infolist())<=2000000; print(json.dumps({i.filename:z.read(i).decode() for i in z.infolist()}))', archive],
  {encoding:'utf8',maxBuffer:3_000_000,timeout:5000});
const files = JSON.parse(decoded);
let bundles = 0, artifacts = 0, calls = 0, promotions = 0;
for (const prefix of ['run-1','run-2']) {
  const evidence = JSON.parse(files[`${prefix}/evidence.json`]);
  const ledger = JSON.parse(files[`${prefix}/calls.json`]);
  calls += ledger.length;
  for (const entry of ledger) {
    if (entry.status !== 'completed') throw Error('incomplete model call');
    if (entry.artifact) {
      if (!entry.artifact.startsWith('artifacts/') || entry.artifact.includes('..')) throw Error('artifact path');
      const source = files[`${prefix}/${entry.artifact}`];
      if (typeof source !== 'string' || createHash('sha256').update(source).digest('hex') !== entry.sourceDigest)
        throw Error('artifact digest mismatch');
      artifacts++;
    }
  }
  for (const family of evidence.families) {
    if (!family.promotion) continue;
    const record = family.promotion;
    if (![...record.bundle.chain,...record.bundle.all_commits].every(c => c.receipt.publicKey === record.trustedSignerPublicKey))
      throw Error('signer mismatch');
    if (!verifyReplayBundle(record.bundle,{promotionRule:completionGate}).pass) throw Error('bundle replay failed');
    promotions += record.bundle.all_commits.filter(c=>c.verdict==='PROMOTED').length;
    bundles++;
  }
}
console.log(JSON.stringify({verified:true,bundles,artifacts,calls,promotions,
  scope:'Receipt consistency and retained artifact hashes; not environment attestation or LLM capability proof.'},null,2));
