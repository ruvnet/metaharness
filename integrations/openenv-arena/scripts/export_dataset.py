"""Export public source tasks with no answer keys into a fresh dataset directory."""
import argparse
import hashlib
import json
from pathlib import Path
from arena_env import tasks as task_module
from arena_env.tasks import TASK_IDS, format_task_id, make_task, parse_task_id


def declared_tasks(path):
    """Validate every selected identity before creating an output directory."""
    if path is None:
        return [(format_task_id(family, level), family, level, {})
                for family in TASK_IDS for level in (1, 2, 3)]
    try:
        if path.stat().st_size > 1_048_576:
            raise ValueError("tasks JSON exceeds 1 MiB")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError("tasks JSON could not be read") from None
    rows = value.get("tasks") if isinstance(value, dict) else value
    if not isinstance(rows, list) or not 1 <= len(rows) <= 50:
        raise ValueError("tasks JSON must contain 1..50 native task IDs")
    result, seen = [], set()
    for row in rows:
        task_id = row.get("task_id") if isinstance(row, dict) else row
        try:
            family, difficulty, params = parse_task_id(task_id)
        except (TypeError, ValueError):
            raise ValueError("tasks JSON contains an invalid native task ID") from None
        canonical_id = format_task_id(family, difficulty, params)
        if canonical_id in seen:
            raise ValueError("tasks JSON contains duplicate task identities")
        if task_id != canonical_id:
            raise ValueError("tasks JSON requires canonical IDs with explicit difficulty")
        seen.add(canonical_id)
        result.append((task_id, family, difficulty, params))
    return result


def environment_source_binding():
    source = Path(task_module.__file__).resolve()
    components = {"arena_env/tasks.py": hashlib.sha256(source.read_bytes()).hexdigest(),
                  "arena_env/environment.py": hashlib.sha256(source.with_name("environment.py").read_bytes()).hexdigest()}
    canonical = json.dumps(components, sort_keys=True, separators=(",", ":"))
    return {"components": components, "sha256": hashlib.sha256(canonical.encode()).hexdigest()}


def file_digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1_048_576), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", type=Path)
    parser.add_argument("--seeds", type=int, default=32)
    parser.add_argument("--tasks-json", type=Path,
                        help="Array of canonical native IDs/task objects, or an object containing tasks; maximum 50")
    args = parser.parse_args(argv)
    if not 1 <= args.seeds <= 10000:
        parser.error("seeds must be 1..10000")
    try:
        selected = declared_tasks(args.tasks_json)
        source_binding = environment_source_binding()
    except (ValueError, OSError) as error:
        parser.error(str(error))
    args.destination.mkdir(parents=True, exist_ok=False)
    dataset_path = args.destination / "tasks.jsonl"
    with dataset_path.open("x", encoding="utf-8") as stream:
        for native_id, family, difficulty, params in selected:
            for seed in range(args.seeds):
                task = make_task(family, seed, difficulty, params)
                row = {k: task[k] for k in ("task_id", "domain", "prompt")}
                row.update(seed=seed, difficulty=difficulty, origin="generated", files_json=json.dumps(task["files"], sort_keys=True))
                if args.tasks_json:
                    row.update(task_id=native_id, family=family, params_json=json.dumps(params, sort_keys=True))
                stream.write(json.dumps(row, sort_keys=True) + "\n")
    card = '''---
license: mit
task_categories:
  - reinforcement-learning
language:
  - en
configs:
  - config_name: default
    data_files:
      - split: train
        path: tasks.jsonl
---
# MetaHarness Arena Tasks

Original synthetic procedural tasks across eight domains, generated from
https://github.com/ruvnet/metaharness/pull/383.
The files_json column preserves each virtual filename and content as lossless JSON.
These public seeds are training fixtures; held-out evaluation uses fresh instances.
Training runs the pinned container, not this JSONL. Explicit seeds replay inputs.
The container generates fresh variants for unseeded resets. The reward is a
deterministic semantic checker with bounded partial credit for correct sub-results.
Empty answers receive zero. Oracle correctness is not model performance.
No official evaluation, training improvement or leaderboard rank is claimed.
No private customer data or copied benchmark problems are included.
'''
    if args.tasks_json:
        card += "\nThis export contains the exact declared native task variants in manifest.json.\nThe family and lossless params_json columns identify their generator settings.\n"
    with (args.destination / "README.md").open("x", encoding="utf-8") as stream:
        stream.write(card)
    count = len(selected) * args.seeds
    manifest = {"version": 1, "row_format": "native_task_ids" if args.tasks_json else "legacy_family_ids",
                "tasks": [{"task_id": item[0], "split": "train"} for item in selected],
                "seeds_per_task": args.seeds, "seed_range": {"start": 0, "stop_exclusive": args.seeds},
                "environmentSource": source_binding,
                "dataset": {"path": "tasks.jsonl", "sha256": file_digest(dataset_path), "rows": count}}
    with (args.destination / "manifest.json").open("x", encoding="utf-8") as stream:
        json.dump(manifest, stream, indent=2, sort_keys=True)
        stream.write("\n")
    print(json.dumps({"tasks": count, "destination": str(args.destination), "manifest": "manifest.json"}))
    return 0


if __name__ == "__main__":
    main()
