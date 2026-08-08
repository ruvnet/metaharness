// @metaharness/oo-agents — the OO agent model, cloned from NOOA
// (NVIDIA-NeMo/labs-OO-Agents): the agent is a class. Fields are state,
// methods are capabilities, doc strings are prompts, schemas are contracts.
// An AGENTIC method has no body — the runtime hands it to a model driver that
// acts by WRITING CODE, one cell at a time, executed in the fuel-limited
// Rust/wasm sandbox with `self` bridged to this object.
//
// Differences from NOOA, stated honestly:
//   - Contracts are explicit Schema values (TS erases annotations at runtime).
//   - Capabilities the sandbox can call are synchronous (the wasm host import
//     is sync); async work belongs in the driver, not in capabilities.
//   - The model driver is pluggable; a deterministic ScriptedDriver ships for
//     tests and simulation. Real LLM drivers are host-side wiring (the kernel
//     routes models), out of scope here by design.

import { describe, Schema, validate } from './schema.js';
import { CellVm, CellOutcome, HostBinding } from './vm.js';

export interface AgenticSpec {
  /** The method docstring — the task prompt. */
  doc: string;
  /** Parameter contracts, in declaration order. */
  params: Record<string, Schema>;
  /** The return contract; return_result(v) must satisfy it (auto-retry). */
  returns: Schema;
  /** Max cells the driver may emit before the call fails (default 16). */
  maxCells?: number;
  /** Max typed-contract retries after invalid return_result (default 2). */
  maxRetries?: number;
  /** Fuel per cell (0 = VM default). */
  fuel?: bigint;
}

export interface CellRecord {
  code: string;
  outcome: CellOutcome;
  /** Set when a signal failed its contract — fed back to the driver. */
  contractError?: string;
}

export interface AgenticContext {
  agentDoc: string;
  methodName: string;
  methodDoc: string;
  contract: string;
  args: Record<string, unknown>;
  capabilities: string[];
  fields: string[];
  cells: CellRecord[];
}

export interface DriverStep {
  kind: 'cell';
  code: string;
}

export interface ModelDriver {
  /** Emit the next cell given everything that has happened so far. */
  next(ctx: AgenticContext): Promise<DriverStep>;
}

export interface AgentEvent {
  seq: number;
  kind: string;
  detail: unknown;
}

/** Base class. Subclasses add typed state fields and capability methods, and
 *  declare agentic methods with `agentic(spec)`. */
export class Agent {
  /** The class docstring — the system prompt. Subclasses override. */
  static doc = 'You are an agent.';

  #events: AgentEvent[] = [];
  #eventSeq = 0;

  /** Model-visible event log (NOOA's events API, minimal form). */
  emit(kind: string, detail: unknown = null): void {
    this.#events.push({ seq: this.#eventSeq++, kind, detail });
  }
  events(): readonly AgentEvent[] {
    return this.#events;
  }

  /** Everything the sandbox may touch: own enumerable fields (state) and own
   *  prototype methods (capabilities), excluding agentic methods and the
   *  runtime plumbing. This is the introspection NOOA gets from the class
   *  statement itself. */
  manifest(): { fields: string[]; capabilities: string[]; agentic: string[] } {
    const fields: string[] = [];
    const capabilities: string[] = [];
    const agentic: string[] = [];
    // Own props: non-function values are state; function values are either
    // agentic declarations (arrow-field `x = agentic({...})`) or bound
    // capabilities. Functions are never exposed as sandbox-readable state.
    for (const [name, v] of Object.entries(this)) {
      if (name.startsWith('_')) continue;
      if (typeof v === 'function') {
        if ((v as { __agentic?: AgenticSpec }).__agentic) agentic.push(name);
        else capabilities.push(name);
      } else {
        fields.push(name);
      }
    }
    const proto = Object.getPrototypeOf(this) as object;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || name.startsWith('_')) continue;
      const fn = (proto as Record<string, unknown>)[name];
      if (typeof fn !== 'function') continue;
      if ((fn as { __agentic?: AgenticSpec }).__agentic) agentic.push(name);
      else capabilities.push(name);
    }
    return { fields, capabilities, agentic };
  }
}

/** Declare an agentic method: the returned function IS the method body — it
 *  runs the code-as-action loop instead of user code (NOOA's `...` body). */
export function agentic(spec: AgenticSpec) {
  const runner = async function (this: Agent, ...args: unknown[]): Promise<unknown> {
    const runtime = currentRuntime;
    if (!runtime) {
      throw new Error(
        'no runtime bound — call Runtime.run(agent, method, args) or runtime.bind()',
      );
    }
    return runtime.runAgentic(this, runner as unknown as AgenticMethod, args);
  };
  (runner as unknown as { __agentic: AgenticSpec }).__agentic = spec;
  return runner as (...args: never[]) => Promise<unknown>;
}

