# ADR-066: example-iot — IoT / Robotics SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

IoT and robotics are the physical-world frontier of agentic AI: devices publish
continuous sensor streams, and agents that can subscribe, interpret, and — with
appropriate safeguards — command those devices close the loop between digital
intelligence and physical systems. This is also the risk frontier: an agent that
sends an unsolicited actuate command to a robot arm or HVAC controller can cause
hardware damage or injury. The gap between "demo that reads a topic" and "harness
that can safely actuate" is exactly the design problem this example must address.

Two npm packages cover the realistic surface an agent harness needs:

- **`mqtt`** (package name: `mqtt`, current version 5.15.1, published March 2026)
  is the de-facto Node.js MQTT client. Version 5 is a full TypeScript rewrite
  supporting ESM (`import { connect } from "mqtt"`), MQTT protocol versions 3.1,
  3.1.1, and 5.0, QoS 0/1/2, TLS/WSS, and broker auth via `{ username, password }`
  connect options. It has no built-in dry-run mode; application-level read-only
  discipline (subscribe only; no publish/actuate unless explicitly opted in) is the
  correct safety boundary.

- **`roslib`** (package name: `roslib`, current version 1.4.1, December 2023) is
  the JavaScript client for ROS 2 via the `rosbridge_suite` WebSocket bridge. It
  supports ESM (`import { Ros, Topic, Service } from "roslib"`), connects to a
  `rosbridge_server` WebSocket (default `ws://localhost:9090`), and exposes
  `Topic.subscribe()`, `Topic.publish()`, and `Service.callService()`. The bridge
  itself (`rosbridge_server`) is a Python/ROS 2 package installed on the robot;
  `roslib` is the browser/Node side. This package is not a managed cloud service
  and has no sandbox mode — safety again relies on application-level gatekeeping.

There is no official "MQTT test mode" analogous to Stripe test keys. Instead the
community provides free public brokers (`broker.hivemq.com`, `test.mosquitto.org`,
`broker.emqx.io`) that are explicitly not-for-production and suitable for
development telemetry testing. HiveMQ Cloud also offers a free tier (up to 100
MQTT clients) with credential-gated access for more persistent testing. For the
rosbridge path, any local or CI ROS 2 environment running `rosbridge_server` serves
as the sandbox.

Three realistic agent-driving capabilities justify this example in the catalog:

1. **Telemetry subscription and interpretation** — subscribe to device topics
   (e.g., `devices/<id>/telemetry`, `/robot/battery_state`, `/robot/imu/data`),
   parse JSON or ROS message payloads, and have an agent reason over the stream
   (anomaly detection, threshold alerts, fleet health summaries).
2. **Guarded actuation** — publish to command topics (`devices/<id>/commands`,
   `/robot/cmd_vel`, `/robot/gripper/cmd`) only after passing a multi-stage
   safety gate: schema validation, velocity/force bounds checking, explicit
   operator opt-in flag (`ALLOW_ACTUATION=true`), and a read-back verification
   step.
3. **Fleet-wide summarisation** — fan out subscriptions across N device topic
   namespaces in parallel, aggregate telemetry, and produce a structured fleet
   health report; this is a natural swarm-coordination use case.

## Decision

Ship `@metaharness/example-iot` as `examples-packages/example-iot/`, implementing
the ADR-051 shared contract with IoT/robotics-specific choices described below.

### Chosen SDKs and rationale

**Primary: `mqtt` v5.x** — the only broadly-maintained, TypeScript-native MQTT
client for Node.js; 3,500+ dependent packages; actively maintained (v5.15.1 as of
March 2026). ESM import: `import { connect } from "mqtt"`. Auth options:
`{ username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD }`.
Broker URL from `MQTT_BROKER_URL` (default `mqtt://broker.hivemq.com` for zero-
credential testing).

**Secondary: `roslib` v1.4.x** — the standard JavaScript/Node rosbridge client;
integrates with any ROS 2 system running `rosbridge_server`. ESM import:
`import { Ros, Topic } from "roslib"`. WebSocket URL from `ROS_BRIDGE_URL`
(default `ws://localhost:9090`). `roslib` is an optional peer — the scaffold
generates the rosbridge integration layer but the agent can operate on MQTT alone
if no ROS 2 environment is present.

### Headline capability

