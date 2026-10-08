"""Original bounded tool-reading curricula for OpenEnv Arena.

Task source files contain all facts needed to solve the episode. ``expected``
and ``rubric`` are private server-side verifier material and MUST NOT be sent
in observations. No source file is executed and no network access is needed.

Generation uses an isolated PRNG; the reference oracle rereads the virtual
files and never reads ``expected``. Scheduling and routing use different
search formulations in generation and in the oracle.
"""

from __future__ import annotations

import copy
import hashlib
import heapq
import itertools
import json
import math
import random
from collections import deque
from fractions import Fraction
from typing import Any


TASK_IDS = [
    "software_change", "industrial_schedule", "science_calibration",
    "office_reconciliation", "finance_ledger", "math_route",
    "security_triage", "media_timeline",
]
DOMAINS = dict(zip(TASK_IDS, [
    "software engineering", "industrial and physical systems", "natural science",
    "office and white-collar work", "finance and economics", "math and formal reasoning",
    "cybersecurity", "media and content production",
]))


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"


def _load(task: dict, name: str) -> Any:
    return json.loads(task["files"][name])


def _ids(rng: random.Random, prefix: str, count: int) -> list[str]:
    """Opaque synthetic identifiers prevent memorizing fixed anomaly rows."""
    return [f"{prefix}_{number:04}" for number in rng.sample(range(1000, 10000), count)]


def _task(task_id: str, prompt: str, files: dict, expected: dict) -> dict:
    return {
        "task_id": task_id,
        "domain": DOMAINS[task_id],
        "prompt": prompt + " Read all three files. Submit exactly the documented JSON object; "
        "all numeric results must be integers, and ID lists must be lexicographically sorted "
        "unless an execution order or route is requested. Do not include explanations or extra keys.",
        "files": {k: _json(v) for k, v in files.items()},
        "expected": copy.deepcopy(expected),
        "rubric": {
            "version": 1,
            "components": {k: 1 / len(expected) for k in expected},
            "partial_credit": "Equal credit for wholly correct substantive output components; "
            "incomplete answers are capped at 0.8. Empty/noop answers receive zero.",
            "max_partial": 0.8,
        },
    }


