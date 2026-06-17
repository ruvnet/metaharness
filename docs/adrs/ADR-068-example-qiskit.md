# ADR-068: example-qiskit — Quantum Computing SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Quantum computing is transitioning from a research curiosity to a cloud-accessible primitive. IBM Quantum Platform (formerly IBM Quantum Experience) is the most widely adopted entry point: it provides a REST API and a Python SDK (`qiskit-ibm-runtime`) that agents can call to build circuits, run simulations on noise-modelled fake backends, and — once verified — submit jobs to real QPUs.

Two capabilities make this an especially relevant MetaHarness showcase target:

1. **Verifiable local simulation before hardware spend.** IBM Qiskit Runtime's `fake_provider` module (e.g. `FakeManilaV2`, `FakeBrisbane`) and the `channel="local"` mode on `QiskitRuntimeService` enable full circuit execution against a hardware-noise snapshot without any credentials or QPU minutes. This maps directly onto ADR-050's verification-gate requirement: the harness must not submit to hardware until a local simulation gate passes.

2. **A mature REST API.** IBM Quantum Platform exposes a REST API at `https://quantum.cloud.ibm.com/api/v1/` (authenticated with an IAM bearer token derived from an IBM Cloud API key and a Cloud Resource Name). This is callable from any runtime — including Node.js — without the Python SDK, which makes it viable as the harness's wire protocol.

The MetaHarness ecosystem also includes the `ruqu-mcp` MCP server (ADR-008), which provides `ruqu_simulate`, `ruqu_verify`, and `ruqu_replay` tools. These tools are metaharness-native circuit tools that complement the IBM API: `ruqu_simulate` runs a local statevector simulation (n_qubits ≤ 16), `ruqu_verify` validates circuit structure and audit codes, and `ruqu_replay` re-executes a stored circuit for deterministic comparison. Pairing `ruqu` with the IBM REST API provides a coherent two-stage pipeline: verify locally with `ruqu`, then optionally submit to IBM hardware.

There is no official npm/JavaScript Qiskit SDK. The archived `qiskit-sdk-js` repository is unmaintained and does not support Qiskit Runtime. The harness therefore uses Node.js `fetch` (built-in, Node >=18) to call the IBM Quantum REST API directly, and spawns a Python subprocess for circuit construction tasks that require `qiskit` circuit builders — or alternatively generates OpenQASM 3 strings directly (a text format easily constructed in JavaScript).

## Decision

### Chosen SDK and transport

- **Primary SDK (Python, via subprocess or pre-generated QASM)**: `qiskit-ibm-runtime` v0.47.0+ (PyPI, Apache-2.0). Provides `QiskitRuntimeService`, `SamplerV2`, `EstimatorV2`, and `qiskit_ibm_runtime.fake_provider` backends for local simulation.
- **Wire protocol (Node.js scaffold)**: IBM Quantum Platform REST API at `https://quantum.cloud.ibm.com/api/v1/`. Authentication via IAM bearer token (exchanged from an API key at `https://iam.cloud.ibm.com/identity/token`). Required headers: `Authorization: Bearer <TOKEN>`, `Service-CRN: <CRN>`, `IBM-API-Version: <YYYY-MM-DD>`.
- **MetaHarness-native quantum layer**: `ruqu-mcp` MCP server tools — `ruqu_simulate`, `ruqu_verify`, `ruqu_replay` — for local simulation and audit within the harness.

### Headline capability showcased

Build a parameterised quantum circuit (Bell state or variational ansatz) as an OpenQASM 3 string, verify it locally with `ruqu_simulate` and then against a `FakeManilaV2` or `FakeBrisbane` noise model (via the Python SDK subprocess), and present the simulation result with confidence metrics before any hardware submission is considered.

### Agent and skill design

Three specialized agents are defined:

| Agent | Role | Model tier |
|---|---|---|
| `circuit-planner` | Translates a natural-language quantum task (e.g. "Bell state on 2 qubits") into an OpenQASM 3 circuit string and a parameter manifest | Frontier (Sonnet/Opus) |
| `sim-executor` | Calls `ruqu_simulate` on the circuit; calls IBM REST API's `/jobs` endpoint with a fake backend (local test mode) to get noisy bitstring distributions; collects both results | Cheap (Haiku) |
| `verify-reporter` | Compares statevector ideal probabilities from `ruqu_verify` against the noisy fake-backend results; computes KL divergence; gates hardware submission; formats the final report | Frontier (Sonnet/Opus) |

The `/qiskit` slash command drives the full pipeline: plan circuit → simulate locally → verify against noise model → report gate fidelity, with hardware submission disabled unless `--submit-to-hardware` is explicitly passed.

### Routing tiers (ADR-026)

| Tier | Handler | Tasks in this example |
|---|---|---|
| 1 | Agent Booster (WASM, <1ms) | OpenQASM 3 string templating for known circuit types (Bell state, GHZ, single-qubit gates) |
| 2 | Haiku (~500ms, $0.0002) | sim-executor: REST API calls, JSON result parsing, bitstring distribution formatting |
| 3 | Sonnet/Opus (2–5s, $0.003–0.015) | circuit-planner (NL → QASM), verify-reporter (fidelity analysis, gate decisions) |

