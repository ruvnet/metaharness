#!/usr/bin/env python3
"""Reviewable OpenEnv Arena requests. Standard library only; no implicit submit/retry."""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://openenvarena-arena.hf.space/api/openenv"
MAX_RESPONSE = 2 * 1024 * 1024
ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
IMAGE_RE = re.compile(r"(?:ghcr\.io|docker\.io)/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}\Z")
DATASET_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*\Z")
LIMITS = {
    "reset_wall_s": (120, 300, 120), "rollout_wall_s": (1, 3600, 180),
    "verifier_wall_s": (1, 1800, 30), "tool_wall_s": (1, 120, 20),
    "tool_calls_total": (1, 1024, 16), "tool_calls_per_minute": (1, 60, 60),
    "completion_tokens": (1, 32768, 4096), "context_tokens": (1, 32768, 8192),
    "memory_gib": (1, 16, 2), "cpu_floor_vcpus": (1, 2, 1),
    "workspace_gib": (1, 44, 2),
}


class ContractError(ValueError):
    pass


class TransportError(RuntimeError):
    """No remote body or token is included in the exception."""
    def __init__(self, status: int | None, code: str = "REQUEST_FAILED"):
        self.status = status
        self.code = code if re.fullmatch(r"[A-Z_]{1,80}", code) else "REQUEST_FAILED"
        super().__init__(f"Arena request failed: HTTP {status or 'unknown'}, {self.code}")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise TransportError(code, "REDIRECT_REFUSED")


def canonical(value: object) -> bytes:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()
    except (ValueError, TypeError) as exc:
        raise ContractError("Request must be finite JSON") from exc


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def load_json(path: str | Path):
    try:
        return json.loads(Path(path).read_text(), parse_constant=lambda x: (_ for _ in ()).throw(ValueError("nonfinite JSON")))
    except (OSError, ValueError) as exc:
        raise ContractError("Cannot read valid JSON input") from exc


def atomic_json(path: str | Path, value: object) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, target)
        directory_fd = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextlib.contextmanager
def exclusive_receipt(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.with_name(path.name + ".lock")
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise ContractError("Receipt is locked; reconcile the original process before retrying") from exc
    try:
        os.close(fd)
        yield
    finally:
        lock.unlink()


def http_json(url: str, method: str = "GET", payload=None, token: str | None = None):
    if token and not url.startswith(BASE + "/"):
        raise ContractError("Authentication is restricted to the official Arena endpoint")
    headers = {"Accept": "application/json", "User-Agent": "metaharness-openenv-submission/1"}
    if token:
        headers["Authorization"] = "Bearer " + token
    body = canonical(payload) if payload is not None else None
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise TransportError(response.status, "RESPONSE_TOO_LARGE")
            try:
                return response.status, json.loads(raw)
            except (ValueError, UnicodeDecodeError) as exc:
                raise TransportError(response.status, "INVALID_JSON_RESPONSE") from exc
    except urllib.error.HTTPError as exc:
        code = "REQUEST_FAILED"
        try:
            value = json.loads(exc.read(MAX_RESPONSE))
            if isinstance(value, dict):
                code = value.get("code", code)
                if not isinstance(code, str):
                    code = "REQUEST_FAILED"
        except (ValueError, UnicodeDecodeError):
            pass
        raise TransportError(exc.code, code) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
        raise TransportError(None, "OUTCOME_UNKNOWN") from None


def fetch_schema(url: str, transport=http_json):
    parsed = urllib.parse.urlsplit(url)
    if parsed.username or parsed.password or parsed.fragment or parsed.query:
        raise ContractError("Schema URL must not contain credentials, query, or fragment")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}):
        raise ContractError("Schema URL must use HTTPS or loopback HTTP")
    if parsed.path.rstrip("/") != "/schema":
        raise ContractError("Schema URL must identify the live /schema endpoint")
    _, raw = transport(url)
    if not isinstance(raw, dict) or not all(isinstance(raw.get(k), dict) for k in ("action", "observation")):
        raise ContractError("Live schema must contain action and observation objects")
    return {k: raw[k] for k in ("action", "observation")}


