# ADR-242: @metaharness/oo-agents — OO agents with a Rust/WASM code-as-action sandbox

**Status**: Accepted (core shipped, $0: wasm VM + OO runtime + scripted driver; live LLM driver deferred)
**Date**: 2026-08-08
**Project**: `ruvnet/metaharness`
**Related**: ADR-022 (MCP primitive — tool exposure this deliberately bypasses), ADR-241 (radio — pod comms; an OO agent is a natural pod member), ADR-004 (hosts)
**Source**: NOOA — *NVIDIA OO Agents: Native Python Object-Oriented Agents*, [NVIDIA-NeMo/labs-OO-Agents](https://github.com/NVIDIA-NeMo/labs-OO-Agents), [arXiv:2607.20709](https://arxiv.org/abs/2607.20709), Apache-2.0.

> NOOA's bet: stop representing prompts, tools, callbacks, and workflows as
> separate abstractions — the agent is a **class**. Fields are state, methods
> are capabilities, docstrings are prompts, type annotations are contracts,
> and a `...` body hands the method to the model, which acts by **writing
> code** in a REPL with `self` in scope. This ADR clones that model onto the
> metaharness stack with one deliberate substitution: the code-as-action
> sandbox is a Rust VM compiled to wasm32, so isolation is by construction
> rather than by guard lists.

## Context

NOOA (~19k lines of Python) demonstrates that collapsing the agent framework
into the host language's own class statement removes an entire layer of
schema/tool bookkeeping: methods and annotations ARE the callable interface;
testing, tracing, refactoring, and version control work like the rest of the
software. Its runtime executes model-written Python cells in a sandbox worker
(`runtime/sandbox/`) with REPL semantics: last-expression capture, namespace
persistence, `return_result()` as the loop-ending signal, typed I/O with
auto-retry.

Python-in-a-worker sandboxing is guard-list security (restricted builtins,
AST checks) — a large attack surface this repo would rather not inherit. We
already ship Rust→wasm as an isolation and portability primitive (kernel,
k3-kernel-bench), and a wasm cell VM gives the sandbox NO ambient authority
to guard in the first place.

## Decision

Ship **`@metaharness/oo-agents`** (TS, Apache-2.0 matching upstream) with an
embedded Rust crate (`crate/` → `wasm/ooa_cell_vm.wasm`, ~180 KB, no
wasm-bindgen, no dependencies):

1. **Cellscript VM (Rust→wasm32)** — a small deterministic imperative
   language (`let`/`if`/`while`/`for-in`, numbers/strings/arrays/objects,
   comparison/logic/arith, `print`, `len/push/keys/range/str/num`). REPL
   semantics faithful to NOOA's `cell_core.py`: last-expression value,
   explicit `return`, namespace persistence across cells,
   `return_result(v)` as the ExecutionSignal. **Fuel-bounded** — a runaway
   cell traps deterministically. The one window to the world is a single
   JSON host import: `self.method(args)` dispatches a capability,
   `self.field` reads state; host errors surface as cell errors the model
   sees. No filesystem, network, clock, randomness, or FFI exists in the
   language, so there is nothing to guard.
2. **OO runtime (TS)** — `Agent` base class (instance fields = state, methods
   = capabilities, `static doc` = system prompt, minimal events API);
   `agentic({doc, params, returns, maxCells, maxRetries, fuel})` declares a
   model-driven method (NOOA's `...` body — TS erases types, so contracts are
   explicit `Schema` values); `Runtime` drives the loop: seed args into the
   namespace as ordinary `let` cells, ask the `ModelDriver` for the next
   cell, execute, and on `return_result` validate against the return
   contract — a violation is fed back verbatim for NOOA's typed auto-retry.
3. **Driver seam** — `ModelDriver` is the only place a model enters.
   `ScriptedDriver` (deterministic) ships for tests and simulation;
   `renderContext` is the canonical prompt rendering a live driver would
   send. Live LLM drivers are host wiring (the kernel owns routing) and are
   deferred, with their cost/benefit to be measured, not assumed.

Verified: 5 native VM tests (REPL persistence, control flow, self bridge +
signal, fuel trap, signal unwinding) and 8 package tests including the
upstream README's SupportAgent triaging refunds end-to-end through the wasm
sandbox and the contract-retry path.

## What this is NOT

- Not a full NOOA port: no MCP bridge, skills registry, tracing viewer,
  storage snapshots, sub-agent spawning, or async capabilities (the wasm
  host import is synchronous; async belongs in the driver). Each is future
  work with its own justification.
- Cellscript is not Python. That is the point — the model writes a language
  whose interpreter we fully control and whose capability surface is exactly
  the agent's own methods. Whether frontier models write cellscript as
  readily as Python is an open empirical question for the live-driver ADR.
- No claim is inherited from NOOA's paper evaluations; this package's claims
  are its own tests.

## Consequences

- Generated harnesses gain an agent-definition style where the typed
  interface IS the class — composable with radio pods (ADR-241): an OO agent
  is a natural `PodAgent`, and `self`-bridge calls are natural worklog posts.
- The sandbox story strengthens: model-written code runs under wasm memory
  isolation + fuel, with a single auditable host boundary — aligned with the
  repo's default-deny posture (ADR-022) rather than exempted from it.
- Two wasm crates now ship in-tree (k3-kernel-bench, ooa-cell-vm); if a
  third appears, factor the packed-pointer ABI helpers into the kernel.
