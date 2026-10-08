import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("arena_submission", Path(__file__).resolve().parents[1] / "submission.py")
submission = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(submission)


def request():
    return {
        "submission_id": "unit-test-v1", "name": "Unit test only",
        "image": "ghcr.io/example/test@sha256:" + "a" * 64,
        "dataset": "example/test", "schema": {"action": {"type": "object"}, "observation": {"type": "object"}},
        "tasks": [submission.validate_task({"task_id": "software_change"})],
        "example_actions": [{"op": "submit", "answer": {}}],
        "finish_action": {"op": "submit", "answer": {}},
    }


class SubmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "receipt.json"

    def test_dry_run_sends_nothing_and_needs_no_token(self):
        value = request()
        def forbidden(*args, **kwargs):
            self.fail("dry run contacted remote service")
        with patch.dict(os.environ, {}, clear=True):
            actual = submission.submit(value, submission.digest(value), self.path, transport=forbidden)
        self.assertFalse(actual["submitted"])
        self.assertFalse(self.path.exists())

    def test_execution_fails_without_token(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(submission.ContractError, "HF_TOKEN is absent"):
                submission.submit(request(), submission.digest(request()), self.path, True)
        self.assertFalse(self.path.exists())

    def test_mutation_invalidates_review_digest(self):
        value = request()
        approved = submission.digest(value)
        value["name"] = "Changed after review"
        with self.assertRaisesRegex(submission.ContractError, "differs"):
            submission.submit(value, approved, self.path, True)

    def test_limits_defaults_and_sum(self):
        result = submission.validate_task({"task_id": "a"})
        self.assertEqual(result["reset_wall_s"], 120)
        self.assertEqual(result["split"], "train")
        for updates in ({"tool_calls_per_minute": 61}, {"tool_wall_s": 121}, {"reset_wall_s": 119},
                        {"rollout_wall_s": 3500}, {"completion_tokens": True}, {"seed": 7}):
            with self.subTest(updates=updates), self.assertRaises(submission.ContractError):
                submission.validate_task({"task_id": "a", **updates})

    def test_task_counts_uniqueness_and_training(self):
        for tasks in ([], [{"task_id": "x"}] * 2, [{"task_id": str(i)} for i in range(51)], [{"task_id": "x", "split": "test"}]):
            value = request()
            value["tasks"] = tasks
            with self.subTest(tasks=len(tasks)), self.assertRaises(submission.ContractError):
                submission.validate_request(value)

    def test_final_request_requires_pinned_registry_image_and_dataset(self):
        for image in ("ghcr.io/example/test:latest", "https://ghcr.io/example/test", "evil.invalid/example/test@sha256:" + "a" * 64,
                      "ghcr.io/user:password@example/test@sha256:" + "a" * 64):
            value = request()
            value["image"] = image
            with self.subTest(image=image), self.assertRaises(submission.ContractError):
                submission.validate_request(value)
        value = request()
        del value["dataset"]
        with self.assertRaises(submission.ContractError):
            submission.validate_request(value)

    def test_reserved_action_shapes_and_nonfinite_rejected(self):
        for action in ({"finish": True}, {"action": {"op": "submit"}}):
            value = request()
            value["example_actions"] = [action]
            with self.assertRaises(submission.ContractError):
                submission.validate_request(value)
        value = request()
        value["example_actions"] = [{"answer": float("nan")}]
        with self.assertRaises(submission.ContractError):
            submission.validate_request(value)

    def test_fetches_native_live_schema_without_authentication(self):
        calls = []
        def mock(url, **kwargs):
            calls.append((url, kwargs))
            return 200, {"action": {"type": "object"}, "observation": {"type": "object"}, "state": {"type": "object"}}
        actual = submission.fetch_schema("http://127.0.0.1:8000/schema", mock)
        self.assertEqual(set(actual), {"action", "observation"})
        self.assertEqual(calls[0][1], {})
        for url in ("http://remote.test/schema", "https://u:p@remote.test/schema", "https://remote.test/schema?token=foo"):
            with self.assertRaises(submission.ContractError):
                submission.fetch_schema(url, mock)

    def test_submit_persists_intention_before_post_and_records_id(self):
        calls = []
        def mock(url, method="GET", **kwargs):
            calls.append((url, method))
            self.assertEqual(kwargs["token"], "test_secret_do_not_log")
            if method == "GET":
                raise submission.TransportError(404, "NOT_FOUND")
            on_disk = json.loads(self.path.read_text())
            self.assertEqual(on_disk["state"], "sending")
            self.assertTrue(on_disk["post_attempted"])
            return 202, {"submission_id": "unit-test-v1", "state": "validating", "slot": {"state": "held"}, "secret": "test_secret_do_not_log"}
        with patch.dict(os.environ, {"HF_TOKEN": "test_secret_do_not_log"}):
            actual = submission.submit(request(), submission.digest(request()), self.path, True, mock)
        self.assertEqual(actual["state"], "recorded")
        self.assertEqual(actual["slot_state"], "held")
        self.assertNotIn("test_secret_do_not_log", self.path.read_text())
        self.assertEqual([method for _, method in calls], ["GET", "POST"])

    def test_unknown_post_reconciles_same_id_and_never_posts_twice(self):
        calls = []
        def mock(url, method="GET", **kwargs):
            calls.append((url, method))
            if len(calls) == 1:
                raise submission.TransportError(404, "NOT_FOUND")
            if method == "POST":
                raise submission.TransportError(None, "OUTCOME_UNKNOWN")
            return 200, {"state": "validated", "run": {"run_id": "run-123"}}
        with patch.dict(os.environ, {"HF_TOKEN": "test_secret"}):
            actual = submission.submit(request(), submission.digest(request()), self.path, True, mock)
            second = submission.submit(request(), submission.digest(request()), self.path, True, mock)
        self.assertEqual(actual["state"], "recorded")
        self.assertEqual(second["run_id"], "run-123")
        self.assertEqual(sum(method == "POST" for _, method in calls), 1)
        self.assertEqual({url for url, method in calls if method == "GET"}, {submission.BASE + "/submissions/unit-test-v1"})

    def test_unknown_and_absent_status_does_not_retry(self):
        calls = []
        def mock(url, method="GET", **kwargs):
            calls.append(method)
            if method == "POST":
                raise submission.TransportError(504, "REQUEST_FAILED")
            raise submission.TransportError(404, "NOT_FOUND")
        with patch.dict(os.environ, {"HF_TOKEN": "test_secret"}):
            first = submission.submit(request(), submission.digest(request()), self.path, True, mock)
            second = submission.submit(request(), submission.digest(request()), self.path, True, mock)
        self.assertEqual(first["state"], "unconfirmed")
        self.assertEqual(second["state"], "unconfirmed")
        self.assertEqual(calls.count("POST"), 1)

    def test_preexisting_remote_id_prevents_mutation(self):
        def mock(url, method="GET", **kwargs):
            self.assertEqual(method, "GET")
            return 200, {"state": "validated"}
        with patch.dict(os.environ, {"HF_TOKEN": "test_secret"}):
            actual = submission.submit(request(), submission.digest(request()), self.path, True, mock)
        self.assertFalse(actual["post_attempted"])
        self.assertIn("not been verified", actual["note"])

    def test_status_failure_prevents_first_post(self):
        def mock(url, method="GET", **kwargs):
            self.assertEqual(method, "GET")
            raise submission.TransportError(503, "REQUEST_FAILED")
        with patch.dict(os.environ, {"HF_TOKEN": "test_secret"}), self.assertRaises(submission.TransportError):
            submission.submit(request(), submission.digest(request()), self.path, True, mock)
        self.assertFalse(self.path.exists())

    def test_receipt_mismatch_and_concurrent_lock_prevent_submit(self):
        wrong = {"submission_id": "other", "request_sha256": "b" * 64}
        submission.atomic_json(self.path, wrong)
        with patch.dict(os.environ, {"HF_TOKEN": "test_secret"}), self.assertRaises(submission.ContractError):
            submission.submit(request(), submission.digest(request()), self.path, True)
        with submission.exclusive_receipt(self.path), self.assertRaises(submission.ContractError):
            with submission.exclusive_receipt(self.path):
                self.fail("duplicate lock")

    def test_no_redirect_or_auth_to_unofficial_endpoint(self):
        with self.assertRaises(submission.TransportError):
            submission.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.test")
        with self.assertRaises(submission.ContractError):
            submission.http_json("https://elsewhere.test/api", token="test_secret")

    def test_malformed_remote_success_does_not_count_as_recorded(self):
        calls = []
        def mock(url, method="GET", **kwargs):
            calls.append(method)
            if method == "POST":
                return 202, {}
            raise submission.TransportError(404, "NOT_FOUND")
        with patch.dict(os.environ, {"HF_TOKEN": "test_secret"}):
            actual = submission.submit(request(), submission.digest(request()), self.path, True, mock)
        self.assertEqual(actual["state"], "unconfirmed")
        self.assertEqual(calls.count("POST"), 1)

    def test_explicit_budgets_and_matching_remote_id_are_required(self):
        value = request()
        del value["tasks"][0]["reset_wall_s"]
        with self.assertRaisesRegex(submission.ContractError, "Every task budget"):
            submission.validate_request(value)
        with self.assertRaises(submission.TransportError):
            submission.receipt_summary({"submission_id": "another-id", "state": "validating"}, "unit-test-v1")

    def test_http_errors_never_include_raw_body(self):
        error = submission.TransportError(401, "bad test_secret body")
        self.assertNotIn("test_secret", str(error))
        self.assertEqual(error.code, "REQUEST_FAILED")

    def test_atomic_receipt_permissions_and_no_temporary_debris(self):
        submission.atomic_json(self.path, {"x": 1})
        self.assertEqual(json.loads(self.path.read_text()), {"x": 1})
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])


if __name__ == "__main__":
    unittest.main()
