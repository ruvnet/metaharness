// SPDX-License-Identifier: MIT

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MAX_PYTHON_BRIDGE_LINE_BYTES,
  MAX_PYTHON_BRIDGE_TIMEOUT_MS,
  PythonArcBridge,
  type PythonArcBridgeOptions,
  type PythonBridgeChild,
  type PythonBridgeChildFactory,
  type PythonBridgeSpawnOptions,
} from '../src/python-bridge.js';

interface FakeRequest {
  readonly id: number;
  readonly op: string;
  readonly params: Record<string, unknown>;
}

type FakeHandler = (request: FakeRequest, child: FakePythonProcess) => void | Promise<void>;

class FakePythonProcess extends EventEmitter implements PythonBridgeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: FakeRequest[] = [];
  readonly killSignals: Array<NodeJS.Signals | number> = [];
  killed = false;

  #buffer = '';
  #exited = false;

  constructor(handler: FakeHandler) {
    super();
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.#buffer += chunk.toString();
      while (true) {
        const newline = this.#buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        const request = JSON.parse(line) as FakeRequest;
        this.requests.push(request);
        void Promise.resolve(handler(request, this)).catch((error: unknown) => {
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
        });
      }
    });
  }

  respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  }

  respondError(id: number, code: string, message: string): void {
    this.stdout.write(`${JSON.stringify({ id, ok: false, error: { code, message } })}\n`);
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.#exited) return false;
    this.killed = true;
    this.killSignals.push(signal);
    queueMicrotask(() => this.exit(null, typeof signal === 'string' ? signal : null));
    return true;
  }
}

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'NOT_FINISHED',
    levelsCompleted: 0,
    winLevels: 3,
    availableActions: ['ACTION1', 'ACTION6', 'ACTION7'],
    frames: [
      { width: 2, height: 2, cells: [[0, 1], [2, 3]], frameIndex: 0 },
      { width: 2, height: 2, cells: [[4, 5], [6, 7]], frameIndex: 1 },
    ],
    metadata: {
      gameId: 'ls20',
      guid: 'guid-1',
      fullReset: true,
      actionInput: { id: 0, name: 'RESET', data: {} },
      progress: { levelsCompleted: 0, winLevels: 3 },
      offeredActionIds: [1, 6, 7],
    },
    ...overrides,
  };
}

function fakeBridge(
  handler: FakeHandler,
  options: Omit<PythonArcBridgeOptions, 'childFactory'> = {},
): {
  bridge: PythonArcBridge;
  child: FakePythonProcess;
  spawnOptions: PythonBridgeSpawnOptions;
  executable: string;
  args: readonly string[];
} {
  let child: FakePythonProcess | undefined;
  let spawnOptions: PythonBridgeSpawnOptions | undefined;
  let executable = '';
  let args: readonly string[] = [];
  const factory: PythonBridgeChildFactory = (command, commandArgs, childOptions) => {
    executable = command;
    args = commandArgs;
    spawnOptions = childOptions;
    child = new FakePythonProcess(handler);
    return child;
  };
  const bridge = new PythonArcBridge({
    pythonExecutable: 'python-for-test',
    scriptPath: '/safe/fake-bridge.py',
    requestTimeoutMs: 250,
    shutdownGraceMs: 10,
    ...options,
    childFactory: factory,
  });
  if (child === undefined || spawnOptions === undefined) {
    throw new Error('child factory was not called');
  }
  return { bridge, child, spawnOptions, executable, args };
}

function standardHandler(request: FakeRequest, child: FakePythonProcess): void {
  switch (request.op) {
    case 'list_games':
      child.respond(request.id, [{ game_id: 'ls20', title: 'hidden from controller' }]);
      break;
    case 'create_scorecard':
      child.respond(request.id, { scorecardId: 'card-created' });
      break;
    case 'open_scorecard':
      child.respond(request.id, { scorecardId: 'card-opened' });
      break;
    case 'start_game':
      child.respond(request.id, { environmentId: 'env-1', observation: observation() });
      break;
    case 'observe':
    case 'act':
    case 'reset':
      child.respond(request.id, observation({
        metadata: {
          ...(observation().metadata as Record<string, unknown>),
          fullReset: request.op === 'reset',
        },
      }));
      break;
    case 'get_scorecard':
    case 'close_scorecard':
      child.respond(request.id, { card_id: request.params.scorecardId, score: 12.5 });
      break;
    case 'shutdown':
      child.respond(request.id, { closed: true, closedScorecards: 0, failedScorecards: 0 });
      queueMicrotask(() => child.exit());
      break;
    default:
      child.respondError(request.id, 'UNKNOWN_OPERATION', 'unknown operation');
  }
}

