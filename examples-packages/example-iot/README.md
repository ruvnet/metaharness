# @metaharness/example-iot

**IoT and robotics telemetry agent with guarded actuation — scaffold in one command.**

> **Illustrative output notice:** The agents, prompts, and tool calls generated
> by this scaffold are examples of what a metaharness IoT harness *could* do.
> They are not a certified safety system. Do not use this harness to control
> safety-critical physical systems without independent hardware interlocks and
> qualified engineering review.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-iot.svg)](https://www.npmjs.com/package/@metaharness/example-iot)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-iot.svg)](https://www.npmjs.com/package/@metaharness/example-iot)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![built with metaharness](https://img.shields.io/badge/built%20with-metaharness-blueviolet)](https://github.com/ruvnet/agent-harness-generator)

---

## Intro

`@metaharness/example-iot` scaffolds an AI agent harness pre-wired to:

- **`mqtt` v5** (ESM, TypeScript-native) for MQTT broker connectivity — subscribe to device telemetry and, when you explicitly opt in, publish actuation commands.
- **`roslib` v1.4** for ROS 2 integration via `rosbridge_server` — subscribe to and publish ROS topics from a Node.js agent without requiring a native ROS installation on the agent host.

**What it IS:** a starting point that shows how to connect an agent harness to real IoT infrastructure, reason over a live telemetry stream, and send commands with a non-bypassable safety gate.

**What it is NOT:** a certified safety system, a production SCADA replacement, a hardware fault-tolerant controller, or a substitute for physical emergency stops. Do not connect this to any system where an unexpected command could cause injury or damage.

---

## Features

| Capability | How it is demonstrated |
|---|---|
| **Tiered model routing** | Tier 1 (Haiku/cheap) for JSON extraction and schema checks; Tier 2 (Sonnet/frontier) only for anomaly reasoning and action proposals |
| **MCP default-deny** | `.harness/mcp-policy.json` grants exactly six tools; publish and ROS service calls are flagged `dangerous` and require both `ALLOW_ACTUATION=true` and operator approval |
| **`/iot-telemetry` slash command** | Subscribe to a topic pattern for 30 s, aggregate the stream, return a structured fleet health report — no actuation triggered |
| **Three specialised agents** | `telemetry-monitor` (subscribe/buffer), `fleet-planner` (reason/propose), `actuation-executor` (bounds-check/publish/verify) |
| **Verification gate** | After every actuation, reads back device status and compares to expected state; reports `UNVERIFIED` if no acknowledgement within 5 s |
| **Swarm fan-out** | For multi-device fleets, parallel claim-TTL subscriptions aggregate telemetry across N devices concurrently |
| **Read-only by default** | Publish and service-call tools are unreachable unless `ALLOW_ACTUATION=true` is set in the environment |
| **Cross-host scaffold** | `--host all` emits configs for claude-code, codex, copilot, github-actions, hermes, openclaw, opencode, pi-dev, rvm |

---

## Quickstart

```bash
npx @metaharness/example-iot@latest my-bot
cd my-bot
npm install
npm run doctor
```

This scaffolds the harness into `my-bot/`, installs dependencies, and runs the health check. With default settings (no credentials, public broker, read-only mode) the doctor check should pass immediately.

To scaffold for a specific host:

```bash
npx @metaharness/example-iot@latest my-bot --host codex
npx @metaharness/example-iot@latest my-bot --host all   # emit every host config
```

---

## Configuration

All credentials and behaviour flags are sourced from environment variables. The scaffold emits `.env.example` — copy it to `.env` (gitignored) and fill in your values.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MQTT_BROKER_URL` | `mqtt://broker.hivemq.com` | Full broker URL. Use `mqtts://` for TLS (port 8883) with a managed broker. The default public HiveMQ broker requires no credentials and is suitable for development testing only. |
| `MQTT_USERNAME` | _(unset)_ | MQTT auth username. Required for HiveMQ Cloud or any credential-gated broker. |
| `MQTT_PASSWORD` | _(unset)_ | MQTT auth password. Required for HiveMQ Cloud or any credential-gated broker. |
| `MQTT_TOPIC_PREFIX` | `devices/lab-a` | Namespace prefix for device topics, e.g. `devices/factory-floor`. |
| `ROS_BRIDGE_URL` | `ws://localhost:9090` | WebSocket URL of a running `rosbridge_server`. Only needed if you use the ROS 2 integration layer. |
| `ALLOW_ACTUATION` | _(unset / false)_ | Set to `true` to unlock the publish and ROS service-call tools. This is the only gate between the agent and physical commands. Do not set it in CI unless you intend to send real commands. |

### Where to get credentials

**Public broker (zero credentials — development only):**
Use the default `MQTT_BROKER_URL=mqtt://broker.hivemq.com`. HiveMQ explicitly states this broker must not be used in production, staging, or UAT environments.

**HiveMQ Cloud (free tier, up to 100 clients):**
1. Create a free account at [hivemq.com/products/mqtt-cloud-broker](https://www.hivemq.com/products/mqtt-cloud-broker/).
2. Create a cluster and note the cluster URL (format: `abc123.hivemq.cloud`).
3. Go to Access Management → Credentials → add a username/password pair.
4. Set `MQTT_BROKER_URL=mqtts://abc123.hivemq.cloud:8883`, `MQTT_USERNAME`, `MQTT_PASSWORD`.

**Mosquitto test broker (alternative):**
`MQTT_BROKER_URL=mqtt://test.mosquitto.org` — also public and not for production.

**ROS 2 / rosbridge:**
On the robot (or a ROS 2 dev machine), install and launch:
```bash
sudo apt install ros-<distro>-rosbridge-server
ros2 launch rosbridge_server rosbridge_websocket_launch.xml
```
Then set `ROS_BRIDGE_URL=ws://<robot-ip>:9090`.

### Sandbox / test mode

MQTT has no built-in test mode equivalent to Stripe test keys. The safe equivalent is:

1. Use a **public broker** (`broker.hivemq.com` or `test.mosquitto.org`) for development — completely isolated from any production infrastructure.
2. Keep `ALLOW_ACTUATION` unset (the default) — the agent can subscribe and read but cannot publish or call services.
3. Use a **dedicated MQTT topic namespace** (`MQTT_TOPIC_PREFIX=devices/dev`) so development traffic never reaches production device topics even if credentials are shared.

---

## Usage

### `/iot-telemetry` slash command

In any supported host, the `/iot-telemetry` command subscribes to device topics matching `$MQTT_TOPIC_PREFIX/+/telemetry` for 30 seconds, aggregates the stream, and returns a fleet health report. No actuation is triggered.

```
/iot-telemetry
```

Or with a custom topic pattern:

```
/iot-telemetry --topic "factory/line-2/+/status" --window 60
```

### Representative natural-language prompts

**Read-only telemetry (default, safe):**
```
Subscribe to the lab-a device fleet for 30 seconds and tell me which sensors
are outside their normal operating range.
```

**Fleet health summary:**
```
Give me a health report for all devices under devices/lab-a — include battery
levels, last-seen timestamps, and any anomalies in the IMU data.
```

**Guarded actuation (requires ALLOW_ACTUATION=true):**
```
The temperature sensor on devices/lab-a/sensor-03 shows 78°C — send a
cooling command to the HVAC controller at devices/lab-a/hvac-01/commands
and confirm it acknowledged.
```
The harness will: validate the command schema → run safety bounds check → publish at QoS 1 → wait for acknowledgement topic → report DONE or UNVERIFIED.

**ROS 2 robot telemetry:**
```
Subscribe to /robot/battery_state and /robot/imu/data for 20 seconds and
summarise the robot's current state.
```

---

## Safety

**Actuation is off by default.** The `iot__mqtt_publish` and `iot__ros_call_service`
MCP tools are flagged `dangerous` in `.harness/mcp-policy.json` and are unreachable
unless:
1. `ALLOW_ACTUATION=true` is set in the process environment, AND
2. The host's approval gate confirms the action (in interactive hosts like Claude Code).

**Bounds checking is in code, not in a model.** Before any publish, `actuation-executor`
runs a deterministic bounds check (velocity limits, force caps, topic allowlist). A
failed check aborts immediately — it is never passed to a frontier model for
re-evaluation.

**QoS 1 for commands.** Actuation publishes use `{ qos: 1 }` (at-least-once with
broker acknowledgement). Silent drops are treated as `UNVERIFIED`.

**Read-back verification.** After every actuation, the executor subscribes to the
device's status/feedback topic and waits up to 5 seconds for confirmation. If no
acknowledgement arrives, it reports `UNVERIFIED`, not `DONE`.

**No secrets in scaffolded files.** The scaffold emits `.env.example` with
placeholder values. Real credentials must be set in the operator's environment.
`.env` is added to `.gitignore` automatically.

**This is not a certified safety system.** Independent hardware interlocks
(emergency stops, watchdog timers, safety PLCs) are mandatory for any real
deployment controlling physical equipment.

---

## How it works

### Agents

```
telemetry-monitor  →  fleet-planner  →  actuation-executor
     (Tier 1)            (Tier 2)             (Tier 1)
```

- **`telemetry-monitor`**: subscribes to MQTT/ROS topics via `iot__mqtt_subscribe`
  or `iot__ros_subscribe`; parses JSON payloads; emits structured `TelemetryEvent`
  records to the harness memory namespace. Runs at Tier 1 — extraction only, no
  reasoning.
- **`fleet-planner`**: reads buffered `TelemetryEvent` records; applies Tier 2
  frontier reasoning to detect anomalies, trends, and threshold breaches; emits an
  `ActionProposal` (or a health report if no action is warranted).
- **`actuation-executor`**: receives an `ActionProposal`; runs the deterministic
  `iot__safety_check` bounds check; if `ALLOW_ACTUATION=true` and bounds pass,
  calls `iot__mqtt_publish` or `iot__ros_call_service`; reads back via
  `iot__fleet_status`; emits `ActuationResult` with DONE or UNVERIFIED.

### Tiered routing

| Tier | Model | Tasks |
|---|---|---|
| 1 (cheap) | Haiku or equivalent | JSON parsing, schema validation, topic pattern expansion, pre-filter rules, bounds checking |
| 2 (frontier) | Sonnet or equivalent | Anomaly reasoning over aggregated telemetry, generating justified `ActionProposal`, interpreting ambiguous sensor patterns |

The physical actuation step itself (publish / service call) is deterministic code
in `actuation-executor` — a frontier model is never in the critical path of
sending a command.

### MCP policy — granted tools

The generated `.harness/mcp-policy.json` grants exactly:

| Tool | Purpose | Dangerous? |
|---|---|---|
| `iot__mqtt_subscribe` | Subscribe to a topic pattern and receive messages | No |
| `iot__mqtt_publish` | Publish a command message to a topic | **Yes** |
| `iot__ros_subscribe` | Subscribe to a ROS topic via rosbridge | No |
| `iot__ros_call_service` | Call a ROS service via rosbridge | **Yes** |
| `iot__fleet_status` | Read current device status (read-back verification) | No |
| `iot__safety_check` | Run deterministic bounds/schema check against a proposed command | No |

All other MCP tools are denied. `defaultDeny: true` ensures that new tools added
to the host environment do not automatically gain access to the IoT surface.
The audit log records every tool call for post-incident review.

---

## Links

- **MQTT.js (mqtt npm package)**: https://github.com/mqttjs/MQTT.js — v5.15.1, ESM-native, TypeScript
- **mqtt on npm**: https://www.npmjs.com/package/mqtt
- **roslib on npm**: https://www.npmjs.com/package/roslib
- **rosbridge_suite (ROS 2)**: https://github.com/ros2/rosbridge_suite
- **HiveMQ public broker** (development only): https://www.hivemq.com/mqtt/public-mqtt-broker/
- **HiveMQ Cloud free tier**: https://www.hivemq.com/products/mqtt-cloud-broker/
- **Mosquitto test broker**: https://test.mosquitto.org
- **ADR-066** (this design): `docs/adrs/ADR-066-example-iot.md` in the generator repo
- **ADR-051** (examples program): `docs/adrs/ADR-051-third-party-sdk-showcase-examples.md`
- **metaharness repo**: https://github.com/ruvnet/agent-harness-generator
