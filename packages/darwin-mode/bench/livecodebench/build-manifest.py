# SPDX-License-Identifier: MIT
# Build lcb-v5.json manifest for solve-lcb.mjs from the official LiveCodeBench loader.
# Shape: {release, window, instances:[{question_id, question_content, starter_code, platform,
#         difficulty, contest_date, public_test_cases:[{input,output,testtype}]}]}
# Run inside the LiveCodeBench venv (cwd = ~/LiveCodeBench):
#   python build-manifest.py --release release_v5 --start 2024-12-01 --n 25 --out /path/lcb-v5.json
import json, argparse, datetime
from dataclasses import asdict
from collections import defaultdict
from lcb_runner.benchmarks.code_generation import load_code_generation_dataset

ap = argparse.ArgumentParser()
ap.add_argument("--release", default="release_v5")
ap.add_argument("--start", default="2024-12-01")  # window start (after model cutoff -> contamination-free)
ap.add_argument("--end", default=None)
ap.add_argument("--n", type=int, default=25)
ap.add_argument("--out", required=True)
ap.add_argument("--seed", type=int, default=0)
args = ap.parse_args()

ds = load_code_generation_dataset(release_version=args.release, start_date=args.start, end_date=args.end)
print(f"window {args.start}..{args.end or 'end'}: {len(ds)} problems")

# Balanced sample: spread across difficulty and platform, deterministic by question_id sort + seed.
ds_sorted = sorted(ds, key=lambda p: p.question_id)
# bucket by (platform, difficulty)
buckets = defaultdict(list)
for p in ds_sorted:
    buckets[(p.platform.value, p.difficulty.value)].append(p)
# round-robin draw from buckets to get a mix
keys = sorted(buckets.keys())
picked = []
idx = {k: 0 for k in keys}
while len(picked) < min(args.n, len(ds_sorted)):
    progressed = False
    for k in keys:
        if len(picked) >= args.n:
            break
        if idx[k] < len(buckets[k]):
            picked.append(buckets[k][idx[k]])
            idx[k] += 1
            progressed = True
    if not progressed:
        break

instances = []
for p in picked:
    instances.append({
        "question_id": p.question_id,
        "question_content": p.question_content,
        "starter_code": p.starter_code,
        "platform": p.platform.value,
        "difficulty": p.difficulty.value,
        "contest_date": p.contest_date.isoformat(),
        "public_test_cases": [
            {"input": t.input, "output": t.output, "testtype": t.testtype.value}
            for t in p.public_test_cases
        ],
    })

from collections import Counter
print("picked platform:", Counter(i["platform"] for i in instances))
print("picked difficulty:", Counter(i["difficulty"] for i in instances))
print("functional(starter):", sum(1 for i in instances if i["starter_code"]),
      "stdin:", sum(1 for i in instances if not i["starter_code"]))
print("date range:", min(i["contest_date"] for i in instances), "..", max(i["contest_date"] for i in instances))

out = {"release": args.release, "window": {"start": args.start, "end": args.end}, "instances": instances}
with open(args.out, "w") as f:
    json.dump(out, f, indent=1)
print(f"wrote {len(instances)} -> {args.out}")