Subscribe to MQTT device telemetry, interpret the stream with a tiered model pair,
and — when the operator explicitly opts in via `ALLOW_ACTUATION=true` — publish
a command message that has passed schema validation, safety-bound checking, and
QoS-1 delivery confirmation. The same agent pattern applies to the ROS 2 path
via `roslib` with `/robot/cmd_vel` or `/robot/gripper/cmd` topics.

### Agent and skill design

Three specialised agents, each with a clear scope boundary:

| Agent | Role | Tier |
|---|---|---|
| **telemetry-monitor** | Subscribes to device/sensor topics; buffers and pre-filters the stream; emits structured `TelemetryEvent` records to shared memory | Tier 1 (cheap: extraction only) |
| **fleet-planner** | Reads buffered events; reasons about anomalies, trends, and recommended actions; emits an `ActionProposal` | Tier 2 (frontier: reasoning/decisions) |
| **actuation-executor** | Receives an `ActionProposal`; validates bounds; checks `ALLOW_ACTUATION`; publishes command; reads back confirmation; emits `ActuationResult` | Tier 1 for schema check; Tier 2 only if bounds check fails and re-evaluation is needed |

Slash command exposed: **`/iot-telemetry`** — ingests a topic pattern, subscribes
for a configurable window (default 30 s), passes the aggregated stream to
`fleet-planner` for interpretation, and returns a structured health report. Actuation
is not triggered from this command; it requires a separate explicit `--actuate`
flag or a direct `ActionProposal` with `ALLOW_ACTUATION=true` in the environment.

### Tiered model routing (ADR-026)

| Tier | Model | When used |
|---|---|---|
| **Tier 1 (cheap)** | Haiku / fastest available | JSON extraction from raw MQTT payloads; topic pattern expansion; schema validation; pre-filter rule evaluation |
| **Tier 2 (frontier)** | Sonnet / frontier | Anomaly reasoning over aggregated telemetry; generating `ActionProposal` with justification; re-evaluation when safety bounds are unclear |

The `telemetry-monitor` agent runs entirely at Tier 1. `fleet-planner` escalates to
Tier 2 only when it emits an `ActionProposal` (not for routine healthy-stream
summarisation). `actuation-executor` stays at Tier 1 for the deterministic bounds
check; Tier 2 is never invoked for the physical actuation step itself — the safety
gate is code, not a model.

### MCP policy — granted tools

The generated `.harness/mcp-policy.json` enables only the minimum surface:

```json
{
  "defaultDeny": true,
  "allowNetwork": true,
  "allowShell": false,
  "allowFileWrite": false,
  "requireApprovalForDangerous": true,
  "toolTimeoutMs": 30000,
  "maxToolCallsPerTurn": 8,
  "auditLog": true,
  "grantedTools": [
    "iot__mqtt_subscribe",
    "iot__mqtt_publish",
    "iot__ros_subscribe",
    "iot__ros_call_service",
    "iot__fleet_status",
    "iot__safety_check"
  ],
  "dangerousTools": [
    "iot__mqtt_publish",
    "iot__ros_call_service"
  ]
}
```

`iot__mqtt_publish` and `iot__ros_call_service` are flagged `dangerous` and
require `requireApprovalForDangerous: true` — they will not fire without the
`ALLOW_ACTUATION=true` environment gate **and** operator approval in interactive
hosts (Claude Code, Codex, OpenCode). In non-interactive hosts (GitHub Actions,
hermes) they are blocked entirely unless the workflow explicitly sets the env var
and configures auto-approval.

### Auth model

All credentials are sourced from environment variables only — never written to
scaffolded files:

| Variable | Purpose | Where to get it |
|---|---|---|
| `MQTT_BROKER_URL` | Full broker URL, e.g. `mqtts://abc123.hivemq.cloud:8883` | Broker console or `mqtt://broker.hivemq.com` for public testing |
| `MQTT_USERNAME` | MQTT auth username | HiveMQ Cloud console → Access Management; leave unset for public broker |
| `MQTT_PASSWORD` | MQTT auth password | HiveMQ Cloud console → Access Management; leave unset for public broker |
| `ROS_BRIDGE_URL` | rosbridge WebSocket, e.g. `ws://robot.local:9090` | Local ROS 2 system running `rosbridge_server` |
| `ALLOW_ACTUATION` | Opt-in gate for publish/actuate | Set `true` only when safe to send commands |
| `MQTT_TOPIC_PREFIX` | Device namespace prefix, e.g. `devices/lab-a` | Application-specific |

