# Sakana AI Coding-Agent Methods: Reverse-Engineering Report

**Date:** 2026-06-23  
**Status:** Research-grade — all claims cite fetched sources or are explicitly marked as inferences  
**Scope:** Sakana Fugu, AB-MCTS / TreeQuest, Darwin-Godel Machine, and the SWE-bench selection-mechanism gap  

---

## 0. Executive Summary

"Fugu" (announced 2026-06-22) is NOT a SWE-bench coding-agent system. It is a learned multi-model orchestrator — a ~0.6B–7B coordinator model that routes queries across a pool of frontier LLMs (Claude Opus 4.8, GPT-5.5, Gemini 3.1 Pro). Its headline benchmark is SWE-Bench **Pro** (a harder, Scale AI benchmark where top scores are ~23–59%), not SWE-bench Verified/Lite. Its selection mechanism — how it picks the best model/answer — is proprietary.

The Sakana method that directly bears on our SWE-bench Lite/Verified problem is the **Darwin-Godel Machine (DGM)**, published May 2025 (arXiv:2505.22954). DGM evolved an agent scaffold from 20% to **50% on SWE-bench Verified** via open-ended self-modification — and the evolved agent looks very much like our own `solve-agentic.mjs` augmented with multi-attempt generation, FM-based patch ranking, and enhanced file-editing tools.

AB-MCTS / TreeQuest is a general inference-time scaling algorithm (NeurIPS 2025 Spotlight, arXiv:2503.04412). It was benchmarked on LiveCodeBench, CodeContest, ARC-AGI, and MLE-Bench — not on SWE-bench. Its reward signal for coding tasks uses **public test cases during search, not gold tests**, which makes it conformant. But it requires a reliable external scorer, and the solver architecture is "generate-a-complete-solution-per-node", not "stateful file editing".