def validate_task(task: dict) -> dict:
    if not isinstance(task, dict):
        raise ContractError("Each task must be an object")
    unknown = set(task) - ({"task_id", "split", "image"} | set(LIMITS))
    if unknown:
        raise ContractError("Task contains fields outside the live Arena contract")
    result = {k: default for k, (_, _, default) in LIMITS.items()}
    result.update(task)
    if not isinstance(result.get("task_id"), str) or not ID_RE.fullmatch(result["task_id"]):
        raise ContractError("Invalid task_id")
    if result.get("split", "train") not in ("train", "validation", "test"):
        raise ContractError("Unknown task split")
    result.setdefault("split", "train")
    if "image" in result and (not isinstance(result["image"], str) or not IMAGE_RE.fullmatch(result["image"])):
        raise ContractError("Task image requires a supported registry and explicit sha256 digest")
    for key, (lower, upper, _) in LIMITS.items():
        value = result[key]
        if type(value) is not int or not lower <= value <= upper:
            raise ContractError(f"{key} must be an integer from {lower} through {upper}")
    if sum(result[k] for k in ("reset_wall_s", "rollout_wall_s", "verifier_wall_s")) > 3600:
        raise ContractError("Reset, rollout and verifier wall time exceed 3600 seconds")
    return result


def validate_request(request: dict) -> dict:
    if not isinstance(request, dict):
        raise ContractError("Submission request must be an object")
    required = {"submission_id", "name", "image", "schema", "tasks", "example_actions", "dataset"}
    if not required <= set(request) or set(request) - required - {"source", "server_port", "finish_action"}:
        raise ContractError("Request fields do not match the supported live contract")
    if not isinstance(request["submission_id"], str) or not ID_RE.fullmatch(request["submission_id"]):
        raise ContractError("Invalid submission_id")
    if not isinstance(request["name"], str) or not 1 <= len(request["name"]) <= 200:
        raise ContractError("Submission name must contain 1 to 200 characters")
    if not isinstance(request["image"], str) or not IMAGE_RE.fullmatch(request["image"]):
        raise ContractError("Image requires ghcr.io or docker.io and explicit sha256 digest")
    if not isinstance(request["dataset"], str) or not DATASET_RE.fullmatch(request["dataset"]):
        raise ContractError("A real public dataset owner/name is required for a ranked submission")
    schema = request["schema"]
    if not isinstance(schema, dict) or set(schema) != {"action", "observation"} or not all(isinstance(v, dict) for v in schema.values()):
        raise ContractError("Schema must contain exactly action and observation from live /schema")
    tasks = request["tasks"]
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= 50:
        raise ContractError("Submission must contain 1 to 50 tasks")
    normalized = [validate_task(task) for task in tasks]
    if len({t["task_id"] for t in normalized}) != len(tasks):
        raise ContractError("Task IDs must be unique")
    if normalized != tasks:
        raise ContractError("Every task budget must be explicit; render the request first")
    if len({request["image"], *(t["image"] for t in tasks if "image" in t)}) > 50:
        raise ContractError("At most 50 distinct images are allowed")
    if not any(t["split"] == "train" for t in normalized):
        raise ContractError("At least one task must have the train split")
    actions = request["example_actions"]
    if not isinstance(actions, list) or not 1 <= len(actions) <= 16 or not all(isinstance(a, dict) for a in actions):
        raise ContractError("Provide 1 to 16 example action objects")
    for action in actions + ([request["finish_action"]] if "finish_action" in request else []):
        if not isinstance(action, dict) or action == {"finish": True} or (set(action) == {"action"} and isinstance(action["action"], dict)):
            raise ContractError("Example and finish actions must be native actions, not reserved wrappers")
    if "server_port" in request and (type(request["server_port"]) is not int or not 1 <= request["server_port"] <= 65535 or request["server_port"] == 49983):
        raise ContractError("Invalid or reserved server port")
    if "source" in request:
        if not isinstance(request["source"], str):
            raise ContractError("Source must be an HTTPS URL")
        source = urllib.parse.urlsplit(request["source"])
        if source.scheme != "https" or not source.hostname or source.username or source.password:
            raise ContractError("Source must be an HTTPS URL without credentials")
    canonical(request)
    return request