### MCP policy (`.harness/mcp-policy.json`) — granted tools only

The policy follows ADR-022 default-deny. Granted tools for this example:

```json
{
  "default": "deny",
  "audit_log": ".harness/mcp-audit.jsonl",
  "grants": [
    { "tool": "ruqu_simulate",  "reason": "local statevector simulation — no hardware, no credentials" },
    { "tool": "ruqu_verify",    "reason": "circuit structure validation and audit-code checking" },
    { "tool": "ruqu_replay",    "reason": "deterministic re-execution for verification gate" },
    { "tool": "fetch",          "reason": "IBM Quantum REST API calls (backends list, job submit, job status)" },
    { "tool": "read_file",      "reason": "read QASM circuit files from working directory" },
    { "tool": "write_file",     "reason": "write simulation results and circuit artefacts to .harness/output/" }
  ]
}
```

All MCP tool invocations are written to `.harness/mcp-audit.jsonl` with timestamp, tool name, circuit ID (content-derived, ≤256 bytes as required by the ruqu-mcp server spec), and result summary.

### Auth model

| Credential | Env var | Source |
|---|---|---|
| IBM Quantum Platform API key | `QISKIT_IBM_TOKEN` | IBM Quantum Platform dashboard → API keys |
| IBM Cloud Resource Name | `QISKIT_IBM_INSTANCE` | IBM Cloud console → Quantum Computing service instance |
| Channel (optional) | `QISKIT_IBM_CHANNEL` | Defaults to `ibm_quantum_platform` |
| REST API token (for direct REST calls) | `IQP_API_TOKEN` | Same 44-character key as above, used directly with REST IAM exchange |

No credentials are required for local simulation mode. When `QISKIT_IBM_TOKEN` is absent, the harness automatically falls back to `ruqu_simulate` + `FakeManilaV2` local-only mode and will not attempt any IBM network call.

### Safety gates

1. **Local-first by default.** The scaffold runs `ruqu_simulate` and the fake-backend noise check before any IBM API call. IBM API calls are only made to fetch the `GET /backends` list (read-only) unless `--submit-to-hardware` is passed.
2. **Hardware submission is opt-in.** The `POST /jobs` endpoint is gated behind the `--submit-to-hardware` flag in the `/qiskit` command. Without the flag, the command always exits after the local verification stage with a "ready for hardware" status message but does not submit.
3. **No credential leak.** `QISKIT_IBM_TOKEN` and `IQP_API_TOKEN` are read from environment; no scaffolded file contains a token value or a token placeholder that would prompt a user to paste credentials into code.
4. **qubit budget.** `ruqu_simulate` enforces `n_qubits ≤ 16` (per the ruqu-mcp v0.0 spec). Circuits exceeding this are rejected locally before any IBM call.
5. **Circuit ID provenance.** The `circuit.id` passed to `ruqu_*` tools must be content-derived (SHA-256 of the QASM string, truncated to ≤256 bytes) to satisfy the ruqu-mcp audit requirement and to enable deterministic replay.

## Consequences

### Positive

- Demonstrates a fully verifiable quantum workflow: NL intent → QASM → local statevector → noisy fake-backend → (optional) real QPU — matching ADR-050's verification-gate pattern precisely.
- The two-layer simulation (ideal `ruqu_simulate` + noisy `FakeManilaV2`) gives a developer quantifiable signal about circuit fidelity before spending QPU minutes, which is the single most valuable step in any quantum development workflow.
- Uses only stable, documented interfaces: IBM Quantum REST API (versioned, `IBM-API-Version` header), `ruqu-mcp` v0.0 (ADR-008), and `qiskit_ibm_runtime.fake_provider` (ships with every `qiskit-ibm-runtime` install).
- MCP surface is minimal (6 granted tools); all calls are audited; hardware submission is off by default — the example can be run safely in a CI environment with no IBM credentials at all.

### Limitations

- **No official Node.js Qiskit SDK.** Circuit construction from JavaScript requires either pre-authoring OpenQASM 3 strings (feasible for common patterns), or shelling out to a local Python/Qiskit process. The scaffold documents both approaches but cannot guarantee a Python environment on the target machine.
- **QPU access requires a paid IBM Cloud plan.** The free Open Plan provides limited QPU minutes and longer queue times. Local simulation (the default) is always free.
- **ruqu-mcp v0.0 stub limitations.** `ruqu_optimize` and `ruqu_qec_schedule` are stubs in the current release (per ADR-008). The example does not claim error-correction scheduling capability.
- **Not for production quantum computation.** This example is an illustrative scaffold, not a production quantum computing framework. Results from the fake backends are noisy simulations, not certified QPU output. No claim of scientific accuracy is made.

### Disclaimer

This example is **illustrative only**. It is not a certified quantum computing environment and is not intended for use in production scientific, financial, pharmaceutical, or cryptographic workloads. QPU results are probabilistic; local simulation results are approximations. IBM Quantum Platform usage is subject to IBM's terms of service and available QPU quotas.
