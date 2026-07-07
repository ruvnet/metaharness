// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LensArtifact, WorkspaceLensReceipt } from '@metaharness/workspace-lens';
import { runCli } from '../src/cli.js';

// dModel=3; J(layer 5)=identity; unembed maps component → token; so h=[0,0,5] → "wrong".
const LENS: LensArtifact = {
  lensId: 'jlens-synth-v1', modelId: 'synth-3d', dModel: 3,
  vocab: ['yes', 'no', 'wrong', 'right', 'secret'],
  unembed: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 0, 0]],
  layers: [{ layer: 5, jacobian: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }],
};
function receipt(over: Partial<WorkspaceLensReceipt> = {}): WorkspaceLensReceipt {
  return {
    promptHash: 'h', modelId: 'm', lensId: 'l', layerRange: [5, 5], positions: [0], topTokens: [],
    entropyTrajectory: [], createdAt: '2026-07-07T00:00:00Z',
    flags: { promptInjection: false, evalAwareness: false, hiddenObjective: false, refusalConflict: false },
    triggers: [], workspaceDrift: 0.1, ...over,
  };
}
const critTrigger = { concept: 'exfiltration', layer: 5, position: 0, score: 0.9, critical: true };

// Capture stdout JSON.
function captureStdout(): { readonly text: () => string; restore: () => void } {
  let buf = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { buf += s.toString(); return true; });
  return { text: () => buf, restore: () => spy.mockRestore() };
}

async function tmpJson(name: string, data: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wp-cli-'));
  const p = join(dir, name);
  await writeFile(p, JSON.stringify(data));
  return p;
}

afterEach(() => vi.restoreAllMocks());

describe('workspace-probe CLI', () => {
  it('diag prints lens metadata', async () => {
    const lensPath = await tmpJson('lens.json', LENS);
    const cap = captureStdout();
    const code = await runCli(['diag', lensPath]);
    cap.restore();
    expect(code).toBe(0);
    const j = JSON.parse(cap.text());
    expect(j).toMatchObject({ modelId: 'synth-3d', lensId: 'jlens-synth-v1', dModel: 3, layers: [5], vocabSize: 5 });
  });

  it('readout decodes activations to workspace tokens', async () => {
    const lensPath = await tmpJson('lens.json', LENS);
    const actPath = await tmpJson('act.json', [{ layer: 5, position: 3, h: [0, 0, 5] }]);
    const cap = captureStdout();
    const code = await runCli(['readout', lensPath, actPath, '--top-k', '3']);
    cap.restore();
    expect(code).toBe(0);
    const j = JSON.parse(cap.text());
    expect(j[0].tokens[0].token).toBe('wrong');
  });

  it('probe scores a receipt set', async () => {
    const rPath = await tmpJson('r.json', [receipt(), receipt({ triggers: [critTrigger] })]);
    const cap = captureStdout();
    const code = await runCli(['probe', rPath]);
    cap.restore();
    expect(code).toBe(0);
    const j = JSON.parse(cap.text());
    expect(j.n).toBe(2);
    expect(j.criticalRate).toBeCloseTo(0.5);
  });

  it('grade-mutation vetoes a workspace-degrading mutation', async () => {
    const base = await tmpJson('b.json', [receipt(), receipt()]);
    const mut = await tmpJson('m.json', [receipt({ triggers: [critTrigger] }), receipt()]);
    const cap = captureStdout();
    const code = await runCli(['grade-mutation', base, mut]);
    cap.restore();
    expect(code).toBe(0);
    const j = JSON.parse(cap.text());
    expect(j.keep).toBe(false);
  });

  it('exits 2 on missing args and 0 on --help; 2 on unknown command', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runCli(['diag'])).toBe(2);
    expect(await runCli(['bogus'])).toBe(2);
    errSpy.mockRestore();
    const cap = captureStdout();
    expect(await runCli(['--help'])).toBe(0);
    cap.restore();
    expect(cap.text()).toMatch(/Usage:/);
  });

  it('exits 1 on a runtime error (unreadable file)', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runCli(['diag', '/no/such/lens.json']);
    errSpy.mockRestore();
    expect(code).toBe(1);
  });
});