def render(args, transport=http_json) -> dict:
    tasks = load_json(args.tasks_json) if args.tasks_json else [{"task_id": name} for name in args.task_id]
    if isinstance(tasks, dict):
        tasks = tasks.get("tasks")
    if not isinstance(tasks, list):
        raise ContractError("Task input must be a list or an object with a tasks list")
    request = {
        "submission_id": args.submission_id, "name": args.name, "image": args.image,
        "dataset": args.dataset, "schema": fetch_schema(args.schema_url, transport),
        "tasks": [validate_task(task) for task in tasks],
        "example_actions": load_json(args.example_actions_json),
    }
    for field in ("source", "server_port"):
        if getattr(args, field, None) is not None:
            request[field] = getattr(args, field)
    if args.finish_action_json:
        request["finish_action"] = load_json(args.finish_action_json)
    validate_request(request)
    atomic_json(args.out, request)
    return {"mode": "dry-run", "submission_id": request["submission_id"], "request_sha256": digest(request), "tasks": len(request["tasks"]), "output": str(args.out), "submitted": False}


def token_from_environment() -> str:
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        raise ContractError("HF_TOKEN is absent; no authenticated request was sent")
    if any(ch.isspace() for ch in token) or len(token) > 4096:
        raise ContractError("HF_TOKEN has invalid format")
    return token


def timestamp() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def receipt_summary(response, submission_id: str) -> dict:
    if not isinstance(response, dict):
        raise TransportError(None, "INVALID_RESPONSE")
    if response.get("submission_id", submission_id) != submission_id:
        raise TransportError(None, "SUBMISSION_ID_MISMATCH")
    if response.get("state") not in {"validating", "validated", "rejected", "pending", "accepted"}:
        raise TransportError(None, "INVALID_SUBMISSION_STATE")
    result = {"submission_id": submission_id, "arena_state": response["state"]}
    slot = response.get("slot")
    if isinstance(slot, dict) and slot.get("state") in {"held", "used", "returned"}:
        result["slot_state"] = slot["state"]
    run = response.get("run")
    if isinstance(run, dict) and isinstance(run.get("run_id"), str) and ID_RE.fullmatch(run["run_id"]):
        result["run_id"] = run["run_id"]
    if response.get("error_origin") in {"author", "platform"}:
        result["error_origin"] = response["error_origin"]
    return result


def own_status(submission_id: str, token: str, transport=http_json):
    try:
        status, response = transport(BASE + "/submissions/" + urllib.parse.quote(submission_id, safe=""), token=token)
        if status != 200:
            raise TransportError(status, "STATUS_UNCERTAIN")
        return receipt_summary(response, submission_id)
    except TransportError as exc:
        if exc.status == 404:
            return None
        raise


def reconcile(receipt: dict, path: Path, token: str, transport=http_json) -> dict:
    try:
        found = own_status(receipt["submission_id"], token, transport)
        receipt["reconciled_at"] = timestamp()
        if found is None:
            receipt["state"] = "unconfirmed"
            receipt["next_action"] = "No POST sent. Recheck this same ID; do not create another ID while its outcome is unknown."
        else:
            receipt.update(found)
            receipt["state"] = "recorded"
            receipt.pop("next_action", None)
    except TransportError:
        receipt["state"] = "unknown"
        receipt["next_action"] = "Reconcile this same ID using the own-submission status endpoint; no retry was sent."
    atomic_json(path, receipt)
    return receipt


