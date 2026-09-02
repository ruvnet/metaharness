// SPDX-License-Identifier: MIT

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';

import type {
  ArcAction,
  ArcEnvironment,
  RawArcObservation,
  RawGridFrame,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
// Covers the core's reviewed maximum of 1,048,576 two-digit grid cells plus JSON framing.
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 250;
export const MAX_PYTHON_BRIDGE_TIMEOUT_MS = 300_000;
export const MAX_PYTHON_BRIDGE_LINE_BYTES = 64 * 1024 * 1024;
const DEFAULT_ARC_BASE_URL = 'https://three.arcprize.org';
const DEFAULT_ALLOWED_ARC_HOSTS = ['three.arcprize.org'] as const;
const MAX_REASONING_BYTES = 16_000;

const ACTION_NAMES = new Set([
  'RESET',
  'ACTION1',
  'ACTION2',
  'ACTION3',
  'ACTION4',
  'ACTION5',
  'ACTION6',
  'ACTION7',
]);

const INHERITED_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'MPLCONFIGDIR',
  'ARC_API_KEY',
  'ARC_BASE_URL',
  'ARC_OPERATION_MODE',
] as const;

type JsonObject = Readonly<Record<string, unknown>>;

export interface ArcGameInfo extends JsonObject {
  readonly game_id: string;
}

export type ArcScorecard = JsonObject;

export interface ScorecardOptions {
  readonly sourceUrl?: string;
  readonly tags?: readonly string[];
  readonly opaque?: unknown;
}

export interface StartGameOptions {
  readonly gameId: string;
  readonly scorecardId: string;
  readonly seed?: number;
  /**
   * The safe default gives the returned environment ownership of this bridge.
   * Use `external` only when a factory deliberately shares one bridge and
   * scorecard across environments and guarantees a later `dispose()` call.
   */
  readonly bridgeOwnership?: 'environment' | 'external';
}

export interface StartedArcEnvironment {
  readonly environmentId: string;
  readonly environment: ArcEnvironment;
  readonly initialObservation: RawArcObservation;
}

/** The deliberately small child-process surface used by the bridge and tests. */
export interface PythonBridgeChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface PythonBridgeSpawnOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
  readonly windowsHide: true;
}

export type PythonBridgeChildFactory = (
  executable: string,
  args: readonly string[],
  options: PythonBridgeSpawnOptions,
) => PythonBridgeChild;

export interface PythonArcBridgeOptions {
  readonly pythonExecutable?: string;
  readonly scriptPath?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Exact HTTPS hostnames permitted to receive the ARC API key. */
  readonly allowedArcHosts?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly shutdownGraceMs?: number;
  /** Test/embedding seam. Production defaults to child_process.spawn. */
  readonly childFactory?: PythonBridgeChildFactory;
}

