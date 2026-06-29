#!/usr/bin/env python3
"""Iteration-3 placement analysis: does task-difficulty-aware ROUTING (escalate the
hard cells from deepseek-v4-pro up to opus-4.8 on an INTRINSIC signal) close the
coverage gap toward dominating claude-code/frontier — or just trade cost for
coverage (slide along the same frontier)?

Reuses the SAME machinery as Phase-2 / i2 (retort_metaharness.diagnose + .analysis
Type-II ANOVA, retort.analysis.pareto). Nothing here re-scores a cell.

Inputs:
  --prior  results-combined-v2.csv  (committed i2 frame: cc/frontier, cc/cheap,
           mh/frontier, mh/cheap-i2)
  --new    results-routed-v3.csv    (harvest3 of the i3 routing run; routing[off|opus])
Outputs: placement-analysis-v3.json + stdout report.
"""
from __future__ import annotations
import json, math, sys
from pathlib import Path
import pandas as pd

G3 = Path("/tmp/claude-1000/-home-ruvultra-projects-agent-harness-generator/ec35bf87-f599-4921-ac41-4996378d9334/scratchpad/grid3")
RETORT = G3.parent / "retort"
sys.path.insert(0, str(RETORT / "src")); sys.path.insert(0, str(RETORT))

from retort_metaharness import analysis as mz_analysis
from retort_metaharness import diagnose as mz_diag
from retort.analysis.pareto import pareto_analysis

THR = mz_diag.DiagnosisThresholds(min_cost_usd=0.0005, min_latency_s=0.5, require_tokens=True)