describe('PythonArcBridge', () => {
  it('exposes the SDK lifecycle, preserves frames, and caches the initial reset', async () => {
    const { bridge, child, executable, args, spawnOptions } = fakeBridge(standardHandler);

    expect(executable).toBe('python-for-test');
    expect(args).toEqual([
      '/safe/fake-bridge.py',
      '--allowed-arc-host',
      'three.arcprize.org',
    ]);
    expect(spawnOptions.shell).toBe(false);
    expect(spawnOptions.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(spawnOptions.env.ARC_BASE_URL).toBe('https://three.arcprize.org');
    expect(spawnOptions.env.ARC_OPERATION_MODE).toBe('online');

    await expect(bridge.listGames()).resolves.toEqual([
      { game_id: 'ls20', title: 'hidden from controller' },
    ]);
    const scorecardId = await bridge.createScorecard({
      sourceUrl: 'https://example.test/harness',
      tags: ['test'],
      opaque: { run: 1 },
    });
    const started = await bridge.startGame({ gameId: 'ls20', scorecardId, seed: 7 });

    expect(started.initialObservation.frames).toHaveLength(2);
    expect(started.initialObservation.frames[1]?.cells).toEqual([[4, 5], [6, 7]]);
    expect(started.initialObservation.availableActions).toContain('ACTION7');
    expect(started.initialObservation.metadata).toMatchObject({
      guid: 'guid-1',
      fullReset: true,
      offeredActionIds: [1, 6, 7],
    });

    // ArcController.start() calls reset(). start_game already obtained that full
    // reset, so the first adapter reset must be a cache hit, not another action.
    await expect(started.environment.reset()).resolves.toBe(started.initialObservation);
    expect(child.requests.filter((request) => request.op === 'reset')).toHaveLength(0);

    await started.environment.reset();
    expect(child.requests.filter((request) => request.op === 'reset')).toHaveLength(1);
    await started.environment.step({ name: 'ACTION6', x: 63, y: 0 });
    await bridge.act('env-1', { name: 'ACTION7' }, { rationale: 'public summary' });
    await started.environment.observe();

    const actionRequests = child.requests.filter((request) => request.op === 'act');
    expect(actionRequests[0]?.params.action).toEqual({ name: 'ACTION6', x: 63, y: 0 });
    expect(actionRequests[1]?.params).toMatchObject({
      action: { name: 'ACTION7' },
      reasoning: { rationale: 'public summary' },
    });

    await expect(bridge.getScorecard(scorecardId)).resolves.toMatchObject({ score: 12.5 });
    await bridge.closeScorecard(scorecardId);
    const ownedAtDispose = await bridge.openScorecard();
    await bridge.dispose();

    const tail = child.requests.slice(-2);
    expect(tail.map((request) => request.op)).toEqual(['close_scorecard', 'shutdown']);
    expect(tail[0]?.params).toEqual({ scorecardId: ownedAtDispose });
  });

  it('accepts the core maximum cell envelope under the default response-line bound', async () => {
    const rows = Array.from({ length: 64 }, () => Array<number>(64).fill(15));
    const frames = Array.from({ length: 256 }, (_, frameIndex) => ({
      width: 64,
      height: 64,
      cells: rows,
      frameIndex,
    }));
    const { bridge } = fakeBridge((request, child) => {
      if (request.op === 'start_game') {
        child.respond(request.id, {
          environmentId: 'maximum-envelope',
          observation: observation({ frames }),
        });
      } else if (request.op === 'shutdown') {
        child.respond(request.id, { closed: true, closedScorecards: 0, failedScorecards: 0 });
        queueMicrotask(() => child.exit());
      }
    }, { requestTimeoutMs: 2_000 });
    const started = await bridge.startGame({ gameId: 'private', scorecardId: 'private' });
    expect(started.initialObservation.frames).toHaveLength(256);
    expect(started.initialObservation.frames[255]).toMatchObject({ width: 64, height: 64 });
    await bridge.dispose();
  });

  it('gives the returned environment safe default ownership of bridge cleanup', async () => {
    const { bridge, child } = fakeBridge(standardHandler);
    const scorecardId = await bridge.createScorecard();
    const started = await bridge.startGame({ gameId: 'opaque-to-controller', scorecardId });

    await started.environment.close?.();

    expect(child.requests.slice(-2).map((request) => request.op)).toEqual([
      'close_scorecard',
      'shutdown',
    ]);
    expect(child.requests.at(-2)?.params).toEqual({ scorecardId });
    expect(child.killed).toBe(false);
  });

  it('reports scorecard cleanup failure after attempting every shutdown step', async () => {
    const { bridge, child } = fakeBridge((request, process) => {
      if (request.op === 'create_scorecard') {
        process.respond(request.id, { scorecardId: 'card-that-will-fail-close' });
      } else if (request.op === 'close_scorecard') {
        process.respondError(request.id, 'SDK_ERROR', 'bounded close failure');
      } else if (request.op === 'shutdown') {
        process.respond(request.id, {
          closed: true,
          closedScorecards: 0,
          failedScorecards: 1,
        });
        queueMicrotask(() => process.exit());
      }
    });
    await bridge.createScorecard();

    await expect(bridge.dispose()).rejects.toThrow(/failed to close 1 scorecard/);
    expect(child.requests.slice(-2).map((request) => request.op)).toEqual([
      'close_scorecard',
      'shutdown',
    ]);
  });

  it('serializes concurrent callers so only one request is in flight', async () => {
    let listRequests = 0;
    const { bridge, child } = fakeBridge((request, process) => {
      if (request.op === 'list_games') {
        listRequests += 1;
        setTimeout(() => process.respond(request.id, [{ game_id: `g-${listRequests}` }]), 20);
      } else if (request.op === 'shutdown') {
        process.respond(request.id, { closed: true, closedScorecards: 0, failedScorecards: 0 });
        queueMicrotask(() => process.exit());
      }
    });

    const first = bridge.listGames();
    const second = bridge.listGames();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(child.requests.filter((request) => request.op === 'list_games')).toHaveLength(1);
    await Promise.all([first, second]);
    expect(child.requests.filter((request) => request.op === 'list_games')).toHaveLength(2);
    await bridge.dispose();
  });

  it('does not inherit unrelated host secrets into the Python child', async () => {
    const sentinelName = 'METAHARNESS_UNRELATED_SENTINEL_SECRET';
    const previous = process.env[sentinelName];
    const previousPythonPath = process.env.PYTHONPATH;
    const previousCertificate = process.env.SSL_CERT_FILE;
    process.env[sentinelName] = 'must-not-cross-process-boundary';
    process.env.PYTHONPATH = '/tmp/untrusted-python-shadow-path';
    process.env.SSL_CERT_FILE = '/tmp/untrusted-certificate.pem';
    try {
      const { bridge, spawnOptions } = fakeBridge(standardHandler, {
        env: { EXPLICIT_TEST_VALUE: 'allowed' },
      });
      expect(spawnOptions.env[sentinelName]).toBeUndefined();
      expect(spawnOptions.env.PYTHONPATH).toBeUndefined();
      expect(spawnOptions.env.SSL_CERT_FILE).toBeUndefined();
      expect(spawnOptions.env.EXPLICIT_TEST_VALUE).toBe('allowed');
      await bridge.dispose();
    } finally {
      if (previous === undefined) delete process.env[sentinelName];
      else process.env[sentinelName] = previous;
      if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = previousPythonPath;
      if (previousCertificate === undefined) delete process.env.SSL_CERT_FILE;
      else process.env.SSL_CERT_FILE = previousCertificate;
    }
  });

  it('rejects unsafe origins, operation modes, and unbounded resource limits before spawn', () => {
    let spawnCalls = 0;
    const childFactory: PythonBridgeChildFactory = () => {
      spawnCalls += 1;
      return new FakePythonProcess(standardHandler);
    };

    expect(() => new PythonArcBridge({
      env: {
        ARC_BASE_URL: 'https://attacker.example',
        ARC_API_KEY: 'secret-that-must-not-leak',
      },
      childFactory,
    })).toThrow(/allowed HTTPS origin/);
    expect(() => new PythonArcBridge({
      env: { ARC_OPERATION_MODE: 'normal' },
      childFactory,
    })).toThrow(/online or competition/);
    expect(() => new PythonArcBridge({
      requestTimeoutMs: MAX_PYTHON_BRIDGE_TIMEOUT_MS + 1,
      childFactory,
    })).toThrow(/requestTimeoutMs/);
    expect(() => new PythonArcBridge({
      shutdownGraceMs: Infinity,
      childFactory,
    })).toThrow(/shutdownGraceMs/);
    expect(() => new PythonArcBridge({
      maxLineBytes: MAX_PYTHON_BRIDGE_LINE_BYTES + 1,
      childFactory,
    })).toThrow(/maxLineBytes/);
    expect(spawnCalls).toBe(0);
  });

  it('validates ACTION6, simple actions, and the reasoning byte bound before writing', async () => {
    const { bridge, child } = fakeBridge(standardHandler);

    await expect(bridge.act('env-1', { name: 'ACTION6', x: 64, y: 0 } as never))
      .rejects.toThrow(/0 through 63/);
    await expect(bridge.act('env-1', { name: 'ACTION7', x: 1 } as never))
      .rejects.toThrow(/accepts no action parameters/);
    await expect(bridge.act('env-1', { name: 'ACTION1' }, { text: 'x'.repeat(16_001) }))
      .rejects.toThrow(/16000 bytes/);
    expect(child.requests.filter((request) => request.op === 'act')).toHaveLength(0);
    await bridge.dispose();
  });

  it('fails closed on malformed JSON, invalid frames, oversized lines, and timeouts', async () => {
    const malformed = fakeBridge((request, child) => {
      if (request.op === 'list_games') child.stdout.write('{not-json}\n');
    });
    await expect(malformed.bridge.listGames()).rejects.toThrow(/malformed JSON/);
    expect(malformed.child.killSignals).toContain('SIGKILL');

    const invalidFrame = fakeBridge((request, child) => {
      if (request.op === 'observe') {
        child.respond(request.id, observation({
          frames: [{ width: 1, height: 1, cells: [[true]], frameIndex: 0 }],
        }));
      }
    });
    await expect(invalidFrame.bridge.observe('env-1')).rejects.toThrow(/frame cells/);
    expect(invalidFrame.child.killSignals).toContain('SIGKILL');

    const oversized = fakeBridge((request, child) => {
      if (request.op === 'list_games') child.stdout.write(Buffer.alloc(257, 0x61));
    }, { maxLineBytes: 256 });
    await expect(oversized.bridge.listGames()).rejects.toThrow(/too large/);
    expect(oversized.child.killSignals).toContain('SIGKILL');

    const timeout = fakeBridge(() => undefined, { requestTimeoutMs: 15 });
    await expect(timeout.bridge.listGames()).rejects.toThrow(/timed out/);
    expect(timeout.child.killSignals).toContain('SIGKILL');

    const cleanup = await Promise.allSettled([
      malformed.bridge.dispose(),
      invalidFrame.bridge.dispose(),
      oversized.bridge.dispose(),
      timeout.bridge.dispose(),
    ]);
    expect(cleanup.every((result) => result.status === 'rejected')).toBe(true);
  });
});

const FAKE_ARCENGINE = `
from enum import Enum

class GameAction(Enum):
    RESET = 0
    ACTION1 = 1
    ACTION2 = 2
    ACTION3 = 3
    ACTION4 = 4
    ACTION5 = 5
    ACTION6 = 6
    ACTION7 = 7

    @classmethod
    def from_name(cls, name):
        return cls[name]

    def validate_data(self, data):
        if self is GameAction.ACTION6:
            if set(data) != {"x", "y"}: raise ValueError("bad complex action")
        elif data:
            raise ValueError("bad simple action")
        return True

class GameState(str, Enum):
    NOT_PLAYED = "NOT_PLAYED"
    NOT_FINISHED = "NOT_FINISHED"
    WIN = "WIN"
    GAME_OVER = "GAME_OVER"
`;

const FAKE_ARC_AGI = `
import os
from enum import Enum
from arcengine import GameAction, GameState

class OperationMode(str, Enum):
    NORMAL = "normal"
    ONLINE = "online"
    OFFLINE = "offline"
    COMPETITION = "competition"

class ActionInput:
    def __init__(self):
        self.id = GameAction.RESET
        self.data = {}
        self.reasoning = None
    def model_dump(self, **kwargs):
        return {"id": 0, "data": {}, "reasoning": None}

class RawObservation:
    def __init__(self, reset_calls):
        self.game_id = "fake"
        self.state = GameState.NOT_FINISHED
        self.levels_completed = 0
        self.win_levels = 2
        self.available_actions = [1, 6, 7]
        if os.getenv("FAKE_MAX_OBSERVATION") == "1":
            self.frame = [[[15] * 64 for _ in range(64)] for _ in range(256)]
        elif os.getenv("FAKE_TOO_MANY_FRAMES") == "1":
            self.frame = [[[0]] for _ in range(257)]
        else:
            self.frame = [[[0, 1], [2, 3]]]
        self.guid = "fake-guid"
        self.full_reset = True
        self.action_input = ActionInput()
        self.progress = {"resetCalls": reset_calls, "actionCount": 0}

class FakeEnvironment:
    def __init__(self):
        self.reset_calls = 0
        self._last_response = None
        if os.getenv("FAKE_EMPTY_OBSERVATION") != "1":
            self.reset()
    @property
    def observation_space(self):
        return self._last_response
    def reset(self):
        self.reset_calls += 1
        self._last_response = RawObservation(self.reset_calls)
        return self._last_response
    def step(self, action, data=None, reasoning=None):
        return self._last_response

class Arcade:
    def __init__(self, **kwargs):
        self.arc_api_key = kwargs.get("arc_api_key", "")
    def get_environments(self): return []
    def create_scorecard(self, source_url=None, tags=None, opaque=None): return "fake-card"
    def open_scorecard(self, source_url=None, tags=None, opaque=None): return "fake-card"
    def make(self, **kwargs): return FakeEnvironment()
    def get_scorecard(self, scorecard_id=None): return None
    def close_scorecard(self, scorecard_id=None):
        if os.getenv("FAKE_CLOSE_FAIL") == "1": raise RuntimeError("bounded close failure")
        return None
`;

function writeFakeSdk(fakeModules: string): void {
  writeFileSync(join(fakeModules, 'arcengine.py'), FAKE_ARCENGINE);
  writeFileSync(join(fakeModules, 'arc_agi.py'), FAKE_ARC_AGI);
  for (const [directory, name, version] of [
    ['arc_agi-0.9.8.dist-info', 'arc-agi', '0.9.8'],
    ['arcengine-0.9.3.dist-info', 'arcengine', '0.9.3'],
  ] as const) {
    const metadataDirectory = join(fakeModules, directory);
    mkdirSync(metadataDirectory);
    writeFileSync(
      join(metadataDirectory, 'METADATA'),
      `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`,
    );
  }
}

describe('python bridge SDK reset contract', () => {
  it('serializes the reviewed maximum and rejects one frame beyond it', () => {
    const fakeModules = mkdtempSync(join(tmpdir(), 'arc-agi-3-fake-sdk-'));
    try {
      writeFakeSdk(fakeModules);
      const scriptPath = fileURLToPath(new URL('../python/bridge.py', import.meta.url));
      const input = [
        JSON.stringify({
          id: 1,
          op: 'start_game',
          params: { gameId: 'fake', scorecardId: 'fake-card' },
        }),
        JSON.stringify({ id: 2, op: 'shutdown', params: {} }),
        '',
      ].join('\n');
      const run = (extraEnv: Record<string, string>) => spawnSync('python3', [scriptPath], {
        encoding: 'utf8',
        input,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: fakeModules,
          PYTHONDONTWRITEBYTECODE: '1',
          ARC_OPERATION_MODE: 'online',
          ...extraEnv,
        },
      });
      const maximum = run({ FAKE_MAX_OBSERVATION: '1' });
      expect(maximum.status).toBe(0);
      const maximumResponse = JSON.parse(maximum.stdout.split('\n')[0]);
      expect(maximumResponse.result.observation.frames).toHaveLength(256);

      const oversized = run({ FAKE_TOO_MANY_FRAMES: '1' });
      expect(oversized.status).toBe(0);
      const oversizedResponse = JSON.parse(oversized.stdout.split('\n')[0]);
      expect(oversizedResponse).toMatchObject({
        ok: false,
        error: { code: 'SDK_PROTOCOL_ERROR' },
      });
    } finally {
      rmSync(fakeModules, { recursive: true, force: true });
    }
  });

  for (const [label, initiallyEmpty] of [
    ['constructor-populated observation', false],
    ['empty observation fallback', true],
  ] as const) {
    it(`performs exactly one initial full reset for ${label}`, () => {
      const fakeModules = mkdtempSync(join(tmpdir(), 'arc-agi-3-fake-sdk-'));
      try {
        writeFakeSdk(fakeModules);
        const scriptPath = fileURLToPath(new URL('../python/bridge.py', import.meta.url));
        const input = [
          JSON.stringify({
            id: 1,
            op: 'start_game',
            params: { gameId: 'fake', scorecardId: 'fake-card' },
          }),
          JSON.stringify({ id: 2, op: 'shutdown', params: {} }),
          '',
        ].join('\n');
        const result = spawnSync('python3', [scriptPath], {
          encoding: 'utf8',
          input,
          env: {
            PATH: process.env.PATH,
            PYTHONPATH: fakeModules,
            PYTHONDONTWRITEBYTECODE: '1',
            ARC_OPERATION_MODE: 'online',
            ...(initiallyEmpty ? { FAKE_EMPTY_OBSERVATION: '1' } : {}),
          },
        });
        if (result.status !== 0) {
          throw new Error(`fake SDK bridge failed: ${result.stderr}`);
        }
        const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
        const initial = responses[0].result.observation;
        expect(initial.metadata.fullReset).toBe(true);
        expect(initial.metadata.actionInput.name).toBe('RESET');
        expect(initial.metadata.progress).toEqual({ resetCalls: 1, actionCount: 0 });
      } finally {
        rmSync(fakeModules, { recursive: true, force: true });
      }
    });
  }

  it('enforces the remote origin and mode boundary inside Python itself', () => {
    const fakeModules = mkdtempSync(join(tmpdir(), 'arc-agi-3-fake-sdk-'));
    try {
      writeFakeSdk(fakeModules);
      const scriptPath = fileURLToPath(new URL('../python/bridge.py', import.meta.url));
      const input = `${JSON.stringify({ id: 1, op: 'list_games', params: {} })}\n`;
      for (const boundary of [
        { ARC_BASE_URL: 'https://attacker.example', ARC_OPERATION_MODE: 'online' },
        { ARC_BASE_URL: 'https://three.arcprize.org', ARC_OPERATION_MODE: 'normal' },
      ]) {
        const result = spawnSync('python3', [scriptPath], {
          encoding: 'utf8',
          input,
          env: {
            PATH: process.env.PATH,
            PYTHONPATH: fakeModules,
            PYTHONDONTWRITEBYTECODE: '1',
            ...boundary,
          },
        });
        expect(result.status).toBe(0);
        const response = JSON.parse(result.stdout.trim());
        expect(response).toMatchObject({
          id: 1,
          ok: false,
          error: { code: 'CONFIGURATION_ERROR' },
        });
      }
    } finally {
      rmSync(fakeModules, { recursive: true, force: true });
    }
  });

  it('refuses an ARC SDK version outside the benchmark lock before import', () => {
    const fakeModules = mkdtempSync(join(tmpdir(), 'arc-agi-3-fake-sdk-'));
    try {
      writeFakeSdk(fakeModules);
      writeFileSync(
        join(fakeModules, 'arc_agi-0.9.8.dist-info', 'METADATA'),
        'Metadata-Version: 2.1\nName: arc-agi\nVersion: 0.9.9\n',
      );
      const scriptPath = fileURLToPath(new URL('../python/bridge.py', import.meta.url));
      const result = spawnSync('python3', [scriptPath], {
        encoding: 'utf8',
        input: `${JSON.stringify({ id: 1, op: 'list_games', params: {} })}\n`,
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: fakeModules,
          PYTHONDONTWRITEBYTECODE: '1',
        },
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('versions do not match the bridge lock');
      expect(result.stderr).not.toContain('0.9.9');
    } finally {
      rmSync(fakeModules, { recursive: true, force: true });
    }
  });

  it('reports Python scorecard cleanup failures without exposing identifiers', () => {
    const fakeModules = mkdtempSync(join(tmpdir(), 'arc-agi-3-fake-sdk-'));
    try {
      writeFakeSdk(fakeModules);
      const scriptPath = fileURLToPath(new URL('../python/bridge.py', import.meta.url));
      const input = [
        JSON.stringify({ id: 1, op: 'create_scorecard', params: {} }),
        JSON.stringify({ id: 2, op: 'shutdown', params: {} }),
        '',
      ].join('\n');
      const result = spawnSync('python3', [scriptPath], {
        encoding: 'utf8',
        input,
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: fakeModules,
          PYTHONDONTWRITEBYTECODE: '1',
          ARC_OPERATION_MODE: 'online',
          FAKE_CLOSE_FAIL: '1',
        },
      });
      expect(result.status).toBe(0);
      const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
      expect(responses[1]).toEqual({
        id: 2,
        ok: true,
        result: { closed: true, closedScorecards: 0, failedScorecards: 1 },
      });
      expect(JSON.stringify(responses[1])).not.toContain('fake-card');
    } finally {
      rmSync(fakeModules, { recursive: true, force: true });
    }
  });
});
