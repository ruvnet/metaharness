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
        "all numeric results must have integer values, and ID lists must be lexicographically sorted "
        "unless an execution order or route is requested. Do not include explanations or extra keys.",
        "files": {k: _json(v) for k, v in files.items()},
        "expected": copy.deepcopy(expected),
        "rubric": {
            "version": 2,
            "components": {k: 1 / len(expected) for k in expected},
            "partial_credit": "Equal credit for wholly correct output components; zero/empty components count once "
            "another correct substantive component anchors the answer. "
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
    tests = {f"test_{i:02}": {"targets": sorted(rng.sample(names, rng.randint(1, min(4, d + 2)))),
                             "cost": rng.randint(2, 10)} for i in range(5 + d)}
    # Two expensive fallback suites guarantee coverage without disclosing impact.
    tests["test_full_a"] = {"targets": names[::2], "cost": 12 + d}
    tests["test_full_b"] = {"targets": names[1::2], "cost": 12 + d}
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
    covers = []
    test_names = sorted(tests)
    for count in range(1, len(tests) + 1):
        for selected in itertools.combinations(test_names, count):
            covered = set().union(*(tests[name]["targets"] for name in selected))
            if affected <= covered:
                covers.append((sum(tests[name]["cost"] for name in selected), count, selected))
    test_cost, _, selected = min(covers)
    expected = {
        "affected": sorted(affected),
        "tests": list(selected), "test_cost": test_cost,
        "build_order": order,
    }
    return _task("software_change",
        "A release changes the modules in change.json. modules.json maps each module to its direct "
        "dependencies. Rebuild changed modules and every transitive consumer. Unaffected dependencies "
        "are already built. tests.json gives each regression suite's targets and cost. Select suites "
        "whose target union covers EVERY affected module; minimize total cost, then suite count, "
        "then the sorted suite ID list lexicographically. Covering extra unaffected modules is allowed. "
        'Return {"affected":[module IDs],"tests":[selected suite IDs],"test_cost":integer,"build_order":[module IDs]}. '
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
    gain, offset, drift = rng.randint(2, 7), rng.randint(-15, 15), rng.choice([-3, -2, -1, 1, 2, 3])
    refs = [{"reference": v, "time": t, "raw": v * gain + offset + drift * t}
            for v, t in ((5, 0), (45, 0), (5, 10))]
    rng.shuffle(refs)
    policy = {"acceptable_median": [15, 35], "max_replicate_span": rng.randint(6, 9)}
    raw, medians, quarantine, accepted = {}, {}, [], []
    sample_ids = _ids(rng, "sample", 4 + d * 2)
    bad_positions = set(rng.sample(range(len(sample_ids)), rng.randint(1, len(sample_ids) - 2)))
    for i, name in enumerate(sample_ids):
        base = rng.randint(19, 31)
        values = [base - 1, base, base + 1] if d == 1 else [base - 2, base - 1, base, base + 1, base + 2]
        if i in bad_positions:
            if rng.random() < .5:
                values[0] -= policy["max_replicate_span"] + 3
            else:
                values = [v + 20 for v in values]
        time, weight = rng.randint(1, 12), rng.randint(1, 2 + d)
        medians[name] = sorted(values)[len(values) // 2]
        bad = max(values) - min(values) > policy["max_replicate_span"] or not 15 <= medians[name] <= 35
        if bad:
            quarantine.append(name)
        else:
            accepted.append((medians[name], weight))
        rng.shuffle(values)
        raw[name] = {"time": time, "weight": weight, "raw": [gain * v + offset + drift * time for v in values]}
    mean = Fraction(sum(value * weight for value, weight in accepted), sum(weight for _, weight in accepted))
    return _task("science_calibration",
        "Audit a sensor with linear time drift. calibration.json gives standards satisfying "
        "raw=gain*reference+offset+drift*time. Infer all three integer parameters from the standards "
        "regardless of their file order. Correct each sample's raw replicates at its recorded time. "
        "Quarantine samples whose corrected replicate span exceeds max_replicate_span or whose "
        "median is outside the inclusive acceptable_median interval in policy.json. Compute the "
        "WEIGHTED mean of accepted sample medians using each sample's weight, as a reduced fraction "
        "with positive denominator. "
        '{"calibration":{"gain":integer,"offset":integer,"drift":integer},"medians":{sample ID:integer},'
        '"quarantine":[sample IDs],"accepted_mean":{"numerator":integer,"denominator":integer}}.',
        {"calibration.json": refs, "samples.json": raw, "policy.json": policy},
        {"calibration": {"gain": gain, "offset": offset, "drift": drift}, "medians": medians,
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
    entry_count, reversal_count = 5 + d * 2, rng.randint(3, 4 + d)
    event_ids = _ids(rng, "txn", entry_count + reversal_count)
    pending = set(rng.sample(range(entry_count), rng.randint(0, d + 1)))
    protected = rng.choice([i for i in range(entry_count) if i not in pending])
    events = []
    for i in range(entry_count):
        events.append({"id": event_ids[i], "kind": "entry",
                       "account": rng.choice(list(opening)), "cents": rng.choice([-1, 1]) * rng.randint(50, 1900),
                       "status": "pending" if i in pending else "posted"})
    amount = abs(events[protected]["cents"])
    first_amount = rng.randint(1, amount)
    second_amount = rng.randint(1, amount)
    for i in range(reversal_count):
        target = event_ids[protected] if i < 2 else rng.choice([name for name in event_ids if name != event_ids[protected]] + ["absent"])
        events.append({"id": event_ids[entry_count + i], "kind": "reversal", "target": target,
                       "cents": [first_amount, second_amount][i] if i < 2 else rng.randint(1, 1600),
                       "status": "posted" if i < 2 or rng.random() > .2 else "pending"})
    # Interleave timestamps, then guarantee one real partial reversal. The second
    # may succeed or exceed remaining principal; other events may refer forward.
    forced = events[entry_count:entry_count + 2]
    events = events[:entry_count] + events[entry_count + 2:]
    rng.shuffle(events)
    pos = next(i for i, event in enumerate(events) if event["id"] == event_ids[protected]) + 1
    events[pos:pos] = forced
    for sequence, event in enumerate(events):
        event["sequence"] = sequence
    policy = {"currency": "USD", "unit": "integer cents", "reversal": "positive partial amount, cumulative cap is original absolute cents"}
    closing = dict(opening)
    applied, rejected, held, used, posting = [], [], [], {}, {}
    for event in events:
        name = event["id"]
        if event["status"] != "posted":
            held.append(name)
        elif event["kind"] == "entry":
            closing[event["account"]] += event["cents"]
            posting[name] = event
            applied.append(name)
        else:
            target = posting.get(event["target"])
            cents = event["cents"]
            if target is None or cents <= 0 or used.get(target["id"], 0) + cents > abs(target["cents"]):
                rejected.append(name)
            else:
                closing[target["account"]] -= cents if target["cents"] > 0 else -cents
                used[target["id"]] = used.get(target["id"], 0) + cents
                applied.append(name)
    rng.shuffle(events)
    return _task("finance_ledger",
        "Close a synthetic cash ledger using accounts.json, events.json and policy.json. Process "
        "ascending sequence, not file order. Pending entries AND pending reversals are held with "
        "no effect. Posted entries add signed cents. A posted reversal has POSITIVE cents and undoes "
        "that amount against a previously applied entry, in the opposite direction to its sign. "
        "Reject unknown, future, pending, or reversal targets, nonpositive amounts, and reversals "
        "that would make cumulative accepted reversal cents exceed the original absolute cents. "
        "Reject the entire over-limit event; never clip its amount. Partial reversals may repeat "
        "until the principal is exhausted. applied_ids includes BOTH accepted entry events AND "
        "accepted reversal events; original entries remain applied even when fully reversed. "
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
    arrivals = {backbone[0]: 0}
    for a, b in zip(backbone, backbone[1:]):
        arrivals[b] = arrivals[a] + edges[(a, b)]["minutes"]
    policy["node_windows"] = {node: [max(0, arrivals[node] - rng.randint(0, 5)), arrivals[node] + rng.randint(0, 4)]
                              for node in rng.sample(backbone[2:], d + 1)}
    policy["required_before"] = {node: [rng.choice(backbone[1:backbone.index(node)])]
                                  for node in rng.sample(backbone[3:], d)}
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
                if any(key not in path for key in policy["required_before"].get(b, [])):
                    continue
                arrival = minutes + edge["minutes"]
                lo, hi = policy["node_windows"].get(b, [0, 10**9])
                arrival = max(arrival, lo)
                if arrival <= hi:
                    visit(path + [b], arrival, exposure + edge["exposure"])
    visit([nodes[0]], 0, 0)
    minutes, exposure, route = min(candidates)
    return _task("math_route",
        "Find a constrained route in a directed acyclic network. Read graph.json, request.json "
        "and policy.json. Visit every required checkpoint, avoid forbidden nodes, and keep summed "
        "exposure at or below max_exposure. Among feasible routes minimize total minutes, then "
        "total exposure, then the lexicographic node sequence. Time starts at zero. On reaching a "
        "node with [open,close] in node_windows, wait until open if early and reject arrival after "
        "close. Waiting adds minutes but no exposure. Each required_before mapping requires those "
        "nodes to have been visited BEFORE entering its key node. Edges are directed. "
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
    names = [f"asset_{i}" for i in range(4 + d)]
    unlicensed = set(rng.sample(names, rng.randint(1, 2)))
    assets = {name: {"frames": rng.randint(350, 650), "licensed": name not in unlicensed,
                     "fps": rng.choice([24, 25, 30])} for name in names}
    policy = {"max_overlap": rng.randint(8, 18), "delivery_budget": 150 + d * 60,
              "require_license": True, "fps": rng.choice([24, 25, 30])}
    clip_ids = _ids(rng, "clip", 4 + d * 2)
    faults = set(rng.sample(range(len(clip_ids)), rng.randint(1, len(clip_ids) - 2)))
    clips = []
    for i, clip_id in enumerate(clip_ids):
        asset = rng.choice([name for name in names if name not in unlicensed])
        speed = rng.choice([(1, 1), (2, 1), (1, 2), (3, 2)])
        ratio = Fraction(speed[1] * policy["fps"], speed[0] * assets[asset]["fps"])
        start = rng.randint(0, 40)
        length = ratio.denominator * rng.randint(4, min(12, 250 // ratio.denominator))
        stop = start + length
        if i in faults:
            mode = rng.choice(["license", "bounds", "fraction", "combined"])
            if mode in ("license", "combined"):
                asset = rng.choice(sorted(unlicensed))
            if mode in ("bounds", "combined"):
                stop = assets[asset]["frames"] + rng.randint(1, 12)
            if mode == "fraction":
                # Rendering one source frame at this rational speed cannot be integral.
                speed = (2 * policy["fps"], 1)
                stop = start + 1
        clips.append({"id": clip_id, "asset": asset, "in": start, "out": stop,
                      "speed_num": speed[0], "speed_den": speed[1], "overlap": rng.randint(0, 30),
                      "gap_before": rng.randint(1, 12) if rng.random() < .25 else 0})
    rejected, timeline = {}, []
    previous_duration, end = 0, 0
    for clip in clips:
        asset = assets[clip["asset"]]
        reasons = []
        if not asset["licensed"]:
            reasons.append("unlicensed")
        if not 0 <= clip["in"] < clip["out"] <= asset["frames"]:
            reasons.append("source_bounds")
        length = Fraction((clip["out"] - clip["in"]) * clip["speed_den"] * policy["fps"],
                          clip["speed_num"] * asset["fps"])
        if length.denominator != 1:
            reasons.append("fractional_frame")
        if reasons:
            rejected[clip["id"]] = sorted(reasons)
            continue
        duration = int(length)
        gap = clip["gap_before"]
        overlap = 0 if not timeline or gap else min(clip["overlap"], policy["max_overlap"], previous_duration - 1, duration - 1)
        start = end + gap - overlap
        end = start + duration
        timeline.append({"id": clip["id"], "start": start, "end": end})
        previous_duration = duration
    return _task("media_timeline",
        "Repair an edit list with mixed source frame rates. Read assets.json, edits.json and "
        "delivery.json. Source [in,out) intervals use the asset fps; timeline uses delivery fps. "
        "Rendered duration=(out-in)*speed_den*delivery.fps/(speed_num*asset.fps). Reject clips for ALL "
        "applicable reasons: unlicensed when a required license is absent; source_bounds unless "
        "0<=in<out<=asset frames; fractional_frame when rendered duration is not integral. Skip "
        "rejected clips and their gaps. Timeline cursor begins at zero. Retained clips add "
        "gap_before; a positive gap disables overlap. Otherwise overlap the previous retained clip "
        "by min(requested overlap,max_overlap,previous rendered duration-1,current duration-1); "
        "the first retained clip cannot overlap. End is exclusive. total_frames is the final end; "
        "over_budget_frames=max(0,total_frames-delivery_budget). "
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
    seed_bytes = f"arena-curriculum-v2|{task_id}|{seed}|{difficulty}".encode()
    rng = random.Random(int.from_bytes(hashlib.sha256(seed_bytes).digest(), "big"))
    result = _GENERATORS[task_id](rng, difficulty)
    result.update(seed=seed, difficulty=difficulty, generator_version=2)
    return result


def _strict_equal(a: Any, b: Any) -> bool:
    """JSON equality without Python's True==1 or nonfinite-number traps."""
    if type(b) is int and type(a) in (int, float):
        return type(a) is int and a == b or type(a) is float and math.isfinite(a) and a.is_integer() and a == b
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
    return type(value) is str and bool(value) or type(value) in (int, float) and value != 0


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
        elif type(node) is float:
            if not math.isfinite(node):
                return False
        elif type(node) not in (int, str):
            return False
    return True


def grade(task: dict, answer: dict) -> float:
    """Grade only exact meaningful components; never mutate task or answer."""
    if type(answer) is not dict or not answer or not _valid_answer(answer):
        return 0.0
    expected = task["expected"]
    if any(type(key) is not str or key not in expected for key in answer):
        return 0.0
    correct = [key for key in expected if key in answer and _strict_equal(answer[key], expected[key])]
    if len(correct) == len(expected):
        return 1.0
    if not any(_substantive(answer[key]) for key in correct):
        return 0.0
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
        # Coverage-state dynamic programming, independent of subset enumeration.
        bits = {name: 1 << i for i, name in enumerate(sorted(affected))}
        states = {0: (0, 0, ())}
        for name, suite in sorted(tests.items()):
            mask = sum(bits.get(target, 0) for target in suite["targets"])
            for covered, (cost, count, selected) in list(states.items()):
                candidate = (cost + suite["cost"], count + 1, selected + (name,))
                union = covered | mask
                if union not in states or candidate < states[union]:
                    states[union] = candidate
        cost, _, selected = states[(1 << len(bits)) - 1]
        return {"affected": sorted(affected), "tests": list(selected), "test_cost": cost, "build_order": order}

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
        # Rational Gaussian elimination solves all standards without assuming order.
        matrix = [[Fraction(r["reference"]), Fraction(1), Fraction(r["time"]), Fraction(r["raw"])] for r in refs]
        for col in range(3):
            pivot = next(row for row in range(col, 3) if matrix[row][col])
            matrix[col], matrix[pivot] = matrix[pivot], matrix[col]
            factor = matrix[col][col]
            matrix[col] = [value / factor for value in matrix[col]]
            for row in range(3):
                if row != col:
                    factor = matrix[row][col]
                    matrix[row] = [x - factor * y for x, y in zip(matrix[row], matrix[col])]
        slope, intercept, drift = [matrix[i][-1] for i in range(3)]
        medians, quarantine, total, count = {}, [], Fraction(0), 0
        for name, sample in samples.items():
            corrected = sorted((Fraction(raw) - intercept - drift * sample["time"]) / slope for raw in sample["raw"])
            middle = corrected[len(corrected) // 2]
            medians[name] = int(middle)
            lo, hi = policy["acceptable_median"]
            if corrected[-1] - corrected[0] > policy["max_replicate_span"] or middle < lo or middle > hi:
                quarantine.append(name)
            else:
                total += middle * sample["weight"]
                count += sample["weight"]
        mean = total / count
        return {"calibration": {"gain": int(slope), "offset": int(intercept), "drift": int(drift)}, "medians": medians,
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
        applied, held, rejected = [], [], []
        contributions = {account: [] for account in opening}
        for position, event in enumerate(ordered):
            if event["status"] == "pending":
                held.append(event["id"])
                continue
            if event["kind"] == "entry":
                contributions[event["account"]].append(event["cents"])
            else:
                targets = [old for old in ordered[:position] if old["id"] == event["target"]
                           and old["kind"] == "entry" and old["id"] in applied]
                if not targets:
                    rejected.append(event["id"])
                    continue
                target = targets[0]
                used = sum(old["cents"] for old in ordered[:position] if old["kind"] == "reversal"
                           and old["id"] in applied and old["target"] == target["id"])
                if event["cents"] <= 0 or used + event["cents"] > abs(target["cents"]):
                    rejected.append(event["id"])
                    continue
                contributions[target["account"]].append(-event["cents"] if target["cents"] > 0 else event["cents"])
            applied.append(event["id"])
        return {"closing_cents": {account: opening[account] + sum(values) for account, values in contributions.items()},
                "applied_ids": sorted(applied), "rejected_ids": sorted(rejected), "held_ids": sorted(held)}

    if task_id == "math_route":
        edges, request, policy = (_load(task, x) for x in ("graph.json", "request.json", "policy.json"))
        keys = set(request["required"]).union(*(set(required) for required in policy["required_before"].values()))
        bits = {node: 1 << i for i, node in enumerate(sorted(keys))}
        goal_mask = sum(bits[node] for node in request["required"])
        heap = [(0, 0, (request["start"],), bits.get(request["start"], 0))]
        visited = set()
        while heap:
            minutes, exposure, route, mask = heapq.heappop(heap)
            node = route[-1]
            # Different arrival times can coalesce at a later opening window;
            # retaining them preserves the route lexicographic tie breaker.
            state = (node, mask, exposure, minutes)
            if state in visited:
                continue
            visited.add(state)
            if node == request["goal"] and mask & goal_mask == goal_mask:
                return {"route": list(route), "minutes": minutes, "exposure": exposure}
            for edge in edges:
                if edge["from"] != node or edge["to"] in policy["forbidden"]:
                    continue
                if any(not mask & bits[key] for key in policy["required_before"].get(edge["to"], [])):
                    continue
                next_exposure = exposure + edge["exposure"]
                lo, hi = policy["node_windows"].get(edge["to"], [0, 10**9])
                arrival = max(minutes + edge["minutes"], lo)
                if arrival > hi:
                    continue
                if next_exposure <= policy["max_exposure"]:
                    heapq.heappush(heap, (arrival, next_exposure,
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
            numerator = (clip["out"] - clip["in"]) * clip["speed_den"] * policy["fps"]
            duration, remainder = divmod(numerator, clip["speed_num"] * asset["fps"])
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
            gap = clip["gap_before"]
            overlap = 0 if i == 0 or gap else min(policy["max_overlap"], clip["overlap"], duration - 1, retained[i - 1][1] - 1)
            total += duration + gap - overlap
            timeline.append({"id": clip["id"], "start": total - duration, "end": total})
        return {"rejected": rejected, "timeline": timeline, "total_frames": total,
                "over_budget_frames": max(0, total - policy["delivery_budget"])}
    raise ValueError(f"Unknown task_id: {task_id!r}")
