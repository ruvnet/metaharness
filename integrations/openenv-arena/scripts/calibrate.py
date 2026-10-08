"""Bounded, explicitly invoked model calibration. This never trains or submits."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import statistics
import time
import urllib.request
from urllib.parse import urlsplit

from arena_env.environment import ArenaAction, ArenaEnvironment
from arena_env.tasks import TASK_IDS


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("provider redirect refused")


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True, help="OpenAI compatible base ending /v1")
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-revision", required=True, help="Provider checkpoint revision; use unknown explicitly if unavailable")
    parser.add_argument("--api-key-env", default="ARENA_MODEL_API_KEY")
    parser.add_argument("--task-id", choices=TASK_IDS, action="append")
    parser.add_argument("--difficulty", type=int, choices=[1, 2, 3], default=2)
    parser.add_argument("--max-steps", type=int, choices=range(2, 9), default=4)
    parser.add_argument("--max-tokens", type=int, choices=range(128, 4097), default=2048)
    parser.add_argument("--seed", type=int, default=400000)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    model_id = args.model+":"+args.model_revision
    if not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,128}", model_id):
        parser.error("model and revision must form an orchestration identifier of at most 128 letters, digits, _ . : / or -")
    host = urlsplit(args.base_url)
    if host.username or host.password or host.query or host.fragment or (host.scheme != "https" and not(host.scheme == "http" and host.hostname in ("127.0.0.1", "localhost"))):
        parser.error("use an HTTPS base URL without credentials, or local HTTP")
    tasks = list(dict.fromkeys(args.task_id or TASK_IDS))
    ceiling = len(tasks)*4*args.max_steps
    manifest = {"tasks": [{"task_id": f"{family}-d{args.difficulty}", "split": "train"} for family in tasks]}
    plan = {"model": args.model, "revision": args.model_revision, "families": tasks, "attempts_per_family": 4, "max_calls": ceiling, "max_completion_tokens": ceiling*args.max_tokens, "difficulty": args.difficulty, "seed": args.seed, "manifest": manifest, "manifestDigest": canonical_digest(manifest)}
    if not args.execute:
        print(json.dumps({"dry_run": True, "plan": plan, "note": "No provider calls. Pricing and actual tokens depend on the selected endpoint."}, indent=2))
        return
    if args.output.exists():
        parser.error("output already exists; preserve calibration evidence")
    token = os.environ.get(args.api_key_env)
    if not token:
        parser.error("configured API key environment variable is absent")
    schema = ArenaAction.model_json_schema()
    rows = []
    opener = urllib.request.build_opener(NoRedirect)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation also reserves the evidence path against concurrent runs.
    with args.output.open("x") as out:
        out.write(json.dumps({"type": "plan", "evidence_kind": "proxy_calibration", "plan": plan})+"\n")
        out.flush()
        for family in tasks:
            for attempt in range(4):
                seed = args.seed+attempt
                env = ArenaEnvironment()
                reset = env.reset(task_id=f"{family}-d{args.difficulty}", seed=seed)
                messages = [
                    {"role": "system", "content": "Solve the task with the available tools. Each reply must be exactly one JSON action object, with no markdown. Action schema: "+json.dumps(schema)},
                    {"role": "user", "content": reset.model_dump_json()},
                ]
                start, usage, reward, failure = time.monotonic(), 0, 0.0, None
                for step in range(args.max_steps):
                    body = json.dumps({"model": args.model, "messages": messages, "temperature": 0.7, "max_tokens": args.max_tokens}).encode()
                    request = urllib.request.Request(args.base_url.rstrip("/")+"/chat/completions", body, {"Authorization": "Bearer "+token, "Content-Type": "application/json"})
                    try:
                        with opener.open(request, timeout=60) as response:
                            raw = response.read(2_000_001)
                        if len(raw) > 2_000_000:
                            raise ValueError("response too large")
                        reply = json.loads(raw)
                        content = reply["choices"][0]["message"]["content"]
                        usage += int(reply.get("usage", {}).get("total_tokens", 0))
                        action = ArenaAction.model_validate_json(content)
                        observation = env.step(action)
                    except Exception as error:
                        # Never include response bodies, headers or exception text containing secrets.
                        failure = type(error).__name__
                        break
                    messages += [{"role": "assistant", "content": content}, {"role": "user", "content": observation.model_dump_json()}]
                    if observation.done:
                        reward = float(observation.reward)
                        break
                else:
                    failure = "step_budget_exhausted"
                trajectory = {"seed": seed, "messages": messages, "failure": failure}
                row = {"type": "episode", "evidence_kind": "proxy_calibration", "task_id": family, "difficulty": args.difficulty, "seed": seed, "attempt": attempt, "reward": reward, "solved": reward == 1.0, "trajectory": trajectory, "trajectoryDigest": canonical_digest(trajectory), "calls": step+1, "total_tokens_reported": usage, "latency_s": round(time.monotonic()-start, 3), "failure": failure}
                rows.append(row)
                out.write(json.dumps(row)+"\n")
                out.flush()
        summary = []
        for family in tasks:
            group = [r for r in rows if r["task_id"] == family]
            rewards = [r["reward"] for r in group]
            successes = sum(r["solved"] for r in group)
            summary.append({"task_id": family, "successes": successes, "attempts": 4, "reward_std": statistics.pstdev(rewards), "zero_variance": len(set(rewards)) == 1, "mixed_success": 1 <= successes <= 3})
        out.write(json.dumps({"type": "summary", "families": summary, "official_evaluation": False, "promotion_authorized": False})+"\n")
        # This receipt matches orchestration/calibrate, but has no authority to promote.
        # Caller must bind its manifest and structural families into a frozen plan.
        receipt = {"kind":"proxy_calibration", "source":"model_rollouts", "modelId":model_id, "runnerRevision":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "manifestDigest":plan["manifestDigest"], "groups":[{"taskId":f"{family}-d{args.difficulty}", "family":family, "attempts":[{"seed":r["seed"], "reward":r["reward"], "success":r["solved"], "trajectoryDigest":r["trajectoryDigest"]} for r in rows if r["task_id"]==family]} for family in tasks]}
        out.write(json.dumps({"type":"orchestration_receipt", "receipt":receipt})+"\n")
    print(json.dumps({"output": str(args.output), "sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(), "families": summary}))


if __name__ == "__main__":
    main()
