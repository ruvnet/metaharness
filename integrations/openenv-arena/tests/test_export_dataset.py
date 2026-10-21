import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("arena_export_dataset", ROOT / "scripts/export_dataset.py")
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class DatasetExportTests(unittest.TestCase):
    def invoke(self, destination, *args):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return exporter.main([str(destination), *args])

    def test_selected_variants_replay_exact_files_without_private_answer_material(self):
        ids = ["software_change-d3--suite_count_delta-p1", "science_calibration-d1--sample_count_delta-m2"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, value in enumerate([ids, {"tasks": [{"task_id": key, "split": "train"} for key in ids]}]):
                with self.subTest(form=index):
                    config = root / f"input-{index}.json"
                    config.write_text(json.dumps(value))
                    destination = root / f"export-{index}"
                    self.assertEqual(self.invoke(destination, "--seeds", "2", "--tasks-json", str(config)), 0)
                    rows = [json.loads(line) for line in (destination / "tasks.jsonl").read_text().splitlines()]
                    self.assertEqual(len(rows), 4)
                    self.assertEqual([row["task_id"] for row in rows], [ids[0], ids[0], ids[1], ids[1]])
                    for row in rows:
                        family, level, params = exporter.parse_task_id(row["task_id"])
                        expected = exporter.make_task(family, row["seed"], level, params)
                        self.assertEqual(set(row), {"task_id", "family", "domain", "prompt", "seed", "difficulty", "origin", "files_json", "params_json"})
                        self.assertEqual(row["family"], family)
                        self.assertEqual(row["difficulty"], level)
                        self.assertEqual(json.loads(row["params_json"]), params)
                        self.assertEqual(json.loads(row["files_json"]), expected["files"])
                        self.assertEqual(row["prompt"], expected["prompt"])
                    manifest = json.loads((destination / "manifest.json").read_text())
                    self.assertEqual([row["task_id"] for row in manifest["tasks"]], ids)
                    self.assertEqual(manifest["dataset"]["rows"], len(rows))
                    self.assertEqual(manifest["dataset"]["sha256"], hashlib.sha256((destination / "tasks.jsonl").read_bytes()).hexdigest())
                    self.assertEqual(manifest["environmentSource"], exporter.environment_source_binding())
                    for name, digest in manifest["environmentSource"]["components"].items():
                        self.assertEqual(digest, hashlib.sha256((ROOT / name).read_bytes()).hexdigest())

    def test_invalid_variants_and_limits_fail_before_creating_destination(self):
        invalid = [[], ["math_route-d2"] * 51, ["software_change-d3--suite_count_delta-m2"],
                   ["science_calibration-d1--sample_count_delta-p3"], ["math_route-d4"],
                   ["math_route-d2--suite_count_delta-p1"], ["software_change-d2--suite_count_delta-p0"],
                   ["software_change-d2--suite_count_delta-p01"], ["bogus-d1"], [True],
                   ["math_route-d2", "math_route-d2"], ["math_route-d2", "math_route"],
                   ["math_route"], {"tasks": "math_route-d2"}, [{"wrong": "math_route-d2"}]]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, value in enumerate(invalid):
                with self.subTest(value=value):
                    config, destination = root / f"bad-{index}.json", root / f"output-{index}"
                    config.write_text(json.dumps(value))
                    with self.assertRaises(SystemExit):
                        self.invoke(destination, "--tasks-json", str(config))
                    self.assertFalse(destination.exists())
            for seed_count in ["0", "10001"]:
                destination = root / f"seeds-{seed_count}"
                with self.assertRaises(SystemExit):
                    self.invoke(destination, "--seeds", seed_count)
                self.assertFalse(destination.exists())

    def test_default_export_retains_all_768_legacy_rows_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "default"
            self.assertEqual(self.invoke(destination), 0)
            path = destination / "tasks.jsonl"
            before = path.read_bytes()
            rows = [json.loads(line) for line in before.splitlines()]
            self.assertEqual(len(rows), 768)
            self.assertEqual({row["task_id"] for row in rows}, set(exporter.TASK_IDS))
            for row in rows:
                self.assertEqual(set(row), {"task_id", "domain", "prompt", "seed", "difficulty", "origin", "files_json"})
            # Compare the full legacy stream against the original generator call shape.
            legacy = []
            for family in exporter.TASK_IDS:
                for level in (1, 2, 3):
                    for seed in range(32):
                        task = exporter.make_task(family, seed, level)
                        row = {key: task[key] for key in ("task_id", "domain", "prompt")}
                        row.update(seed=seed, difficulty=level, origin="generated", files_json=json.dumps(task["files"], sort_keys=True))
                        legacy.append(json.dumps(row, sort_keys=True) + "\n")
            self.assertEqual(before, "".join(legacy).encode())
            with self.assertRaises(FileExistsError):
                self.invoke(destination, "--seeds", "1")
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(json.loads((destination / "manifest.json").read_text())["dataset"]["rows"], 768)


if __name__ == "__main__":
    unittest.main()
