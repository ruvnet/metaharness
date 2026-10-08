"""Export public source tasks with no answer keys into a fresh dataset directory."""
import argparse
import json
from pathlib import Path
from arena_env.tasks import TASK_IDS, make_task


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", type=Path)
    parser.add_argument("--seeds", type=int, default=32)
    args = parser.parse_args()
    if not 1 <= args.seeds <= 10000:
        parser.error("seeds must be 1..10000")
    args.destination.mkdir(parents=True, exist_ok=False)
    with (args.destination / "tasks.jsonl").open("w") as stream:
        for task_id in TASK_IDS:
            for difficulty in (1, 2, 3):
                for seed in range(args.seeds):
                    task = make_task(task_id, seed, difficulty)
                    row = {k: task[k] for k in ("task_id", "domain", "prompt")}
                    row.update(seed=seed, difficulty=difficulty, origin="generated", files_json=json.dumps(task["files"], sort_keys=True))
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
    (args.destination / "README.md").write_text(card)
    print(json.dumps({"tasks": len(TASK_IDS)*3*args.seeds, "destination": str(args.destination)}))


if __name__ == "__main__":
    main()
