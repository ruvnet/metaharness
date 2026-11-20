#!/usr/bin/env python3
"""Replay every declared task through the real OpenEnv WebSocket protocol.

Four episodes per task, with a hard ceiling of 200 total episodes:
  1. Declared example actions terminate at reward zero.
  2. Independent oracle derived only from public observations/files earns one.
  3. A type-preserving incorrect answer earns less than one.
  4. The same seed reproduces the public reset and files and earns one again.

This is a runtime/source-protocol acceptance check, not a model evaluation.
Run against a separately started server or an anonymously pulled image:
  python scripts/replay_native.py --url http://127.0.0.1:8000 --output report.json
No credentials, privileged endpoints, generated expected answers, or model APIs
are read. The report does not contain prompts, virtual files, or oracle answers.
"""

from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import sys
import time
from typing import Any
import urllib.parse
import urllib.request

from websockets.sync.client import connect


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Import only the independent file-based oracle, never make_task or grade.
from arena_env.tasks import oracle_answer, parse_task_id  # noqa: E402


OPENENV_REVISION = "86a180ede21e044f7929b9a7783ad83aa67d83a3"
CONTROLS = ("declared_examples", "observed_file_oracle", "wrong_answer", "seeded_reset_replay")
FORBIDDEN_OBSERVATION_KEYS = {"expected", "rubric", "answer", "seed"}


