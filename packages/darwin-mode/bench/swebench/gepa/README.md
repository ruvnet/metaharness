# GEPA executor-genome harness (ADR-228)

Offline evolutionary optimization of the cheap executor's **operating policy** — the genome, a flat
`dict[str,str]` of named text components (GEPA's native candidate format). Answers the ADR-226
runtime-advice null (D 3/24 = D0 3/24 vs cascade 9/24): the same strong-model judgment is applied
**offline**, as empirically-selected mutations to the executor's standing policy, instead of as
runtime whispers. Spec: `docs/adrs/ADR-228-gepa-distilled-executor-genome.md`.

## Files

| File | Role |
|---|---|
| `genome.mjs` | Seed genome (extracted from `buildAgenticSystem`/`buildAdvisedSystem`/`buildAdvisorSystem`) + `buildSystemFromGenome`. Byte-equivalence regression guard in `genome.test.mjs`. |
| `seed-genome.json` | The seed candidate artifact (renders byte-identical to today's prompts). |
| `metric.mjs` | Pre-registered §5.1 metric, §5.3 failure classes, §5.2 ASI feedback generator. |
| `build-reflective-dataset.mjs` | Harvests fadv/advbench artifacts into admitted GEPA records (ADR-227 admission gates: paired, verified-outcome, contamination-scanned, provenance, replay-convertible; drop+count). |
| `reflective-dataset.json` | Built dataset (58 admitted / 96 candidates from the 2026-07-02 runs). |
| `evaluate-genome.mjs` | Runs one genome on a manifest slice via `solve-advisor.mjs --genome … --advisor-model none` (unmodified D0 path), gold-scores, emits per-instance `{score, ASI}`. Never raises per instance. |
| `gepa-loop.mjs` | The GEPA loop: reflective mutation + per-instance Pareto frontier + budget accounting. Pure/DI. |
| `run-gepa.mjs` | Real wiring: subprocess evaluator + OpenRouter reflection LM + hard $ cap + holdout eval. |

## $0 workflow

```bash
cd packages/darwin-mode/bench/swebench

# all mock tests (genome round-trip, metric, Pareto, gates, assembly)
node --test gepa/*.test.mjs

# rebuild the reflective dataset from today's artifacts
node gepa/build-reflective-dataset.mjs \
  --fable-bench <fable-bench-worktree>/packages/darwin-mode/bench/swebench \
  --adr226 <adr226-worktree>/packages/darwin-mode/bench/swebench \
  --manifest advisor-medium-25.json \
  --gold advbench-D0-med=/tmp/darwin-advisor.adv_d0_med.json \
  --gold advbench-D-med=/tmp/darwin-advisor.adv_d_med.json \
  --gold advbench-Dself-med=/tmp/darwin-advisor.adv_dself_med.json \
  --gold advbench-B-med=/tmp/darwin-agentic.adv_b_med.json \
  --gold fadv-glm-solo=<fable-bench>/darwin-advisor.fadv_glm_solo.json \
  --gold-patches gepa/gold-patches.json \
  --out gepa/reflective-dataset.json
```

## Paid workflow (GATED — ADR-228 §9.5)

Gate: OpenRouter headroom (usage − $2439.31 baseline vs the $800 cap) ≥ $50 AND the 4 fadv arms
(GLM/v4-pro × solo/Fable) finished. Do not run otherwise.

```bash
# evaluate one genome on a slice (rollouts + Docker gold scoring)
OPENROUTER_API_KEY=$(cat /tmp/.orkey) node gepa/evaluate-genome.mjs \
  --genome gepa/seed-genome.json --manifest advisor-medium-25.json --first 12 \
  --model z-ai/glm-5.2 --max-steps 12 --concurrency 2 --max-cost 3 \
  --reflective gepa/reflective-dataset.json --out gepa/eval-seed.json

# the pilot: GLM genome, medium-12 train / other-12 holdout, ≤$25 hard
OPENROUTER_API_KEY=$(cat /tmp/.orkey) node gepa/run-gepa.mjs \
  --seed gepa/seed-genome.json --model z-ai/glm-5.2 \
  --manifest advisor-medium-25.json --train-first 12 \
  --reflection-model anthropic/claude-sonnet-5 \
  --max-candidates 15 --max-cost 25 --out gepa/pilot-result.json
```

The result reports the **full Pareto frontier** (not one winner) and the **holdout** gold delta —
the promotion decision reads the holdout number only (§8: defective-seed cautions, arXiv 2603.18388).

## Acceptance (pre-registered, ADR-228 §7)

GEPA executor ≥ own-baseline + 3/24 AND ≥ 50% of the cascade lift AND $/resolved < cascade.
Minimum useful for GLM: ≥ 10/24 (baseline 7/24). Anything less is reported as a null.
