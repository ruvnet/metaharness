"""Bounded, explicit proxy calibration. Never trains, downloads models, or submits.

Arena-style accounting is local accounting, NOT equivalence to Arena's unknown
production chat wrapper. A pinned tokenizer counts a documented serialization.
The global reservation ceiling is not a provider dollar limit or billing promise.
Thinking controls record requested chat-template kwargs, not verified trainer
behavior. Unset preserves provider defaults; short completions do not prove mode.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
import socket
import statistics
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from arena_env.environment import ArenaAction, ArenaEnvironment
from arena_env import tasks as task_module
from arena_env.tasks import TASK_IDS, parse_task_id, format_task_id

MAX_RESPONSE_BYTES = 2_000_000
FINISH_REASONS = {"stop", "length", "tool_calls", "content_filter"}


class CalibrationError(ValueError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CalibrationError("Provider redirect refused")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def canonical_digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class TokenCounter:
    """Measured tokenizer counts, or explicit byte-based reservation estimates."""
    def __init__(self, tokenizer=None, tokenizer_sha256=None):
        self.tokenizer = tokenizer
        self.sha256 = tokenizer_sha256
        self.mode = "pinned_tokenizer" if tokenizer is not None else "utf8_bytes_reservation_estimate"

    def count(self, text):
        if self.tokenizer is None:
            return len(text.encode("utf-8"))
        return len(self.tokenizer.encode(text, add_special_tokens=False).ids)

    def context(self, messages):
        # Intentionally explicit approximation, not an invented provider chat template.
        return self.count(canonical(messages))


def load_counter(args):
    if args.accounting != "arena":
        if args.tokenizer_json or args.tokenizer_sha256:
            raise CalibrationError("Tokenizer options require --accounting arena")
        return TokenCounter()
    if not args.tokenizer_json or not args.tokenizer_sha256 or not re.fullmatch(r"[0-9a-f]{64}", args.tokenizer_sha256):
        raise CalibrationError("Arena-style accounting requires a local tokenizer JSON and exact SHA256 pin")
    try:
        if args.tokenizer_json.stat().st_size > 128 * 1024 * 1024:
            raise CalibrationError("Tokenizer file exceeds 128 MiB")
        raw = args.tokenizer_json.read_bytes()
        if hashlib.sha256(raw).hexdigest() != args.tokenizer_sha256:
            raise CalibrationError("Local tokenizer differs from its declared SHA256")
        from tokenizers import Tokenizer  # Optional local runner dependency only.
        tokenizer = Tokenizer.from_str(raw.decode())
        tokenizer.no_truncation()
        tokenizer.no_padding()
        return TokenCounter(tokenizer, args.tokenizer_sha256)
    except CalibrationError:
        raise
    except Exception:
        raise CalibrationError("Pinned tokenizer could not be loaded; install the local tokenizers helper") from None


class ReservationBudget:
    """Do not refund unused reservations, including timed-out requests."""
    def __init__(self, limit):
        self.limit, self.reserved, self.reported, self.overrun = limit, 0, 0, False

    def remaining(self):
        return max(0, self.limit - self.reserved)

    def reserve(self, prompt, generated):
        amount = prompt + generated
        if self.overrun or amount > self.remaining():
            return False
        self.reserved += amount
        return True

    def observe(self, total, reservation):
        if total is not None:
            self.reported += total
            if total > reservation:
                self.reserved += total - reservation
                # A provider exceeded this local estimate. Fail closed for future calls.
                self.overrun = True


def integer_usage(value):
    return value if type(value) is int and value >= 0 else None


def metric_for(reply):
    usage = reply.get("usage") if isinstance(reply.get("usage"), dict) else {}
    choice = reply["choices"][0]
    finish = choice.get("finish_reason")
    metric = {"finish_reason": finish if finish in FINISH_REASONS else "unknown"}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        metric[key] = integer_usage(usage.get(key))
    details = usage.get("completion_tokens_details")
    metric["reasoning_tokens"] = integer_usage(details.get("reasoning_tokens")) if isinstance(details, dict) else None
    return metric


def provider_call(opener, base_url, token, payload, timeout):
    body = json.dumps(payload, allow_nan=False).encode()
    request = urllib.request.Request(base_url.rstrip("/") + "/chat/completions", body,
                                     {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with opener.open(request, timeout=timeout) as response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise CalibrationError("Provider response too large")
    return json.loads(raw)


def redacted(text, token):
    return text.replace(token, "[REDACTED_CREDENTIAL]") if token else text


def reasoning_payload(message, token):
    """Current vLLM uses reasoning; retain legacy reasoning_content faithfully.

    https://docs.vllm.ai/en/stable/features/reasoning_outputs/
    Identical aliases count once and prefer the current field. Conflicting or
    nontext aliases are retained safely for diagnosis but never execute actions.
    """
    values = {key: message.get(key) for key in ("reasoning", "reasoning_content")}
    texts = {key: value for key, value in values.items() if isinstance(value, str)}
    invalid = any(value is not None and not isinstance(value, str) for value in values.values())
    conflicting = len(texts) == 2 and texts["reasoning"] != texts["reasoning_content"]
    error = "invalid_reasoning_type" if invalid else "conflicting_reasoning_aliases" if conflicting else None
    if error:
        retained = {key: redacted(value, token) for key, value in texts.items()}
        return retained, "\n".join(dict.fromkeys(texts.values())), "invalid", False, error, any(token in value for value in texts.values())
    field = "reasoning" if "reasoning" in texts else "reasoning_content" if "reasoning_content" in texts else None
    text = texts[field] if field else ""
    retained = {field: redacted(text, token)} if field else {}
    return retained, text, field, len(texts) == 2, None, bool(token and token in text)


def native_task_id(value, difficulty):
    """Bare family IDs use --difficulty; explicit native IDs keep their level."""
    try:
        if value in TASK_IDS:
            return format_task_id(value, difficulty)
        family, level, params = parse_task_id(value)
        return format_task_id(family, level, params)
    except (TypeError, ValueError):
        raise CalibrationError("Unknown, malformed or out-of-bounds native task ID") from None


def task_budgets(args, tasks):
    result = {family: {"completion_tokens": args.episode_completion_tokens,
                       "context_tokens": args.episode_context_tokens} for family in tasks}
    if args.task_budgets_json:
        try:
            value = json.loads(args.task_budgets_json.read_text())
            rows = value.get("tasks") if isinstance(value, dict) else value
            if not isinstance(rows, list):
                raise CalibrationError("Task budgets must use the native tasks list format")
            seen = set()
            by_native = {native_task_id(task, args.difficulty): task for task in tasks}
            for row in rows:
                task_id = row.get("task_id") if isinstance(row, dict) else None
                if not isinstance(task_id, str):
                    raise CalibrationError("Invalid or duplicated task budget ID")
                canonical_id = native_task_id(task_id, args.difficulty)
                if canonical_id in seen:
                    raise CalibrationError("Invalid or duplicated task budget ID")
                seen.add(canonical_id)
                for field in ("completion_tokens", "context_tokens"):
                    number = row.get(field)
                    if type(number) is not int or not 1 <= number <= 32768:
                        raise CalibrationError("Task token budgets must be explicit integers in 1..32768")
                    if canonical_id in by_native:
                        result[by_native[canonical_id]][field] = number
            if not set(by_native) <= seen:
                raise CalibrationError("Task budget file does not cover every exact selected native ID")
        except CalibrationError:
            raise
        except Exception:
            raise CalibrationError("Task budget file could not be read") from None
    return result


def chat_template_kwargs(thinking):
    """Only the explicit supported switch is sent; None means field omitted.

    https://docs.vllm.ai/en/stable/features/reasoning_outputs/#request-level-override
    A request override does not independently attest the loaded trainer/template.
    """
    if thinking is None:
        return None
    if thinking not in ("on", "off"):
        raise CalibrationError("Thinking must be on, off, or unset")
    return {"enable_thinking": thinking == "on"}


def run_episode(args, family, attempt, token, counter, global_budget, limits, opener, env_factory=ArenaEnvironment):
    template_kwargs = chat_template_kwargs(getattr(args, "thinking", None))
    seed = args.seed + attempt
    env = env_factory()
    native_id = native_task_id(family, args.difficulty)
    base_family, difficulty, params = parse_task_id(native_id)
    reset = env.reset(task_id=native_id, seed=seed)
    messages = [
        {"role": "system", "content": "Solve the task with the available tools. Each reply must be exactly one JSON action object, with no markdown. Action schema: " + json.dumps(ArenaAction.model_json_schema())},
        {"role": "user", "content": reset.model_dump_json()},
    ]
    start, reward, failure, calls = time.monotonic(), 0.0, None, 0
    provider_metrics, generation_used, observation_used = [], 0, 0
    initial_context = counter.context(messages)
    max_context = initial_context
    episode_reserved = 0
    for _ in range(args.max_steps):
        context_used = counter.context(messages)
        max_context = max(max_context, context_used)
        prompt_reservation = context_used
        allowance = min(args.max_tokens, global_budget.remaining() - prompt_reservation)
        if global_budget.overrun:
            failure = "provider_exceeded_reservation"
            break
        if args.accounting == "arena":
            completion_remaining = limits["completion_tokens"] - generation_used - observation_used
            context_remaining = limits["context_tokens"] - context_used
            if completion_remaining <= 0:
                failure = "episode_completion_budget_exhausted"
                break
            if context_remaining <= 0:
                failure = "episode_context_budget_exhausted"
                break
            allowance = min(allowance, completion_remaining, context_remaining)
        if allowance < 1 or not global_budget.reserve(prompt_reservation, allowance):
            failure = "global_token_budget_exhausted"
            break
        reservation = prompt_reservation + allowance
        episode_reserved += reservation
        calls += 1
        metric = {"request_max_tokens": allowance, "request_timeout_s": args.request_timeout,
                  "chat_template_kwargs": template_kwargs, "thinking_mode_verified": False,
                  "prompt_reservation": prompt_reservation, "reservation": reservation,
                  "prompt_count_method": counter.mode, "context_serialization": "canonical JSON messages without provider chat template"}
        provider_metrics.append(metric)
        payload = {"model": args.model, "messages": messages, "temperature": 0.7, "max_tokens": allowance}
        if template_kwargs is not None:
            payload["chat_template_kwargs"] = template_kwargs
        try:
            reply = provider_call(opener, args.base_url, token, payload, args.request_timeout)
        except Exception as error:
            timeout = isinstance(error, (TimeoutError, socket.timeout)) or isinstance(error, urllib.error.URLError) and isinstance(error.reason, (TimeoutError, socket.timeout))
            failure = "request_timeout" if timeout else "provider_request_failed"
            metric["request_failure"] = failure
            break
        try:
            metric.update(metric_for(reply))
            message = reply["choices"][0]["message"]
            content = message.get("content")
            if content is not None and not isinstance(content, str):
                raise CalibrationError("Nontext provider reply")
            reasoning_fields, reasoning, reasoning_field, aliases_coalesced, reasoning_error, reasoning_leaked = reasoning_payload(message, token)
            metric["reasoning_field"] = reasoning_field
            metric["reasoning_aliases_coalesced"] = aliases_coalesced
            # Keep provider field names separate from the native JSON action.
            assistant = {"role": "assistant", "content": redacted(content or "", token), **reasoning_fields}
            messages.append(assistant)
            leaked = content is not None and token in content or reasoning_leaked
            reported_completion = metric["completion_tokens"]
            measured_completion = counter.count(content or "") + counter.count(reasoning or "")
            # Provider completion_tokens generally INCLUDES reasoning_tokens. Do not add it twice.
            charged_completion = reported_completion if reported_completion is not None else measured_completion
            metric["generation_charged"] = charged_completion
            metric["generation_count_method"] = "provider_completion_tokens_including_reasoning" if reported_completion is not None else counter.mode + "_reasoning_plus_content_estimate"
            generation_used += charged_completion
            reported_total = metric["total_tokens"]
            if reported_total is None and metric["prompt_tokens"] is not None and reported_completion is not None:
                reported_total = metric["prompt_tokens"] + reported_completion
            global_budget.observe(reported_total, reservation)
            if charged_completion > allowance:
                global_budget.overrun = True
            if leaked:
                failure = "credential_redacted_from_provider_reply"
                break
            if reasoning_error:
                failure = reasoning_error
                break
            if metric["finish_reason"] == "length":
                failure = "completion_truncated"
                break
            if metric["finish_reason"] == "content_filter":
                failure = "provider_content_filter"
                break
            if not content:
                failure = "missing_action_content"
                break
            if charged_completion > allowance:
                failure = "provider_exceeded_generation_cap"
                break
            if global_budget.overrun:
                failure = "provider_exceeded_reservation"
                break
            if args.accounting == "arena" and generation_used + observation_used > limits["completion_tokens"]:
                failure = "episode_completion_budget_exceeded"
                break
            # Context is evaluated again with the received assistant turn before executing an action.
            max_context = max(max_context, counter.context(messages))
            if args.accounting == "arena" and max_context > limits["context_tokens"]:
                failure = "episode_context_budget_exceeded"
                break
        except Exception:
            failure = "invalid_provider_response"
            break
        try:
            action = ArenaAction.model_validate_json(content)
        except Exception:
            failure = "invalid_json_action"
            break
        try:
            observation = env.step(action)
            observation_text = observation.model_dump_json()
            observation_tokens = counter.count(observation_text)
        except Exception:
            failure = "environment_step_failed"
            break
        observation_used += observation_tokens
        messages.append({"role": "user", "content": observation_text})
        metric["observation_tokens"] = observation_tokens
        metric["observation_count_method"] = counter.mode
        max_context = max(max_context, counter.context(messages))
        # Conservatively charge terminal observations too. Production wrapping is unverified.
        if args.accounting == "arena" and generation_used + observation_used > limits["completion_tokens"]:
            failure = "episode_completion_budget_exceeded"
            break
        if args.accounting == "arena" and max_context > limits["context_tokens"]:
            failure = "episode_context_budget_exceeded"
            break
        if observation.done:
            reward = float(observation.reward)
            break
    else:
        failure = "step_budget_exhausted"
    accounting = {"mode": args.accounting, "count_method": counter.mode, "tokenizer_sha256": counter.sha256,
                  "generation_tokens": generation_used, "post_reset_observation_tokens": observation_used,
                  "episode_completion_tokens": generation_used + observation_used,
                  "initial_context_units": initial_context, "max_context_units": max_context,
                  "completion_limit": limits["completion_tokens"] if args.accounting == "arena" else None,
                  "context_limit": limits["context_tokens"] if args.accounting == "arena" else None,
                  "global_reserved_units": global_budget.reserved, "episode_reserved_units": episode_reserved,
                  "arena_budget_matched": False, "arena_wall_matched": False}
    trajectory = {"seed": seed, "messages": messages, "failure": failure, "provider_metrics": provider_metrics, "accounting": accounting,
                  "chat_template_kwargs": template_kwargs, "thinking_mode_verified": False}
    return {"type": "episode", "evidence_kind": "proxy_calibration", "task_id": family, "difficulty": difficulty,
            "native_task_id": native_id, "family": base_family, "params": params,
            "seed": seed, "attempt": attempt, "reward": reward, "solved": reward == 1.0,
            "trajectory": trajectory, "trajectoryDigest": canonical_digest(trajectory), "calls": calls,
            "total_tokens_reported": sum(m.get("total_tokens") or 0 for m in provider_metrics),
            "latency_s": round(time.monotonic() - start, 3), "failure": failure}


def bounded_int(lower, upper):
    def parse(value):
        try:
            number = int(value)
        except ValueError:
            raise argparse.ArgumentTypeError(f"Expected integer in {lower}..{upper}") from None
        if not lower <= number <= upper:
            raise argparse.ArgumentTypeError(f"Expected integer in {lower}..{upper}")
        return number
    return parse


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="OpenAI compatible base ending /v1")
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--thinking", choices=["on", "off"],
                        help="Request enable_thinking=true/false through chat_template_kwargs; unset leaves provider defaults. Effect remains unverified.")
    parser.add_argument("--api-key-env", default="ARENA_MODEL_API_KEY")
    parser.add_argument("--task-id", action="append", help="Bare family or validated native ID with optional bounded knob; explicit IDs keep their own difficulty")
    parser.add_argument("--difficulty", type=int, choices=[1, 2, 3], default=2)
    parser.add_argument("--max-steps", type=bounded_int(2, 8), default=4)
    parser.add_argument("--max-tokens", type=bounded_int(128, 32768), default=2048)
    parser.add_argument("--request-timeout", type=bounded_int(30, 900), default=300, help="Per-request network timeout seconds; not an Arena episode wall budget")
    parser.add_argument("--max-total-tokens", type=bounded_int(1, 100_000_000), help="Required for execute: global prompt+generation reservation ceiling; not a dollar/billing guarantee")
    parser.add_argument("--accounting", choices=["request", "arena"], default="request")
    parser.add_argument("--episode-completion-tokens", type=bounded_int(1, 32768), default=4096)
    parser.add_argument("--episode-context-tokens", type=bounded_int(1, 32768), default=8192)
    parser.add_argument("--task-budgets-json", type=Path, help="Native tasks list with explicit per-task completion_tokens/context_tokens")
    parser.add_argument("--tokenizer-json", type=Path, help="Local tokenizer.json; never downloaded by this runner")
    parser.add_argument("--tokenizer-sha256", help="Exact SHA256 of local tokenizer.json")
    parser.add_argument("--seed", type=bounded_int(0, 2**63 - 5), default=400000)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--execute", action="store_true")
    return parser


def environment_source_binding():
    """Bind the actual imported environment modules, not just reused task IDs."""
    modules = {"arena_env/tasks.py": task_module,
               "arena_env/environment.py": sys.modules[ArenaEnvironment.__module__]}
    try:
        components = {name: hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()
                      for name, module in modules.items()}
    except Exception:
        raise CalibrationError("Imported environment source could not be hashed") from None
    return {"components": components, "sha256": canonical_digest(components)}


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        template_kwargs = chat_template_kwargs(args.thinking)
        model_id = args.model + ":" + args.model_revision
        if not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,128}", model_id):
            raise CalibrationError("Model and revision must form an orchestration identifier of at most 128 characters")
        host = urlsplit(args.base_url)
        if not host.hostname or host.username or host.password or host.query or host.fragment or (host.scheme != "https" and not(host.scheme == "http" and host.hostname in ("127.0.0.1", "localhost", "::1"))):
            raise CalibrationError("Use HTTPS without credentials, or loopback HTTP")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", args.api_key_env):
            raise CalibrationError("API key setting must name an environment variable")
        tasks = list(dict.fromkeys(args.task_id or TASK_IDS))
        native_ids = [native_task_id(task, args.difficulty) for task in tasks]
        if len(tasks) > 50 or len(set(native_ids)) != len(native_ids):
            raise CalibrationError("Select 1..50 unique native tasks; aliases cannot duplicate a task")
        limits = task_budgets(args, tasks)
        if args.accounting == "arena" and (not args.tokenizer_json or not args.tokenizer_sha256):
            raise CalibrationError("Arena-style accounting requires a local tokenizer JSON and its SHA256")
        if args.accounting != "arena" and (args.tokenizer_json or args.tokenizer_sha256):
            raise CalibrationError("Tokenizer options require --accounting arena")
        manifest = {"tasks": [{"task_id": task_id, "split": "train"} for task_id in native_ids],
                    "environmentSource": environment_source_binding(), "chat_template_kwargs": template_kwargs}
        ceiling = len(tasks) * 4 * args.max_steps
        plan = {"model": args.model, "revision": args.model_revision, "families": tasks, "attempts_per_family": 4,
                "chat_template_kwargs": template_kwargs, "thinking_mode_verified": False,
                "thinking_control_scope": "Exact requested kwargs; null means omitted/provider default unknown. Trainer/template effect remains unverified; short completions do not establish thinking mode.",
                "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "max_calls": ceiling, "max_completion_tokens": ceiling * args.max_tokens,
                "global_prompt_generation_reservation_limit": args.max_total_tokens,
                "request_timeout_s": args.request_timeout, "max_tokens_per_request": args.max_tokens,
                "max_request_wait_seconds": ceiling * args.request_timeout,
                "difficulty": args.difficulty, "seed": args.seed, "manifest": manifest, "manifestDigest": canonical_digest(manifest),
                "accounting": args.accounting, "task_token_budgets": limits, "tokenizer_sha256": args.tokenizer_sha256,
                "arena_budget_matched": False, "arena_wall_matched": False,
                "token_accounting": "Arena-style mode counts all generation and observations after reset; context is local canonical JSON, not the unknown production chat wrapper. Provider completion includes reasoning. Global reservations are never refunded; omitted provider usage uses explicit local estimates.",
                "spend_limit_scope": "Local prompt+generation reservation units; unverified provider overhead may differ. No dollar or billing guarantee."}
        if not args.execute:
            print(json.dumps({"dry_run": True, "plan": plan, "note": "No provider calls or tokenizer downloads. Execution requires an explicit --max-total-tokens ceiling."}, indent=2))
            return 0
        if args.max_total_tokens is None:
            raise CalibrationError("Execution requires an explicit --max-total-tokens ceiling")
        if args.output.exists():
            raise CalibrationError("Output already exists; preserve calibration evidence")
        token = os.environ.get(args.api_key_env, "").strip()
        if not token or any(ch.isspace() for ch in token):
            raise CalibrationError("Configured API key environment variable is absent or invalid")
        counter = load_counter(args)
        budget = ReservationBudget(args.max_total_tokens)
        opener = urllib.request.build_opener(NoRedirect)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        rows = []
        with args.output.open("x") as out:
            out.write(json.dumps({"type": "plan", "evidence_kind": "proxy_calibration", "plan": plan}) + "\n")
            out.flush()
            for family in tasks:
                for attempt in range(4):
                    row = run_episode(args, family, attempt, token, counter, budget, limits[family], opener)
                    rows.append(row)
                    out.write(json.dumps(row) + "\n")
                    out.flush()
            summary = []
            for family in tasks:
                group = [r for r in rows if r["task_id"] == family]
                rewards = [r["reward"] for r in group]
                successes = sum(r["solved"] for r in group)
                summary.append({"task_id": family, "successes": successes, "attempts": 4,
                                "reward_std": statistics.pstdev(rewards), "zero_variance": len(set(rewards)) == 1,
                                "mixed_success": 1 <= successes <= 3,
                                "failures": {reason: sum(r["failure"] == reason for r in group) for reason in sorted({r["failure"] for r in group if r["failure"]})}})
            out.write(json.dumps({"type": "summary", "families": summary, "official_evaluation": False,
                                  "promotion_authorized": False, "global_reserved_units": budget.reserved,
                                  "global_provider_reported_tokens": budget.reported, "provider_exceeded_reservation": budget.overrun}) + "\n")
            receipt = {"kind": "proxy_calibration", "source": "model_rollouts", "modelId": model_id,
                       "runnerRevision": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "manifestDigest": plan["manifestDigest"],
                       "groups": [{"taskId": native_task_id(family, args.difficulty), "family": parse_task_id(native_task_id(family, args.difficulty))[0],
                                   "attempts": [{"seed": r["seed"], "reward": r["reward"], "success": r["solved"], "trajectoryDigest": r["trajectoryDigest"]}
                                                for r in rows if r["task_id"] == family]} for family in tasks]}
            # No-call budget rows are not model rollouts; do not manufacture a receipt.
            complete = all(r["calls"] > 0 and r["trajectory"]["provider_metrics"] and "finish_reason" in r["trajectory"]["provider_metrics"][-1] for r in rows)
            out.write(json.dumps({"type": "orchestration_receipt", "available": complete, "receipt": receipt if complete else None,
                                  "note": "Calibration only; training and transfer evidence still required. Incomplete provider execution has no calibration receipt."}) + "\n")
        print(json.dumps({"output": str(args.output), "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(), "families": summary}))
        return 0
    except CalibrationError as error:
        print(str(error), file=sys.stderr)
        return 2
    except Exception:
        print("Calibration failed; retained output may be incomplete. No automatic retry. No credentials were logged.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
