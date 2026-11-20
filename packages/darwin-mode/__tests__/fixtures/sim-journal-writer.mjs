// SPDX-License-Identifier: MIT
// Independent writer process for sim-journal multi-process tests.
// argv: <distModule> <journalPath> <prefix> <count> [crashAfter|-] [holdMs]
// Prints "LOCKED", then exits 3 when another writer holds the lease; prints "ACK <id>"
// only after append() resolves (fsynced). With crashAfter=N, SIGKILLs itself
// halfway through writing record N+1.
const [, , distModule, file, prefix, count, crashAfter, holdMs] = process.argv;
const { SimJournal } = await import(distModule);
const crashAt = crashAfter === undefined || crashAfter === "-" ? -1 : Number(crashAfter);
let index = 0;
const journal = new SimJournal(file, {
  faults: crashAt < 0 ? {} : {
    afterPartialWrite() { if (index === crashAt) process.kill(process.pid, 'SIGKILL'); },
  },
});
const row = (id) => ({
  id, createdAt: '2026-11-20T00:00:00.000Z',
  scope: { ownerId: 'tenant-a', repoId: 'repo-a', interfaceId: 'v1', modelId: 'model-a', benchmarkId: 'benchmark-a', harnessVersion: 'v1' },
  problemKey: 'retry', diagnosis: 'timeout', variantId: 'v-' + id, parentId: 'baseline',
  mutationSurface: 'retryPolicy', rationale: 'multi-process lease test',
  predictedDelta: null, observedDelta: 0.01, finalScore: 0.51, promoted: true, evidenceIds: ['archive:' + id],
});
try {
  for (index = 0; index < Number(count); index++) {
    const id = `${prefix}-${index}`;
    await journal.append(row(id));
    process.stdout.write(`ACK ${id}\n`);
  }
  if (holdMs) { process.stdout.write("HOLDING\n"); await new Promise((r) => setTimeout(r, Number(holdMs))); }
  await journal.close();
} catch (error) {
  if (error?.code === 'SIM_JOURNAL_LOCKED') { process.stdout.write('LOCKED\n'); process.exit(3); }
  process.stderr.write(String(error?.stack ?? error) + '\n');
  process.exit(1);
}
