#!/usr/bin/env python3
"""Harvest the Phase-2.1 cheap-tier re-run campaigns into a CellResult CSV.

Same contract as grid/harvest.py: only READS each campaign retort.db (Retort's
own runner + scorers + conformance spec-gate produced them, untouched). The new
factor is `memory` [none|agenticow]; model is pinned to deepseek-v4-pro (cheap).
"""
from __future__ import annotations
import csv, json, sqlite3, sys
from pathlib import Path

G2 = Path("/tmp/claude-1000/-home-ruvultra-projects-agent-harness-generator/ec35bf87-f599-4921-ac41-4996378d9334/scratchpad/grid2")

# campaign dir -> (harness_config, task)   (model is constant cheap/deepseek-v4-pro)
CAMPAIGNS = {
    "mh2-crud": ("metaharness", "rest-api-crud"),
    "mh2-cli":  ("metaharness", "cli-data-pipeline"),
}
COLS = ["cell_id","replicate","model","harness_config","scaffold","memory","language","task",
        "status","requirement_coverage","code_quality","cost_per_task","latency_s",
        "tokens","runner","notes","x_raw_model"]


def harvest_db(db: Path, harness: str, task: str) -> list[dict]:
    con = sqlite3.connect(str(db)); con.row_factory = sqlite3.Row
    rows = []
    for r in con.execute("SELECT id, replicate, status, run_config_json FROM experiment_runs"):
        cfg = json.loads(r["run_config_json"] or "{}")
        lang = cfg.get("language", "unknown")
        memory = cfg.get("memory", "none")
        m = {x["metric_name"]: x["value"] for x in con.execute(
            "SELECT metric_name, value FROM run_results WHERE run_id=?", (r["id"],))}
        sraw = (r["status"] or "").lower()
        status = "pass" if sraw in ("done","completed","success","ok") else "fail"
        rc = m.get("requirement_coverage")
        rows.append({
            "cell_id": f"{harness}-{task}-{lang}-cheap-mem-{memory}",
            "replicate": r["replicate"], "model": "cheap", "harness_config": harness,
            "scaffold": "none", "memory": memory, "language": lang, "task": task,
            "status": status,
            "requirement_coverage": float(rc) if rc is not None else 0.0,
            "code_quality": float(m.get("code_quality", 0.0)),
            "cost_per_task": float(m.get("_cost_usd", 0.0)),
            "latency_s": float(m.get("_duration_seconds", 0.0)),
            "tokens": int(m.get("_tokens", 0) or 0),
            "runner": harness, "notes": f"req_cov_raw={rc}", "x_raw_model": "deepseek-v4-pro",
        })
    con.close(); return rows


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else G2 / "results-cheap-v2.csv"
    all_rows = []
    for name, (harness, task) in CAMPAIGNS.items():
        db = G2 / name / "retort.db"
        if not db.exists():
            print(f"  (skip {name}: no retort.db)"); continue
        rows = harvest_db(db, harness, task)
        print(f"  {name}: {len(rows)} runs"); all_rows.extend(rows)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS); w.writeheader(); w.writerows(all_rows)
    print(f"Wrote {len(all_rows)} rows -> {out}")


if __name__ == "__main__":
    main()