interface PendingRequest {
  readonly id: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface BridgeRequest {
  readonly id: number;
  readonly op: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export class ArcPythonBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArcPythonBridgeError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function requireBoundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function validateAllowedArcHosts(values: readonly string[]): readonly string[] {
  if (values.length === 0) {
    throw new TypeError('allowedArcHosts must contain at least one exact hostname');
  }
  const hosts = values.map((value) => {
    const host = value.trim().toLowerCase();
    if (
      host.length === 0
      || host.endsWith('.')
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
    ) {
      throw new TypeError('allowedArcHosts must contain exact DNS hostnames');
    }
    return host;
  });
  return [...new Set(hosts)];
}

function validateArcBaseUrl(value: string, allowedHosts: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('ARC_BASE_URL must be a valid URL');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || !allowedHosts.includes(parsed.hostname.toLowerCase())
    || (parsed.port !== '' && parsed.port !== '443')
    || parsed.pathname !== '/'
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new TypeError(
      'ARC_BASE_URL must be an allowed HTTPS origin with no credentials, path, query, or fragment',
    );
  }
  return `https://${parsed.hostname.toLowerCase()}`;
}

function validateOperationMode(value: string): 'online' | 'competition' {
  const mode = value.trim().toLowerCase();
  if (mode !== 'online' && mode !== 'competition') {
    throw new TypeError('ARC_OPERATION_MODE must be online or competition');
  }
  return mode;
}

function inheritedPythonEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function validateAction(action: ArcAction): Readonly<Record<string, unknown>> {
  if (!isRecord(action) || typeof action.name !== 'string' || !ACTION_NAMES.has(action.name)) {
    throw new TypeError('action.name must be RESET or ACTION1 through ACTION7');
  }
  if (action.name === 'ACTION6') {
    if (
      !hasExactKeys(action, ['name', 'x', 'y'])
      || !Number.isInteger(action.x)
      || !Number.isInteger(action.y)
      || (action.x as number) < 0
      || (action.x as number) > 63
      || (action.y as number) < 0
      || (action.y as number) > 63
    ) {
      throw new TypeError('ACTION6 x and y must be integers from 0 through 63');
    }
  } else if (!hasExactKeys(action, ['name'])) {
    throw new TypeError(`${action.name} accepts no action parameters`);
  }
  return action;
}

function validateReasoning(
  reasoning: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (reasoning === undefined) return undefined;
  if (!isRecord(reasoning)) {
    throw new TypeError('reasoning must be a JSON object');
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(reasoning);
  } catch {
    throw new TypeError('reasoning must be JSON serializable');
  }
  if (encoded === undefined) {
    throw new TypeError('reasoning must be JSON serializable');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REASONING_BYTES) {
    throw new TypeError(`reasoning JSON exceeds ${MAX_REASONING_BYTES} bytes`);
  }
  return reasoning;
}

function parseGridFrame(value: unknown, expectedIndex: number): RawGridFrame {
  if (!isRecord(value)) {
    throw new Error('frame must be an object');
  }
  const { width, height, cells, frameIndex } = value;
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || (width as number) < 1
    || (width as number) > 64
    || (height as number) < 1
    || (height as number) > 64
  ) {
    throw new Error('frame dimensions must be integers from 1 through 64');
  }
  if (!Array.isArray(cells) || cells.length !== height) {
    throw new Error('frame height does not match cells');
  }
  const checkedCells = cells.map((row) => {
    if (!Array.isArray(row) || row.length !== width) {
      throw new Error('frame width does not match cells');
    }
    return row.map((cell) => {
      if (!Number.isInteger(cell) || (cell as number) < 0 || (cell as number) > 15) {
        throw new Error('frame cells must be integers from 0 through 15');
      }
      return cell as number;
    });
  });
  if (frameIndex !== undefined && frameIndex !== expectedIndex) {
    throw new Error('frameIndex is not sequential');
  }
  return {
    width: width as number,
    height: height as number,
    cells: checkedCells,
    ...(frameIndex === undefined ? {} : { frameIndex: expectedIndex }),
  };
}

function parseObservation(value: unknown): RawArcObservation {
  if (!isRecord(value)) {
    throw new Error('observation must be an object');
  }
  const { state, levelsCompleted, winLevels, availableActions, frames, metadata } = value;
  if (
    state !== 'NOT_PLAYED'
    && state !== 'NOT_FINISHED'
    && state !== 'WIN'
    && state !== 'GAME_OVER'
  ) {
    throw new Error('observation contains an invalid state');
  }
  if (
    !Number.isSafeInteger(levelsCompleted)
    || (levelsCompleted as number) < 0
    || !Number.isSafeInteger(winLevels)
    || (winLevels as number) < 0
  ) {
    throw new Error('observation contains invalid progress');
  }
  if (
    !Array.isArray(availableActions)
    || availableActions.some((action) => typeof action !== 'string' || !ACTION_NAMES.has(action))
  ) {
    throw new Error('observation contains invalid offered actions');
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('observation must contain at least one animation frame');
  }
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new Error('observation metadata must be an object');
  }

  // The SDK has historically returned NOT_PLAYED before the first reset.  It
  // is intentionally preserved rather than silently rewritten.  The shared
  // RawArcObservation contract includes that official state.
  return {
    state,
    levelsCompleted: levelsCompleted as number,
    winLevels: winLevels as number,
    availableActions: availableActions as RawArcObservation['availableActions'],
    frames: frames.map(parseGridFrame),
    ...(metadata === undefined ? {} : { metadata }),
  } as RawArcObservation;
}

function parseEnvironmentStart(value: unknown): {
  environmentId: string;
  observation: RawArcObservation;
} {
  if (!isRecord(value) || !hasExactKeys(value, ['environmentId', 'observation'])) {
    throw new Error('start_game returned an invalid result');
  }
  if (typeof value.environmentId !== 'string' || value.environmentId.length === 0) {
    throw new Error('start_game returned an invalid environmentId');
  }
  return {
    environmentId: value.environmentId,
    observation: parseObservation(value.observation),
  };
}