No API key management service is required for the public broker path, making the
zero-credential quickstart honest.

### Safety gates (non-negotiable)

1. **Read-only by default.** The scaffold wires the agent in subscribe-only mode.
   `iot__mqtt_publish` and `iot__ros_call_service` are not callable unless
   `ALLOW_ACTUATION=true` is set in the environment.
2. **Bounds checking before every actuate.** `actuation-executor` runs a
   deterministic `safety_check` (velocity limits, force caps, topic allowlist)
   in code before any publish. A check failure aborts and is logged; it never
   escalates to Tier 2 for a "second opinion" on a safety decision.
3. **QoS 1 for commands.** Actuation publishes use `{ qos: 1 }` — at-least-once
   delivery with broker acknowledgement — to ensure the command is not silently
   dropped.
4. **Read-back verification (ADR-050).** After publishing a command, the executor
   subscribes to a status/feedback topic (e.g. `devices/<id>/status`) for a
   configurable window (default 5 s) and confirms the device acknowledged the
   command before reporting success. If no acknowledgement arrives, it reports
   `UNVERIFIED` — never `DONE`.
5. **Topic allowlist.** The MCP policy's `grantedTools` scope limits which topic
   patterns the agent can publish to. Wildcard publishes are not permitted by the
   generated tool schema.
6. **No secrets in scaffolded files.** The scaffold emits `.env.example` with
   placeholder values and a `.gitignore` entry for `.env`. Real credentials live
   only in the operator's environment.

### Verification gate (ADR-050)

The `verify` step: after `actuation-executor` publishes a command (opt-in path),
it calls `iot__fleet_status` on the target device and compares the returned state
against the expected post-command state. If state matches within tolerance → `DONE`.
If not → `UNVERIFIED` with a diff logged to the audit trail. For the read-only
(telemetry-only) path, `verify` re-subscribes to the same topic for 5 s and
confirms that at least one message arrived in the expected schema — ensuring the
subscription itself is live and the device is actually publishing.

### Cross-host scaffold (ADR-051 §2)

`--host <id>` (default `claude-code`) / `--host all` delegates to `metaharness`
CLI + `@metaharness/host-<id>`. All nine hosts are supported:
`claude-code`, `codex`, `copilot`, `github-actions`, `hermes`, `openclaw`,
`opencode`, `pi-dev`, `rvm`.

## Consequences

### Positive

- Demonstrates the hardest dimension of IoT agent design — safe actuation with a
  non-bypassable gate — as a one-command scaffold, replacing a weekend of bespoke
  wiring.
- The three-agent pattern (monitor / planner / executor) is reusable as a template
  for any physical-world domain (industrial sensors, smart building, edge robotics).
- The zero-credential quickstart (public MQTT broker, subscribe-only) lowers the
  barrier to entry without requiring a paid account.
- Fleet-wide fan-out with claim-TTL (swarm coordination) is a natural fit for MQTT
  multi-device scenarios and showcases that metaharness capability concretely.

### Limitations

- **No native MQTT dry-run exists** in the broker or the `mqtt` npm package.
  Safety is enforced by application-level read-only discipline, not a protocol
  feature. This is documented prominently — operators must trust the `ALLOW_ACTUATION`
  gate is the actual safety boundary.
- **`roslib` requires a live rosbridge server.** The rosbridge integration cannot
  be exercised without a running ROS 2 environment. The scaffold generates the
  integration layer but marks it as requiring `rosbridge_server` to be installed
  separately on the robot host.
- **Public test brokers are not production-grade.** `broker.hivemq.com` and
  `test.mosquitto.org` carry explicit not-for-production warnings from their
  operators. Real deployments require a private or managed broker.
- **Physical safety is out of scope.** The harness enforces software-level safety
  gates; physical interlocks (emergency stops, hardware watchdogs, safety PLCs)
  are the responsibility of the robotics system operator. This example is NOT a
  certified safety system and MUST NOT be used to control safety-critical physical
  systems without appropriate hardware interlocks.

### Not-for-production disclaimer

This example is **illustrative**. It is not certified for use in safety-critical
environments. Do not connect it to systems where an unexpected actuation could
cause injury, property damage, or loss of life. Physical safety interlocks
independent of this software are mandatory for any real deployment.
