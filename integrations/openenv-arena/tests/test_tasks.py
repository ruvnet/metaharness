"""Offline semantic verifier tests. No models, secrets, or network calls."""

import copy
import json
import math
import random
import unittest

from arena_env.tasks import TASK_IDS, grade, make_task, oracle_answer


class TaskContractTests(unittest.TestCase):
    def test_all_families_across_seeds_and_difficulties(self):
        """768 independently solved cases, including hardest scheduling variants."""
        for task_id in TASK_IDS:
            fingerprints = set()
            for difficulty in (1, 2, 3):
                for seed in range(32):
                    with self.subTest(task_id=task_id, seed=seed, difficulty=difficulty):
                        task = make_task(task_id, seed, difficulty)
                        self.assertEqual(task, make_task(task_id, seed, difficulty))
                        self.assertEqual(len(task["files"]), 3)
                        self.assertLess(sum(len(v.encode()) for v in task["files"].values()), 14000)
                        self.assertEqual(task["expected"], oracle_answer(task))
                        self.assertEqual(grade(task, oracle_answer(task)), 1.0)
                        self.assertEqual(grade(task, {}), 0.0)
                        self.assertEqual(grade(task, {key: [] for key in task["expected"]}), 0.0)
                        self.assertEqual(grade(task, {"finish": True}), 0.0)
                        self.assertEqual(grade(task, {"answer": "done"}), 0.0)
                        self.assertEqual(grade(task, {key: "wrong" for key in task["expected"]}), 0.0)
                        fingerprints.add(json.dumps(task["files"], sort_keys=True))
            self.assertEqual(len(fingerprints), 96)

    def test_oracles_ignore_cached_expected_and_generator_metadata(self):
        for task_id in TASK_IDS:
            task = make_task(task_id, 57, 3)
            original = copy.deepcopy(task["expected"])
            task["expected"] = {"poison": "never use this"}
            task["seed"] = "not the seed"
            task["difficulty"] = None
            self.assertEqual(oracle_answer(task), original)

    def test_partial_credit_requires_correct_subproblem(self):
        for task_id in TASK_IDS:
            task = make_task(task_id, 3)
            for field, value in task["expected"].items():
                # Some fields can correctly be zero/empty: these are not evidence alone.
                score = grade(task, {field: value})
                self.assertGreaterEqual(score, 0)
                self.assertLessEqual(score, 0.8)
                if value and value != 0:
                    self.assertGreater(score, 0)
                else:
                    self.assertEqual(score, 0)
            bad = copy.deepcopy(task["expected"])
            bad[next(iter(bad))] = "plausible but wrong"
            self.assertLess(grade(task, bad), 1)
            self.assertEqual(grade(task, {**task["expected"], "extra": "key"}), 0)

    def test_type_confusion_and_nonfinite_cannot_receive_reward(self):
        for task_id in TASK_IDS:
            task = make_task(task_id, 8)
            field = next(iter(task["expected"]))
            for invalid in (True, False, float("nan"), float("inf"), -float("inf"), None, ("tuple",)):
                answer = copy.deepcopy(task["expected"])
                answer[field] = invalid
                self.assertEqual(grade(task, answer), 0)
            for invalid in (None, [], "done", True, 1):
                self.assertEqual(grade(task, invalid), 0)
            answer = copy.deepcopy(task["expected"])
            answer[field] = {"nested": [float("nan")]}
            self.assertEqual(grade(task, answer), 0)
            self.assertEqual(grade(task, {1: "numeric key"}), 0)

    def test_no_mutation_aliases_or_global_rng_effect(self):
        random.seed(725)
        state = random.getstate()
        for task_id in TASK_IDS:
            task = make_task(task_id, 10)
            original_task = copy.deepcopy(task)
            answer = oracle_answer(task)
            original_answer = copy.deepcopy(answer)
            grade(task, answer)
            self.assertEqual(task, original_task)
            self.assertEqual(answer, original_answer)
            task["files"].clear()
            task["expected"].clear()
            task["rubric"]["components"].clear()
            answer.clear()
            self.assertEqual(make_task(task_id, 10), original_task)
        self.assertEqual(random.getstate(), state)

    def test_bounded_verifier_handles_deep_and_large_answers(self):
        task = make_task("math_route", 0)
        deep = "x"
        for _ in range(100):
            deep = [deep]
        self.assertEqual(grade(task, {"route": deep}), 0)
        self.assertEqual(grade(task, {"route": ["N00"] * 3000}), 0)

    def test_integral_float_equivalence_without_bool_or_rounding(self):
        def floats(value):
            if type(value) is int:
                return float(value)
            if type(value) is list:
                return [floats(item) for item in value]
            if type(value) is dict:
                return {key: floats(item) for key, item in value.items()}
            return value
        for family in TASK_IDS:
            task = make_task(family, 15, 3)
            self.assertEqual(grade(task, floats(task["expected"])), 1)
        task = {"expected": {"x": 3, "y": 8}}
        self.assertEqual(grade(task, {"x": 3.0, "y": 8.0}), 1)
        self.assertLess(grade(task, {"x": 3.00000001, "y": 8}), 1)
        self.assertEqual(grade(task, {"x": True, "y": 8}), 0)
        huge = 2**53 + 1
        self.assertLess(grade({"expected": {"x": huge}}, {"x": float(huge)}), 1)

    def test_zero_and_empty_credit_is_monotonic_but_needs_correct_anchor(self):
        task = {"expected": {"result": ["a"], "overflow": 0, "rejects": [], "total": 12}}
        self.assertEqual(grade(task, {}), 0)
        self.assertEqual(grade(task, {"overflow": 0}), 0)
        self.assertEqual(grade(task, {"overflow": 0, "rejects": []}), 0)
        self.assertEqual(grade(task, {"result": ["wrong"], "overflow": 0}), 0)
        self.assertEqual(grade(task, {"result": ["a"]}), .25)
        self.assertEqual(grade(task, {"result": ["a"], "overflow": 0.0}), .5)
        self.assertEqual(grade(task, {"result": ["a"], "overflow": 0, "rejects": []}), .75)
        self.assertEqual(grade(task, task["expected"]), 1)
        self.assertEqual(grade({"expected": {"result": 0, "rejects": []}}, {"result": 0.0, "rejects": []}), 1)

    def test_parameter_validation(self):
        for seed in (True, "2", 2.0, None):
            with self.assertRaises(ValueError):
                make_task(TASK_IDS[0], seed)
        for difficulty in (0, 4, True, 2.0, "2", None):
            with self.assertRaises(ValueError):
                make_task(TASK_IDS[0], 0, difficulty)
        with self.assertRaises(ValueError):
            make_task("unknown", 0)