class ReplayFailure(RuntimeError):
    """A concrete protocol or task acceptance invariant failed."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReplayFailure(message)


def digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def endpoints(url: str) -> tuple[str, str]:
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme in ("http", "https") and bool(parsed.hostname), "--url must be an HTTP(S) server URL")
    require(parsed.username is None and parsed.password is None, "Credentials are forbidden in --url")
    require(not parsed.query and not parsed.fragment, "Query strings and fragments are forbidden in --url")
    base = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))
    websocket = urllib.parse.urlunsplit(("wss" if parsed.scheme == "https" else "ws", parsed.netloc,
                                        parsed.path.rstrip("/") + "/ws", "", ""))
    return base, websocket


def http_json(url: str) -> dict:
    # Disable environment proxy discovery: these credential-free checks target
    # the explicit server only and never attach proxy authorization headers.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=10) as response:
        require(response.status == 200, "HTTP endpoint did not return 200")
        payload = response.read(1_048_577)
    require(len(payload) <= 1_048_576, "HTTP payload exceeds one MiB")
    result = json.loads(payload)
    require(type(result) is dict, "HTTP endpoint must return a JSON object")
    return result


def exchange(socket, message_type: str, data: dict) -> dict:
    """Pinned OpenEnv wire format from http_server.py and serialization.py."""
    socket.send(json.dumps({"type": message_type, "data": data}, allow_nan=False))
    message = json.loads(socket.recv(timeout=15))
    require(type(message) is dict and message.get("type") == "observation", "Expected a native observation envelope")
    result = message.get("data")
    require(type(result) is dict, "Observation envelope has no data object")
    require(type(result.get("done")) is bool, "Observation done must be a boolean")
    reward = result.get("reward")
    require(type(reward) in (int, float) and math.isfinite(reward) and 0 <= reward <= 1,
            "Observation reward must be finite and between zero and one")
    observation = result.get("observation")
    require(type(observation) is dict, "Native data.observation object is missing")
    require(not FORBIDDEN_OBSERVATION_KEYS.intersection(observation), "Private verifier data leaked into an observation")
    require(not observation.get("error"), "Environment returned an observation error")
    return result


def read_public_task(socket, reset: dict) -> tuple[dict, dict]:
    result = exchange(socket, "step", {"op": "read", "path": "*"})
    require(not result["done"] and result["reward"] == 0, "Reading source files must not terminate or reward")
    observation = reset["observation"]
    family = observation.get("task_id")
    require(type(family) is str and bool(family), "Reset did not identify the task family")
    content = result["observation"].get("content")
    require(type(content) is str, "Virtual file read did not return textual content")
    files = json.loads(content)
    require(type(files) is dict and len(files) == 3 and all(type(k) is str and type(v) is str for k, v in files.items()),
            "Virtual workspace must contain three textual files")
    require(sorted(files) == observation.get("files"), "Read files disagree with the reset file listing")
    require(sum(len(value.encode()) for value in files.values()) <= 16_384, "Virtual workspace exceeds replay budget")
    # No seed, expected answer, private rubric, or generator invocation enters
    # this oracle input. Everything below came over the native WebSocket.
    public_task = {"task_id": family, "prompt": observation.get("prompt", ""), "files": files}
    fingerprint = {"reset_sha256": digest(reset), "files_sha256": digest(files),
                   "virtual_file_count": len(files), "virtual_file_bytes": sum(len(v.encode()) for v in files.values())}
    return public_task, fingerprint


def incorrect_answer(answer: dict) -> dict:
    """Change one actual semantic value while preserving JSON value types."""
    def change(value: Any) -> Any:
        if type(value) is int:
            return value + 1
        if type(value) is str:
            return value + "_incorrect"
        if type(value) is list and value:
            return [change(value[0]), *copy.deepcopy(value[1:])]
        if type(value) is dict and value:
            result = copy.deepcopy(value)
            key = sorted(result)[0]
            result[key] = change(result[key])
            return result
        raise ReplayFailure("Could not construct a type-preserving wrong answer")
    result = copy.deepcopy(answer)
    for key in sorted(result):
        try:
            result[key] = change(result[key])
            require(result != answer, "Wrong-answer control did not change a value")
            return result
        except ReplayFailure:
            continue
    raise ReplayFailure("Oracle answer has no mutable semantic value")


def run_episode(websocket_url: str, declared_id: str, seed: int, control: str,
                examples: list, reference: dict | None) -> tuple[dict, dict | None]:
    started = time.perf_counter()
    with connect(websocket_url, proxy=None, open_timeout=10, close_timeout=3, max_size=1_048_576) as socket:
        reset = exchange(socket, "reset", {"task_id": declared_id, "seed": seed})
        require(not reset["done"] and reset["reward"] == 0, "Reset must begin an unrewarded nonterminal episode")
        family = parse_task_id(declared_id)[0]
        require(reset["observation"].get("task_id") == family, "Server reset selected a different task family")
        require(type(reset["observation"].get("prompt")) is str and bool(reset["observation"]["prompt"]),
                "Reset prompt is missing")
        fingerprint = None
        if control == "declared_examples":
            terminal = reset
            for index, action in enumerate(examples):
                require(not terminal["done"], "Declared example sequence terminated before its last action")
                terminal = exchange(socket, "step", action)
            action_count = len(examples)
            require(terminal["done"] and terminal["reward"] == 0, "Declared examples must terminate at reward zero")
        else:
            public_task, fingerprint = read_public_task(socket, reset)
            answer = oracle_answer(public_task)
            if control == "seeded_reset_replay":
                require(reference is not None, "Seed consistency reference is unavailable")
                require(fingerprint == reference, "Identical task ID and seed changed public reset or file contents")
            if control == "wrong_answer":
                answer = incorrect_answer(answer)
            terminal = exchange(socket, "step", {"op": "submit", "answer": answer})
            action_count = 2
            require(terminal["done"], "Submit must terminate the episode")
            if control == "wrong_answer":
                require(terminal["reward"] < 1, "Incorrect semantic answer received full reward")
            else:
                require(terminal["reward"] == 1, "Oracle from public source files did not receive reward one")
    record = {"control": control, "status": "passed", "terminal": terminal["done"],
              "reward": terminal["reward"], "action_count": action_count,
              "elapsed_seconds": round(time.perf_counter() - started, 6)}
    if fingerprint is not None:
        record.update(fingerprint)
        record["oracle_input"] = "public_reset_and_virtual_file_observations_only"
    return record, fingerprint


def replay(url: str, tasks_path: Path = ROOT / "tasks.json") -> dict:
    started = time.perf_counter()
    base, websocket_url = endpoints(url)
    task_manifest = json.loads(tasks_path.read_text())
    tasks = task_manifest.get("tasks")
    require(type(tasks) is list and bool(tasks), "tasks.json has no declared tasks")
    declared_ids = [row.get("task_id") for row in tasks]
    require(all(type(value) is str and value for value in declared_ids), "Task IDs must be nonempty strings")
    require(len(set(declared_ids)) == len(declared_ids), "Task IDs must be unique")
    require(len(declared_ids) * len(CONTROLS) <= 200, "Replay exceeds the 200-episode ceiling")
    for declared_id in declared_ids:
        parse_task_id(declared_id)
    examples = json.loads((ROOT / "example-actions.json").read_text())
    require(type(examples) is list and 1 <= len(examples) <= 16 and all(type(action) is dict for action in examples),
            "example-actions.json must contain 1..16 action objects")
    health = http_json(base + "/health")
    schema = http_json(base + "/schema")
    require({"action", "observation", "state"} <= schema.keys(), "Native schema endpoint is incomplete")
    evidence = {
        "evidence_kind": "native_runtime_protocol_replay",
        "is_model_benchmark": False,
        "private_arena_score": None,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "target": {"base_url": base, "health": health, "schema_sha256": digest(schema),
                   "server_revision_attested": False},
        "protocol": {"transport": "real_websocket", "endpoint": "/ws",
                     "openenv_revision_expected": OPENENV_REVISION,
                     "reference_source": f"https://github.com/meta-pytorch/OpenEnv/tree/{OPENENV_REVISION}/src/openenv/core/env_server",
                     "request_envelope": {"type": "reset|step", "data": "object"},
                     "response_envelope": "type=observation; data={observation,reward,done}",
                     "client_websockets_version": importlib.metadata.version("websockets")},
        "source_sha256": {**{name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                          for name in ("example-actions.json", "arena_env/tasks.py", "scripts/replay_native.py")},
                          "task_manifest": hashlib.sha256(tasks_path.read_bytes()).hexdigest()},
        "task_count": len(declared_ids), "episodes_expected": len(declared_ids) * len(CONTROLS),
        "episodes_attempted": 0, "episodes_passed": 0, "tasks": [],
        "limitations": ["Verifies runtime protocol and synthetic reward controls, not model transfer or leaderboard performance.",
                        "Source hashes identify the replay client; endpoint image identity must be attested separately by CI."],
    }
    for index, declared_id in enumerate(declared_ids):
        seed = 8_000_123 + index
        task_record = {"task_id": declared_id, "seed": seed, "episodes": []}
        reference = None
        for control in CONTROLS:
            evidence["episodes_attempted"] += 1
            try:
                record, fingerprint = run_episode(websocket_url, declared_id, seed, control, examples, reference)
                if control == "observed_file_oracle":
                    reference = fingerprint
                evidence["episodes_passed"] += 1
            except Exception as error:
                record = {"control": control, "status": "failed", "error_type": type(error).__name__,
                          "error": str(error)[:500]}
            task_record["episodes"].append(record)
        task_record["status"] = "passed" if all(e["status"] == "passed" for e in task_record["episodes"]) else "failed"
        evidence["tasks"].append(task_record)
    evidence["status"] = "passed" if evidence["episodes_passed"] == evidence["episodes_expected"] else "failed"
    evidence["elapsed_seconds"] = round(time.perf_counter() - started, 6)
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Running native OpenEnv server, without credentials")
    parser.add_argument("--output", required=True, type=Path, help="JSON evidence report path")
    parser.add_argument("--tasks-json", type=Path, default=ROOT / "tasks.json", help="Explicit task manifest, at most 50 tasks")
    args = parser.parse_args()
    try:
        report = replay(args.url, args.tasks_json)
    except Exception as error:
        report = {"evidence_kind": "native_runtime_protocol_replay", "is_model_benchmark": False,
                  "private_arena_score": None, "status": "failed", "error_type": type(error).__name__,
                  "error": str(error)[:500]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n")
    print(json.dumps({"status": report["status"], "task_count": report.get("task_count", 0),
                      "episodes_passed": report.get("episodes_passed", 0),
                      "episodes_expected": report.get("episodes_expected", 0), "output": str(args.output)}))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