def wilson(k, n, z=1.96):
    if n == 0: return (0.0, 0.0, 0.0)
    p = k / n; d = 1 + z*z/n
    c = (p + z*z/(2*n)) / d
    h = (z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / d
    return (round(p,4), round(max(0,c-h),4), round(min(1,c+h),4))


def agg(g):
    n = len(g); kpass = int((g["status"].str.lower()=="pass").sum())
    p, lo, hi = wilson(kpass, n)
    return {"n": n, "coverage_mean": round(float(g["requirement_coverage"].mean()),4),
            "coverage_median": round(float(g["requirement_coverage"].median()),4),
            "code_quality_mean": round(float(g["code_quality"].mean()),4),
            "cost_per_task_mean": round(float(g["cost_per_task"].mean()),6),
            "latency_s_mean": round(float(g["latency_s"].mean()),2),
            "latency_s_median": round(float(g["latency_s"].median()),2),
            "pass_rate": p, "pass_lo": lo, "pass_hi": hi,
            "n_full_cov": int((g["requirement_coverage"]>=1.0).sum())}


def allin(df):
    n=len(df); k=int((df["status"].str.lower()=="pass").sum()); p,lo,hi=wilson(k,n)
    return {"n_all": n, "pass_rate_allin": p, "pass_lo": lo, "pass_hi": hi,
            "timeouts": int(((df["tokens"]==0)&(df["latency_s"]>600)).sum())}


def diag_counts(df):
    d = mz_diag.diagnose_frame(df, thr=THR)
    v = d["verdict"].astype(str).str.upper()
    return {"pass": int((v=="PASS").sum()),
            "genuine_model_fail": int((v=="GENUINE_MODEL_FAIL").sum()),
            "tooling_false_fail": int((v=="TOOLING_FALSE_FAIL").sum())}


def anova(df, factors):
    out = {}
    fs = [f for f in factors if f in df.columns and df[f].nunique()>1]
    try:
        eff = mz_analysis.attribute(df, factors=fs, include_interactions=True, transform="log")
        for resp, e in eff.items():
            rows = [{"effect": r.term,
                     "pct_variance": (None if r.pct_variance!=r.pct_variance else round(float(r.pct_variance),2)),
                     "p_value": (None if (r.p_value is None or r.p_value!=r.p_value) else round(float(r.p_value),4)),
                     "significant": bool(r.significant)} for r in e.rows]
            out[resp] = {"rows": rows, "r_squared": round(float(e.r_squared),4),
                         "residual_pct": round(float(e.residual_pct),2), "n": int(e.n_obs)}
    except Exception as ex:
        out["error"] = str(ex)
    return {"factors": fs, "effects": out}


def main():
    a = {x.split("=")[0]: x.split("=")[1] for x in sys.argv[1:] if "=" in x}
    prior_p = Path(a["--prior"]); new_p = Path(a["--new"])
    prior = pd.read_csv(prior_p)
    new = pd.read_csv(new_p)
    if "routing" not in new.columns: new["routing"] = "off"
    report = {"inputs": {"prior": str(prior_p), "new": str(new_p)}}

    # ---------- A. NEW routing run: diagnosis + arms by routing ----------
    report["new_diagnosis"] = diag_counts(new)
    new_gen = mz_diag.drop_tooling_fails(new, thr=THR).copy()
    report["new_n_genuine"] = int(len(new_gen))
    arms = {}
    for lvl, g in new_gen.groupby("routing"):
        arms[lvl] = agg(g)
    report["new_by_routing_genuine"] = arms
    # all-in (timeouts counted as fails) per arm — the honest reliability lens
    report["new_by_routing_allin"] = {lvl: allin(g) for lvl, g in new.groupby("routing")}
    report["new_timeouts_total"] = int(((new["tokens"]==0) & (new["latency_s"]>600)).sum())

    # ---------- B. Escalation fraction (the cost driver) ----------
    opus = new[new["routing"]=="opus"].copy()
    esc = {"n_opus_cells": int(len(opus)),
           "n_escalated": int(opus["escalated"].astype(str).str.lower().isin(["true","1"]).sum()),
           "escalation_rate": round(float(opus["escalated"].astype(str).str.lower().isin(["true","1"]).mean()) if len(opus) else 0.0, 4)}
    esc["escalated_by_lang"] = {}
    for lang, g in opus.groupby("language"):
        kk = int(g["escalated"].astype(str).str.lower().isin(["true","1"]).sum())
        esc["escalated_by_lang"][lang] = {"n": int(len(g)), "escalated": kk}
    esc["escalated_by_task"] = {}
    for tk, g in opus.groupby("task"):
        kk = int(g["escalated"].astype(str).str.lower().isin(["true","1"]).sum())
        esc["escalated_by_task"][tk] = {"n": int(len(g)), "escalated": kk}
    report["escalation"] = esc

    # ---------- C. before/after vs i2 baseline + within-i3 off control ----------
    pri_mh_cheap = prior[(prior["harness_config"]=="metaharness") & (prior["model"]=="cheap")]
    pri_mh_cheap_gen = mz_diag.drop_tooling_fails(pri_mh_cheap, thr=THR)
    report["i2_baseline_mh_cheap"] = agg(pri_mh_cheap_gen)
    report["i2_baseline_mh_cheap"]["allin"] = allin(pri_mh_cheap)
    report["i3_off_control"] = arms.get("off", {})        # should reproduce i2 (deepseek-only)
    report["i3_off_control_allin"] = allin(new[new["routing"]=="off"])
    report["i3_routed_opus"] = arms.get("opus", {})       # the headline routed stack
    report["i3_routed_opus_allin"] = allin(new[new["routing"]=="opus"])

    # ---------- D. Combined-v3 frame: swap mh/cheap with the routed-OPUS arm ----------
    keep = prior[~((prior["harness_config"]=="metaharness") & (prior["model"]=="cheap"))].copy()
    routed = new[new["routing"]=="opus"].copy()
    for c in keep.columns:
        if c not in routed.columns:
            routed[c] = "none" if c in ("memory","scaffold") else 0
    combined = pd.concat([keep, routed[keep.columns]], ignore_index=True)
    report["combined_diagnosis"] = diag_counts(combined)
    cgen = mz_diag.drop_tooling_fails(combined, thr=THR).copy()
    stacks = []
    for (h, t), g in cgen.groupby(["harness_config","model"]):
        s = {"stack": f"{h}/{t}", "harness": h, "tier": t}; s.update(agg(g)); stacks.append(s)
    stacks.sort(key=lambda s: (-s["coverage_mean"], s["cost_per_task_mean"]))
    report["combined_stacks"] = stacks

    labels = [s["stack"] for s in stacks]
    cov = [s["coverage_mean"] for s in stacks]
    negcost = [-s["cost_per_task_mean"] for s in stacks]
    neglat = [-s["latency_s_mean"] for s in stacks]
    pr_cost = pareto_analysis(labels, list(zip(cov, negcost)), ["coverage","neg_cost"])
    pr_lat = pareto_analysis(labels, list(zip(cov, neglat)), ["coverage","neg_latency"])
    report["pareto_cost"] = {"frontier": list(pr_cost.frontier_labels),
                             "dominated": [l for l in labels if pr_cost.is_dominated(l)]}
    report["pareto_latency"] = {"frontier": list(pr_lat.frontier_labels),
                                "dominated": [l for l in labels if pr_lat.is_dominated(l)]}
    # DOMINANCE test vs claude-code/frontier (cov>=, cost<=, one strict) — the beyond-SOTA question
    ccf = next((s for s in stacks if s["stack"]=="claude-code/frontier"), None)
    dom = {}
    if ccf:
        for s in stacks:
            if not s["stack"].startswith("metaharness"): continue
            cov_ge = s["coverage_mean"] >= ccf["coverage_mean"] - 1e-9
            cost_le = s["cost_per_task_mean"] <= ccf["cost_per_task_mean"] + 1e-9
            strict = (s["coverage_mean"] > ccf["coverage_mean"] + 1e-9) or (s["cost_per_task_mean"] < ccf["cost_per_task_mean"] - 1e-9)
            dom[s["stack"]] = {"coverage": s["coverage_mean"], "cost": s["cost_per_task_mean"],
                               "coverage_ge_ccf": bool(cov_ge), "cost_le_ccf": bool(cost_le),
                               "dominates_ccf": bool(cov_ge and cost_le and strict)}
    report["dominance_vs_ccf"] = {"ccf": {"coverage": ccf["coverage_mean"], "cost": ccf["cost_per_task_mean"]} if ccf else None, "metaharness": dom}

    # ---------- E. ANOVA ----------
    report["anova_routing"] = anova(new_gen, ["routing","language","task"])
    report["anova_combined"] = anova(cgen, ["model","harness_config","language","task"])

    # per-language coverage table (off vs opus arm)
    pl = {}
    for lang in sorted(new_gen["language"].unique()):
        row = {}
        for lvl in ("off","opus"):
            gg = new_gen[(new_gen["language"]==lang)&(new_gen["routing"]==lvl)]
            row[lvl] = round(float(gg["requirement_coverage"].mean()),4) if len(gg) else None
        pl[lang] = row
    report["per_language_coverage"] = pl

    out = G3 / "placement-analysis-v3.json"
    out.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
