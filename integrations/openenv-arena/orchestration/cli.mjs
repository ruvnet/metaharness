#!/usr/bin/env node
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openWorkflow, actionFor } from './runtime.mjs';

const [command, input, journal = '.arena/workflow.db'] = process.argv.slice(2);
const commands = { validate: 'arena.validate_plan', calibrate: 'arena.calibrate', review: 'arena.review' };
if (!commands[command] || !input) {
  console.error('Usage: node orchestration/cli.mjs validate|calibrate|review input.json [journal.db]');
  process.exit(2);
}
let runtime;
try {
  const payload = JSON.parse(readFileSync(input, 'utf8'));
  const dbPath = resolve(journal);
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const rollbackManifest = process.env.ARENA_ROLLBACK_MANIFEST
    ? JSON.parse(readFileSync(process.env.ARENA_ROLLBACK_MANIFEST, 'utf8')) : undefined;
  runtime = await openWorkflow({ dbPath,
    allowedCapabilities: (process.env.ARENA_CAPABILITIES ?? '').split(',').filter(Boolean),
    allowLocalSelection: process.env.ARENA_ENABLE_LOCAL_SELECTION === '1', rollbackManifest });
  const action = actionFor(commands[command], payload);
  const queued = runtime.enqueue(action);
  if (queued) await runtime.step();
  const job = runtime.store.job(action.id);
  const result = runtime.store.db.prepare('SELECT result FROM jobs WHERE id=?').get(action.id)?.result;
  console.log(JSON.stringify({ queued, jobStatus: job.status, reason: job.reason,
    result: result ? JSON.parse(result) : null, runtime: runtime.status() }, null, 2));
  if (job.status !== 'succeeded' || (result && JSON.parse(result).accepted === false)) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { runtime?.close(); }
