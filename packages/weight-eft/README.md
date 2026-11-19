# @metaharness/weight-eft

<!-- ruv-seo:start (ADR-356) -->

Turns your coding agent's past runs into LoRA training data: SFT rows from gold-resolved trajectories and DPO pairs from the same model's resolved and failed attempts, with an eval-holdout contamination guard and reward-hack filtering. Training itself is a GPU-gated dry-run plan unless you opt in.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). Pure JavaScript, no native build step. Export and planning are offline and free; `train --train` needs a GPU host or endpoint.

## Quickstart

```bash
mkdir demo && cd demo && npm init -y >/dev/null
npm install @metaharness/weight-eft
cat > quickstart.mjs <<'EOF'
import { exportTrainingData } from '@metaharness/weight-eft';
const sys = { role: 'system', content: 'You are a SWE agent.' };
const issue = { role: 'user', content: 'Issue: RST writer ignores header_rows.' };
const archive = [
  { instance_id: 'demo-1', model: 'z-ai/glm-5.2', tier: 'cheap', resolved: true, sample: 0,
    model_patch: 'diff --git a/a.py b/a.py\n+fix\n',
    messages: [sys, issue, { role: 'assistant', content: 'Final patch submitted.' }] },
  { instance_id: 'demo-1', model: 'z-ai/glm-5.2', tier: 'cheap', resolved: false, sample: 1,
    model_patch: '', messages: [sys, issue, { role: 'assistant', content: 'Could not fix it.' }] },
  { instance_id: 'held-out-1', model: 'z-ai/glm-5.2', tier: 'cheap', resolved: true, sample: 0,
    model_patch: 'diff --git a/b.py b/b.py\n+fix\n', messages: [sys, issue] },
];
const { sft, dpo, report } = exportTrainingData(archive, { evalHoldout: ['held-out-1'] });
console.log('SFT rows:', sft.length, '| DPO pairs:', dpo.length, '| excluded by holdout:', report.excludedByHoldout);
console.log('SFT instances:', report.sftInstanceIds.join(', '));
EOF
node quickstart.mjs
```

Expected output:

```text
SFT rows: 1 | DPO pairs: 1 | excluded by holdout: 1
SFT instances: demo-1
```

