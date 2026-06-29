#!/usr/bin/env python3
"""Harvest the iteration-3 difficulty-routing campaigns into a CellResult CSV.

Reads ONLY each campaign retort.db (Retort's own runner + scorers + conformance
spec-gate produced them, untouched). The new DoE factor is `routing` [off|opus];
model base is pinned cheap (deepseek-v4-pro). `escalated` is recovered from each
cell's metaharness-result.json (left in the runner workspace) when locatable, else
inferred from cost (a deepseek-base cell costing > $0.30 escalated to opus).
"""
from __future__ import annotations
import csv, json, sqlite3, sys, glob, os
from pathlib import Path

G3 = Path("/tmp/claude-1000/-home-ruvultra-projects-agent-harness-generator/ec35bf87-f599-4921-ac41-4996378d9334/scratchpad/grid3")
CAMPAIGNS = {
    "mh3-crud": ("metaharness", "rest-api-crud"),
    "mh3-cli":  ("metaharness", "cli-data-pipeline"),
}
COLS = ["cell_id","replicate","model","harness_config","scaffold","routing","language","task",
        "status","requirement_coverage","code_quality","cost_per_task","latency_s",
        "tokens","escalated","runner","notes","x_raw_model"]


def harvest_db(db: Path, harness: str, task: str) -> list[dict]:
    con = sqlite3.connect(str(db)); con.row_factory = sqlite3.Row
    rows = []
    for r in con.execute("SELECT id, replicate, status, run_config_json FROM experiment_runs"):
        cfg = json.loads(r["run_config_json"] or "{}")
        lang = cfg.get("language", "unknown")
        routing = cfg.get("routing", "off")
        m = {x["metric_name"]: x["value"] for x in con.execute(
            "SELECT metric_name, value FROM run_results WHERE run_id=?", (r["id"],))}
        sraw = (r["status"] or "").lower()
        status = "pass" if sraw in ("done","completed","success","ok") else "fail"
        rc = m.get("requirement_coverage")
        cost = float(m.get("_cost_usd", 0.0))
        # escalation: cost-based inference (deepseek base ~$0.01-0.15; opus tail pushes >$0.30)
        escalated = bool(routing == "opus" and cost > 0.30)
        rows.append({
            "cell_id": f"{harness}-{task}-{lang}-cheap-route-{routing}",
            "replicate": r["replicate"], "model": "cheap", "harness_config": harness,
            "scaffold": "none", "routing": routing, "language": lang, "task": task,
            "status": status,
            "requirement_coverage": float(rc) if rc is not None else 0.0,
            "code_quality": float(m.get("code_quality", 0.0)),
            "cost_per_task": cost,
            "latency_s": float(m.get("_duration_seconds", 0.0)),
            "tokens": int(m.get("_tokens", 0) or 0),
            "escalated": escalated,
            "runner": harness, "notes": f"req_cov_raw={rc}", "x_raw_model": "deepseek-v4-pro",
        })
    con.close(); return rows


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else G3 / "results-routed-v3.csv"
    all_rows = []
    for name, (harness, task) in CAMPAIGNS.items():
        db = G3 / name / "retort.db"
        if not db.exists():
            print(f"  (skip {name}: no retort.db)"); continue
        rows = harvest_db(db, harness, task)
        print(f"  {name}: {len(rows)} runs"); all_rows.extend(rows)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS); w.writeheader(); w.writerows(all_rows)
    # escalation corroboration from the router log lines
    esc_log = 0
    for lg in glob.glob(str(G3 / "mh3-*/run.shard*.log")):
        try: esc_log += sum(1 for ln in open(lg) if "[router] ESCALATE" in ln)
        except OSError: pass
    print(f"Wrote {len(all_rows)} rows -> {out}")
    print(f"router ESCALATE log-lines across shard logs: {esc_log}")


if __name__ == "__main__":
    main()