function parseScorecardId(value: unknown): string {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['scorecardId'])
    || typeof value.scorecardId !== 'string'
    || value.scorecardId.length === 0
  ) {
    throw new Error('ARC SDK returned an invalid scorecard id');
  }
  return value.scorecardId;
}

function defaultChildFactory(
  executable: string,
  args: readonly string[],
  options: PythonBridgeSpawnOptions,
): PythonBridgeChild {
  return spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

class PythonArcEnvironment implements ArcEnvironment {
  readonly environmentId: string;
  readonly #bridge: PythonArcBridge;
  readonly #bridgeOwnership: 'environment' | 'external';
  #initialObservation: RawArcObservation | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(
    bridge: PythonArcBridge,
    environmentId: string,
    initialObservation: RawArcObservation,
    bridgeOwnership: 'environment' | 'external',
  ) {
    this.#bridge = bridge;
    this.environmentId = environmentId;
    this.#initialObservation = initialObservation;
    this.#bridgeOwnership = bridgeOwnership;
  }

  reset(): Promise<RawArcObservation> {
    if (this.#initialObservation !== undefined) {
      const initial = this.#initialObservation;
      this.#initialObservation = undefined;
      return Promise.resolve(initial);
    }
    return this.#bridge.reset(this.environmentId);
  }

  observe(): Promise<RawArcObservation> {
    return this.#bridge.observe(this.environmentId);
  }

  step(action: ArcAction): Promise<RawArcObservation> {
    if (action.name === 'RESET') return this.reset();
    // A non-reset mutation makes the cached start observation stale.
    this.#initialObservation = undefined;
    return this.#bridge.act(this.environmentId, action);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#bridgeOwnership === 'environment'
      ? this.#bridge.dispose()
      : Promise.resolve();
    return this.#closePromise;
  }
}

/**
 * Long-lived, serial, fail-closed client for python/bridge.py.
 *
 * One request may be in flight at a time. A timeout, unexpected response id,
 * oversized line, or malformed stdout permanently terminates the child.
 * The official online SDK cannot rehydrate its remote guid/cookie session
 * after this process dies; durable controller memory is not a live-game resume.
 */
export class PythonArcBridge {
  readonly #child: PythonBridgeChild;
  readonly #requestTimeoutMs: number;
  readonly #maxLineBytes: number;
  readonly #shutdownGraceMs: number;
  readonly #scorecardIds = new Set<string>();
  readonly #exitWaiters = new Set<(exited: boolean) => void>();

  #stdoutBuffer = Buffer.alloc(0);
  #nextId = 1;
  #pending: PendingRequest | undefined;
  #queue: Promise<void> = Promise.resolve();
  #disposePromise: Promise<void> | undefined;
  #accepting = true;
  #state: 'running' | 'disposing' | 'closed' | 'failed' = 'running';
  #exited = false;