type AgenticMethod = ((...args: unknown[]) => Promise<unknown>) & { __agentic: AgenticSpec };

let currentRuntime: Runtime | null = null;

export class Runtime {
  private constructor(
    private readonly vm: CellVm,
    private readonly driver: ModelDriver,
  ) {}

  static async create(driver: ModelDriver, wasmPath?: string): Promise<Runtime> {
    return new Runtime(await CellVm.load(wasmPath), driver);
  }

  /** Bind as the process-current runtime so agentic methods can be awaited
   *  directly (`await agent.triage(...)`). Returns an unbind function. */
  bind(): () => void {
    currentRuntime = this;
    return () => {
      if (currentRuntime === this) currentRuntime = null;
    };
  }

  /** Explicit entry point (no ambient binding needed). */
  async run(agent: Agent, methodName: string, args: unknown[]): Promise<unknown> {
    // Instance first (arrow-field declarations), then the prototype.
    const own = (agent as unknown as Record<string, unknown>)[methodName];
    const proto = Object.getPrototypeOf(agent) as Record<string, unknown>;
    const m = (own ?? proto[methodName]) as AgenticMethod | undefined;
    if (!m || !m.__agentic) throw new Error(`${methodName} is not an agentic method`);
    return this.runAgentic(agent, m, args);
  }

  async runAgentic(agent: Agent, method: AgenticMethod, args: unknown[]): Promise<unknown> {
    const spec = method.__agentic;
    const paramNames = Object.keys(spec.params);
    const argMap: Record<string, unknown> = {};
    paramNames.forEach((p, i) => {
      const err = validate(args[i], spec.params[p], `${p}`);
      if (err) throw new Error(`argument contract violated: ${err}`);
      argMap[p] = args[i];
    });

    const { fields, capabilities } = agent.manifest();
    const binding: HostBinding = {
      getField: (name) => {
        if (!fields.includes(name)) throw new Error(`unknown state field '${name}'`);
        return (agent as unknown as Record<string, unknown>)[name];
      },
      callMethod: (name, callArgs) => {
        if (!capabilities.includes(name)) throw new Error(`unknown capability '${name}'`);
        const own = (agent as unknown as Record<string, unknown>)[name];
        const fn = (own ?? (Object.getPrototypeOf(agent) as Record<string, unknown>)[name]) as (
          ...a: unknown[]
        ) => unknown;
        return fn.apply(agent, callArgs);
      },
    };

    const ctx: AgenticContext = {
      agentDoc: (agent.constructor as typeof Agent).doc,
      methodName: methodNameOf(agent, method),
      methodDoc: spec.doc,
      contract: describe(spec.returns),
      args: argMap,
      capabilities,
      fields,
      cells: [],
    };

    this.vm.reset(binding);
    // Seed the namespace with the typed arguments — JSON literals are valid
    // cellscript, so the preamble is ordinary code the model can also read.
    const preamble = paramNames
      .map((p) => `let ${p} = ${JSON.stringify(argMap[p] ?? null)}`)
      .join('\n');
    if (preamble) {
      const seeded = this.vm.runCell(preamble, spec.fuel ?? 0n);
      if (seeded.kind === 'error') {
        throw new Error(`argument preamble failed: ${seeded.message}`);
      }
    }

    const maxCells = spec.maxCells ?? 16;
    let retries = 0;
    const maxRetries = spec.maxRetries ?? 2;
    agent.emit('agentic:start', { method: ctx.methodName, args: argMap });

    for (let cell = 0; cell < maxCells; cell++) {
      const step = await this.driver.next(ctx);
      const outcome = this.vm.runCell(step.code, spec.fuel ?? 0n);
      const record: CellRecord = { code: step.code, outcome };
      ctx.cells.push(record);
      agent.emit('agentic:cell', { code: step.code, kind: outcome.kind });

      if (outcome.kind === 'signal') {
        const err = validate(outcome.value, spec.returns);
        if (!err) {
          agent.emit('agentic:done', { result: outcome.value });
          return outcome.value;
        }
        // NOOA's typed auto-retry: the validation error goes back to the model.
        record.contractError = `typed contract violated: ${err}; expected ${ctx.contract}`;
        retries++;
        if (retries > maxRetries) {
          throw new Error(`typed contract still violated after ${maxRetries} retries: ${err}`);
        }
      }
    }
    throw new Error(`agentic method exceeded ${maxCells} cells without return_result`);
  }
}

function methodNameOf(agent: Agent, method: AgenticMethod): string {
  const proto = Object.getPrototypeOf(agent) as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (proto[name] === method) return name;
  }
  return '(agentic)';
}
