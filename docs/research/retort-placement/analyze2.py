#!/usr/bin/env python3
"""Phase-2.1 placement re-analysis: did the timeout/efficiency fix move
metaharness/cheap toward dominating, and does agenticow memory help?

Reuses the SAME machinery as the Phase-2 analysis (retort_metaharness.diagnose +
.analysis Type-II ANOVA, retort.analysis.pareto). Nothing here re-scores a cell.

Inputs:
  --prior  docs results-combined.csv (the committed Phase-2 frame)
  --new    results-cheap-v2.csv (harvest2 of the fixed-harness cheap re-run)
Outputs: placement-analysis-v2.json + stdout report.
"""
from __future__ import annotations
import json, math, sys
from pathlib import Path
import pandas as pd

G2 = Path("/tmp/claude-1000/-home-ruvultra-projects-agent-harness-generator/ec35bf87-f599-4921-ac41-4996378d9334/scratchpad/grid2")
RETORT = G2.parent / "retort"
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


def main():
    a = {x.split("=")[0]: x.split("=")[1] for x in sys.argv[1:] if "=" in x}
    prior_p = Path(a.get("--prior", str(G2.parent.parent / "no")))  # set explicitly by caller
    new_p = Path(a.get("--new", str(G2 / "results-cheap-v2.csv")))
    prior = pd.read_csv(prior_p)
    new = pd.read_csv(new_p)
    if "memory" not in prior.columns: prior["memory"] = "none"
    report = {"inputs": {"prior": str(prior_p), "new": str(new_p)}}

    # ---------- A. NEW cheap re-run: diagnosis + memory arms ----------
    report["new_diagnosis"] = diag_counts(new)
    new_genuine = mz_diag.drop_tooling_fails(new, thr=THR).copy()
    report["new_n_genuine"] = int(len(new_genuine))
    # headline metaharness/cheap (fixed harness) = memory==none arm
    mem_arms = {}
    for memlvl, g in new_genuine.groupby("memory"):
        mem_arms[memlvl] = agg(g)
    report["new_cheap_by_memory"] = mem_arms
    # also raw (incl tooling) timeout count in the new run
    report["new_timeouts"] = int(((new["tokens"]==0) & (new["latency_s"]>600)).sum())

    # ---------- B. BEFORE/AFTER for metaharness/cheap ----------
    pri_mh_cheap = prior[(prior["harness_config"]=="metaharness") & (prior["model"]=="cheap")]
    pri_mh_cheap_gen = mz_diag.drop_tooling_fails(pri_mh_cheap, thr=THR)
    before = agg(pri_mh_cheap_gen)
    before["timeouts_excluded"] = int(((pri_mh_cheap["tokens"]==0) & (pri_mh_cheap["latency_s"]>600)).sum())
    after_none = mem_arms.get("none", {})
    # all-in reliability (timeouts counted as fails) — the honest reliability lens
    new_none_all = new[new["memory"]=="none"]
    report["before_after_mh_cheap"] = {
        "before_v1": before, "after_v2_memNone": after_none,
        "before_v1_allin": allin(pri_mh_cheap),
        "after_v2_memNone_allin": allin(new_none_all),
        "after_v2_bothMem_allin": allin(new),
    }

    # ---------- C. Combined-v2 frame: swap mh/cheap with fixed memNone ----------
    keep = prior[~((prior["harness_config"]=="metaharness") & (prior["model"]=="cheap"))].copy()
    newcheap_none = new[new["memory"]=="none"].copy()
    # align columns
    for c in keep.columns:
        if c not in newcheap_none.columns: newcheap_none[c] = "none" if c=="memory" else 0
    combined = pd.concat([keep, newcheap_none[keep.columns]], ignore_index=True)
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
    # does any metaharness stack now DOMINATE claude-code/frontier? (cov>=, cost<=, one strict)
    ccf = next((s for s in stacks if s["stack"]=="claude-code/frontier"), None)
    dom = {}
    if ccf:
        for s in stacks:
            if not s["stack"].startswith("metaharness"): continue
            cov_ge = s["coverage_mean"] >= ccf["coverage_mean"] - 1e-9
            cost_le = s["cost_per_task_mean"] <= ccf["cost_per_task_mean"] + 1e-9
            strict = (s["coverage_mean"] > ccf["coverage_mean"] + 1e-9) or (s["cost_per_task_mean"] < ccf["cost_per_task_mean"] - 1e-9)
            dom[s["stack"]] = {"coverage_ge": bool(cov_ge), "cost_le": bool(cost_le),
                               "dominates_ccf": bool(cov_ge and cost_le and strict)}
    report["dominance_vs_ccf"] = dom

    # ---------- D. ANOVA on combined-v2 (model x harness x language x task) ----------
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
    report["anova_combined"] = anova(cgen, ["model","harness_config","language","task"])

    # ---------- E. Memory-factor ANOVA on the NEW cheap cells (language x memory x task) ----------
    report["anova_memory"] = anova(new_genuine, ["memory","language","task"])

    out = G2 / "placement-analysis-v2.json"
    out.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
