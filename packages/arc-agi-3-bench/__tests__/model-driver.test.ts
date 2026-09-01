import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FileBrokerModelDriver,
  MAX_FILE_BROKER_RESPONSE_BYTES,
  MeteredModelDriver,
  validateModelTurnResponse,
} from '../src/model-driver.js';
import type { ModelDriver, ModelTurnRequest } from '../src/types.js';

const PLAN_REQUEST: ModelTurnRequest = Object.freeze({
  schema: 'metaharness.arc_agi_3.model_turn.v1',
  requestId: 'turn_00000000000000000000000000000000',
  kind: 'PLAN',
  arm: 'direct',
  opaqueTaskHandle: 'task_00000000000000000000000000000000',
  episodeSeed: 11,
  turnIndex: 0,
  availableActions: ['ACTION1'],
  purpose: 'test',
});

function validPlanResponse(): Record<string, unknown> {
  return {
    schema: 'metaharness.arc_agi_3.model_turn_response.v1',
    requestId: PLAN_REQUEST.requestId,
    candidateActions: [{
      action: { name: 'ACTION1' },
      hypothesis: 'test the offered action',
      confidence: 0.5,
    }],
    latencyMs: 1,
    usage: { inputUnits: 1, outputUnits: 1, reasoningUnits: 1 },
  };
}

describe('model response boundary', () => {
  it('rejects extra, wrong-kind, nonfinite, malformed usage, and accessor data', () => {
    expect(() => validateModelTurnResponse({ ...validPlanResponse(), extra: true }, PLAN_REQUEST))
      .toThrow(/exact schema/);
    expect(() => validateModelTurnResponse({ ...validPlanResponse(), reflection: 'wrong kind' }, PLAN_REQUEST))
      .toThrow(/exact schema/);
    expect(() => validateModelTurnResponse({
      ...validPlanResponse(),
      modelReceipt: { provider: 'unverified' },
    }, PLAN_REQUEST)).toThrow(/exact schema/);
    expect(() => validateModelTurnResponse({ ...validPlanResponse(), latencyMs: Infinity }, PLAN_REQUEST))
      .toThrow(/latencyMs/);
    expect(() => validateModelTurnResponse({
      ...validPlanResponse(),
      usage: { inputUnits: Number.NaN, outputUnits: 1, reasoningUnits: 1 },
    }, PLAN_REQUEST)).toThrow(/inputUnits/);
    expect(() => validateModelTurnResponse({
      ...validPlanResponse(),
      usage: { inputUnits: -1, outputUnits: 1, reasoningUnits: 1 },
    }, PLAN_REQUEST)).toThrow(/inputUnits/);
    expect(() => validateModelTurnResponse({
      ...validPlanResponse(),
      usage: { inputUnits: 1, outputUnits: 1, reasoningUnits: 1, tokens: 3 },
    }, PLAN_REQUEST)).toThrow(/exact schema/);

    let accessed = false;
    const accessorResponse = validPlanResponse();
    Object.defineProperty(accessorResponse, 'requestId', {
      enumerable: true,
      get() {
        accessed = true;
        return PLAN_REQUEST.requestId;
      },
    });
    expect(() => validateModelTurnResponse(accessorResponse, PLAN_REQUEST)).toThrow(/exact schema/);
    expect(accessed).toBe(false);
  });

  it('charges an invalid dispatched response to the frozen turn budget', async () => {
    const invalid: ModelDriver = {
      id: 'invalid',
      latencySource: 'wall-clock',
      async turn() {
        return { ...validPlanResponse(), extra: true } as never;
      },
    };
    const metered = new MeteredModelDriver(invalid, 1);
    await expect(metered.turn(PLAN_REQUEST)).rejects.toThrow(/exact schema/);
    expect(metered.summary()).toMatchObject({
      turnCount: 1,
      failedTurnCount: 1,
      usageComplete: false,
    });
    await expect(metered.turn({ ...PLAN_REQUEST, turnIndex: 1 })).rejects.toThrow(/budget exhausted/);
  });

  it('round-trips a typed response through the provider-neutral file broker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arc-file-broker-'));
    try {
      const broker = new FileBrokerModelDriver({
        directory,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      });
      const pending = broker.turn(PLAN_REQUEST);
      let names: string[] = [];
      for (let attempt = 0; attempt < 100 && names.length === 0; attempt += 1) {
        try {
          // The broker writes `<id>.json.partial` and then renames it, so a bare
          // "directory is non-empty" poll can observe the temporary name and exit
          // early. Wait for the settled file, or this races on slower filesystems
          // (seen failing on ubuntu/windows CI while passing locally and on macOS).
          names = (await readdir(join(directory, 'requests'))).filter(
            name => !name.endsWith('.partial'),
          );
        } catch {
          // The broker creates the directory asynchronously.
        }
        if (names.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(names).toEqual([`${PLAN_REQUEST.requestId}.json`]);
      const serialized = await readFile(join(directory, 'requests', names[0]!), 'utf8');
      expect(serialized).toContain(PLAN_REQUEST.opaqueTaskHandle);
      const partial = join(directory, 'responses', `${names[0]!}.partial`);
      await writeFile(
        partial,
        `${JSON.stringify(validPlanResponse())}\n`,
      );
      await rename(partial, join(directory, 'responses', names[0]!));
      await expect(pending).resolves.toMatchObject({ requestId: PLAN_REQUEST.requestId });
      expect(await readdir(join(directory, 'archive'))).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an oversized broker response using a bounded read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arc-file-broker-oversized-'));
    try {
      const broker = new FileBrokerModelDriver({
        directory,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      });
      const pending = broker.turn(PLAN_REQUEST);
      let names: string[] = [];
      for (let attempt = 0; attempt < 100 && names.length === 0; attempt += 1) {
        try {
          names = await readdir(join(directory, 'requests'));
        } catch {
          // The broker creates the directory asynchronously.
        }
        if (names.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(names).toEqual([`${PLAN_REQUEST.requestId}.json`]);
      const finalPath = join(directory, 'responses', names[0]!);
      const partialPath = `${finalPath}.partial`;
      await writeFile(partialPath, Buffer.alloc(MAX_FILE_BROKER_RESPONSE_BYTES + 1, 0x61));
      await rename(partialPath, finalPath);
      await expect(pending).rejects.toThrow(/exceeds 262144 bytes/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