def submit(request: dict, approved_digest: str, receipt_path: str | Path, execute: bool = False, transport=http_json) -> dict:
    validate_request(request)
    actual_digest = digest(request)
    if not isinstance(approved_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", approved_digest) or approved_digest != actual_digest:
        raise ContractError("Request digest differs from the reviewed digest; render and review again")
    if not execute:
        return {"mode": "dry-run", "submission_id": request["submission_id"], "request_sha256": actual_digest, "submitted": False}
    token = token_from_environment()
    path = Path(receipt_path)
    with exclusive_receipt(path):
        if path.exists():
            receipt = load_json(path)
            if not isinstance(receipt, dict) or receipt.get("submission_id") != request["submission_id"] or receipt.get("request_sha256") != actual_digest:
                raise ContractError("Receipt belongs to a different request; no submission sent")
            return reconcile(receipt, path, token, transport)
        # Preflight checks the caller's own ID before any mutation. A network failure stops here.
        found = own_status(request["submission_id"], token, transport)
        receipt = {"submission_id": request["submission_id"], "request_sha256": actual_digest, "created_at": timestamp(), "state": "prepared", "post_attempted": False}
        if found is not None:
            receipt.update(found)
            receipt["state"] = "recorded"
            receipt["note"] = "Existing Arena ID discovered; its payload digest has not been verified. No POST sent."
            atomic_json(path, receipt)
            return receipt
        # Persist intention before sending so interruption never silently causes a second POST.
        receipt.update(state="sending", post_attempted=True)
        atomic_json(path, receipt)
        try:
            status, response = transport(BASE + "/submissions", method="POST", payload=request, token=token)
            if status != 202:
                raise TransportError(status, "SUBMISSION_RESULT_UNCERTAIN")
            receipt.update(receipt_summary(response, request["submission_id"]))
            receipt.update(state="recorded", accepted_at=timestamp())
            atomic_json(path, receipt)
            return receipt
        except TransportError as exc:
            receipt.update(state="unknown", http_status=exc.status, error_code=exc.code)
            atomic_json(path, receipt)
            return reconcile(receipt, path, token, transport)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    render_parser = commands.add_parser("render", help="Read live /schema and write request; never submit")
    for arg in ("submission-id", "name", "image", "dataset", "schema-url", "example-actions-json", "out"):
        render_parser.add_argument("--" + arg, required=True)
    task_group = render_parser.add_mutually_exclusive_group(required=True)
    task_group.add_argument("--tasks-json")
    task_group.add_argument("--task-id", action="append")
    render_parser.add_argument("--finish-action-json")
    render_parser.add_argument("--source")
    render_parser.add_argument("--server-port", type=int)
    submit_parser = commands.add_parser("submit", help="Dry run unless --execute is explicit")
    submit_parser.add_argument("--request", required=True)
    submit_parser.add_argument("--approve-sha256", required=True)
    submit_parser.add_argument("--receipt", required=True)
    submit_parser.add_argument("--execute", action="store_true")
    status_parser = commands.add_parser("status", help="Read only: reconcile an existing receipt")
    status_parser.add_argument("--receipt", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "render":
            result = render(args)
        elif args.command == "submit":
            result = submit(load_json(args.request), args.approve_sha256, args.receipt, args.execute)
        else:
            path = Path(args.receipt)
            token = token_from_environment()
            with exclusive_receipt(path):
                receipt = load_json(path)
                if not isinstance(receipt, dict) or not isinstance(receipt.get("submission_id"), str) or not ID_RE.fullmatch(receipt["submission_id"]):
                    raise ContractError("Invalid receipt submission_id")
                result = reconcile(receipt, path, token)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 2 if result.get("state") in {"unknown", "unconfirmed"} else 0
    except (ContractError, TransportError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
