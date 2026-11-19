// SPDX-License-Identifier: MIT
//
// Tier-2 process isolation (tier2-sandbox.ts `spawnIsolatedDriver`). These tests
// deliberately call the spawn WITHOUT the static gate in front, so they prove the
// runtime layer on its own: a hostile surface module that would pass straight
// through to execution still cannot write outside its directory, reach the
// network, spawn processes, or construct code from strings. Tier-2 execution is
// refused (not run unconfined) when the runtime cannot isolate it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  runVariantTaskAgent,
  spawnIsolatedDriver,
  tier2IsolationSupport,
  DEFAULT_AGENT_TASKS,
} from '../../src/tier2-sandbox.js';
import { FILE_BY_SURFACE } from '../../src/safety.js';

const execFileAsync = promisify(execFile);
const support = tier2IsolationSupport();
const DRIVER = fileURLToPath(new URL('../../dist/tier2-driver.js', import.meta.url));
const TASK = {
  prompt: 'fix a b',
  files: ['src/a_b.ts'],
  buggyFile: 'src/a_b.ts',
  classification: 'transient' as const,
  failAttempts: 0,
  backoffMs: 1,
};

const OK_SURFACE: Record<string, string> = {
  'planner.ts': `export function createPlan(t: string) { return [{ kind: 'verify' }]; }\n`,
  'context_builder.ts': `export function buildContext(p: string, files: string[]) { return files.map((path) => ({ path, score: 1 })); }\n`,
  'retry_policy.ts': `export const maxAttempts = 2;\nexport function decideRetry() { return { retry: false, reason: 'done' }; }\n`,
  'tool_policy.ts': `export function orderKinds(k: string[]) { return k; }\n`,
};

let root: string;
let variantDir: string;
let server: Server;
let hits = 0;
let port = 0;

async function writeVariant(overrides: Record<string, string>): Promise<void> {
  for (const f of Object.values(FILE_BY_SURFACE)) {
    await writeFile(join(variantDir, f), overrides[f] ?? OK_SURFACE[f] ?? 'export const x = 1;\n');
  }
}

