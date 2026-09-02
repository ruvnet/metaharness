import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type {
  ArcAction,
  ArcActionName,
  ArcEnvironment,
  JsonValue,
  RawArcObservation,
} from '@metaharness/arc-agi-3';

import { hashCanonical } from './canonical.js';
import type { MechanismFixtureSuite, MechanismTask } from './types.js';

const SIMPLE_ACTIONS = new Set<ArcActionName>([
  'ACTION1',
  'ACTION2',
  'ACTION3',
  'ACTION4',
  'ACTION5',
  'ACTION7',
]);

export class LogicalClock {
  #nowMs: number;

  constructor(startMs = 1_700_000_000_000) {
    this.#nowMs = startMs;
  }

  now = (): number => this.#nowMs;

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new TypeError('logical clock advance must be finite and non-negative');
    }
    this.#nowMs += milliseconds;
  }
}

interface MechanismCheckpoint {
  readonly schema: 'metaharness.arc_agi_3.mechanism_checkpoint.v1';
  readonly won: boolean;
  readonly actions: number;
}

export class MechanismEnvironment implements ArcEnvironment {
  readonly #task: MechanismTask;
  readonly #seed: number;
  readonly #actionLatencyMs: number;
  readonly #clock: LogicalClock;
  #won = false;
  #actions = 0;
  #closed = false;

  constructor(options: {
    readonly task: MechanismTask;
    readonly seed: number;
    readonly actionLatencyMs: number;
    readonly clock: LogicalClock;
  }) {
    this.#task = options.task;
    this.#seed = options.seed;
    this.#actionLatencyMs = options.actionLatencyMs;
    this.#clock = options.clock;
  }

  get scoredActionCount(): number {
    return this.#actions;
  }

  async reset(): Promise<RawArcObservation> {
    this.#assertOpen();
    this.#won = false;
    this.#actions = 0;
    return this.#observation();
  }

  async observe(): Promise<RawArcObservation> {
    this.#assertOpen();
    return this.#observation();
  }

  async step(action: ArcAction): Promise<RawArcObservation> {
    this.#assertOpen();
    if (action.name === 'RESET' || action.name === 'ACTION6') {
      throw new Error(`fixture does not offer ${action.name}`);
    }
    if (!this.#task.availableActions.includes(action.name)) {
      throw new Error(`fixture did not offer ${action.name}`);
    }
    this.#actions += 1;
    this.#clock.advance(this.#actionLatencyMs);
    if (action.name === this.#task.goalAction) this.#won = true;
    return this.#observation();
  }

  async checkpoint(): Promise<JsonValue> {
    this.#assertOpen();
    return {
      schema: 'metaharness.arc_agi_3.mechanism_checkpoint.v1',
      won: this.#won,
      actions: this.#actions,
    };
  }

  async resume(value: unknown): Promise<RawArcObservation> {
    this.#assertOpen();
    if (
      typeof value !== 'object'
      || value === null
      || (value as Partial<MechanismCheckpoint>).schema
        !== 'metaharness.arc_agi_3.mechanism_checkpoint.v1'
      || typeof (value as Partial<MechanismCheckpoint>).won !== 'boolean'
      || !Number.isSafeInteger((value as Partial<MechanismCheckpoint>).actions)
    ) {
      throw new Error('invalid mechanism fixture checkpoint');
    }
    const checkpoint = value as MechanismCheckpoint;
    this.#won = checkpoint.won;
    this.#actions = checkpoint.actions;
    return this.#observation();
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('mechanism environment is closed');
  }

  #observation(): RawArcObservation {
    const base = (this.#task.frameSalt * 3 + this.#seed) % 9 + 1;
    const terminal = this.#won ? 9 : base;
    return {
      state: this.#won ? 'WIN' : 'NOT_FINISHED',
      levelsCompleted: this.#won ? 1 : 0,
      winLevels: 1,
      availableActions: [...this.#task.availableActions] as ArcActionName[],
      frames: [{
        width: 3,
        height: 3,
        frameIndex: 0,
        cells: [
          [base, 0, base],
          [0, terminal, 0],
          [base, 0, base],
        ],
      }],
    };
  }
}

export function validateMechanismFixture(value: unknown): MechanismFixtureSuite {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('fixture suite must be an object');
  }
  const suite = value as Partial<MechanismFixtureSuite>;
  if (
    suite.schema !== 'metaharness.arc_agi_3.mechanism_fixture.v1'
    || typeof suite.suiteId !== 'string'
    || suite.suiteId.length === 0
    || typeof suite.description !== 'string'
    || !Number.isFinite(suite.actionLatencyMs)
    || (suite.actionLatencyMs ?? -1) < 0
    || !Array.isArray(suite.tasks)
    || suite.tasks.length < 2
  ) {
    throw new TypeError('fixture suite header is invalid');
  }
  const ids = new Set<string>();
  for (const task of suite.tasks) {
    if (
      typeof task.id !== 'string'
      || task.id.length === 0
      || ids.has(task.id)
      || !Array.isArray(task.availableActions)
      || task.availableActions.length < 2
      || task.availableActions.some((action: ArcActionName) => !SIMPLE_ACTIONS.has(action))
      || new Set(task.availableActions).size !== task.availableActions.length
      || !task.availableActions.includes(task.goalAction)
      || !Number.isSafeInteger(task.frameSalt)
      || task.frameSalt < 0
      || !Number.isSafeInteger(task.referenceActions)
      || task.referenceActions < 1
    ) {
      throw new TypeError(`fixture task ${String(task.id)} is invalid`);
    }
    ids.add(task.id);
  }
  return suite as MechanismFixtureSuite;
}

export async function loadMechanismFixture(
  path = fileURLToPath(new URL('../fixtures/causal-escape-v1.json', import.meta.url)),
): Promise<{ readonly suite: MechanismFixtureSuite; readonly suiteHash: string }> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const suite = validateMechanismFixture(parsed);
  return { suite, suiteHash: hashCanonical(suite) };
}

export function mechanismScore(task: MechanismTask, state: RawArcObservation['state'], actions: number): number {
  if (state !== 'WIN' || actions < 1) return 0;
  return Math.min(100, 100 * (task.referenceActions / actions) ** 2);
}