class SemanticWitnessTests(unittest.TestCase):
    """Targeted witnesses test independently checkable task-specific invariants."""

    def test_software_order_respects_dependencies_not_id_sort(self):
        witnessed_nonlexical = False
        for seed in range(32):
            task = make_task("software_change", seed, 3)
            answer = oracle_answer(task)
            modules = json.loads(task["files"]["modules.json"])
            positions = {name: i for i, name in enumerate(answer["build_order"])}
            for module, deps in modules.items():
                if module in positions:
                    for dep in deps:
                        if dep in positions:
                            self.assertLess(positions[dep], positions[module])
            witnessed_nonlexical |= answer["build_order"] != sorted(answer["build_order"])
        self.assertTrue(witnessed_nonlexical)

    def test_software_coverage_cost_count_and_lexical_ties(self):
        task = make_task("software_change", 0)
        task["files"] = {
            "modules.json": json.dumps({"A": [], "B": ["A"], "C": []}),
            "change.json": json.dumps({"changed": ["A"]}),
            "tests.json": json.dumps({
                "a": {"targets": ["A"], "cost": 2}, "b": {"targets": ["B"], "cost": 2},
                "c": {"targets": ["A", "B"], "cost": 4}, "d": {"targets": ["A", "B", "C"], "cost": 4},
            }),
        }
        self.assertEqual(oracle_answer(task), {"affected": ["A", "B"], "build_order": ["A", "B"], "tests": ["c"], "test_cost": 4})

    def test_industrial_schedule_feasibility_and_objective(self):
        for seed in range(16):
            task = make_task("industrial_schedule", seed, 3)
            answer = oracle_answer(task)
            jobs = {job["id"]: job for job in json.loads(task["files"]["jobs.json"])}
            lo, hi = json.loads(task["files"]["calendar.json"])["blackout"]
            end, penalty = 0, 0
            for name in answer["order"]:
                job = jobs[name]
                finish = answer["completion"][name]
                start = finish - job["duration"]
                self.assertGreaterEqual(start, end)
                self.assertGreaterEqual(start, job["release"])
                self.assertTrue(finish <= lo or start >= hi)
                end = finish
                penalty += job["weight"] * max(0, finish - job["due"])
            self.assertEqual(answer["makespan"], end)
            self.assertEqual(answer["weighted_tardiness"], penalty)

    def test_science_calibration_and_fraction_reduction(self):
        for seed in range(16):
            task = make_task("science_calibration", seed, 3)
            answer = oracle_answer(task)
            refs = json.loads(task["files"]["calibration.json"])
            for point in refs:
                self.assertEqual(point["raw"], point["reference"] * answer["calibration"]["gain"] + answer["calibration"]["offset"] + point["time"] * answer["calibration"]["drift"])
            fraction = answer["accepted_mean"]
            self.assertEqual(math.gcd(fraction["numerator"], fraction["denominator"]), 1)
            self.assertGreater(fraction["denominator"], 0)
            self.assertGreaterEqual(len(answer["quarantine"]), 1)
            self.assertLess(len(answer["quarantine"]), len(answer["medians"]))

    def test_science_drift_weighting_and_inclusive_boundaries(self):
        task = make_task("science_calibration", 0)
        task["files"] = {
            "calibration.json": json.dumps([
                {"reference": 5, "time": 10, "raw": 23},
                {"reference": 45, "time": 0, "raw": 93},
                {"reference": 5, "time": 0, "raw": 13},
            ]),
            "samples.json": json.dumps({
                "a": {"time": 2, "weight": 1, "raw": [29, 35, 41]},
                "b": {"time": 3, "weight": 3, "raw": [70, 76, 82]},
                "c": {"time": 1, "weight": 10, "raw": [84, 86, 88]},
            }),
            "policy.json": json.dumps({"acceptable_median": [15, 35], "max_replicate_span": 6}),
        }
        self.assertEqual(oracle_answer(task), {
            "calibration": {"gain": 2, "offset": 3, "drift": 1}, "medians": {"a": 15, "b": 35, "c": 41},
            "quarantine": ["c"], "accepted_mean": {"numerator": 30, "denominator": 1},
        })

    def test_office_provenance_ties_and_missing_fields(self):
        task = make_task("office_reconciliation", 0)
        master = [{"id": "p", "email": "p@example.invalid", "phone": "5551", "team": "ops"}]
        changes = [
            {"id": "a", "email": " Alias@example.invalid ", "timestamp": 2, "source": "hr", "fields": {"phone": "(555) 2"}},
            {"id": "b", "email": "p@example.invalid", "timestamp": 2, "source": "hr", "fields": {"phone": "(555) 3"}},
            {"id": "c", "email": "p@example.invalid", "timestamp": 2, "source": "crm", "fields": {"phone": "(555) 4", "team": "sales"}},
            {"id": "x", "email": "other@example.invalid", "timestamp": 99, "source": "hr", "fields": {"team": "research"}},
        ]
        task["files"] = {"contacts.json": json.dumps(master), "changes.json": json.dumps(changes),
                         "policy.json": json.dumps({"aliases": {"alias@example.invalid": "p@example.invalid"}, "source_priority": {"hr": 3, "crm": 2}})}
        self.assertEqual(oracle_answer(task), {"contacts": {"p": {"phone": "5553", "team": "sales"}}, "unresolved": ["x"]})

    def test_finance_reversals_not_double_counted(self):
        for seed in range(16):
            task = make_task("finance_ledger", seed, 3)
            answer = oracle_answer(task)
            events = sorted(json.loads(task["files"]["events.json"]), key=lambda x: x["sequence"])
            entries = [event for event in events if event["kind"] == "entry"]
            reversals = [event for event in events if event["kind"] == "reversal"]
            self.assertTrue(any(row["id"] in answer["applied_ids"] for row in reversals))
            self.assertEqual(answer["held_ids"], sorted(row["id"] for row in events if row["status"] == "pending"))
            opening = json.loads(task["files"]["accounts.json"])
            entry_map = {row["id"]: row for row in entries}
            adjustments = [row["cents"] * (-1 if entry_map[row["target"]]["cents"] > 0 else 1)
                           for row in reversals if row["id"] in answer["applied_ids"]]
            expected_total = sum(opening.values()) + sum(row["cents"] for row in entries if row["status"] == "posted") + sum(adjustments)
            self.assertEqual(sum(answer["closing_cents"].values()), expected_total)
            self.assertEqual(set(answer["applied_ids"] + answer["held_ids"] + answer["rejected_ids"]), {row["id"] for row in events})

    def test_finance_partial_reversal_cap_and_negative_entry(self):
        task = make_task("finance_ledger", 0)
        events = [
            {"id": "future", "kind": "reversal", "target": "credit", "cents": 10},
            {"id": "debit", "kind": "entry", "account": "a", "cents": -600},
            {"id": "r1", "kind": "reversal", "target": "debit", "cents": 250},
            {"id": "over", "kind": "reversal", "target": "debit", "cents": 400},
            {"id": "r2", "kind": "reversal", "target": "debit", "cents": 350},
            {"id": "duplicate", "kind": "reversal", "target": "debit", "cents": 1},
            {"id": "credit", "kind": "entry", "account": "a", "cents": 120},
            {"id": "held", "kind": "reversal", "target": "credit", "cents": 90, "status": "pending"},
            {"id": "wrong_target", "kind": "reversal", "target": "r1", "cents": 5},
            {"id": "r3", "kind": "reversal", "target": "credit", "cents": 20},
        ]
        for sequence, event in enumerate(events):
            event["sequence"] = sequence
            event.setdefault("status", "posted")
        task["files"]["accounts.json"] = json.dumps({"a": 1000})
        task["files"]["events.json"] = json.dumps(list(reversed(events)))
        self.assertEqual(oracle_answer(task), {"closing_cents": {"a": 1100},
            "applied_ids": ["credit", "debit", "r1", "r2", "r3"], "held_ids": ["held"],
            "rejected_ids": ["duplicate", "future", "over", "wrong_target"]})

    def test_route_constraints_and_edge_totals(self):
        for seed in range(32):
            task = make_task("math_route", seed, 3)
            answer = oracle_answer(task)
            edges = {(edge["from"], edge["to"]): edge for edge in json.loads(task["files"]["graph.json"])}
            policy = json.loads(task["files"]["policy.json"])
            request = json.loads(task["files"]["request.json"])
            route = answer["route"]
            self.assertTrue(set(request["required"]) <= set(route))
            self.assertFalse(set(policy["forbidden"]) & set(route))
            legs = [edges[leg] for leg in zip(route, route[1:])]
            elapsed, visited = 0, {route[0]}
            for leg in legs:
                node = leg["to"]
                self.assertTrue(set(policy["required_before"].get(node, [])) <= visited)
                elapsed += leg["minutes"]
                lo, hi = policy["node_windows"].get(node, [0, 10**9])
                elapsed = max(elapsed, lo)
                self.assertLessEqual(elapsed, hi)
                visited.add(node)
            self.assertEqual(elapsed, answer["minutes"])
            self.assertEqual(sum(leg["exposure"] for leg in legs), answer["exposure"])
            self.assertLessEqual(answer["exposure"], policy["max_exposure"])

    def test_route_waiting_preserves_lexical_tie_and_access_requirement(self):
        task = make_task("math_route", 0)
        edges = [("S", "A", 5), ("S", "B", 1), ("A", "C", 1), ("B", "C", 1), ("C", "G", 1)]
        task["files"] = {
            "graph.json": json.dumps([{"from": a, "to": b, "minutes": t, "exposure": 0} for a, b, t in edges]),
            "request.json": json.dumps({"start": "S", "goal": "G", "required": []}),
            "policy.json": json.dumps({"forbidden": [], "max_exposure": 0, "node_windows": {"G": [10, 10]}, "required_before": {}}),
        }
        self.assertEqual(oracle_answer(task), {"route": ["S", "A", "C", "G"], "minutes": 10, "exposure": 0})
        policy = json.loads(task["files"]["policy.json"])
        policy["required_before"] = {"C": ["B"]}
        task["files"]["policy.json"] = json.dumps(policy)
        self.assertEqual(oracle_answer(task), {"route": ["S", "B", "C", "G"], "minutes": 10, "exposure": 0})

    def test_fault_positions_and_counts_are_not_fixed_templates(self):
        counts = {name: set() for name in ("science", "media", "held", "rejected")}
        media_positions = set()
        for seed in range(32):
            science = make_task("science_calibration", seed, 3)
            counts["science"].add(len(science["expected"]["quarantine"]))
            media = make_task("media_timeline", seed, 3)
            counts["media"].add(len(media["expected"]["rejected"]))
            media_positions.add(tuple(i for i, clip in enumerate(json.loads(media["files"]["edits.json"]))
                                      if clip["id"] in media["expected"]["rejected"]))
            finance = make_task("finance_ledger", seed, 3)
            counts["held"].add(len(finance["expected"]["held_ids"]))
            counts["rejected"].add(len(finance["expected"]["rejected_ids"]))
        for name, values in counts.items():
            self.assertGreater(len(values), 2, (name, values))
        self.assertGreater(len(media_positions), 20)

    def test_security_all_reasons_and_expiry_boundary(self):
        task = make_task("security_triage", 0)
        events = [{"id": "e", "user": "user_1", "action": "delete", "sensitivity": "secret",
                   "zone": "external", "mfa": False, "time": 100, "expires": 100}]
        task["files"]["events.json"] = json.dumps(events)
        answer = oracle_answer(task)
        self.assertEqual(answer["denied"]["e"], ["action_forbidden", "disabled", "expired", "mfa_required", "secret_role", "untrusted_zone"])
        self.assertEqual(answer["containment"], [])
        self.assertEqual(answer["allowed_ids"], [])

    def test_media_exclusive_end_and_overlap_repair(self):
        task = make_task("media_timeline", 0)
        task["files"] = {
            "assets.json": json.dumps({"a": {"frames": 100, "licensed": True, "fps": 24}, "b": {"frames": 100, "licensed": False, "fps": 24}}),
            "delivery.json": json.dumps({"max_overlap": 10, "delivery_budget": 20, "require_license": True, "fps": 30}),
            "edits.json": json.dumps([
                {"id": "c0", "asset": "a", "in": 0, "out": 20, "speed_num": 1, "speed_den": 1, "overlap": 50, "gap_before": 0},
                {"id": "c1", "asset": "b", "in": 0, "out": 101, "speed_num": 2, "speed_den": 1, "overlap": 0, "gap_before": 99},
                {"id": "c2", "asset": "a", "in": 0, "out": 8, "speed_num": 2, "speed_den": 1, "overlap": 50, "gap_before": 3},
            ]),
        }
        self.assertEqual(oracle_answer(task), {
            "rejected": {"c1": ["fractional_frame", "source_bounds", "unlicensed"]},
            "timeline": [{"id": "c0", "start": 0, "end": 25}, {"id": "c2", "start": 28, "end": 33}],
            "total_frames": 33, "over_budget_frames": 13,
        })


if __name__ == "__main__":
    unittest.main()