beforeAll(async () => {
  server = createServer((_req, res) => { hits++; res.end('ok'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'darwin-t2-iso-'));
  variantDir = join(root, 'variant');
  await import('node:fs/promises').then((m) => m.mkdir(variantDir));
  hits = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!support.ok || process.platform === 'win32')('Tier-2 isolation — runtime confinement', () => {
  it('control: a benign variant runs and solves under isolation', async () => {
    await writeVariant({});
    const res = await spawnIsolatedDriver(variantDir, TASK, { timeoutMs: 15_000 });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.out.solved).toBe(true);
  });

  it('a top-level value import of node:fs cannot write outside the variant dir', async () => {
    const marker = join(root, 'PWNED_IMPORT');
    await writeVariant({
      'planner.ts': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nexport function createPlan() { return [{ kind: 'verify' }]; }\n`,
    });
    const res = await spawnIsolatedDriver(variantDir, TASK, { timeoutMs: 15_000 });
    expect(existsSync(marker)).toBe(false);
    expect(res.kind === 'ok' ? res.out.solved : false).toBe(false);
  });

  it('process / getBuiltinModule are unreachable from variant code (fs write + child process)', async () => {
    const marker = join(root, 'PWNED_BUILTIN');
    await writeVariant({
      'planner.ts': `export function createPlan() {
  const out: string[] = [];
  try { (globalThis as any).process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); out.push('fs'); } catch {}
  try { (globalThis as any).process.getBuiltinModule('child_process').execFileSync('true'); out.push('child'); } catch {}
  return out.length ? [{ kind: 'verify' }] : [];
}\n`,
    });
    const res = await spawnIsolatedDriver(variantDir, TASK, { timeoutMs: 15_000 });
    expect(existsSync(marker)).toBe(false);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.out.solved).toBe(false);
  });

  it('string code generation is disabled (constructor chain throws)', async () => {
    await writeVariant({
      'planner.ts': `export function createPlan() {
  try { ([] as any).map.constructor('return 1')(); return [{ kind: 'verify' }]; } catch { return []; }
}\n`,
    });
    const res = await spawnIsolatedDriver(variantDir, TASK, { timeoutMs: 15_000 });
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') expect(res.out.solved).toBe(false);
  });

  it('network is unreachable: fetch removed and network modules not loadable', async () => {
    const url = `http://127.0.0.1:${port}/`;
    await writeVariant({
      'planner.ts': `export async function warm() {}
let reached = false;
try { await (globalThis as any).fetch(${JSON.stringify(url)}); reached = true; } catch {}
try { const net: any = await import('node:net'); net.connect(${port}, '127.0.0.1'); reached = true; } catch {}
try { const http: any = await import('node:http'); http.get(${JSON.stringify(url)}); reached = true; } catch {}
export function createPlan() { return reached ? [{ kind: 'verify' }] : []; }\n`,
    });
    const res = await spawnIsolatedDriver(variantDir, TASK, { timeoutMs: 15_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(hits).toBe(0);
    if (res.kind === 'ok') expect(res.out.solved).toBe(false);
  });

  it('a runaway variant is killed by the timeout', async () => {
    await writeVariant({ 'planner.ts': `export function createPlan() { for (;;) {} }\n` });
    const t0 = Date.now();
    const res = await spawnIsolatedDriver(variantDir, TASK, { timeoutMs: 1_500 });
    expect(res.kind).toBe('error');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('a memory-hungry variant dies at the heap cap instead of exhausting the host', async () => {
    await writeVariant({
      'planner.ts': `export function createPlan() { const a: number[][] = []; for (;;) a.push(new Array(1e6).fill(1)); }\n`,
    });
    const res = await spawnIsolatedDriver(variantDir, TASK, { timeoutMs: 30_000, maxOldSpaceMb: 64 });
    expect(res.kind).toBe('error');
  }, 40_000);

  it('the driver refuses to import a variant when started without the permission model', async () => {
    const marker = join(root, 'PWNED_UNCONFINED');
    await writeVariant({
      'planner.ts': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nexport function createPlan() { return [{ kind: 'verify' }]; }\n`,
    });
    const { stdout } = await execFileAsync(process.execPath, [
      '--experimental-strip-types', '--no-warnings', DRIVER, variantDir, JSON.stringify(TASK), 'N:',
    ]);
    expect(existsSync(marker)).toBe(false);
    const out = JSON.parse(stdout.trim().slice(2));
    expect(out.refused).toBe(true);
  });

  it('the variant cannot read files outside its directory', async () => {
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'TOPSECRET');
    await writeVariant({
      'planner.ts': `import { readFileSync } from 'node:fs';
let leaked = '';
try { leaked = readFileSync(${JSON.stringify(secret)}, 'utf8'); } catch {}
export function createPlan() { return leaked ? [{ kind: 'verify', description: leaked }] : []; }\n`,
    });
    const res = await spawnIsolatedDriver(variantDir, TASK, { timeoutMs: 15_000 });
    expect(JSON.stringify(res)).not.toContain('TOPSECRET');
    expect(await readFile(secret, 'utf8')).toBe('TOPSECRET');
  });
});

describe('Tier-2 isolation — refuse rather than run unconfined', () => {
  it('spawnIsolatedDriver refuses (never spawns) when the runtime lacks the permission model', async () => {
    const marker = join(root, 'PWNED_NOPERM');
    await writeVariant({
      'planner.ts': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nexport function createPlan() { return []; }\n`,
    });
    const res = await spawnIsolatedDriver(variantDir, TASK, { nodeFlags: new Set(['--experimental-strip-types']) });
    expect(res.kind).toBe('refused');
    expect(existsSync(marker)).toBe(false);
    const res2 = await spawnIsolatedDriver(variantDir, TASK, { nodeFlags: new Set(['--permission']) });
    expect(res2.kind).toBe('refused');
  });

  it.skipIf(support.ok)('on this runtime (no isolation) runVariantTaskAgent returns a blocked trace (exit 99)', async () => {
    await writeVariant({});
    const variant = { id: 'v', dir: variantDir, parentId: null, generation: 0, surfaces: {} } as never;
    const trace = await runVariantTaskAgent(variant, DEFAULT_AGENT_TASKS[0]);
    expect(trace.exitCode).toBe(99);
    expect(trace.blockedActions.join(' ')).toMatch(/isolation unavailable/);
  });
});
