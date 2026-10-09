// Child process for spend-secrets.test.mjs: provisionGpu with the REAL signal traps (installTraps: true) against the
// fake vastai/gcloud on PATH. Every journal event and watchdog launch/stop is appended to <log> as one JSON line.
//   node provision-child.mjs <stateDir> <pathEnv> <keyPath> <log>
import { appendFileSync } from 'node:fs';
import { DUMMY_KEY } from './shims.mjs';
import { provisionGpu } from '../../gpu.mjs';

const [stateDir, pathEnv, keyPath, log] = process.argv.slice(2);
const T0 = Date.parse('2026-10-09T12:00:00Z');
const j = e => appendFileSync(log, `${JSON.stringify(e)}\n`);
await provisionGpu({ runId: 'b1', stateDir, pathEnv, getKey: async () => DUMMY_KEY, installTraps: true, now: () => T0,
  sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 50))), journal: j,
  launch: async a => { j({ phase: 'WATCHDOG_LAUNCHED', instanceId: a.instanceId, label: a.label }); return { how: 'fake', stop() { j({ phase: 'WATCHDOG_STOPPED' }); } }; },
  config: { sshKeyPath: keyPath, destroyBackoffSec: 0.01 } });
j({ phase: 'PROVISION_RETURNED' });
