# Darwin — GLM→Opus empty-patch cascade (SWE-bench Lite)

**51.33% (154/300)** · Wilson 95% [45.7, 56.9] · **$0.267/instance** · conformant.

A cost-Pareto submission: the contribution is the **cost at this resolve**, not the absolute score.
Cheap GLM-5.2 ReAct base; only empty-patch give-ups (a 100%-precision escalation signal) go to
Claude-Opus-4.8. ~56× cheaper than frontier-only systems at a comparable resolve tier.

- `all_preds.jsonl` — predictions (instance_id, model_name_or_path, model_patch)
- `results/results.json` — resolved IDs + rate (official `swebench` harness, gold eval)
- Conformance: the solver never sees gold tests during solving (repo's own tests only).
- Replication: ecascade 50.7% n=300 (pooled ~51.0% over 600). See LEARNINGS §28/§35b.
