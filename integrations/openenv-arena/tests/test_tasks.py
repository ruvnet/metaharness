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
            for invalid in (True, False, float("nan"), float("inf"), -float("inf"), None, 1.0, ("tuple",)):
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
                self.assertEqual(point["raw"], point["reference"] * answer["calibration"]["gain"] + answer["calibration"]["offset"])
            fraction = answer["accepted_mean"]
            self.assertEqual(math.gcd(fraction["numerator"], fraction["denominator"]), 1)
            self.assertGreater(fraction["denominator"], 0)
            self.assertGreaterEqual(len(answer["quarantine"]), 2)
            self.assertLess(len(answer["quarantine"]), len(answer["medians"]))

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
            self.assertIn(reversals[1]["id"], answer["applied_ids"])
            self.assertEqual(answer["rejected_ids"], sorted(row["id"] for row in [reversals[0], *reversals[2:]]))
            self.assertEqual(answer["held_ids"], sorted(row["id"] for row in entries if row["status"] == "pending"))
            opening = json.loads(task["files"]["accounts.json"])
            reversed_entry = next(row for row in entries if row["id"] == reversals[1]["target"])
            expected_total = sum(opening.values()) + sum(row["cents"] for row in entries if row["status"] == "posted") - reversed_entry["cents"]
            self.assertEqual(sum(answer["closing_cents"].values()), expected_total)

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
            self.assertEqual(sum(leg["minutes"] for leg in legs), answer["minutes"])
            self.assertEqual(sum(leg["exposure"] for leg in legs), answer["exposure"])
            self.assertLessEqual(answer["exposure"], policy["max_exposure"])

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
            "assets.json": json.dumps({"a": {"frames": 100, "licensed": True}, "b": {"frames": 100, "licensed": False}}),
            "delivery.json": json.dumps({"max_overlap": 10, "delivery_budget": 20, "require_license": True}),
            "edits.json": json.dumps([
                {"id": "c0", "asset": "a", "in": 0, "out": 20, "speed_num": 1, "speed_den": 1, "overlap": 50},
                {"id": "c1", "asset": "b", "in": 0, "out": 101, "speed_num": 2, "speed_den": 1, "overlap": 0},
                {"id": "c2", "asset": "a", "in": 0, "out": 8, "speed_num": 2, "speed_den": 1, "overlap": 50},
            ]),
        }
        self.assertEqual(oracle_answer(task), {
            "rejected": {"c1": ["fractional_frame", "source_bounds", "unlicensed"]},
            "timeline": [{"id": "c0", "start": 0, "end": 20}, {"id": "c2", "start": 17, "end": 21}],
            "total_frames": 21, "over_budget_frames": 1,
        })


if __name__ == "__main__":
    unittest.main()
