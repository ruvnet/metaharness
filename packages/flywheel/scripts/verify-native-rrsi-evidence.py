"""Offline re-execution of retained actor artifacts. No model calls, credentials or zip extraction."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zipfile


def canon(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


archive = Path(sys.argv[1])
worker = Path(sys.argv[2])
with zipfile.ZipFile(archive) as z:
    assert len(z.infolist()) <= 512 and sum(i.file_size for i in z.infolist()) <= 5_000_000
    files = {i.filename: z.read(i).decode() for i in z.infolist() if not i.is_dir()}
passes = sorted({p.split("/")[0] for p in files if p.endswith("/calls.json")})
assert passes, "no pilot ledgers"
totals = {"passes": 0, "incompletePasses": 0, "calls": 0, "artifacts": 0, "reexecutedTrials": 0, "acceptedDevelopmentChanges": 0, "apiCostUsd": 0, "reservedUsd": 0}
for prefix in passes:
    get = lambda path: json.loads(files[f"{prefix}/{path}"])
    freeze, ledger = get("freeze.json"), get("calls.json")
    result = get("result.json") if f"{prefix}/result.json" in files else None
    assert freeze["upstreamPin"] == "be50316e1db05914068a973f322770ef08ed7ba1"
    assert freeze["workerSourceSha256"] == hashlib.sha256(worker.read_bytes()).hexdigest()
    if result:
        assert result["freezeDigest"] == hashlib.sha256(canon(freeze).encode()).hexdigest()
    assert len(ledger) <= freeze["maxCalls"]
    assert result is None or result["completed"] is True
    assert all(c["status"] == "completed" and c["tokens"] > 0 and 0 <= c["costUsd"] <= c["reservedUsd"] for c in ledger)
    if result:
        assert abs(result["knownApiCostUsd"] - sum(c["costUsd"] for c in ledger)) < 1e-10
    assert sum(c["reservedUsd"] for c in ledger) <= freeze["maxReservedUsd"]
    first_confirm = next((i for i,c in enumerate(ledger) if "confirmation:" in c["stage"]), len(ledger))
    assert not any(c["stage"] == "native-proposer" for c in ledger[first_confirm:])
    by_stage = {c["stage"]: c for c in ledger if c["stage"] != "native-proposer"}
    for c in ledger:
        if c.get("artifact"):
            assert "/" not in c["artifact"] and ".." not in c["artifact"]
            assert hashlib.sha256(files[f"{prefix}/{c['artifact']}"].encode()).hexdigest() == c["sourceDigest"]
            totals["artifacts"] += 1
    for name in files:
        if not name.startswith(prefix+"/") or not name.endswith(".json"):
            continue
        document = json.loads(files[name])
        if not isinstance(document, dict) or "evaluation" not in document or "records" not in document:
            continue
        ev, records = document["evaluation"], document["records"]
        task_set = freeze["confirmation"] if "confirmation" in ev["job"] else freeze["development"]
        assert set(records) == {t["id"] for t in task_set}
        rewards, token_counts = [], []
        for task in task_set:
            runs = records[task["id"]]["runs"]
            assert len(runs) == freeze["trialsPerTask"]
            for trial, record in enumerate(runs):
                call = by_stage[f"{ev['job']}:{task['id']}:{trial}"]
                assert record["source"] == files[f"{prefix}/{call['artifact']}"]
                output = subprocess.run(["python3", "-I", str(worker.resolve())],
                    input=json.dumps({"source": record["source"], "inputs": [c[0] for c in task["cases"]]}),
                    text=True, capture_output=True, timeout=4, env={"PATH":"/usr/bin:/bin","LANG":"C.UTF-8"})
                try:
                    data = json.loads(output.stdout)
                except Exception:
                    data = {"ok":False}
                checks = [canon(v) == canon(c[1]) and data["inputUnchanged"][i]
                          for i,(v,c) in enumerate(zip(data.get("results",[]),task["cases"]))] if data.get("ok") else []
                won = len(checks) == len(task["cases"]) and all(checks)
                assert won == record["strictSuccess"]
                rewards.append(int(won)); token_counts.append(call["tokens"])
                totals["reexecutedTrials"] += 1
        assert ev["missing"] == 0 and ev["n_expected"] == len(rewards)
        assert abs(ev["S"] - sum(rewards)/len(rewards)) < 1e-12
        assert abs(ev["C"] - sum(token_counts)/len(token_counts)) < 1e-12
    totals["passes"] += 1; totals["calls"] += len(ledger)
    totals["apiCostUsd"] += sum(c["costUsd"] for c in ledger)
    totals["reservedUsd"] += sum(c["reservedUsd"] for c in ledger)
    if result is None:
        totals["incompletePasses"] += 1
        continue
    baseline = result["developmentBaseline"]
    accepted = 0
    rounds_path = f"{prefix}/rounds.json"
    for item in json.loads(files.get(rounds_path, "[]")):
        if not item["accepted"]:
            continue
        child = item["evaluation"]
        assert child["S"] > baseline["S"] and child["missing"] == 0 and not child["extra"]["safetyViolation"]
        assert all(sum(child["per_task"][k]["rewards"])/len(child["per_task"][k]["rewards"]) >=
                   sum(baseline["per_task"][k]["rewards"])/len(baseline["per_task"][k]["rewards"])
                   for k in baseline["per_task"])
        assert not baseline["S"] or child["extra"]["apiCostUsd"]/child["S"] <= baseline["extra"]["apiCostUsd"]/baseline["S"]
        baseline = child; accepted += 1
    assert accepted == result["acceptedDevelopmentChanges"]
    assert abs(baseline["S"]-result["developmentSelected"]["S"]) < 1e-12
    totals["acceptedDevelopmentChanges"] += accepted
assert totals["reservedUsd"] <= 3
print(json.dumps({"verified": True, **totals, "scope": "Artifact re-execution, score and cost consistency. Not provider or host attestation, statistical superiority or general RSI proof."}, indent=2))
