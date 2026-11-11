"""Regression tests for the retained paid actor failure and worker boundary."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("pilot", HERE / "native-rrsi-pilot.py")
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)
WORKER = HERE / "restricted-python-worker.py"


class ActorContractTests(unittest.TestCase):
    def test_retained_truncated_response_is_failed_without_execution(self):
        archive = HERE.parents[2] / "docs/validation/native-rrsi-evidence.zip"
        with zipfile.ZipFile(archive) as z:
            response = json.loads(z.read("pass2/response-019.json"))
            ledger = json.loads(z.read("pass2/calls.json"))
        with patch.object(pilot.subprocess, "run") as run:
            source, result = pilot.actor_trial(response["text"], WORKER, ["IV"])
        run.assert_not_called()
        self.assertEqual((source, result["kind"]), ("", "actor_contract_failed"))
        self.assertGreater(ledger[-1]["costUsd"], 0)
        self.assertEqual(len(ledger), 19)

    def test_invalid_source_contracts(self):
        for text in ["null", "[]", "42", '{}', '{"source":0}', '{"source":" "}', json.dumps({"source":"x"*100001})]:
            with self.subTest(text=text[:40]), patch.object(pilot.subprocess, "run") as run:
                self.assertFalse(pilot.actor_trial(text, WORKER, [1])[1]["ok"])
                run.assert_not_called()

    def test_real_worker_success_after_failed_trial(self):
        self.assertFalse(pilot.actor_trial('{"source":', WORKER, [1])[1]["ok"])
        _, result = pilot.actor_trial(json.dumps({"source":"def solve(data):\n    return data + 1"}), WORKER, [1, 9])
        self.assertEqual(result["results"], [2, 10])
        self.assertEqual(result["inputUnchanged"], [True, True])

    def test_forbidden_import_stays_rejected(self):
        _, result = pilot.actor_trial(json.dumps({"source":"import os\ndef solve(data):\n    return 1"}), WORKER, [0])
        self.assertFalse(result["ok"])
        self.assertEqual(result["kind"], "language_rejected")

    def test_timeout_and_bad_worker_results_fail_closed(self):
        text = json.dumps({"source":"def solve(data):\n    return data"})
        failures = [subprocess.TimeoutExpired("worker", 4), OSError("unavailable")]
        for failure in failures:
            with patch.object(pilot.subprocess, "run", side_effect=failure):
                self.assertFalse(pilot.actor_trial(text, WORKER, [1])[1]["ok"])
        for output in ['[]', 'broken', '{"ok":true,"results":[],"inputUnchanged":[]}']:
            with patch.object(pilot.subprocess, "run", return_value=subprocess.CompletedProcess([],0,output,'')):
                self.assertFalse(pilot.actor_trial(text, WORKER, [1])[1]["ok"])


if __name__ == "__main__":
    unittest.main()