  constructor(options: PythonArcBridgeOptions = {}) {
    this.#requestTimeoutMs = requireBoundedPositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      'requestTimeoutMs',
      MAX_PYTHON_BRIDGE_TIMEOUT_MS,
    );
    this.#maxLineBytes = requireBoundedPositiveInteger(
      options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      'maxLineBytes',
      MAX_PYTHON_BRIDGE_LINE_BYTES,
    );
    this.#shutdownGraceMs = requireBoundedPositiveInteger(
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      'shutdownGraceMs',
      MAX_PYTHON_BRIDGE_TIMEOUT_MS,
    );

    const executable = options.pythonExecutable ?? 'python3';
    const scriptPath = options.scriptPath
      ?? fileURLToPath(new URL('../python/bridge.py', import.meta.url));
    if (executable.length === 0 || scriptPath.length === 0) {
      throw new TypeError('pythonExecutable and scriptPath must be non-empty');
    }
    const allowedArcHosts = validateAllowedArcHosts(
      options.allowedArcHosts ?? DEFAULT_ALLOWED_ARC_HOSTS,
    );
    const baseUrl = validateArcBaseUrl(
      options.env?.ARC_BASE_URL
        ?? process.env.ARC_BASE_URL
        ?? DEFAULT_ARC_BASE_URL,
      allowedArcHosts,
    );
    const operationMode = validateOperationMode(
      options.env?.ARC_OPERATION_MODE
        ?? options.env?.OPERATION_MODE
        ?? process.env.ARC_OPERATION_MODE
        ?? process.env.OPERATION_MODE
        ?? 'online',
    );
    const environment: NodeJS.ProcessEnv = {
      ...inheritedPythonEnvironment(),
      ...options.env,
      ARC_BASE_URL: baseUrl,
      ARC_OPERATION_MODE: operationMode,
    };
    const factory = options.childFactory ?? defaultChildFactory;
    const scriptArgs = [
      scriptPath,
      ...allowedArcHosts.flatMap((host) => ['--allowed-arc-host', host]),
    ];
    this.#child = factory(executable, scriptArgs, {
      cwd: options.cwd,
      env: environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.#child.stdout.on('data', (chunk: Buffer | string) => {
      this.#onStdout(chunk);
    });
    this.#child.stdout.on('end', () => {
      if (!this.#exited && this.#state === 'running') {
        this.#failClosed(new Error('ARC Python bridge closed stdout unexpectedly'));
      }
    });
    // Always drain stderr, but never mirror it into errors where it could expose
    // credentials or make the JSON protocol ambiguous.
    this.#child.stderr.on('data', () => undefined);
    this.#child.on('error', (error) => {
      this.#failClosed(new Error(`ARC Python bridge process error: ${error.message}`));
    });
    this.#child.on('exit', (code, signal) => {
      this.#onExit(code, signal);
    });
  }

  listGames(): Promise<readonly ArcGameInfo[]> {
    return this.#enqueue('list_games', {}, (value) => {
      if (
        !Array.isArray(value)
        || value.some((game) => !isRecord(game) || typeof game.game_id !== 'string')
      ) {
        throw new Error('list_games returned an invalid result');
      }
      return value as unknown as readonly ArcGameInfo[];
    });
  }

  async createScorecard(options: ScorecardOptions = {}): Promise<string> {
    const scorecardId = await this.#enqueue(
      'create_scorecard',
      this.#scorecardParams(options),
      parseScorecardId,
    );
    this.#scorecardIds.add(scorecardId);
    return scorecardId;
  }

  async openScorecard(options: ScorecardOptions = {}): Promise<string> {
    const scorecardId = await this.#enqueue(
      'open_scorecard',
      this.#scorecardParams(options),
      parseScorecardId,
    );
    this.#scorecardIds.add(scorecardId);
    return scorecardId;
  }

  async startGame(options: StartGameOptions): Promise<StartedArcEnvironment> {
    if (
      options.bridgeOwnership !== undefined
      && options.bridgeOwnership !== 'environment'
      && options.bridgeOwnership !== 'external'
    ) {
      throw new TypeError('bridgeOwnership must be environment or external');
    }
    const result = await this.#enqueue(
      'start_game',
      {
        gameId: options.gameId,
        scorecardId: options.scorecardId,
        ...(options.seed === undefined ? {} : { seed: options.seed }),
      },
      parseEnvironmentStart,
    );
    return {
      environmentId: result.environmentId,
      environment: new PythonArcEnvironment(
        this,
        result.environmentId,
        result.observation,
        options.bridgeOwnership ?? 'environment',
      ),
      initialObservation: result.observation,
    };
  }

  observe(environmentId: string): Promise<RawArcObservation> {
    return this.#enqueue('observe', { environmentId }, parseObservation);
  }

  act(
    environmentId: string,
    action: ArcAction,
    reasoning?: Readonly<Record<string, unknown>>,
  ): Promise<RawArcObservation> {
    let checkedAction: Readonly<Record<string, unknown>>;
    let checkedReasoning: Readonly<Record<string, unknown>> | undefined;
    try {
      checkedAction = validateAction(action);
      checkedReasoning = validateReasoning(reasoning);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueue(
      'act',
      {
        environmentId,
        action: checkedAction,
        ...(checkedReasoning === undefined ? {} : { reasoning: checkedReasoning }),
      },
      parseObservation,
    );
  }

  reset(environmentId: string): Promise<RawArcObservation> {
    return this.#enqueue('reset', { environmentId }, parseObservation);
  }

  getScorecard(scorecardId?: string): Promise<ArcScorecard | null> {
    return this.#enqueue(
      'get_scorecard',
      scorecardId === undefined ? {} : { scorecardId },
      (value) => {
        if (value !== null && !isRecord(value)) {
          throw new Error('get_scorecard returned an invalid result');
        }
        return value;
      },
    );
  }

  async closeScorecard(scorecardId?: string): Promise<ArcScorecard | null> {
    const result = await this.#enqueue(
      'close_scorecard',
      scorecardId === undefined ? {} : { scorecardId },
      (value) => {
        if (value !== null && !isRecord(value)) {
          throw new Error('close_scorecard returned an invalid result');
        }
        return value;
      },
    );
    if (scorecardId !== undefined) {
      this.#scorecardIds.delete(scorecardId);
    }
    return result;
  }

  /** Gracefully closes owned scorecards, asks Python to shut down, then kills if needed. */
  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) {
      return this.#disposePromise;
    }
    this.#accepting = false;
    this.#disposePromise = this.#disposeAfterQueue();
    return this.#disposePromise;
  }

  close(): Promise<void> {
    return this.dispose();
  }

  #scorecardParams(options: ScorecardOptions): Record<string, unknown> {
    return {
      ...(options.sourceUrl === undefined ? {} : { sourceUrl: options.sourceUrl }),
      ...(options.tags === undefined ? {} : { tags: [...options.tags] }),
      ...(options.opaque === undefined ? {} : { opaque: options.opaque }),
    };
  }

  #enqueue<T>(
    operation: string,
    params: Readonly<Record<string, unknown>>,
    parse: (value: unknown) => T,
  ): Promise<T> {
    if (!this.#accepting || this.#state !== 'running') {
      return Promise.reject(new Error('ARC Python bridge is closing or closed'));
    }
    const result = this.#queue.then(async () => {
      const value = await this.#requestNow(operation, params);
      try {
        return parse(value);
      } catch (error) {
        const failure = new Error(
          `ARC Python bridge emitted invalid ${operation} data: ${
            error instanceof Error ? error.message : 'unknown validation error'
          }`,
        );
        this.#failClosed(failure);
        throw failure;
      }
    });
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #requestNow(
    operation: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (this.#state !== 'running' && this.#state !== 'disposing') {
      return Promise.reject(new Error('ARC Python bridge is not running'));
    }
    if (this.#pending !== undefined) {
      this.#failClosed(new Error('ARC Python bridge request serialization invariant failed'));
      return Promise.reject(new Error('ARC Python bridge request serialization invariant failed'));
    }

    const id = this.#nextId++;
    const request: BridgeRequest = { id, op: operation, params };
    let line: Buffer;
    try {
      line = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
    } catch {
      return Promise.reject(new TypeError('ARC bridge request must be JSON serializable'));
    }
    if (line.byteLength - 1 > this.#maxLineBytes) {
      return Promise.reject(new Error(`ARC bridge request exceeds ${this.#maxLineBytes} bytes`));
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#failClosed(new Error(`ARC Python bridge request timed out after ${this.#requestTimeoutMs}ms`));
      }, this.#requestTimeoutMs);
      this.#pending = { id, resolve, reject, timer };
      try {
        this.#child.stdin.write(line, (error?: Error | null) => {
          if (error) {
            this.#failClosed(new Error(`Failed to write to ARC Python bridge: ${error.message}`));
          }
        });
      } catch (error) {
        this.#failClosed(
          new Error(
            `Failed to write to ARC Python bridge: ${error instanceof Error ? error.message : 'unknown error'}`,
          ),
        );
      }
    });
  }

  #onStdout(chunk: Buffer | string): void {
    if (this.#state === 'failed' || this.#state === 'closed') {
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, bytes]);

    while (true) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#stdoutBuffer.byteLength > this.#maxLineBytes) {
          this.#failClosed(new Error('ARC Python bridge response line is too large'));
        }
        return;
      }
      if (newline > this.#maxLineBytes) {
        this.#failClosed(new Error('ARC Python bridge response line is too large'));
        return;
      }
      let line = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.byteLength === 0) {
        this.#failClosed(new Error('ARC Python bridge emitted an empty response'));
        return;
      }
      if (!this.#handleResponseLine(line)) {
        return;
      }
    }
  }

  #handleResponseLine(line: Buffer): boolean {
    const pending = this.#pending;
    if (pending === undefined) {
      this.#failClosed(new Error('ARC Python bridge emitted an unsolicited response'));
      return false;
    }

    let response: unknown;
    try {
      response = JSON.parse(line.toString('utf8')) as unknown;
    } catch {
      this.#failClosed(new Error('ARC Python bridge emitted malformed JSON'));
      return false;
    }
    if (!isRecord(response) || response.id !== pending.id || typeof response.ok !== 'boolean') {
      this.#failClosed(new Error('ARC Python bridge emitted a malformed response envelope'));
      return false;
    }

    if (response.ok) {
      if (!hasExactKeys(response, ['id', 'ok', 'result'])) {
        this.#failClosed(new Error('ARC Python bridge emitted a malformed success response'));
        return false;
      }
      this.#pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(response.result);
      return true;
    }

    if (
      !hasExactKeys(response, ['error', 'id', 'ok'])
      || !isRecord(response.error)
      || !hasExactKeys(response.error, ['code', 'message'])
      || typeof response.error.code !== 'string'
      || typeof response.error.message !== 'string'
    ) {
      this.#failClosed(new Error('ARC Python bridge emitted a malformed error response'));
      return false;
    }
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(new ArcPythonBridgeError(response.error.code, response.error.message));
    return true;
  }

  #failClosed(error: Error): void {
    if (this.#state === 'failed' || this.#state === 'closed') {
      return;
    }
    this.#state = 'failed';
    this.#accepting = false;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    try {
      this.#child.stdin.destroy();
    } catch {
      // The process may already have closed its pipe.
    }
    this.#kill('SIGKILL');
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#exited = true;
    for (const waiter of this.#exitWaiters) {
      waiter(true);
    }
    this.#exitWaiters.clear();

    const pending = this.#pending;
    if (pending !== undefined) {
      this.#pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`ARC Python bridge exited before responding (code=${String(code)}, signal=${String(signal)})`),
      );
    }
    if (this.#state === 'running') {
      this.#state = 'failed';
      this.#accepting = false;
    } else if (this.#state === 'disposing') {
      this.#state = 'closed';
    }
  }

  async #disposeAfterQueue(): Promise<void> {
    await this.#queue;
    if (this.#state === 'closed') return;
    if (this.#state === 'failed') {
      throw new Error('ARC Python bridge failed before graceful scorecard cleanup');
    }
    this.#state = 'disposing';
    let cleanupFailure: Error | undefined;

    for (const scorecardId of [...this.#scorecardIds]) {
      try {
        await this.#requestNow('close_scorecard', { scorecardId });
        this.#scorecardIds.delete(scorecardId);
      } catch {
        // Continue best-effort cleanup. Python shutdown retries tracked cards.
      }
      if (this.#hasFailed()) {
        throw new Error('ARC Python bridge failed during scorecard cleanup');
      }
    }

    try {
      const shutdown = await this.#requestNow('shutdown', {});
      if (
        !isRecord(shutdown)
        || !hasExactKeys(shutdown, ['closed', 'closedScorecards', 'failedScorecards'])
        || shutdown.closed !== true
        || !Number.isSafeInteger(shutdown.closedScorecards)
        || (shutdown.closedScorecards as number) < 0
        || !Number.isSafeInteger(shutdown.failedScorecards)
        || (shutdown.failedScorecards as number) < 0
      ) {
        cleanupFailure = new Error('ARC Python bridge returned an invalid shutdown result');
      } else if ((shutdown.failedScorecards as number) > 0) {
        cleanupFailure = new Error(
          `ARC Python bridge failed to close ${String(shutdown.failedScorecards)} scorecard(s)`,
        );
      }
    } catch {
      cleanupFailure = new Error('ARC Python bridge shutdown request failed');
    }
    if (this.#hasFailed()) {
      throw cleanupFailure ?? new Error('ARC Python bridge failed during shutdown');
    }
    try {
      this.#child.stdin.end();
    } catch {
      // The child may have exited immediately after its shutdown response.
    }

    if (!(await this.#waitForExit(this.#shutdownGraceMs))) {
      this.#kill('SIGTERM');
      if (!(await this.#waitForExit(this.#shutdownGraceMs))) {
        this.#kill('SIGKILL');
      }
    }
    this.#state = 'closed';
    if (cleanupFailure) throw cleanupFailure;
  }

  #hasFailed(): boolean {
    return this.#state === 'failed';
  }

  #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exited) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#exitWaiters.delete(finish);
        resolve(exited);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.#exitWaiters.add(finish);
    });
  }

  #kill(signal: NodeJS.Signals): void {
    if (this.#exited) {
      return;
    }
    try {
      this.#child.kill(signal);
    } catch {
      // Nothing else can be done if the OS has already reaped the child.
    }
  }
}