**Next:** [`@metaharness/darwin`](https://www.npmjs.com/package/@metaharness/darwin) — produces the run archives this package exports from.

**Where it fits:** `metaharness` depends on it and forwards `npx metaharness weight-eft <export|train|eval|status>` to `@metaharness/weight-eft/cli` (`packages/create-agent-harness/src/index.ts`).
<!-- ruv-seo:end -->

## Reference

> **Make cheap open-source LLMs solve more coding tasks on their own.** Fine-tune them (LoRA) on your AI agent's *past successful runs*, so your pipeline calls expensive frontier models (GPT, Claude) **less often** — and your cost-per-fix drops.

[![npm version](https://img.shields.io/npm/v/@metaharness/weight-eft.svg)](https://www.npmjs.com/package/@metaharness/weight-eft)
[![license: MIT](https://img.shields.io/npm/l/@metaharness/weight-eft.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@metaharness/weight-eft.svg)](https://nodejs.org)

```bash
npm i @metaharness/weight-eft
```

## What is this? (plain language)

If you run an **AI coding agent**, you probably use a **model cascade**: a cheap
model (GLM / Qwen / DeepSeek) tries first, and only the hard problems
**escalate** to an expensive frontier model (GPT / Claude). Every escalation
costs real money.

**`weight-eft` makes the cheap model smarter** by fine-tuning it with **LoRA** on
the trajectories your agent *already solved* — turning your run history into
training data. The cheap model then resolves more issues by itself, so you
**escalate less and pay less per solved task.**

It's a self-improving loop: **your agent's wins become the next model's training set.**

- **Input:** your agent's run archive (successful + failed trajectories).
- **Output:** portable LoRA training data — **SFT + DPO** in standard formats
  (OpenAI chat JSONL / TRL / axolotl / unsloth) **+ a GPU training plan**.
- **Goal:** lower **cost-per-resolved**, not a leaderboard score.

## Why it exists (the honest, bounded thesis)

We attack the **cost axis, not the capability ceiling.** A small (7-14B) local
fine-tune **will not** out-reason a frontier model on the hardest problems —
that's a model-capability ceiling (measured: clean-eval ~37.3%, ADR-198 / §53).
The win is **fewer escalations** (lower cost), and the tooling keeps the
telemetry honest about exactly that: the eval metric is
**escalation-rate-reduction + cost/resolved**, *never* "we beat the frontier."

Under the hood this is the gradient/weight counterpart to Darwin's gradient-free
policy evolution (*freeze the model, evolve the harness*) — here we **also**
evolve the cheap model's *weights*, on the open tier, from the harness's own
archive.

## The data recipe (on/off-policy)

| Set | Contents | Why |
|-----|----------|-----|
| **SFT** | **ALL** gold-resolved trajectories — cheap-OWN *and* frontier-escalation | SFT (max-likelihood) is off-policy-stable, so a frontier success on an issue the cheap model couldn't solve is **off-policy-safe DISTILLATION**. |
| **DPO** | **ON-POLICY cheap-vs-cheap pairs ONLY** — `chosen` = a resolved sample, `rejected` = an empty/failed sample by the **same cheap model on the same instance** (BoN-derived) | A frontier-chosen-vs-cheap-rejected pair is **off-policy and unstable** (the reference policy never produced the chosen completion). That signal goes to SFT instead. |

### Output formats (canonical / portable)

Exported files use **standard** schemas (portable to TRL / axolotl / unsloth /
ruvllm-MicroLoRA), never a custom format. A thin runner-adapter at the training
boundary maps standard → whatever the runner ingests.

- **SFT** — OpenAI chat JSONL:
  `{"messages":[{role:system},{role:user},{role:assistant,tool_calls:[…]},{role:tool,…},…,{role:assistant}]}`.
  **`tool_calls` are preserved** — the ReAct loop is **not** flattened to plain
  text; the model learns real tool-use trajectories.
- **DPO** — TRL/HF conversational preference:
  `{"prompt":[system+issue], "chosen":[resolved trajectory], "rejected":[failed trajectory]}`.
  ReAct diverges from the first action, so `prompt` is the shared system+issue
  and chosen/rejected are full trajectories from there.

## The guards

1. **Contamination guard (the headline correctness property).** Strict
   **train/eval instance-ID disjointness.** The exporter excludes any
   trajectory whose `instance_id` is in the caller's `evalHoldout`, and
   `assertTrainEvalDisjoint` **throws** on any overlap. *Training on eval
   instances is fake lift — the exact contamination we debunk elsewhere.*
2. **Reward-hacking filter** (Ornith-1.0 borrow). A **deterministic monitor**
   drops any "success" that read a withheld gold/test path, modified the
   verification harness, or escaped the sandbox. An archived reward-hack would
   teach the model to reward-hack — this is the **training-data analog of the
   conformance firewall**, separate from and *in addition to* the disjointness
   guard.
3. **Long-context filter.** SWE/ReAct trajectories can blow past a 7-14B
   context window (~32k). Over-budget trajectories are **dropped (or truncated
   with `--truncate`) and REPORTED** — never silently lost.

Every drop is surfaced in the export report (`droppedRewardHacked`,
`excludedByHoldout`, `droppedOverLength`, `truncatedOverLength`).

## The `weightAdapter` genome gene (prune-the-overfitter safety net)

A LoRA tune can overfit. Rather than trust it blindly, the adapter is a **gene**
in the Darwin genome (`packages/darwin-mode/bench/swebench/evolve-config.mjs`):

- `weightAdapter: null` = **BASE** (no adapter) — the default and the control.
  A genome that never opts in is **byte-identical (by key) to a pre-gene
  genome.**
- `weightAdapter: 'sft'` = SFT-distilled adapter.
- `weightAdapter: 'sft-dpo'` = SFT then on-policy DPO.

Base competes against the tuned variants under the **same conformant fitness**,
so **evolution prunes an adapter that doesn't actually lift held-out resolve.**
The gene is inert until an adapter is trained (a GPU job) — it only *names* an
adapter; it does not create one.

## The training runner (GPU-gated)

`weight-eft train` is **$0 by default** — it emits a training **plan** (config +
the exact `ruvllm microlora …` command). A **real** run requires **BOTH** an
explicit `--train` flag **AND** a detected GPU / endpoint; otherwise it dry-runs
or refuses. Target is **7-14B** (Qwen2.5-Coder-7B / GLM-4-9B class) — *not* 32B
(§59: 32B q4 spills a 16GB GPU). Stages: SFT first, then optional on-policy DPO
from the SFT checkpoint.

## CLI

```bash
# Status / recipe summary
weight-eft status
metaharness weight-eft status         # via the umbrella CLI

# Export training sets ($0). evalHoldout enforces the contamination guard.
weight-eft export --archive archive.json --eval-holdout holdout.json --out-dir ./out

# Emit the training plan ($0 dry-run). Add --train on a GPU host to run.
weight-eft train --base Qwen/Qwen2.5-Coder-7B-Instruct --params-b 7 \
  --sft ./out/sft.jsonl --dpo ./out/dpo.jsonl --adapter glm5.2

# Measure the cost-Pareto delta (base vs adapter cascade runs).
weight-eft eval --base-outcomes base.json --adapter-outcomes adapter.json
```

### The exact (later, GPU) command to train + eval

```bash
# 1) Export ($0) — disjoint train/eval, reward-hack-filtered, long-context-filtered
weight-eft export --archive darwin-archive.json --eval-holdout clean-eval-ids.json --out-dir ./eft

# 2) Train (GPU host) — SFT then on-policy DPO. ruvllm/MicroLoRA executes plan.command.
weight-eft train --base Qwen/Qwen2.5-Coder-7B-Instruct --params-b 7 \
  --sft ./eft/sft.jsonl --dpo ./eft/dpo.jsonl --adapter glm5.2 --train
# (refuses unless WEIGHT_EFT_BASE_URL / CUDA_VISIBLE_DEVICES is set)

# 3) Run the conformant cascade twice (base vs glm5.2-sft-dpo adapter) on the
#    HELD-OUT clean set via the existing darwin eval path, collect per-instance
#    CascadeOutcome[] for each, then:
weight-eft eval --base-outcomes base-outcomes.json --adapter-outcomes adapter-outcomes.json
```

## Input contract

The exporter codes against `DarwinTrajectory[]` (see `src/types.ts`) —
reconstructable from Firestore `darwin_runs` + the local prediction/trajectory
artifacts (`predictions-*.jsonl` rows carry `instance_id` + `model_patch`; the
agentic loop carries the `messages` array with `tool_calls`, see
`darwin-mode/bench/swebench/solve-agentic.mjs`). A tiny mock fixture archive
lives in `__tests__/fixtures/`.

## Status (honest)

- **Runnable, $0:** exporter (with all three guards), training-plan emission,
  cost-Pareto eval folding, the `weightAdapter` gene (wired into darwin's
  evolve-config genome + the umbrella `metaharness weight-eft` CLI).
- **Scaffolded, GPU-gated:** the actual LoRA training (`spawn(plan.command)` on
  a GPU host implementing the ruvllm/MicroLoRA seam). No training run, no GPU
  job, no paid model call has been executed.

See **ADR-198** for the full rationale, the SFT-distill / on-policy-DPO recipe,
the disjointness invariant, and the self-scaffolding RL roadmap (Ornith-1.0).

## License

MIT