**Key gap finding:** For the best-of-N selection problem (picking the winning trajectory without the gold test), the literature converges on three conformant signals: (1) repo existing-test pass/fail (green = strong signal), (2) LLM-judge Discriminator with structured debate (SWE-Search: selects the gold-correct trajectory 84% of the time), and (3) self-written repro tests gated by a critic (our own MCTS solver's approach — but documented Goodhart trap). The DGM shows that a second FM evaluating patches is a discovered-by-evolution optimization worth implementing directly.

**Bottom line for 45% @ <$0.50/inst:** The DGM's evolved scaffold — multi-attempt + FM evaluator for selection, combined with our proven stateful ReAct loop at $0.005/inst baseline — is the highest-leverage path. An LLM-judge Discriminator (5-agent debate, no gold test) costs ~$0.03–0.05/instance and could be layered onto our existing N=3–5 parallel runs.

---

## 1. What Fugu Actually Is

### 1.1 Release and positioning

Sakana AI launched Sakana Fugu on 2026-06-22 as a commercial product. It is an **orchestration model** — itself a learned LLM — that calls other LLMs and synthesizes their outputs. It is NOT a purpose-built SWE-bench solver; it is a general-purpose multi-model coordination system.

**Sources:**
- [MarkTechPost announcement](https://www.marktechpost.com/2026/06/22/sakana-ai-launches-sakana-fugu-an-orchestration-model-that-routes-tasks-across-a-swappable-pool-of-frontier-llms/)
- [Sakana Fugu Technical Report (arXiv:2606.21228)](https://arxiv.org/html/2606.21228)
- [Sakana.ai product page](https://sakana.ai/fugu-beta/)

### 1.2 Architecture

Two underlying research systems underpin Fugu:

**TRINITY** (ICLR 2026, arXiv:2512.04695):
- A ~0.6B-parameter coordinator evolved with **separable CMA-ES** (an evolutionary strategy, not RL).
- Assigns three roles to worker models at each turn: **Thinker** (reasoning/planning), **Worker** (execution), **Verifier** (validation).
- The coordinator model is lightweight — it reads hidden-state representations and outputs a routing decision via a ~10K-parameter head.
- Achieves 86.2% on LiveCodeBench in the research paper.

**Conductor** (arXiv:2512.04388):
- A **7B-parameter** model trained with **GRPO** (Group Relative Policy Optimization — an RL variant).
- Learns to output natural-language coordination strategies: which workers communicate with which, and what specialized prompt each gets.
- Allows recursive self-calling (the orchestrator as one of its own workers), enabling test-time compute scaling.
- Reward: format correctness (0 if unparseable) + task correctness (1.0 if correct, 0.5 otherwise).

**Fugu product** (Technical Report arXiv:2606.21228):
- Fugu (standard): single-step routing — lightweight prediction head outputs L logits (one per worker), trained with soft targets from historical worker performance using a temperature-scaled softmax. 
- Fugu Ultra: multi-step Conductor-style agentic workflow, specifying worker assignments and communication topology in natural language.
- Agent pool: Claude Opus 4.8, GPT-5.5, Gemini 3.1 Pro (Fable/Mythos excluded as of June 2026 per US policy).
- Evolution uses sep-CMA-ES for end-to-end task optimization (same as TRINITY).
- Routing is proprietary; per-query model selection is not disclosed.

### 1.3 SWE-bench scores

Fugu's coding benchmarks are on **SWE-Bench Pro**, which is a different, harder benchmark than SWE-bench Lite/Verified:

| System | SWE-Bench Pro (public, 731 instances) |
|--------|--------------------------------------|
| Fugu Ultra (vendor-reported) | 73.7% |
| Claude Opus 4.8 | 69.2% |
| GPT-5.5 | 58.6% |

**Critical caveat:** SWE-Bench Pro top models score **23%** under standardized evaluation. The vendor-reported numbers use a proprietary harness ("mini-swe-agent" with "max turns = 1000, effectively disabling turn caps"). The Scale AI public leaderboard's top score as of this writing is 59.1% (gpt-5.4), with Sakana not appearing on the official leaderboard. Vendor and leaderboard numbers are not comparable.

For standard SWE-bench Verified, no Sakana Fugu submission appears in the public leaderboard.

**Sources:**
- [SWE-Bench Pro Public Leaderboard (Scale AI)](https://labs.scale.com/leaderboard/swe_bench_pro_public)
- [Fugu Technical Report](https://arxiv.org/html/2606.21228)
- [MorphLLM SWE-bench Pro tracker](https://www.morphllm.com/swe-bench-pro)

### 1.4 Selection mechanism in Fugu

For Fugu (routing mode): a prediction head selects one worker from the pool — there is no multi-candidate generation+selection; it routes to the predicted best model.

For Fugu Ultra: the Conductor generates an agentic workflow executed end-to-end. The "selection" is implicit in the Verifier role assigned to one agent. Exact mechanism is proprietary.

**No public evidence that Fugu uses test execution (gold or repo) as a selection signal for SWE-bench tasks.**

---

## 2. AB-MCTS: The Core Algorithm

### 2.1 Paper

**"Wider or Deeper? Scaling LLM Inference-Time Compute with Adaptive Branching Tree Search"**  
Yuichi Inoue, Kou Misaki, Yuki Imajuku, So Kuroki, Taishi Nakamura, Takuya Akiba  
NeurIPS 2025 Spotlight. arXiv:2503.04412, submitted March 2025, final revision November 2025.

**Sources:**
- [arXiv abstract](https://arxiv.org/abs/2503.04412)
- [arXiv HTML full text v5](https://arxiv.org/html/2503.04412v5)
- [Sakana AI blog post](https://sakana.ai/ab-mcts/)

### 2.2 Algorithm

The core tree structure uses two node types:
- **GEN node:** represents the option to generate a new child (go wider).
- **CONT nodes:** existing children, representing the option to refine/deepen.

At each step:
1. `SelectExpansionTarget(T)`: traverse from root, using Thompson Sampling to choose between GEN (expand) and CONT (deepen) at each node.
2. Expand: call the LLM to generate a new solution or refinement.
3. Back-propagate the score from the new node upward.

**Thompson Sampling decision rule:** At node N with actions {GEN, CONT-child-1, CONT-child-2, ...}:
- Maintain a Bayesian posterior distribution over expected reward for each action.
- Sample a score from each distribution.
- Select the action with the highest sampled score: `a* = argmax_j ~ P_N(r | a_j)`.

Two variants:
- **AB-MCTS-M (Mixed Model):** Bayesian mixed-effects model with shared parameters across subtrees — enables information pooling.
- **AB-MCTS-A (Aggregated):** Conjugate priors (Gaussian or Beta) per node, analytical updates, no shared parameters. Simpler and faster.

### 2.3 Reward signal for coding tasks

**THIS IS THE KEY CONFORMANCE QUESTION.**

From the paper (Section 5.1, arXiv:2503.04412v5):

> "We use the **public tests** to calculate each node's score and the **hidden tests** for final evaluation. A solution is counted as correct only if it passes all hidden test cases."

This maps directly to our conformance model:
- **In-loop signal = public/visible test cases** (fraction passed, normalized to [0,1])
- **Final score = hidden/gold tests** (never seen during search)

This is **conformant** by SWE-bench leaderboard rules.

**Final answer selection:** "At each budget, we choose the single solution based on validation-set performance" — i.e., the highest-score node in the tree.

### 2.4 Multi-LLM AB-MCTS (TreeQuest)

Adds a third dimension: at each node, also choose *which* LLM to use. Separate Thompson Sampling bandit per LLM type. Models that earn higher reward get chosen more often. TreeQuest is the open-source implementation.

**GitHub:** https://github.com/SakanaAI/treequest (Apache 2.0, v0.3.2 as of Feb 2025)

### 2.5 Benchmark results

AB-MCTS benchmarks are on **LiveCodeBench and CodeContest and ARC-AGI-2** — NOT SWE-bench:

| Task | Method | Score |
|------|--------|-------|
| LiveCodeBench | AB-MCTS-A (Gaussian) + GPT-4o | 39.1% ± 1.9 |
| LiveCodeBench | Repeated Sampling | 37.8% |
| CodeContest | AB-MCTS | 40.6% |
| CodeContest | Repeated Sampling | 37.9% |
| ARC-AGI-2 | Multi-LLM AB-MCTS (o4-mini + Gemini-2.5-Pro + R1-0528) | >30% of 120 tasks |
| ARC-AGI-2 | Single-model repeated sampling | 23% |

**Typical compute budget:** 128–512 LLM API calls per task. The improvement over repeated sampling is modest (~1–3 absolute points on coding benchmarks) but consistent.

**AB-MCTS does not have published SWE-bench numbers.** The paper cites SWE-Search as related prior work on MCTS+SWE-bench.

### 2.6 Critical limitation for our use case

AB-MCTS is designed for tasks where a **complete, self-contained solution** is generated at each node and can be scored by an external oracle (fraction-of-tests-passed). It is not designed for **stateful multi-step file-editing** where the environment changes across turns. The "generate-a-complete-solution" node model doesn't map cleanly to our ReAct loop's interleaved read/edit/test trajectory.

AB-MCTS could be applied at the **trajectory level** (each "node" = one complete agentic solve run), but this raises the cost dramatically (each node = a full $0.005–$0.05 solve run).

---

## 3. Darwin-Godel Machine: The Closest Published Sakana SWE-bench System

### 3.1 Overview

The Darwin-Godel Machine (DGM) is the Sakana system that directly addresses SWE-bench Verified at the agent-scaffold level. It is not a runtime algorithm for solving individual instances — it is an **evolutionary meta-algorithm that improves the agent's code over many generations**.

**Paper:** "Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents"  
Authors: Sakana AI, University of British Columbia, Vector Institute  
Published: May 2025 (arXiv:2505.22954)

**Sources:**
- [arXiv:2505.22954](https://arxiv.org/abs/2505.22954)
- [arXiv HTML v2](https://arxiv.org/html/2505.22954v2)
- [Sakana AI blog](https://sakana.ai/dgm/)
- [GitHub: jennyzzt/dgm](https://github.com/jennyzzt/dgm)

### 3.2 Base agent (starting point)

The initial agent uses:
- **Frozen foundation model** with tool use (Bash + file-edit tools)
- Receives: repo location, problem statement, repo testing framework
- Action space: run bash commands, view/edit files
- This is the same fundamental architecture as our `agentic-loop.mjs`

### 3.3 Evolution mechanism

DGM maintains a growing **archive** of coding agent variants. At each evolution step:

1. Sample a parent agent (probability proportional to performance score × number of successful children).
2. Use a foundation FM to generate a modified version (diff to the agent's code).
3. Evaluate the new agent on a staged benchmark subset:
   - Stage 1: 10 tasks (basic functionality gate)
   - Stage 2: 50 tasks (performance gate, >40% required)
   - Stage 3: 200 tasks (full evaluation for the best agents)
4. Add all variants that retain code-editing ability to the archive (open-ended diversity).

**Fitness signal:** SWE-bench Verified benchmark performance (fraction resolved). The evolution process does use SWE-bench gold tests as the outer evolutionary fitness signal — but this is the meta-training loop, not the per-instance solving.

### 3.4 What the evolved agent discovered

The DGM autonomously evolved the following improvements over the base agent:

1. **Enhanced editing tools:** More granular file viewing by line range; string-replacement editing (the SWE-agent primitive) for more precise changes.
2. **Long-context window management:** Auto-summarizing prior interactions when context fills up.
3. **Multi-attempt generation with FM-based ranking:** Making multiple attempts to solve a task, then using a second FM to evaluate and select the best solution.
4. **Iterative refinement:** Considering previous failed attempts when generating subsequent ones (exactly our `feedback` variable in `runBranch`).
5. **Patch validation step:** Testing patches before submitting.
6. **Peer-review mechanism:** Using another FM to evaluate patches — the discriminator pattern.

These are the key evolved behaviors. The multi-attempt + FM-evaluator for selection is the most directly applicable finding.

### 3.5 SWE-bench scores

| System | SWE-bench Verified | Notes |
|--------|-------------------|-------|
| Base agent | 20.0% | frozen FM + basic tools |
| DGM without open-ended exploration | 23.0% | single evolutionary path |
| DGM (full) | **50.0%** | open-ended archive + self-improvement |
| Base agent on Polyglot | 14.2% | multi-language tasks |
| DGM on Polyglot | 30.7% | |

Benchmark: SWE-bench Verified (human-validated subset where all tasks are confirmed solvable).

### 3.6 Cost

- **Evolution run:** ~$22,000 total, ~2 weeks. The evolved agent's code is the deliverable.
- **Single evaluation run baseline:** ~$10,000 per full SWE-bench run.
- **Per-instance cost of the final evolved agent when deployed:** Not disclosed, but based on the description (multi-attempt + FM evaluator), estimated at $0.10–$0.50/instance at frontier model prices.

### 3.7 What this means for us

The DGM's key finding is that the final evolved agent's key differences from the base agent are:
- Multi-attempt generation (what our `--k` flag does in `solve-mcts.mjs`)
- FM-based evaluator/discriminator to rank patches (what we DON'T have — our current selector is "first repro-passing patch wins")

We can implement the evolved agent's discovered behaviors directly without running the $22K evolution loop — the evolution already found them; we just need to build them.

---

## 4. The Selection Problem: What Sakana and Others Use

This is our open problem: picking the winning trajectory/patch from N candidates WITHOUT seeing the gold test.

### 4.1 The signals available (conformant)

**Signal A: Repo existing test pass/fail (strongest conformant signal)**
- Run the repository's pre-existing test suite against each candidate patch.
- Our `runRepoTests` in `solve-agentic.mjs` (with `--no-test-oracle`) already does this.
- Limitation: many SWE-bench issues are in areas with sparse test coverage, so existing tests may not discriminate.
- AB-MCTS uses "public test cases" (fraction passed) — same signal.

**Signal B: Self-written repro test (our current `test-critic.mjs` approach)**
- Generate a reproduction test that fails on buggy code, passes on fixed code.
- Selection: run repro against each patch, pick first passer.
- Problem: Goodhart trap documented in our ADR-177 / LEARNINGS §10-12 — self-written repros can be wrong or under-constrained, selecting incorrect patches.
- Evidence: capped cheap models at 12-16%; Opus best-of-3 at 33%.

**Signal C: LLM-judge Discriminator (SWE-Search, conformant)**
- SWE-Search (arXiv:2410.20285, ICLR 2025) evaluated a 5-agent debate Discriminator.
- "A structured debate to determine the most effective solution" — agents argue for different patches, a judge agent evaluates reasoning quality and selects.
- No gold tests consulted; selection relies on trajectory reasoning quality.
- **Result: Discriminator selected the gold-correct trajectory 84% of the time** (value function alone: 73%).
- Cost: ~5 additional LLM calls per instance for the debate.

**Signal D: Learned reward model / value function (requires training)**
- SWE-RM (arXiv:2512.21919): execution-free reward model using static analysis signals (AST analysis, import tracking, variable scope, function signatures).
- Trained on gold-labeled data — not zero-shot.
- SWE-Search's Value Agent: uses repo existing tests + trajectory analysis to produce a numerical score + qualitative explanation.

**Signal E: Multi-LLM voting / ensemble (Fugu pattern)**
- Generate patches from different models; select by majority vote or LLM-judge over the set.
- TRAE (70.4% SWE-bench Verified): o1 selects among Claude 3.7 Sonnet + Gemini 2.5 Pro + o4-mini patches.
- AgentScope (63.4%): Qwen2.5 selects best from multiple Claude 3.5 Sonnet trials.
- devlo (70.2%): 3 models for diversity + selection.

**Sources:**
- [SWE-Search paper](https://arxiv.org/abs/2410.20285)
- [SWE-Search ICLR 2025 proceedings](https://proceedings.iclr.cc/paper_files/paper/2025/file/a1e6783e4d739196cad3336f12d402bf-Paper-Conference.pdf)
- [Dissecting SWE-bench Leaderboards paper](https://arxiv.org/pdf/2506.17208)

### 4.2 AB-MCTS selection mechanism (detailed)

From Section 5.2 of arXiv:2503.04412:

> "We choose the single solution based on **validation-set performance**"

This means: the node with the highest score (fraction of public tests passed) at the end of the budget is the winner. This is simple and effective for competitive-coding tasks where scoring is granular. For SWE-bench (binary pass/fail per instance), the fractional signal is coarser — only a few test files exist per instance.

AB-MCTS does NOT use any learned value model. The Thompson Sampling posterior tracks empirical per-node scores, which is exactly the existing-test signal.

### 4.3 How DGM's evolved agent selects

"Using another FM to evaluate and select the best solution" — the DGM evolved a discriminator pattern. No details on what prompt this FM uses, but the pattern is: generate k patches, evaluate each with a separate FM call, pick the best-scored. This is Signal C (LLM judge) applied after generation, not during search.

### 4.4 Non-serializable environment problem

arXiv:2505.13652 ("Guided Search Strategies in Non-Serializable Environments") directly addresses our situation: Docker containers can't easily save/restore mid-trajectory states for MCTS tree expansion. Their solution: **1-step lookahead** and **trajectory selection**, both guided by a learned action-value function. This doubled the success rate of a fine-tuned Qwen-72B to 40.8% on SWE-bench. Requires a trained value model.

---

## 5. Implementation Blueprint for Our Stack

### Our current state (as measured)

| Approach | Resolve Rate | Cost/Instance | Status |
|----------|-------------|---------------|--------|
| MCTS + self-repro gating | 12–16% (cheap models), 33% (Opus best-of-3) | $0.01–$0.10 | Goodhart trap |
| Stateful ReAct loop (deepseek-v4-flash, `--no-test-oracle`) | **~36% single trajectory** | **$0.005** | BREAKTHROUGH |
| Full-300 run | measuring now | $0.005 | base rate |

The ReAct loop is the foundation. The following are ordered by expected resolve-lift per implementation effort.

---

### Improvement 1: LLM-Judge Discriminator (N=3 parallel runs)

**What:** Run 3 independent ReAct trajectories (temperature variation: 0.0, 0.2, 0.4). Pass all 3 resulting patches to a lightweight LLM-judge (5-agent structured debate or single-pass critique). Select the highest-scored patch.

**Why it works:** SWE-Search Discriminator selected gold-correct trajectory 84% of the time vs. 73% for the value function alone. At 36% single-trajectory resolve, if the discriminator correctly identifies the correct patch when one of 3 is right, and the probability of at least one of 3 solving it is ~1-(0.64)^3 = 73.8%, then selection accuracy of 84% gives ~62% effective resolve. This is likely optimistic, but even 45–55% is achievable.

**How to implement in `solve-agentic.mjs`:**
1. Run N=3 parallel `agenticSolve` calls with temp=0, 0.2, 0.4 (already supported via `TEMP` flag).
2. After all 3 complete, add a discriminator step:
```javascript
async function discriminatorSelect(patches, problem, snippets) {
  // Each patch is a git diff. Ask an FM to evaluate each.
  const candidates = patches.map((p, i) => 
    `Candidate ${i+1}:\n${p.slice(0,2000)}`).join('\n\n---\n\n');
  const prompt = `Problem:\n${problem.slice(0,1500)}\n\nPatches:\n${candidates}\n\n` +
    `Score each patch 1-10 for: (a) correctness of logic fix, (b) minimal/targeted change, ` +
    `(c) no regressions. Output JSON: {"winner": 1, "scores": [s1,s2,s3], "reasoning": "..."}.`;
  const r = await llm(prompt, 'You are a senior code reviewer. Pick the best patch.');
  // parse winner index, return patches[winner-1]
}
```
3. Emit the discriminator-selected patch.

**Conformant?** Yes — no gold tests used. The discriminator sees only patches and the problem statement.

**Estimated $/instance:** 3 × $0.005 (solve) + 1 × $0.002 (discriminator, 4K token call) = **~$0.017/instance**

**Expected resolve-lift:** +8–15 absolute points (from ~36% to ~44–51%). HIGH uncertainty.

**Evidence grade:** Medium — derived from SWE-Search's 84% selection accuracy, which was measured on a different solver/benchmark configuration.

---

### Improvement 2: Repo-test Diversity Signal + N-selection

**What:** Keep `--no-test-oracle` mode (existing repo tests as in-loop signal). Run N=3–5 trajectories, use repo test pass-count as the selection signal (most tests passing = winner). This is exactly what AB-MCTS does with "public tests".

**How to implement:**
- `solve-agentic.mjs` already runs `runRepoTests` per trajectory. Capture the pass-count from each run's `resolvedInLoop` + `logTail`.
- Add a simple winner selection: sort by test pass count, take the highest.
- Costs: if repo tests run per trajectory, ~3–5× current cost.

**Conformant?** Yes.

**Estimated $/instance:** ~$0.015–$0.025 for N=3–5.

**Expected lift:** Moderate (+5–10 pts) if repo test coverage is reasonable. Many SWE-bench instances have sparse coverage — this will underperform on sparse-test repos.

**Evidence grade:** Medium-High — this is what AB-MCTS uses; it consistently outperforms repeated sampling by ~2–5 absolute points on coding benchmarks.

---

### Improvement 3: FM Patch Evaluator (DGM evolved mechanism)

**What:** After generating K patches (from `solve-mcts.mjs` branches), run a second FM to score each patch on likely correctness without execution. Inspired by what DGM's evolution discovered.

**How to implement in `solve-mcts.mjs`:**
After the K-branch loop, before the Opus sniper escalation, add:
```javascript
async function fmRankPatches(patches, problem, sourceSnapshot) {
  if (patches.length <= 1) return patches[0];
  const ranked = await llm(
    `Problem: ${problem.slice(0,2000)}\n\n` +
    patches.map((p,i) => `Patch ${i+1}:\n${p.slice(0,1500)}`).join('\n---\n') +
    `\nRank these patches by likely correctness. Output JSON: {"ranking": [1,2,...], "best": N}`,
    'You are a senior Python engineer. Evaluate patches for correctness and side-effect risk.');
  // parse ranked.best, return patches[best-1]
}
```

**Conformant?** Yes — no gold tests.

**Estimated $/instance:** +$0.002–$0.005 per K patches ranked.

**Expected lift:** +3–7 pts. Lower confidence than Improvement 1 — depends on how well an FM can evaluate correctness without execution.

**Evidence grade:** Medium — DGM evolved this pattern, implying it helps; exact improvement unknown.

---

### Improvement 4: Better Edit Tool (DGM "str_replace" finding)

**What:** Our `LINE_SYS` (line-range editing) in `solve-mcts.mjs` already addresses the search/replace reliability problem. The DGM evolved the same insight independently. But our `agentic-loop.mjs` still uses search/replace. Migrating the agentic loop to line-range edits should reduce the ~30% empty-patch rate seen in earlier MCTS experiments.

**How:** The `LINE_SYS` and `applyLineEdits` functions in `solve-mcts.mjs` can be extracted and injected into `agentic-loop.mjs`. Add a `line_edit` tool alongside the existing `edit` tool, preferring it.

**Conformant?** Yes.

**Estimated $/instance:** No added cost (same number of LLM calls).

**Expected lift:** +2–5 pts (reduces empty/misapplied patches in the agentic loop).

**Evidence grade:** Medium-High — DGM evolved this; our own MCTS experiments showed ~50% empty-patch rate with search/replace fixed by line-range.

---

### Improvement 5: Context Window Management (Auto-summarize)

**What:** DGM evolved long-context management (auto-summarizing prior interactions). Our `agentic-loop.mjs` sends the full transcript each turn. At 20 steps with 4K obs per step, this approaches context limits for cheap models.

**How:** After step N (configurable, e.g., 10), summarize earlier steps:
```javascript
if (transcript.length > 10) {
  const summary = await llm(`Summarize these prior debugging steps concisely:\n` +
    transcript.slice(0,-5).map(t => t.actionRaw+' => '+t.obs.slice(0,200)).join('\n'));
  // Replace early transcript entries with summary
}
```

**Conformant?** Yes.

**Estimated $/instance:** +$0.001 for the summary call.

**Expected lift:** +2–4 pts (prevents context overflow on harder instances with longer trajectories).

**Evidence grade:** Medium — DGM evolved this; direct quantification unavailable.

---

### Improvement 6: AB-MCTS at Trajectory Level

**What:** Apply AB-MCTS branching to complete ReAct solve runs (each "node" = one full `agenticSolve` call). Use repo test pass-count as the reward signal. Thompson Sampling decides whether to "go wider" (new temperature-varied run) or "go deeper" (start from a promising mid-trajectory state — hard without serializable Docker state).

**Limitation:** The non-serializable Docker state problem (arXiv:2505.13652) means true MCTS tree reuse is hard. Effectively degrades to repeated sampling with smarter stopping.

**Conformant?** Yes.

**Estimated $/instance:** $0.03–$0.10 for 6–20 nodes.

**Expected lift:** +5–10 pts if the repo-test signal is discriminative; uncertain for sparse-coverage instances.

**Evidence grade:** Low-Medium — AB-MCTS improvements over repeated sampling are 2–5 pts on coding benchmarks with reliable oracles; SWE-bench oracle is weaker.

---

### Improvement 7: Multi-LLM Diversity (Conductor/AB-MCTS Multi-LLM)

**What:** Instead of N identical deepseek-v4-flash runs, use different cheap models per trajectory (deepseek-v4-flash, Qwen3-30B, gemma-3-27b). Models have different coding styles and blind spots. Thompson Sampling (AB-MCTS Multi-LLM) allocates more calls to whichever model is performing better in real time.

**How:** Modify `solve-agentic.mjs` to cycle models across the N trajectories. Add model-level performance tracking (array of pass counts per model, Beta-distributed Thompson Sampling to pick next model).

**Conformant?** Yes.

**Estimated $/instance:** Same as N-parallel — $0.015–$0.025 for N=3.

**Expected lift:** +3–7 pts (model diversity is a known contributor; TRAE, devlo use it).

**Evidence grade:** Medium — Multi-LLM AB-MCTS outperforms single-LLM AB-MCTS on ARC-AGI-2 by 2.5+ pts; SWE-bench transfer uncertain.

---

## 6. Honest Assessment

### What is reproducible cheaply (our stack, <1 week)

1. **LLM-judge Discriminator over N=3 parallel runs** — the single highest-leverage addition. Costs ~$0.017/instance, could move 36% → 44–50%. Directly maps to the DGM's evolved FM-evaluator and SWE-Search's Discriminator Agent. Implementation: ~100 lines added to `solve-agentic.mjs`.

2. **Repo-test diversity signal for N-selection** — already have the signal (`resolvedInLoop` from `runRepoTests`). Need to expose pass-count granularity and add selection logic. Low effort, moderate expected gain.

3. **Line-range edit tool in agentic-loop.mjs** — already have the primitives in `solve-mcts.mjs`. Extract + inject. ~50 lines.

4. **Context summarization** — ~30 lines.

### What requires training (out of scope)

- **Learned value function / SWE-RM** (arXiv:2512.21919): trained on gold-labeled patches. Requires a GPU, labeled dataset, and days of training.
- **TRINITY coordinator** (CMA-ES evolved 0.6B model): requires evolution infrastructure + thousands of eval runs.
- **Conductor RL training** (GRPO, 7B model): requires RL training infrastructure.
- **DGM evolution itself** ($22K, 2 weeks): we can implement the *discovered* behaviors without re-running evolution.

### Does the Sakana approach clear 45% conformant at <$0.50/inst?

**DGM's evolved agent (50% on SWE-bench Verified):** Likely yes, but the per-instance cost of the final evolved agent is unquantified. Given it uses multiple solve attempts + FM evaluator, and frontier model pricing, estimated $0.10–$0.50/instance. Plausibly within the $0.50 cap.

**Fugu at SWE-bench Lite/Verified:** Unknown — Fugu has not published SWE-bench Verified/Lite numbers. Its SWE-bench Pro number (73.7%) is on a harder benchmark with vendor-specific harness settings and is not comparable.

**AB-MCTS at SWE-bench:** Unknown — never benchmarked on SWE-bench by Sakana.

**Our path to 45% at <$0.50/inst:** The combination of (1) our 36% single-trajectory base + (2) LLM-judge Discriminator + (3) repo-test selection over N=3 runs is the most promising direction. Estimated $0.017–0.025/instance. Expected resolve: 42–52% (high uncertainty). This is achievable in days of implementation.

---

## 7. Summary Table

| Technique | Source | Conformant | Est. $/inst | Expected lift | Effort |
|-----------|--------|-----------|-------------|---------------|--------|
| LLM-judge Discriminator (N=3) | SWE-Search, DGM | Yes | ~$0.017 | +8–15 pts | Low (100 lines) |
| Repo-test diversity N-selection | AB-MCTS (public tests) | Yes | ~$0.015 | +5–10 pts | Low (50 lines) |
| Line-range edit in agentic loop | DGM (evolved) | Yes | $0 extra | +2–5 pts | Low (50 lines) |
| FM patch evaluator post-K | DGM (evolved) | Yes | +$0.003 | +3–7 pts | Low (30 lines) |
| Context auto-summarize | DGM (evolved) | Yes | +$0.001 | +2–4 pts | Low (30 lines) |
| Multi-LLM diversity (Thompson) | AB-MCTS Multi-LLM | Yes | ~$0.020 | +3–7 pts | Medium (200 lines) |
| AB-MCTS at trajectory level | AB-MCTS paper | Yes | $0.03–0.10 | +5–10 pts | Medium (300 lines) |
| Learned value model (SWE-RM) | arXiv:2512.21919 | Yes | varies | +10–20 pts | Out of scope (training) |
| DGM evolution | arXiv:2505.22954 | Yes* | $22K run | +30 pts | Out of scope |

*DGM uses gold tests as the outer evolutionary fitness signal, but the per-instance solving never sees gold tests.

---

## 8. Source Index

All URLs were fetched during this research session:

- [Sakana Fugu product page](https://sakana.ai/fugu-beta/)
- [Sakana Fugu Technical Report (arXiv:2606.21228)](https://arxiv.org/html/2606.21228)
- [MarkTechPost Fugu announcement](https://www.marktechpost.com/2026/06/22/sakana-ai-launches-sakana-fugu-an-orchestration-model-that-routes-tasks-across-a-swappable-pool-of-frontier-llms/)
- [Sakana AB-MCTS blog post](https://sakana.ai/ab-mcts/)
- [AB-MCTS paper arXiv:2503.04412 (abstract)](https://arxiv.org/abs/2503.04412)
- [AB-MCTS paper arXiv:2503.04412v5 (HTML)](https://arxiv.org/html/2503.04412v5)
- [TreeQuest GitHub releases](https://github.com/SakanaAI/treequest/releases)
- [TreeQuest VentureBeat coverage](https://venturebeat.com/ai/sakana-ais-treequest-deploy-multi-model-teams-that-outperform-individual-llms-by-30)
- [neurohive.io AB-MCTS analysis](https://neurohive.io/en/frameworks/treequest-framework-adaptive-llm-teams-outperform-individual-models-by-30/)
- [the-decoder.com AB-MCTS coverage](https://the-decoder.com/sakana-ais-new-algorithm-lets-large-language-models-work-together-to-solve-complex-problems/)
- [Darwin-Godel Machine arXiv:2505.22954 (abstract)](https://arxiv.org/abs/2505.22954)
- [Darwin-Godel Machine arXiv HTML v2](https://arxiv.org/html/2505.22954v2)
- [Sakana DGM blog post](https://sakana.ai/dgm/)
- [DGM GitHub: jennyzzt/dgm](https://github.com/jennyzzt/dgm)
- [SWE-Search arXiv:2410.20285](https://arxiv.org/abs/2410.20285)
- [SWE-Search HTML v1](https://arxiv.org/html/2410.20285v1)
- [Non-serializable environments arXiv:2505.13652](https://arxiv.org/abs/2505.13652)
- [SWE-RM arXiv:2512.21919](https://arxiv.org/pdf/2512.21919)
- [TRINITY arXiv:2512.04695](https://arxiv.org/abs/2512.04695)
- [Conductor arXiv:2512.04388](https://arxiv.org/abs/2512.04388)
- [Dissecting SWE-bench Leaderboards arXiv:2506.17208](https://arxiv.org/html/2506.17208v2)
- [SWE-bench Pro public leaderboard (Scale AI)](https://labs.scale.com/leaderboard/swe_bench_pro_public)
- [Sakana Marlin (AB-MCTS commercialization)](https://www.marktechpost.com/2026/06/15/sakana-ai-marlin/)
