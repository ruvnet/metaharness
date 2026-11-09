# @metaharness/oo-agents

<!-- ruv-seo:start (ADR-356) -->
`@metaharness/oo-agents` lets you write an agent as a class: fields are state, methods are capabilities, schemas are typed contracts, and an `agentic` method is answered by a model writing code cells that run in a fuel-limited Rust/WASM VM with no filesystem, network or clock.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). The cell VM is a bundled `wasm32` module (`wasm/ooa_cell_vm.wasm`); no native build step. `ScriptedDriver` stands in for a model, so the quickstart needs no API key.

## Quickstart

```bash
npm install @metaharness/oo-agents
cat > quickstart.mjs <<'JS'
import { Agent, agentic, Runtime, ScriptedDriver } from '@metaharness/oo-agents';

class SupportAgent extends Agent {
  static doc = 'You are a support agent.';
  orders = { 'A-1': { delivered: true, daysSinceDelivery: 3 }, 'A-2': { delivered: true, daysSinceDelivery: 45 } };
  isRefundEligible(id) { const o = this.orders[id]; return o.delivered && o.daysSinceDelivery <= 30; }
  triage = agentic({
    doc: 'Create a typed support ticket.',
    params: { message: { type: 'string' }, orderId: { type: 'string' } },
    returns: {
      type: 'object',
      properties: { orderId: { type: 'string' }, refund: { type: 'boolean' }, note: { type: 'string' } },
      required: ['orderId', 'refund', 'note'],
    },
  });
}

// ScriptedDriver stands in for a model: it emits the code cell the model would write.
const cell = 'return_result({ orderId: orderId, refund: self.isRefundEligible(orderId), note: "auto-triaged" })';
const agent = new SupportAgent();
for (const id of ['A-1', 'A-2']) {
  const rt = await Runtime.create(new ScriptedDriver([cell]));
  console.log(JSON.stringify(await rt.run(agent, 'triage', ['where is my refund?', id])));
}
JS
node quickstart.mjs
```

Expected output:

```text
{"note":"auto-triaged","orderId":"A-1","refund":true}
{"note":"auto-triaged","orderId":"A-2","refund":false}
```

**Next:** [`@metaharness/radio`](https://www.npmjs.com/package/@metaharness/radio) — the passive-awareness bus that pods of these agents coordinate over.

**Fit:** standalone — no published `@metaharness` package depends on it. It depends on `@metaharness/radio` for multi-agent pods.
<!-- ruv-seo:end -->

## Reference

**The agent is a class. The model acts by writing code — inside a Rust/WASM
sandbox.**

A TypeScript + Rust/wasm32 clone of **NOOA**
([NVIDIA-NeMo/labs-OO-Agents](https://github.com/NVIDIA-NeMo/labs-OO-Agents),
[arXiv:2607.20709](https://arxiv.org/abs/2607.20709)): fields are state,
methods are capabilities, doc strings are prompts, schemas are typed
contracts, and an *agentic* method has no body — the runtime hands it to a
model driver that emits code cells executed against the live object. See
[ADR-242](../../docs/adrs/ADR-242-oo-agents-wasm-code-as-action.md).

```ts
import { Agent, agentic, Runtime, ScriptedDriver } from '@metaharness/oo-agents';

class SupportAgent extends Agent {
  static doc = 'You are a support agent.';

  // State lives on the object.
  orders: Record<string, Order> = { /* … */ };

  // Ordinary method. Just TypeScript — callable from sandbox cells as
  // self.isRefundEligible(id).
  isRefundEligible(orderId: string): boolean {
    const o = this.orders[orderId];
    return o.delivered && o.daysSinceDelivery <= 30;
  }

  // Agentic method: the runtime hands this to a model driver.
  triage = agentic({
    doc: 'Create a typed support ticket.',
    params: { message: { type: 'string' }, orderId: { type: 'string' } },
    returns: {
      type: 'object',
      properties: { orderId: { type: 'string' }, refund: { type: 'boolean' }, note: { type: 'string' } },
      required: ['orderId', 'refund', 'note'],
    },
  });
}
```

## The Rust/WASM sandbox is the point

NOOA sandboxes Python cells with guard lists in a worker process. This clone
gets isolation **by construction**: cells are written in *cellscript* — a
small deterministic imperative language (`let`/`if`/`while`/`for`, arrays,
objects, strings; `self.method(...)`/`self.field` host bridge;
`return_result(v)`; `print`) — interpreted by a ~1k-line Rust VM compiled to
`wasm32-unknown-unknown` (~180 KB, no wasm-bindgen, no dependencies):

- **No ambient authority.** The language has no filesystem, network, clock,
  randomness, or FFI. The ONE window to the world is a single JSON host
  import answered from the bound agent object — every state read and
  capability call crosses an inspectable, loggable boundary.
- **Fuel-bounded.** A runaway cell traps deterministically
  (`fuel exhausted`) instead of hanging the harness.
- **REPL-faithful.** Last-expression value, explicit `return`, namespace
  persistence across cells, and `return_result(v)` as the ExecutionSignal —
  the semantics of NOOA's `cell_core.py`.

## Typed contracts with auto-retry

TS erases types at runtime, so contracts are explicit `Schema` values
(NOOA reads Python annotations). Validation runs where NOOA's does — on
`return_result` — and a violation is fed back to the driver verbatim as the
retry prompt (`typed contract violated: $.refund: expected boolean, got
string; expected { orderId: string, refund: boolean, note: string }`).

## Drivers

`ModelDriver` is the only seam where a model enters. The package ships the
deterministic `ScriptedDriver` (tests/simulation) and `renderContext` (the
canonical prompt rendering). Real LLM drivers are host wiring — the kernel
owns model routing — by design.

## Build & test

```bash
npm run build:wasm   # cargo build crate/ → wasm/ooa_cell_vm.wasm
npm run build && npm test
cd crate && cargo test   # VM-level tests, native
```

Apache-2.0 (upstream NOOA's license).
