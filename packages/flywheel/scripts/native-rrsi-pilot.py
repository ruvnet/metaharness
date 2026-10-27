"""Live bounded adaptation of pinned RRSI components, not its published benchmark reproduction.

Runs the actual upstream JSON proposer, annealing, history, aggregation and selection. Replaces only
the provider, domain runner and adds stricter guards. Never runs upstream digester/analyst shell tools.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request

PIN = "be50316e1db05914068a973f322770ef08ed7ba1"
ACTOR = "qwen/qwen3.8-27b"
EDITOR = "moonshotai/kimi-k3.1-pro"
BASELINE = "Read the complete task specification. Implement a correct, simple pure function. Check edge cases, preserve required ordering, and follow the requested output contract."
DEV = [
    {"id": "development-1", "spec": "Implement solve(data) for a list of strings. Sum durations in M:SS format as integer seconds. Strip outer whitespace. M is one or more ASCII digits with any nonnegative value. SS is exactly two ASCII digits in 00 through 59. Ignore malformed strings. Return an integer.",
     "cases": [(["1:02", " 0:59 ", "4:60", "-1:20", "1:2"], 121), (["10:00", "00:00", "foo"], 600), ([], 0)]},
    {"id": "development-2", "spec": "Implement solve(data) for one uppercase Roman numeral string. Return its integer only if the string is a canonical Roman numeral for 1 through 3999, using I,V,X,L,C,D,M and standard subtractive notation. Return 0 for empty or malformed or noncanonical strings. No imports.",
     "cases": [("MCMXCIV", 1994), ("IL", 0), ("IIII", 0), ("MMMCMXCIX", 3999), ("", 0)]},
    {"id": "development-3", "spec": "Implement solve(data) for one CSV line. Commas separate fields; a field may start with a double quote, then embedded double quotes are escaped by doubling. No characters are permitted between a closing quote and a separator or end. A quote in an unquoted field is invalid. Preserve whitespace exactly. Return the list of fields, including empty fields, or None for malformed input. Empty line is one empty field. No imports.",
     "cases": [('a,"b,c","d""e"', ["a", "b,c", 'd"e']), ('"a"x,b', None), ("x,,z", ["x", "", "z"]), ('"a,b', None), ("", [""])]},
    {"id": "development-4", "spec": "Implement solve(data) for an object with unique string nodes and directed edges as [prerequisite,dependent]. All edge endpoints exist. Return a topological ordering, choosing the lexicographically smallest currently available node each step. Return [] for cycles. Duplicate edges must not change the result. Do not mutate the input.",
     "cases": [({"nodes": ["b", "a", "c"], "edges": [["a", "c"]]}, ["a", "b", "c"]), ({"nodes": ["a", "b"], "edges": [["a", "b"], ["b", "a"]]}, []), ({"nodes": ["a", "b"], "edges": [["a", "b"], ["a", "b"]]}, ["a", "b"])]},
]
CONFIRM = [
    {"id": "confirmation-1", "spec": "Implement solve(data) for a list of strings. Sum durations D:HH:MM as integer minutes. Strip outer whitespace. D is one or more ASCII digits with arbitrary nonnegative value. HH is exactly two ASCII digits in 00 through 23. MM is exactly two ASCII digits in 00 through 59. Ignore malformed strings. Return an integer.",
     "cases": [(["1:02:03", " 0:23:59 ", "2:24:00", "3:2:05"], 3002), (["100:00:01", "0:00:00"], 144001), ([], 0)]},
    {"id": "confirmation-2", "spec": "Implement solve(data) for a string containing a signed integer with optional underscore thousands grouping. Strip outer whitespace. An optional single + or - precedes the number. Without underscores, one or more ASCII digits is valid. With underscores, the first group has 1 to 3 ASCII digits and every following group has exactly 3 ASCII digits. Leading zeros are allowed. Return the integer or None if invalid.",
     "cases": [("+1_234", 1234), ("12_34", None), ("000_123", 123), ("-123456", -123456), ("_123", None), ("1__234", None)]},
    {"id": "confirmation-3", "spec": "Implement solve(data) for one line with pipe separated fields. A field may start with a single quote; embedded single quotes are escaped by doubling. Nothing may occur between a closing quote and a separator or end. Single quotes inside unquoted fields are invalid. Preserve whitespace exactly. Return all fields including empty ones or None for malformed input. Empty line returns one empty field. No imports.",
     "cases": [("a|'b|c'|'d''e'", ["a", "b|c", "d'e"]), ("'a'x|b", None), ("x||z", ["x", "", "z"]), ("", [""])]},
    {"id": "confirmation-4", "spec": "Implement solve(data) for an object containing unique string nodes, directed edges [prerequisite,dependent], and priority mapping each node to an integer. Endpoints exist. Return a topological ordering, each time choosing the available node with lowest numeric priority, breaking ties lexicographically. Return [] for a cycle. Duplicate edges have no effect. Do not mutate input.",
     "cases": [({"nodes": ["a", "b", "c"], "edges": [["a", "c"]], "priority": {"a": 3, "b": 1, "c": 0}}, ["b", "a", "c"]), ({"nodes": ["b", "a", "c"], "edges": [], "priority": {"a": 2, "b": 2, "c": 1}}, ["c", "a", "b"]), ({"nodes": ["a", "b"], "edges": [["a", "b"], ["b", "a"]], "priority": {"a": 1, "b": 2}}, [])]},
]


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()



def actor_trial(text, worker, inputs):
    """Fail closed on output-contract and worker failures; never retry or repair output."""
    try:
        value = json.loads(text)
        source = value.get("source") if isinstance(value, dict) else None
        if not isinstance(source, str) or not source.strip() or len(source) > 100_000:
            raise ValueError("invalid source")
    except (ValueError, TypeError):
        return "", {"ok": False, "kind": "actor_contract_failed"}
    try:
        proc = subprocess.run(["python3", "-I", str(worker)],
            input=json.dumps({"source": source, "inputs": inputs}),
            text=True, capture_output=True, timeout=4,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        output = json.loads(proc.stdout)
        if proc.returncode or not isinstance(output, dict):
            raise ValueError("invalid worker response")
        if output.get("ok") and (not isinstance(output.get("results"), list)
                or not isinstance(output.get("inputUnchanged"), list)
                or len(output["results"]) != len(inputs)
                or len(output["inputUnchanged"]) != len(inputs)):
            raise ValueError("incomplete worker response")
        return source, output
    except subprocess.TimeoutExpired:
        return source, {"ok": False, "kind": "worker_timeout"}
    except (ValueError, OSError):
        return source, {"ok": False, "kind": "worker_failed"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rrsi_root", type=Path)
    ap.add_argument("worker", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--live", action="store_true")
    args = ap.parse_args()
    cap_usd = float(os.environ.get("RSI_PILOT_CAP_USD", "3"))
    if not math.isfinite(cap_usd) or not 0 < cap_usd <= 3:
        raise RuntimeError("invalid pilot cap")
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.rrsi_root, text=True).strip()
    if actual != PIN:
        raise RuntimeError("upstream source pin mismatch")
    sys.path.insert(0, str(args.rrsi_root))
    from rrsi.config import RRSIConfig
    from rrsi.evaluate import TaskResult, aggregate
    from rrsi.history import History
    from rrsi.schedule import edit_budget
    from rrsi.selection import Candidate, select_round
    import rrsi.propose as proposer
    if not args.live:
        assert edit_budget(0, 2, 1, 1) == 1
        assert len({x["id"] for x in DEV + CONFIRM}) == 8
        assert not ({x["spec"] for x in DEV} & {x["spec"] for x in CONFIRM})
        print(json.dumps({"offline": True, "upstreamPin": actual, "tasks": 8}))
        return
    args.out.mkdir(parents=True, exist_ok=False)
    deadline = time.monotonic() + 600
    freeze = {"schema": "native-rrsi-components-pilot/v1", "upstreamPin": PIN, "actor": ACTOR,
              "editor": EDITOR, "baseline": BASELINE, "development": DEV, "confirmation": CONFIRM,
              "rounds": 2, "trialsPerTask": 2, "maxCalls": 72, "maxReservedUsd": cap_usd, "maxProposerTurns": 12,
              "scope": "Native proposer/schedule/history/aggregate/select_round with custom host domain and stricter guards. Not full Run or published benchmark reproduction.",
              "gate": "Strict development lift, no per-task regressions, complete known costs, API cost per success does not increase. Frozen confirmation used once after selection."}
    freeze["adapterSourceSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    freeze["workerSourceSha256"] = hashlib.sha256(args.worker.read_bytes()).hexdigest()
    (args.out / "freeze.json").write_text(json.dumps(freeze, indent=2))
    keyline = next(line for line in Path("/run/user/1000/ruos-env").read_text().splitlines()
                   if re.match(r"^(export\s+)?OPENROUTER_API_KEY=", line))
    key = keyline.split("=", 1)[1].strip().strip("\"").strip("'")
    with urllib.request.urlopen("https://openrouter.ai/api/v1/models", timeout=20) as res:
        catalogue = {x["id"]: x for x in json.load(res)["data"]}
    prices = {model: {k: float(catalogue[model]["pricing"][k]) for k in ["prompt", "completion"]}
              for model in [ACTOR, EDITOR]}
    if any(not math.isfinite(v) or v < 0 for p in prices.values() for v in p.values()):
        raise RuntimeError("invalid model prices")
    ledger, reserved, sequence = [], 0.0, 0
    def save(name, value):
        (args.out / name).write_text(json.dumps(value, indent=2))
    def request(stage, model, prompt, system=""):
        nonlocal reserved, sequence
        if time.monotonic() >= deadline or sequence >= 72:
            raise RuntimeError("runtime or call budget exhausted")
        ceiling = (len((prompt + system).encode()) + 4096) * prices[model]["prompt"] + 1800 * prices[model]["completion"]
        if reserved + ceiling > cap_usd:
            raise RuntimeError("reservation denied")
        reserved += ceiling
        sequence += 1
        entry = {"sequence": sequence, "stage": stage, "requestedModel": model, "reservedUsd": ceiling, "status": "pending"}
        ledger.append(entry)
        save("calls.json", ledger)
        body = {"model": model, "temperature": 0, "max_tokens": 1800, "reasoning": {"enabled": False},
                "response_format": {"type": "json_object"}, "usage": {"include": True},
                "messages": [{"role": "system", "content": system or "Return JSON only."}, {"role": "user", "content": prompt}]}
        req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        start = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=min(45, max(1, deadline - time.monotonic()))) as res:
                data = json.load(res)
            usage = data["usage"]
            tokens = usage["prompt_tokens"] + usage["completion_tokens"]
            if not isinstance(tokens, int) or tokens <= 0:
                raise RuntimeError("missing token accounting")
            estimated = usage["prompt_tokens"] * prices[model]["prompt"] + usage["completion_tokens"] * prices[model]["completion"]
            charge = usage.get("cost", estimated)
            if not isinstance(charge, (int, float)) or not math.isfinite(charge) or charge < 0 or charge > ceiling:
                raise RuntimeError("invalid or over-budget charge")
            text = data["choices"][0]["message"]["content"]
            entry.update(status="completed", responseId=data.get("id"), servedModel=data.get("model"),
                         tokens=tokens, costUsd=charge, costSource="provider" if "cost" in usage else "list-price-estimate",
                         latencyMs=(time.monotonic()-start)*1000)
            save(f"response-{sequence:03}.json", {"stage": stage, "text": text})
            save("calls.json", ledger)
            return text, entry
        except Exception:
            entry.update(status="failed", latencyMs=(time.monotonic()-start)*1000, failure="provider_attempt_failed")
            save("calls.json", ledger)
            raise RuntimeError("provider_attempt_failed") from None
    actor_contract = ("Write pure Python defining solve(data). Return JSON with string field source. No imports, classes, print, file or network APIs, private names, eval or exec. Do not mutate input. Use simple loops, safe numeric/string/list/dict/set builtins. Allowed methods: append, extend, sort, reverse, get, items, keys, values, strip, lower, upper, split, isdigit, isascii, startswith, endswith, add, discard, pop, copy, count, index, remove, join, setdefault. Avoid exceptions unless necessary.")
    def evaluate(policy, tasks, label):
        per_task, records, costs = {}, {}, []
        for task in tasks:
            rewards, token_counts, runs = [], [], []
            for trial in range(2):
                text, call = request(f"{label}:{task['id']}:{trial}", ACTOR,
                                     actor_contract + "\nReusable harness guidance:\n" + policy + "\nTask:\n" + task["spec"])
                source, output = actor_trial(text, args.worker, [c[0] for c in task["cases"]])
                checks = [encoded(r) == encoded(c[1]) and output["inputUnchanged"][i]
                          for i, (r, c) in enumerate(zip(output.get("results", []), task["cases"]))] if output.get("ok") else []
                passed = len(checks) == len(task["cases"]) and all(checks)
                artifact = f"artifact-{call['sequence']:03}.py"
                (args.out / artifact).write_text(source)
                call.update(artifact=artifact, sourceDigest=hashlib.sha256(source.encode()).hexdigest())
                save("calls.json", ledger)
                rewards.append(float(passed)); token_counts.append(call["tokens"]); costs.append(call["costUsd"])
                runs.append({"source": source, "strictSuccess": passed, "passedChecks": sum(checks),
                             "totalChecks": len(task["cases"]), "failureKind": output.get("kind") if not output.get("ok") else None, "safetyViolation": output.get("kind") == "language_rejected"})
            per_task[task["id"]] = TaskResult(rewards=rewards, tokens=token_counts)
            records[task["id"]] = {"spec": task["spec"], "runs": runs}
        ev = aggregate(label, 2, per_task, {"apiCostUsd": sum(costs), "safetyViolation": any(r["safetyViolation"] for t in records.values() for r in t["runs"])})
        save(label + ".json", {"evaluation": ev.to_json(), "records": records})
        save("calls.json", ledger)
        return ev, records
    baseline, records = evaluate(BASELINE, DEV, "baseline-development")
    incumbent, policy, best = baseline, BASELINE, baseline.S
    history = History(args.out / "history.jsonl")
    cfg = RRSIConfig(T=2, k=2, m=1, b_min=1, b_max=1, delta=0)
    proposer.MAX_TURNS = 12
    def generate(prompt, system=None, cache_prefix=None, **kwargs):
        return request("native-proposer", EDITOR, (cache_prefix or "") + "\n" + prompt, system or "")[0]
    proposer.generate = generate
    class Domain:
        source_exts = {".md"}
        briefs = {"proposer": "Only instructions.md is applied as reusable guidance. Change this prompt module only, with generic specification checking mechanisms. No task names, hardcoded answers, implementations, task-specific numeric constants or tests. No shell tools exist in this domain."}
        def render_trace(self, rec, detail=False):
            return json.dumps(rec)
        def task_row(self, task_id, rec, tr):
            return f"{task_id}: success={tr.mean}"
    domain = Domain()
    rounds = []
    for generation in range(2):
        with tempfile.TemporaryDirectory(prefix="native-rrsi-proposal-") as candidate_dir:
            harness = Path(candidate_dir)
            (harness / "instructions.md").write_text(policy)
            proposal = proposer.propose(domain, harness,
                report={"failures": [k for k,v in incumbent.per_task.items() if v.mean < 1],
                        "success_habits": [k for k,v in incumbent.per_task.items() if v.mean == 1],
                        "instruction": "Find recurring generalizable contract handling defects from development traces. Preserve successful behavior."},
                history_rows=history.render(), skill_md="Only reusable instructions may change. Frozen model, budgets, grader and data. Never write task-specific solutions or branch on task identifiers.",
                patterns_md="Use evidence, keep changes small, and preserve exact semantics.",
                budget=edit_budget(generation,2,1,1), explore={"text": "One prompt module only."}, reserved_slot=False,
                prune_set=history.prune_set(generation,4), traces=records, per_task=incumbent.per_task,
                findings=[], model=EDITOR)
            candidate_policy = (harness / "instructions.md").read_text()
            allowed = [p for p in harness.rglob("*") if p.is_file()]
            valid = proposal.get("status") == "done" and len(allowed) == 1 and candidate_policy != policy and len(candidate_policy) <= 12000
            valid = valid and not any(task["id"] in candidate_policy for task in DEV+CONFIRM)
            if not valid:
                rounds.append({"generation": generation, "proposal": proposal, "accepted": False, "reason": "proposal_contract"})
                save("rounds.json", rounds)
                continue
            ev, candidate_records = evaluate(candidate_policy, DEV, f"candidate-{generation}-development")
            candidate = Candidate(f"generation-{generation}", proposal["edits"], ev=ev)
            def guards(parent, child):
                violations = []
                if child.C is None or child.C <= 0 or child.missing: violations.append("unknown or incomplete evidence")
                if child.S <= parent.S: violations.append("strict improvement required")
                if any(child.per_task[k].mean < parent.per_task[k].mean for k in parent.per_task): violations.append("per-task regression")
                if child.extra["safetyViolation"]: violations.append("restricted language safety")
                if child.S and parent.S and child.extra["apiCostUsd"]/child.S > parent.extra["apiCostUsd"]/parent.S: violations.append("API cost per success worsened")
                return violations
            winner, decisions = select_round([candidate], incumbent, best, 0, cfg, history.incumbent_component_counts(), guard_fn=guards)
            accepted = winner is not None
            history.append_candidate(generation, candidate.variant, candidate.edits, "ACCEPTED" if accepted else "REJECTED",
                ev.S-incumbent.S, (ev.C-incumbent.C)/incumbent.C, accepted, ev.S, ev.C, None)
            rounds.append({"generation": generation, "proposal": proposal, "policy": candidate_policy, "policyDigest": digest(candidate_policy),
                           "evaluation": ev.to_json(), "decisions": [d.to_json() for d in decisions], "accepted": accepted})
            if accepted:
                incumbent, policy, records, best = ev, candidate_policy, candidate_records, max(best, ev.S)
            save("rounds.json", rounds)
            print(json.dumps({"generation": generation, "accepted": accepted, "developmentScore": ev.S}), flush=True)
    save("candidate-freeze.json", {"baseline": BASELINE, "selected": policy, "selectedDigest": digest(policy), "beforeConfirmation": True})
    base_confirmation, _ = evaluate(BASELINE, CONFIRM, "baseline-confirmation")
    final_confirmation, _ = evaluate(policy, CONFIRM, "selected-confirmation")
    latencies = sorted(x["latencyMs"] for x in ledger)
    summary = {"completed": True, "scope": freeze["scope"], "upstreamPin": PIN, "freezeDigest": digest(freeze),
               "acceptedDevelopmentChanges": sum(r["accepted"] for r in rounds),
               "developmentBaseline": baseline.to_json(), "developmentSelected": incumbent.to_json(),
               "confirmationBaseline": base_confirmation.to_json(), "confirmationSelected": final_confirmation.to_json(),
               "calls": len(ledger), "knownApiCostUsd": sum(x["costUsd"] for x in ledger), "reservedUsd": reserved,
               "latencyMedianMs": statistics.median(latencies), "latencyP95Ms": latencies[math.ceil(len(latencies)*.95)-1],
               "persistentHarnessChanged": policy != BASELINE, "generalRSIProven": False,
               "limitations": ["Two rounds on four development tasks; small synthetic pure-function domain.", "Two rollout repeats are not independent training seeds.", "No equal-total-budget random-search control; no general superiority claim.", "Selection cost rule covers actor inference; total reported cost also includes proposer calls; infrastructure excluded.", "No upstream shell analysis, full native Run, pruning ablation, weight updates or production promotion."]}
    save("result.json", summary)
    save("calls.json", ledger)
    print(json.dumps({k: summary[k] for k in ["acceptedDevelopmentChanges","calls","knownApiCostUsd","persistentHarnessChanged"]}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Raw exceptions from provider libraries or model JSON may contain private material.
        print("bounded_native_rrsi_pilot_failed; inspect sanitized evidence", file=sys.stderr)
        sys.exit(1)