def _software(rng: random.Random, d: int) -> dict:
    names = [f"svc_{i:02}" for i in range(4 + 2 * d)]
    rng.shuffle(names)
    modules = {}
    for i, name in enumerate(names):
        deps = rng.sample(names[:i], min(i, rng.randint(1, 3)))
        modules[name] = sorted(deps)
    changed = sorted(rng.sample(names[1:1 + len(names) // 2], d))
    tests = {f"test_{i:02}": sorted(rng.sample(names, rng.randint(1, min(3, d + 1))))
             for i in range(4 + d * 2)}
    tests["test_smoke"] = [names[-1]]
    affected = set(changed)
    # Generation order is topological, independent of the shuffled public IDs.
    for name in names:
        if any(dep in affected for dep in modules[name]):
            affected.add(name)
    indegree = {name: sum(dep in affected for dep in modules[name]) for name in affected}
    ready = [name for name, count in indegree.items() if count == 0]
    heapq.heapify(ready)
    order = []
    while ready:
        current = heapq.heappop(ready)
        order.append(current)
        for consumer in affected:
            if current in modules[consumer]:
                indegree[consumer] -= 1
                if indegree[consumer] == 0:
                    heapq.heappush(ready, consumer)
    expected = {
        "affected": sorted(affected),
        "tests": sorted(k for k, targets in tests.items() if affected.intersection(targets)),
        "build_order": order,
    }
    return _task("software_change",
        "A release changes the modules in change.json. modules.json maps each module to its direct "
        "dependencies. Rebuild changed modules and every transitive consumer. Unaffected dependencies "
        "are already built. Select every test in tests.json that targets any affected module. "
        'Return {"affected":[module IDs],"tests":[test IDs],"build_order":[module IDs]}. '
        "build_order must be a topological ordering of affected modules, always choosing the "
        "lexicographically smallest currently eligible module.",
        {"modules.json": modules, "change.json": {"changed": changed}, "tests.json": tests}, expected)


def _industrial(rng: random.Random, d: int) -> dict:
    n = 4 + d
    jobs = [{"id": f"job_{i}", "duration": rng.randint(2, 8), "release": rng.randint(0, 8),
             "due": rng.randint(9, 30), "weight": rng.randint(1, 5)} for i in range(n)]
    precedences = [[f"job_{i}", f"job_{j}"] for j in range(1, n) for i in range(j)
                   if rng.random() < 0.12 * d]
    calendar = {"blackout": [rng.randint(7, 11), rng.randint(14, 18)], "start": 0}
    # Layered prefix expansion, discarding precedence-infeasible branches.
    states = [((), 0, 0, {})]
    for _ in range(n):
        expanded = []
        for order, end, penalty, completion in states:
            for job in jobs:
                name = job["id"]
                if name in order or any(a not in order for a, b in precedences if b == name):
                    continue
                start = max(end, job["release"])
                lo, hi = calendar["blackout"]
                if start < hi and start + job["duration"] > lo:
                    start = hi
                finish = start + job["duration"]
                expanded.append((order + (name,), finish,
                                 penalty + job["weight"] * max(0, finish - job["due"]),
                                 {**completion, name: finish}))
        states = expanded
    order, end, penalty, completion = min(states, key=lambda x: (x[2], x[1], x[0]))
    return _task("industrial_schedule",
        "Plan jobs on one nonpreemptive shared service machine. Read jobs.json, precedences.json "
        "and calendar.json. Each precedence pair [a,b] requires a before b. For a chosen order, "
        "start each job as early as possible after the prior completion and its release time. "
        "No interval may overlap blackout [lo,hi); a job ending exactly at lo is allowed and a job "
        "starting exactly at hi is allowed. If it overlaps, move its start to hi. Minimize the sum "
        "of weight*max(0,completion-due), then makespan, then lexicographic execution order. "
        'Return {"order":[job IDs],"completion":{job ID:completion minute},'
        '"weighted_tardiness":integer,"makespan":integer}. Do not insert discretionary idle time.',
        {"jobs.json": jobs, "precedences.json": precedences, "calendar.json": calendar},
        {"order": list(order), "completion": completion, "weighted_tardiness": penalty, "makespan": end})


def _science(rng: random.Random, d: int) -> dict:
    gain, offset = rng.randint(2, 7), rng.randint(-15, 15)
    refs = [{"reference": v, "raw": v * gain + offset} for v in (5, 45)]
    policy = {"acceptable_median": [15, 35], "max_replicate_span": 6}
    raw, medians, quarantine, accepted = {}, {}, [], []
    sample_ids = _ids(rng, "sample", 4 + d * 2)
    for i, name in enumerate(sample_ids):
        base = rng.randint(19, 31)
        values = [base - 1, base, base + 1]
        if i == 0:
            values = [base, base + 1, base + 12]
        elif i == 1:
            values = [39, 40, 41]
        elif i > 2 and rng.random() < .2 * d:
            values[0] -= 10
        medians[name] = sorted(values)[1]
        bad = max(values) - min(values) > 6 or not 15 <= medians[name] <= 35
        if bad:
            quarantine.append(name)
        else:
            accepted.append(medians[name])
        rng.shuffle(values)
        raw[name] = [gain * v + offset for v in values]
    mean = Fraction(sum(accepted), len(accepted))
    return _task("science_calibration",
        "Audit a calibrated sensor batch. calibration.json gives two standards obeying "
        "raw=gain*reference+offset with integer gain and offset. Correct every raw replicate in "
        "samples.json, then calculate each sample's median. quarantine samples whose corrected "
        "replicate span is greater than max_replicate_span or whose median is outside the inclusive "
        "acceptable_median interval in policy.json. Compute the arithmetic mean of accepted sample "
        "medians as a reduced fraction with positive denominator. "
        'Return {"calibration":{"gain":integer,"offset":integer},"medians":{sample ID:integer},'
        '"quarantine":[sample IDs],"accepted_mean":{"numerator":integer,"denominator":integer}}.',
        {"calibration.json": refs, "samples.json": raw, "policy.json": policy},
        {"calibration": {"gain": gain, "offset": offset}, "medians": medians,
         "quarantine": sorted(quarantine), "accepted_mean": {"numerator": mean.numerator, "denominator": mean.denominator}})


def _office(rng: random.Random, d: int) -> dict:
    master = [{"id": f"person_{i}", "email": f"person{i}@example.invalid",
               "phone": f"555010{i:04}", "team": rng.choice(["ops", "sales", "research"])}
              for i in range(3 + d)]
    aliases = {f"legacy{i}@example.invalid": row["email"] for i, row in enumerate(master)}
    policy = {"aliases": aliases, "source_priority": {"hr": 3, "crm": 2, "import": 1}}
    changes = []
    row_ids = _ids(rng, "row", 6 + 3 * d)
    unresolved_index = rng.randrange(len(row_ids))
    for i, row_id in enumerate(row_ids):
        person = rng.randrange(len(master))
        email = rng.choice([f"person{person}@example.invalid", f"legacy{person}@example.invalid"])
        if i == unresolved_index:
            email = "unknown@example.invalid"
        fields = {"team": rng.choice(["ops", "sales", "research", "support"])}
        if i % 3 != 0:
            fields["phone"] = f"(555) 02{rng.randrange(100000):05}"
        changes.append({"id": row_id, "email": f" {email.upper()} ",
                        "timestamp": rng.randint(100, 103), "source": rng.choice(list(policy["source_priority"])),
                        "fields": fields})
    # Group by entity and field; pick the maximum provenance tuple.
    result = {r["id"]: {"phone": r["phone"], "team": r["team"]} for r in master}
    email_to_id = {r["email"]: r["id"] for r in master}
    groups: dict = {}
    unresolved = []
    for row in changes:
        address = row["email"].strip().lower()
        address = aliases.get(address, address)
        who = email_to_id.get(address)
        if who is None:
            unresolved.append(row["id"])
            continue
        for key, value in row["fields"].items():
            if key == "phone":
                value = "".join(c for c in value if c.isdigit())
            groups.setdefault((who, key), []).append(
                ((row["timestamp"], policy["source_priority"][row["source"]], row["id"]), value))
    for (who, field), candidates in groups.items():
        result[who][field] = max(candidates)[1]
    rng.shuffle(changes)
    return _task("office_reconciliation",
        "Merge contact updates without merging different people. Read contacts.json, changes.json "
        "and policy.json. Normalize email by trimming whitespace and lowercasing; apply exactly "
        "one alias lookup, then match the master email. Unmatched rows are unresolved. For each "
        "person and each field independently, use the update with greatest timestamp, then greatest "
        "source_priority, then lexicographically greatest row ID. Preserve the master value if no "
        "matching update supplies that field. Strip every nondigit character from updated phones. "
        'Return {"contacts":{person ID:{"phone":string,"team":string}},"unresolved":[row IDs]}.',
        {"contacts.json": master, "changes.json": changes, "policy.json": policy},
        {"contacts": result, "unresolved": sorted(unresolved)})


def _finance(rng: random.Random, d: int) -> dict:
    opening = {f"acct_{i}": rng.randint(2000, 12000) for i in range(2 + d)}
    entry_count = 5 + d * 2
    event_ids = _ids(rng, "txn", entry_count + 6)
    pending_index = rng.randrange(entry_count)
    reverse_index = rng.choice([i for i in range(entry_count) if i != pending_index])
    events = []
    for i in range(entry_count):
        events.append({"id": event_ids[i], "sequence": i, "kind": "entry",
                       "account": rng.choice(list(opening)), "cents": rng.choice([-1, 1]) * rng.randint(50, 1900),
                       "status": "pending" if i == pending_index else "posted"})
    for target in [event_ids[reverse_index], event_ids[reverse_index], event_ids[pending_index], "absent", event_ids[entry_count]]:
        i = len(events)
        events.append({"id": event_ids[i], "sequence": i, "kind": "reversal", "target": target,
                       "status": "posted"})
    # A future entry cannot authorize an earlier reversal, even if it later posts.
    events.insert(0, {"id": event_ids[-1], "sequence": -1, "kind": "reversal",
                      "target": event_ids[reverse_index], "status": "posted"})
    policy = {"currency": "USD", "unit": "integer cents", "reversal": "full, once, previously posted entry only"}
    closing = dict(opening)
    applied, rejected, held, undone, posting = [], [], [], set(), {}
    for event in events:
        name = event["id"]
        if event["status"] != "posted":
            held.append(name)
        elif event["kind"] == "entry":
            closing[event["account"]] += event["cents"]
            posting[name] = event
            applied.append(name)
        elif event["target"] not in posting or event["target"] in undone:
            rejected.append(name)
        else:
            target = posting[event["target"]]
            closing[target["account"]] -= target["cents"]
            undone.add(target["id"])
            applied.append(name)
    rng.shuffle(events)
    return _task("finance_ledger",
        "Close a synthetic cash ledger using accounts.json, events.json and policy.json. Process "
        "events in ascending sequence, regardless of file order. Pending events are held and have "
        "no balance effect. Posted entries add their signed integer cents to the account. A posted "
        "reversal undoes one previously applied entry in full; a pending, unknown, future, reversal, "
        "or already reversed target is invalid and the reversal is rejected. Original entries "
        "remain in applied_ids even when reversed. "
        'Return {"closing_cents":{account ID:integer},"applied_ids":[event IDs],'
        '"rejected_ids":[event IDs],"held_ids":[event IDs]}.',
        {"accounts.json": opening, "events.json": events, "policy.json": policy},
        {"closing_cents": closing, "applied_ids": sorted(applied), "rejected_ids": sorted(rejected), "held_ids": sorted(held)})


def _math(rng: random.Random, d: int) -> dict:
    n = 6 + 2 * d
    nodes = [f"N{i:02}" for i in range(n)]
    blocked = rng.choice(nodes[2:-2])
    backbone = [node for node in nodes if node != blocked]
    edges = {}
    for a, b in zip(backbone, backbone[1:]):
        edges[(a, b)] = {"from": a, "to": b, "minutes": rng.randint(1, 7), "exposure": rng.randint(0, 2)}
    for i in range(n):
        for j in range(i + 1, n):
            if (nodes[i], nodes[j]) not in edges and rng.random() < .23:
                edges[(nodes[i], nodes[j])] = {"from": nodes[i], "to": nodes[j],
                                              "minutes": rng.randint(2, 12), "exposure": rng.randint(0, 5)}
    checkpoints = sorted(rng.sample(backbone[1:-1], d))
    budget = sum(edges[(a, b)]["exposure"] for a, b in zip(backbone, backbone[1:])) + rng.randint(0, 3)
    request = {"start": nodes[0], "goal": nodes[-1], "required": checkpoints}
    policy = {"forbidden": [blocked], "max_exposure": budget}
    candidates = []
    def visit(path: list, minutes: int, exposure: int) -> None:
        if exposure > budget:
            return
        if path[-1] == nodes[-1]:
            if all(c in path for c in checkpoints):
                candidates.append((minutes, exposure, tuple(path)))
            return
        for (a, b), edge in edges.items():
            if a == path[-1] and b != blocked:
                visit(path + [b], minutes + edge["minutes"], exposure + edge["exposure"])
    visit([nodes[0]], 0, 0)
    minutes, exposure, route = min(candidates)
    return _task("math_route",
        "Find a constrained route in a directed acyclic network. Read graph.json, request.json "
        "and policy.json. Visit every required checkpoint, avoid forbidden nodes, and keep summed "
        "exposure at or below max_exposure. Among feasible routes minimize total minutes, then "
        "total exposure, then the lexicographic node sequence. Edges are directed. "
        'Return {"route":[node IDs in travel order],"minutes":integer,"exposure":integer}.',
        {"graph.json": list(edges.values()), "request.json": request, "policy.json": policy},
        {"route": list(route), "minutes": minutes, "exposure": exposure})


def _security(rng: random.Random, d: int) -> dict:
    users = {f"user_{i}": {"role": ["reader", "operator", "admin"][i % 3], "enabled": i != 1}
             for i in range(3 + d)}
    policy = {
        "role_actions": {"reader": ["read"], "operator": ["read", "write"], "admin": ["read", "write", "delete"]},
        "secret_roles": ["admin"], "trusted_zones": ["office", "vpn"],
        "mfa_actions": ["write", "delete"], "containment_denials": 2,
    }
    events = []
    for event_id in _ids(rng, "event", 7 + d * 3):
        events.append({"id": event_id, "user": rng.choice(list(users)),
                       "action": rng.choice(["read", "write", "delete"]),
                       "sensitivity": rng.choice(["public", "internal", "secret"]),
                       "zone": rng.choice(["office", "vpn", "external"]),
                       "mfa": rng.choice([True, False]), "time": rng.randint(95, 105), "expires": 100})
    events[0].update(user="user_0", action="read", sensitivity="public", zone="office", mfa=True, time=99)
    allowed, denied, counts = [], {}, dict.fromkeys(users, 0)
    for event in events:
        user = users[event["user"]]
        tests = {
            "disabled": not user["enabled"],
            "action_forbidden": event["action"] not in policy["role_actions"][user["role"]],
            "secret_role": event["sensitivity"] == "secret" and user["role"] not in policy["secret_roles"],
            "mfa_required": (event["action"] in policy["mfa_actions"] or event["sensitivity"] == "secret") and not event["mfa"],
            "untrusted_zone": event["sensitivity"] != "public" and event["zone"] not in policy["trusted_zones"],
            "expired": event["time"] >= event["expires"],
        }
        reasons = sorted(k for k, bad in tests.items() if bad)
        if reasons:
            denied[event["id"]] = reasons
            counts[event["user"]] += 1
        else:
            allowed.append(event["id"])
    return _task("security_triage",
        "Audit synthetic authorization logs, not a live system. Read identities.json, policy.json "
        "and events.json. A request is denied if ANY rule fails. Report ALL applicable reason codes: "
        "disabled if the identity is disabled; action_forbidden if the role lacks the action; "
        "secret_role if secret data needs a role absent from secret_roles; mfa_required if a "
        "mfa_actions action OR secret data is requested without MFA; untrusted_zone if nonpublic "
        "data is accessed outside trusted_zones; expired if time>=expires. Count denied requests "
        "per user, not individual reason codes. Contain users meeting containment_denials. "
        'Return {"allowed_ids":[event IDs],"denied":{event ID:[sorted reason codes]},'
        '"containment":[user IDs]}. Only denied events belong in denied.',
        {"identities.json": users, "policy.json": policy, "events.json": events},
        {"allowed_ids": sorted(allowed), "denied": denied,
         "containment": sorted(k for k, count in counts.items() if count >= policy["containment_denials"])})


def _media(rng: random.Random, d: int) -> dict:
    assets = {f"asset_{i}": {"frames": rng.randint(200, 600), "licensed": i != 1} for i in range(4 + d)}
    clips = []
    for i, clip_id in enumerate(_ids(rng, "clip", 4 + d * 2)):
        asset = rng.choice(list(assets))
        if i in (0, 2):
            asset = "asset_0"
        if i == 1:
            asset = "asset_1"
        speed = rng.choice([(1, 1), (2, 1), (1, 2)])
        start = rng.randint(0, 50)
        length = rng.randint(20, 60) * 2
        stop = start + length
        if i == 3:
            stop = assets[asset]["frames"] + 10
        if i == 4:
            stop += 1
            speed = (2, 1)
        clips.append({"id": clip_id, "asset": asset, "in": start, "out": stop,
                      "speed_num": speed[0], "speed_den": speed[1], "overlap": rng.randint(0, 40)})
    policy = {"max_overlap": rng.randint(8, 18), "delivery_budget": 200 + d * 70, "require_license": True}
    rejected, timeline = {}, []
    previous_duration, end = 0, 0
    for clip in clips:
        asset = assets[clip["asset"]]
        reasons = []
        if not asset["licensed"]:
            reasons.append("unlicensed")
        if clip["in"] < 0 or not clip["in"] < clip["out"] <= asset["frames"]:
            reasons.append("source_bounds")
        length = Fraction((clip["out"] - clip["in"]) * clip["speed_den"], clip["speed_num"])
        if length.denominator != 1:
            reasons.append("fractional_frame")
        if reasons:
            rejected[clip["id"]] = sorted(reasons)
            continue
        duration = int(length)
        overlap = 0 if not timeline else min(clip["overlap"], policy["max_overlap"], previous_duration - 1, duration - 1)
        start = end - overlap
        end = start + duration
        timeline.append({"id": clip["id"], "start": start, "end": end})
        previous_duration = duration
    return _task("media_timeline",
        "Repair a frame-exact edit decision list. Read assets.json, edits.json and delivery.json. "
        "All frames use one shared timebase and [in,out) source intervals. Reject clips for ALL "
        "applicable reasons: unlicensed when require_license is true and the asset lacks a license; "
        "source_bounds unless 0<=in<out<=asset frames; fractional_frame if (out-in)*speed_den/speed_num "
        "is not an integer. Skip rejected clips without consuming timeline time. Place retained clips "
        "in edits order, first at frame 0. For each later clip, overlap the previous retained clip by "
        "min(requested overlap,max_overlap,previous rendered duration-1,current rendered duration-1). "
        "End is exclusive. Compute final total_frames and max(0,total_frames-delivery_budget). "
        'Return {"rejected":{clip ID:[sorted reason codes]},"timeline":[{"id":clip ID,"start":integer,"end":integer}],'
        '"total_frames":integer,"over_budget_frames":integer}.',
        {"assets.json": assets, "edits.json": clips, "delivery.json": policy},
        {"rejected": rejected, "timeline": timeline, "total_frames": end,
         "over_budget_frames": max(0, end - policy["delivery_budget"])})


_GENERATORS = dict(zip(TASK_IDS, [_software, _industrial, _science, _office, _finance, _math, _security, _media]))


def make_task(task_id: str, seed: int, difficulty: int = 2) -> dict:
    """Generate a fresh task without touching global RNG state or caller data."""
    if task_id not in _GENERATORS:
        raise ValueError(f"Unknown task_id: {task_id!r}")
    if type(seed) is not int:
        raise ValueError("seed must be an integer, not a boolean")
    if type(difficulty) is not int or difficulty not in (1, 2, 3):
        raise ValueError("difficulty must be 1, 2, or 3")
    seed_bytes = f"arena-curriculum-v1|{task_id}|{seed}|{difficulty}".encode()
    rng = random.Random(int.from_bytes(hashlib.sha256(seed_bytes).digest(), "big"))
    result = _GENERATORS[task_id](rng, difficulty)
    result.update(seed=seed, difficulty=difficulty, generator_version=1)
    return result


def _strict_equal(a: Any, b: Any) -> bool:
    """JSON equality without Python's True==1 or nonfinite-number traps."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_strict_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(_strict_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, float) and not math.isfinite(a):
        return False
    return a == b


def _substantive(value: Any) -> bool:
    if isinstance(value, dict):
        return any(_substantive(v) for v in value.values())
    if isinstance(value, list):
        return any(_substantive(v) for v in value)
    return type(value) is str and bool(value) or type(value) is int and value != 0


def _valid_answer(value: Any) -> bool:
    """Bound verifier work and reject coercion-prone or non-JSON answers."""
    pending, count = [(value, 0)], 0
    while pending:
        node, depth = pending.pop()
        count += 1
        if depth > 20 or count > 2048:
            return False
        if type(node) is dict:
            if any(type(key) is not str for key in node):
                return False
            pending.extend((item, depth + 1) for item in node.values())
        elif type(node) is list:
            pending.extend((item, depth + 1) for item in node)
        elif type(node) not in (int, str):
            return False
    return True


def grade(task: dict, answer: dict) -> float:
    """Grade only exact meaningful components; never mutate task or answer."""
    if type(answer) is not dict or not answer or not _valid_answer(answer) or not _substantive(answer):
        return 0.0
    expected = task["expected"]
    if any(type(key) is not str or key not in expected for key in answer):
        return 0.0
    correct = [key for key in expected if key in answer and _strict_equal(answer[key], expected[key])]
    if len(correct) == len(expected):
        return 1.0
    # An empty set by itself is not evidence of a solved subproblem.
    correct = [key for key in correct if _substantive(answer[key])]
    return min(0.8, len(correct) / len(expected))


def oracle_answer(task: dict) -> dict:
    """Independent deterministic reference solution from the three source files.

    This function is an offline test/benchmark helper, never an environment tool.
    It intentionally ignores cached expected answers and hidden generator state.
    """
    task_id = task["task_id"]
    if task_id == "software_change":
        modules, changes, tests = (_load(task, x) for x in ("modules.json", "change.json", "tests.json"))
        reverse = {name: [] for name in modules}
        for consumer, dependencies in modules.items():
            for dependency in dependencies:
                reverse[dependency].append(consumer)
        affected, queue = set(), deque(changes["changed"])
        while queue:
            name = queue.popleft()
            if name not in affected:
                affected.add(name)
                queue.extend(reverse[name])
        remaining, order = set(affected), []
        while remaining:
            chosen = min(name for name in remaining if not remaining.intersection(modules[name]))
            order.append(chosen)
            remaining.remove(chosen)
        return {"affected": sorted(affected),
                "tests": sorted(name for name, targets in tests.items() if any(t in affected for t in targets)),
                "build_order": order}

    if task_id == "industrial_schedule":
        jobs, precedences, calendar = (_load(task, x) for x in ("jobs.json", "precedences.json", "calendar.json"))
        by_id = {job["id"]: job for job in jobs}
        best, completions = None, None
        for order in itertools.permutations(sorted(by_id)):
            positions = {name: i for i, name in enumerate(order)}
            if any(positions[a] >= positions[b] for a, b in precedences):
                continue
            end, penalty, completion = calendar["start"], 0, {}
            for name in order:
                job = by_id[name]
                end = max(end, job["release"])
                lo, hi = calendar["blackout"]
                # Two half-open intervals intersect iff max(starts)<min(ends).
                if max(end, lo) < min(end + job["duration"], hi):
                    end = hi
                end += job["duration"]
                completion[name] = end
                penalty += job["weight"] * max(end - job["due"], 0)
            score = (penalty, end, order)
            if best is None or score < best:
                best, completions = score, completion
        return {"order": list(best[2]), "completion": completions,
                "weighted_tardiness": best[0], "makespan": best[1]}

    if task_id == "science_calibration":
        refs, samples, policy = (_load(task, x) for x in ("calibration.json", "samples.json", "policy.json"))
        slope = Fraction(refs[1]["raw"] - refs[0]["raw"], refs[1]["reference"] - refs[0]["reference"])
        intercept = refs[0]["raw"] - refs[0]["reference"] * slope
        medians, quarantine, total, count = {}, [], Fraction(0), 0
        for name, values in samples.items():
            corrected = sorted((Fraction(raw) - intercept) / slope for raw in values)
            middle = corrected[len(corrected) // 2]
            medians[name] = int(middle)
            lo, hi = policy["acceptable_median"]
            if corrected[-1] - corrected[0] > policy["max_replicate_span"] or middle < lo or middle > hi:
                quarantine.append(name)
            else:
                total += middle
                count += 1
        mean = total / count
        return {"calibration": {"gain": int(slope), "offset": int(intercept)}, "medians": medians,
                "quarantine": sorted(quarantine), "accepted_mean": {"numerator": mean.numerator, "denominator": mean.denominator}}

    if task_id == "office_reconciliation":
        master, changes, policy = (_load(task, x) for x in ("contacts.json", "changes.json", "policy.json"))
        contacts = {person["id"]: {"phone": person["phone"], "team": person["team"]} for person in master}
        unresolved = []
        # Applying ascending provenance order naturally retains the last field update.
        for row in sorted(changes, key=lambda r: (r["timestamp"], policy["source_priority"][r["source"]], r["id"])):
            address = row["email"].lower().strip()
            address = policy["aliases"].get(address, address)
            matching = [person for person in master if person["email"] == address]
            if not matching:
                unresolved.append(row["id"])
                continue
            for field in ("phone", "team"):
                if field in row["fields"]:
                    value = row["fields"][field]
                    contacts[matching[0]["id"]][field] = "".join(filter(str.isdigit, value)) if field == "phone" else value
        return {"contacts": contacts, "unresolved": sorted(unresolved)}

    if task_id == "finance_ledger":
        opening, events = _load(task, "accounts.json"), _load(task, "events.json")
        ordered = sorted(events, key=lambda row: row["sequence"])
        applied, held, rejected, reversed_ids = [], [], [], set()
        contributions = {account: [] for account in opening}
        for position, event in enumerate(ordered):
            if event["status"] == "pending":
                held.append(event["id"])
                continue
            if event["kind"] == "entry":
                contributions[event["account"]].append(event["cents"])
            else:
                targets = [old for old in ordered[:position] if old["id"] == event["target"]
                           and old["kind"] == "entry" and old["id"] in applied and old["id"] not in reversed_ids]
                if not targets:
                    rejected.append(event["id"])
                    continue
                target = targets[0]
                contributions[target["account"]].append(-target["cents"])
                reversed_ids.add(target["id"])
            applied.append(event["id"])
        return {"closing_cents": {account: opening[account] + sum(values) for account, values in contributions.items()},
                "applied_ids": sorted(applied), "rejected_ids": sorted(rejected), "held_ids": sorted(held)}

    if task_id == "math_route":
        edges, request, policy = (_load(task, x) for x in ("graph.json", "request.json", "policy.json"))
        bits = {node: 1 << i for i, node in enumerate(request["required"])}
        goal_mask = (1 << len(bits)) - 1
        heap = [(0, 0, (request["start"],), bits.get(request["start"], 0))]
        visited = set()
        while heap:
            minutes, exposure, route, mask = heapq.heappop(heap)
            node = route[-1]
            state = (node, mask, exposure)
            if state in visited:
                continue
            visited.add(state)
            if node == request["goal"] and mask == goal_mask:
                return {"route": list(route), "minutes": minutes, "exposure": exposure}
            for edge in edges:
                if edge["from"] != node or edge["to"] in policy["forbidden"]:
                    continue
                next_exposure = exposure + edge["exposure"]
                if next_exposure <= policy["max_exposure"]:
                    heapq.heappush(heap, (minutes + edge["minutes"], next_exposure,
                                          route + (edge["to"],), mask | bits.get(edge["to"], 0)))
        raise ValueError("No feasible route in task")

    if task_id == "security_triage":
        identities, policy, events = (_load(task, x) for x in ("identities.json", "policy.json", "events.json"))
        allowed, denied, denied_users = [], {}, []
        for event in events:
            user = identities[event["user"]]
            reasons = []
            if not user["enabled"]:
                reasons.append("disabled")
            if event["action"] not in policy["role_actions"].get(user["role"], []):
                reasons.append("action_forbidden")
            if event["sensitivity"] == "secret" and user["role"] not in policy["secret_roles"]:
                reasons.append("secret_role")
            needs_mfa = event["sensitivity"] == "secret" or event["action"] in policy["mfa_actions"]
            if needs_mfa and not event["mfa"]:
                reasons.append("mfa_required")
            if event["sensitivity"] in ("internal", "secret") and event["zone"] not in policy["trusted_zones"]:
                reasons.append("untrusted_zone")
            if event["expires"] <= event["time"]:
                reasons.append("expired")
            if reasons:
                denied[event["id"]] = sorted(reasons)
                denied_users.append(event["user"])
            else:
                allowed.append(event["id"])
        return {"allowed_ids": sorted(allowed), "denied": denied,
                "containment": sorted(user for user in identities if denied_users.count(user) >= policy["containment_denials"])}

    if task_id == "media_timeline":
        assets, clips, policy = (_load(task, x) for x in ("assets.json", "edits.json", "delivery.json"))
        retained, rejected = [], {}
        for clip in clips:
            asset = assets[clip["asset"]]
            numerator = (clip["out"] - clip["in"]) * clip["speed_den"]
            duration, remainder = divmod(numerator, clip["speed_num"])
            reasons = []
            if policy["require_license"] and not asset["licensed"]:
                reasons.append("unlicensed")
            if not (0 <= clip["in"] < clip["out"] <= asset["frames"]):
                reasons.append("source_bounds")
            if remainder:
                reasons.append("fractional_frame")
            if reasons:
                rejected[clip["id"]] = sorted(reasons)
            else:
                retained.append((clip, duration))
        timeline, total = [], 0
        for i, (clip, duration) in enumerate(retained):
            overlap = 0 if i == 0 else min(policy["max_overlap"], clip["overlap"], duration - 1, retained[i - 1][1] - 1)
            total += duration - overlap
            timeline.append({"id": clip["id"], "start": total - duration, "end": total})
        return {"rejected": rejected, "timeline": timeline, "total_frames": total,
                "over_budget_frames": max(0, total - policy["delivery_budget"])}
    raise ValueError(f"Unknown task_id: {task_id!r}")
