// SPDX-License-Identifier: MIT
// Regenerates the cross-repo SIM handoff v2 fixture (issue #524).
//
//   npm run build -w @metaharness/darwin
//   node packages/darwin-mode/bench/sim-handoff-fixture.mjs [outDir]
//
// Builds real SimMemory records for two tenants, signs each tenant's handoff
// with a FRESH throwaway Ed25519 key, and writes only the signed envelopes and
// PUBLIC keys. The private keys are never written, so the fixture cannot be
// used to forge new evidence. Copy the output directory verbatim to
// ruflo: v3/@claude-flow/cli/__tests__/fixtures/sim-handoff-v2/ to keep both
// repositories in lockstep.
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimMemory, signedRufloHandoff, simKeyId } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, '..', '__tests__', 'fixtures', 'sim-handoff-v2'));
const createdAt = new Date('2026-11-20T00:00:00.000Z');

const tenants = [
  { name: 'a', owner: 'tenant-a', repo: 'ruvnet/metaharness', problem: 'retry-loop', diagnosis: 'Retried a failing tool call without changing inputs' },
  { name: 'b', owner: 'tenant-b', repo: 'ruvnet/metaharness', problem: 'early-stop', diagnosis: 'Stopped before running the verification command' },
];

const work = await mkdtemp(join(tmpdir(), 'sim-handoff-fixture-'));
const trustedKeys = [];
try {
  await mkdir(outDir, { recursive: true });
  for (const t of tenants) {
    const scope = {
      ownerId: t.owner, repoId: t.repo, interfaceId: 'darwin-v1',
      modelId: 'fixture-model', benchmarkId: 'public-training-suite-v1', harnessVersion: '0.14.0',
    };
    const memory = new SimMemory(join(work, t.name + '.json'));
    const base = {
      createdAt: '2026-11-19T12:00:00.000Z', scope, problemKey: t.problem, diagnosis: t.diagnosis,
      parentId: 'baseline', mutationSurface: 'retryPolicy', predictedDelta: null, evidenceIds: [],
    };
    await memory.append({ ...base, id: t.name + '-fail', variantId: t.name + '-v1', rationale: 'First attempt regressed', observedDelta: -0.05, finalScore: 0.41, promoted: false, evidenceIds: ['archive:' + t.name + '-v1'] });
    await memory.append({ ...base, id: t.name + '-win', variantId: t.name + '-v2', rationale: 'Change inputs before retrying', observedDelta: 0.04, finalScore: 0.5, promoted: true, evidenceIds: ['archive:' + t.name + '-v2'] });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const envelope = await signedRufloHandoff(
      memory,
      { scope, query: t.problem + ' ' + t.diagnosis, mode: 'full', maxTokens: 1000 },
      { privateKey, createdAt, lifetimeMs: 30 * 24 * 3600 * 1000, retentionDays: 30 },
    );
    await writeFile(join(outDir, 'envelope-' + t.name + '.json'), JSON.stringify(envelope, null, 2) + '\n');
    trustedKeys.push({
      keyId: simKeyId(publicKey),
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      tenants: [t.owner + '/' + t.repo],
    });
  }
  await writeFile(join(outDir, 'trusted-keys.json'), JSON.stringify({
    note: 'Public keys only. Private keys were discarded after signing. Verify with now = 2026-11-20T01:00:00.000Z.',
    verifyAt: '2026-11-20T01:00:00.000Z',
    keys: trustedKeys,
  }, null, 2) + '\n');
  console.log('wrote', outDir);
} finally {
  await rm(work, { recursive: true, force: true });
}
