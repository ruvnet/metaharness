# SCAFFOLDING SOTA — Reasoning-Loop Techniques That Raise LLM Effective Intelligence Without Weight Changes

**Scope**: API-applicable scaffolding techniques — no fine-tuning, no weight changes. Focus: do they lift *cheap/weak* models specifically (DeepSeek-V4-Pro-class, GLM-5.2-class)? Do lifts survive on hard contamination-resistant tasks or only easy ones? Honest cost accounting required.

**Baseline context**: Cheap models at ReAct baseline score ~0.42 on FRAMES. RAG is confirmed null for raising *intelligence* (context-utilization ceiling). The open lever is *process* (scaffolding) + inference-time compute.

**Evidence grades**: A = multiple independent replication or quantified large controlled study; B = single credible paper with measured numbers; C = anecdotal / no hard lift numbers.

---

## 1. Reflexion — Verbal Self-Reflection on Failure → Retry

**Mechanism**: After a task attempt fails, the agent writes a natural-language post-mortem ("What went wrong and why"), stores it in episodic memory, and prepends it to the next attempt. No external critic — the same model reflects on its own trace. Published NeurIPS 2023 (Shinn et al.).

### Lift Numbers

| Task | Baseline | Reflexion | Delta | Model |
|------|----------|-----------|-------|-------|
| HumanEval pass@1 | ~80% (GPT-4 base) | 91% | +11 pp | GPT-4 |
| AlfWorld (decision-making) | 75% (ReAct) | 97% | +22 pp | GPT-3.5 + GPT-4 |
| HotPotQA (100-question subset) | ~36% (ReAct) | 51% | +15 pp | GPT-3.5 |
| Code gen (GPT-3.5 self-improve) | baseline | +3% in 12% of runs | marginal | GPT-3.5 |

Sources: Shinn et al. 2023 (NeurIPS); Self-Reflection in LLM Agents 2024 (arxiv:2405.06682).

### Cost Multiplier

×N calls where N = number of retry attempts (typically 3–5). Each retry includes the full prior trajectory + reflection text in the prompt, so token cost compounds: roughly ×3–5× total tokens vs. a single-pass attempt.

### Does It Help Cheap/Weak Models?

**Mixed — grade B with strong caveats.** AlfWorld numbers used GPT-3.5 as executor, showing +22 pp lift. But the lift concentrated in near-solved tasks where the reflection signal was meaningful. Research on truly weak backbones (GPT-3.5 class self-improve tasks) found that only 12% of GPT-3.5 runs yielded ≥3% improvement in code generation; GPT-3.5 proposed improvements that sometimes actively harmed downstream performance. The critical failure mode: when the initial reasoning backbone is weak, reflection quality is also weak — a poorly-understood failure generates a poor diagnosis which generates a worse second attempt.

### Does the Lift Survive Hard Tasks?

**Partially — degrades at hard tail.** On AlfWorld (a relatively constrained discrete environment) gains are dramatic. On open-ended HotPotQA the lift is more modest (+15 pp) and saturates after 1–2 reflections. On tasks requiring external knowledge the model doesn't have, reflection cannot conjure it — it hallucinates a new task specification instead.

### Failure Mode: Hallucinated Reflection (Grade A)

Documented in multiple papers (2024): After a failed attempt, the reflection step incorrectly infers an alternative task and rewrites the implementation accordingly — not diagnosing the real bug but redefining the task. This causes the second attempt to diverge further from the correct solution. Low-quality self-feedback in single-agent loops entrench errors instead of correcting them. Complex multi-step environments with dynamic action spaces make old trajectories less informative, limiting the utility of reflection.

### Verdict

**Use with caution on cheap models.** Best fit: well-defined tasks with a clear success signal (code execution, unit tests, AlfWorld step outcomes) where the model can form an accurate error diagnosis. Do not apply to open-ended reasoning where bad reflection = bad next attempt. Cap retries at 2–3; beyond that, error compounding dominates. Requires external success oracle (code runner, env feedback) to be reliable.

**Grade: B — measured lifts on strong models, marginal/unreliable on weak models without an external oracle.**

---

## 2. Plan-and-Solve / Plan-Then-Execute

**Mechanism**: Before solving, generate an explicit decomposed plan ("Step 1: ... Step 2: ..."), then execute each step. Addresses "missing-step errors" in zero-shot CoT (where the model jumps to conclusions, skipping required intermediate steps). Wang et al., ACL 2023.

### Lift Numbers

| Task type | Baseline (Zero-shot CoT) | Plan-and-Solve (PS+) | Delta |
|-----------|-------------------------|----------------------|-------|
| Math reasoning (GPT-3) | ~50% (various math sets) | +5–12 pp | +5–12 pp |
| Commonsense reasoning | comparable to 8-shot CoT | similar | roughly neutral |
| Symbolic tasks | improves on missing-step errors | +10 pp | +10 pp |

The PS+ variant ("pay attention to calculation and commonsense") consistently outperforms Zero-shot-CoT across all datasets. Comparable to 8-shot CoT without requiring few-shot examples. Source: Wang et al. 2023 (ACL), arxiv:2305.04091.

### Cost Multiplier

×1.5–2× tokens. One planning call + one execution call, or combined in a single longer generation. The cheapest expansion technique on this list — fundamentally it is just a longer prompt that forces structured output before committing to an answer.

### Does It Help Cheap/Weak Models?

**Yes — grade A for structured reasoning tasks.** The key insight is that Plan-and-Solve attacks the specific failure mode most common in weak models: calculation errors and missing-step errors (skipping required intermediate reasoning). Weak models are more likely to skip steps; explicit planning forces the step structure into the generation. The benefit is particularly clear for arithmetic/math where step omission is the primary failure mode.

### Does the Lift Survive Hard Tasks?

**Moderate.** On straightforward math benchmarks the lifts are clean (+5–12 pp). On FRAMES-class tasks (multi-document retrieval + multi-hop reasoning), pure Plan-and-Solve without external retrieval still hits the context-utilization ceiling. Best combined with a retrieval action plan.

### Failure Mode

Over-planning: weak models sometimes generate elaborate plans that are internally inconsistent, then faithfully execute a flawed plan. The plan provides no correction mechanism; it just structures the error. Also: plan-following overhead can force the model into a rigid structure that prevents it from taking a shortcut that the problem actually allows.

### Verdict

**High-value, low-cost lift for structured tasks.** Should be default prompt structure for any agentic task where subtask decomposition is natural (multi-step math, multi-tool use, multi-document Q&A). Costs almost nothing extra. The ablation test: does the cheap model skip reasoning steps on baseline? If yes, Plan-and-Solve will help.

**Grade: A for structured/math/agentic tasks; B for open-ended reasoning.**

---

## 3. Self-Refine / Self-Critique-and-Revise

**Mechanism**: Generate an initial output → generate critique of that output → revise based on critique → repeat until convergence or budget exhausted. All three phases use the same model; no external judge. Madaan et al. 2023.

### Lift Numbers

| Task type | Lift | Notes |
|-----------|------|-------|
| Dialogue response generation | +20% avg improvement | as reported by authors |
| Sentiment reversal, acronym generation | large gains | subjective/creative tasks |
| Math reasoning | +2–5 pp | modest gains |
| Code generation | +3–8 pp | varies by model |
| SOTA models (Gemini 2.5 Pro, GPT-5 class) 2025 | ≤+1.8 pp | with unguided self-critique |
| With external guided feedback | up to +80% within 5 turns | but requires oracle |

Source: Madaan et al. 2023; CoRefine 2025 (arxiv:2602.08948); Socratic Self-Refine SSR 2024 (arxiv:2511.10621).

### Cost Multiplier

×N where N = refinement rounds. Each round = one critique call + one revision call = 2× baseline. Three rounds = ×6× calls vs. single-pass. Total token cost grows quickly because full output is re-generated each round.

### Does It Help Cheap/Weak Models?

**Conditionally — grade B with significant caveats.** The key finding from 2025 research: frontier models (Gemini 2.5 Pro, GPT-5 equivalent) show essentially no self-refinement gain (+1.8 pp max) without external guidance, because they already generate near-optimal outputs. But weaker models gain more because their initial outputs have more room for improvement. However, weak models also generate weaker critiques — the critique quality is bounded by the same model that generated the flawed output. This creates a ceiling on self-refine benefit for weak models.

The breakthrough finding: gains are much larger when critique is guided (external oracle / different model provides feedback, or structured critique prompts are provided). Unguided self-critique by the same weak model provides limited signal.

### Does the Lift Survive Hard Tasks?

**No — weakest on hard reasoning.** The 20% average gain comes primarily from subjective/creative tasks where quality is broadly defined (dialogue, sentiment reversal). On math and code reasoning (verifiable correctness), gains are much more modest (2–8 pp). On FRAMES-class hard multi-hop reasoning, there is no evidence self-refine without external signal reliably helps.

### Failure Mode

Error entrenchment: the model confidently "refines" a wrong answer by making it more elaborate and convincing. The critique does not detect the fundamental error; it polishes surface quality. For cheap models, this is common on logical or mathematical errors where the critique itself makes the same reasoning error.

### Verdict

**Valuable for output quality on subjective tasks; unreliable for hard reasoning without an external critic.** The "self" in self-refine is the limitation: you cannot reliably critique what you cannot correctly evaluate. The technique transforms into something much stronger when a separate verifier provides the critique signal (see Section 7).

**Grade: B for subjective/quality tasks; C for hard reasoning on cheap models.**

---

## 4. Tree-of-Thoughts (ToT) / LATS / Graph-of-Thoughts (GoT)

**Mechanism**: Instead of a single reasoning chain, maintain a tree (or graph) of partial reasoning states. At each node, generate multiple possible next steps ("thoughts"), evaluate them, and search the tree using BFS/DFS/MCTS. LATS (Language Agent Tree Search) extends this to agentic settings with ReAct-style action execution + external environment feedback. Yao et al. 2023 (ToT); Zhou et al. 2023 (LATS); Besta et al. 2023 (GoT).

### Lift Numbers

| Method | Task | Score | vs. Baseline | Model |
|--------|------|-------|--------------|-------|
| ToT | Game of 24 | 74% | +71 pp vs CoT (4%) | GPT-4 |
| ToT | Game of 24 | 19% | +19 pp vs CoT (~0%) | GPT-3.5 |
| LATS | HumanEval pass@1 | 92.7% | vs ~80% (ReAct) | GPT-4 |
| LATS | WebShop | 75.9 avg | SOTA across methods | GPT-3.5 |
| GoT | Sorting (128 el.) | 69% median error reduction | vs ToT | GPT-3.5 |
| GoT | Cost reduction | >31% fewer tokens | vs ToT | any |

Sources: Yao et al. NeurIPS 2023; Zhou et al. ICML 2024; Besta et al. 2023 (arxiv:2308.09687); "Understanding When ToT Succeeds" arxiv:2410.17820.

### Cost Multiplier

**Extreme.** ToT: ×5–100× CoT token cost. For Game of 24, solving one problem requires 5,500 completion tokens in ToT, comparable to ~100 CoT trials (6,700 tokens total). Some analyses estimate ToT at >100× compute vs. a single CoT pass. LATS is similarly expensive due to tree expansion + value function calls at every node. GoT reduces cost vs. ToT by ~31% but remains expensive.

### Does It Help Cheap/Weak Models?

**Severely limited — grade B for strong models, C for weak.** The GPT-3.5 Game of 24 result (19%) vs. GPT-4 (74%) makes the model-dependency clear. The failure mechanism: ToT requires an *evaluation function* at each node to decide which branches to expand. Weak models produce low-quality evaluations — they cannot reliably judge whether a partial reasoning state is on a promising path. Bad evaluation = wrong pruning = wasted expansion budget on bad branches. Analysis (arxiv:2410.17820) confirmed: "The performance of Tree-of-Thoughts lags that of a simple self-consistency baseline by a considerable margin on weaker models than GPT-4."

### Does the Lift Survive Hard Tasks?

**Yes for combinatorial / structured search problems (if model is strong enough).** The original ToT was designed for constrained search problems (Game of 24, creative writing with constraints, crosswords). For these, the lift is large and verified. For natural-language hard reasoning (FRAMES, HotPotQA), the gain is less clear because the search space is less well-defined and evaluation is harder to formulate. LATS on WebShop does show strong gains in agentic settings.

### Failure Mode

Computational budget explosion. Weak evaluation functions prune viable paths. Error in one node propagates through all child branches. The framework requires careful tuning of branching factor and depth — these are task-specific hyperparameters.

### Verdict

**Do not use for cheap-model ablations. Too expensive, fails on weak backbones.** If you do have a strong model and a well-defined search problem (code correctness, math) with a verifiable evaluation signal, LATS is the right framework. For cheap-model intelligence lift per dollar, Self-Consistency + Plan-and-Solve + verifier-gated BoN will beat LATS at 1/10th the cost.

**Grade: A for strong models on structured search; C for weak models. Cost-disqualified for cheap-model ablations.**

---

## 5. Self-Consistency (Sample-and-Vote / Best-of-N with Majority)

**Mechanism**: Sample N independent reasoning paths for the same problem at temperature >0. Aggregate answers by majority vote (for closed-form tasks) or normalized probability (for generation tasks). No additional model calls for voting — the aggregation is deterministic. Wang et al. 2022 (arxiv:2203.11171).

### Lift Numbers

| Benchmark | N=1 | N=10 | N=40 | Delta (1→40) |
|-----------|-----|------|------|--------------|
| GSM8K (math, GPT-3) | 46.9% | ~74% | ~78% | +31 pp |
| MATH competition | varies | +15–20 pp | diminishing | +15–20 pp |
| MMMU (InternVL2.5-8B) | 56.2% | ~58% | 60.6% (N=128) | +4.4 pp |
| MMMU (MiniCPM-V2.6) | 49.8% | ~51% | 53.2% (N=128) | +3.4 pp |

Sources: Wang et al. 2022; "Reevaluating Self-Consistency in Multi-Agent Systems" 2024 (arxiv:2511.00751); inference scaling laws ICLR 2025.

### Cost Multiplier

Exactly ×N, linear. N=10 → ×10× tokens. N=40 → ×40×. Cost is predictable and controllable. Efficient variants:
- Reasoning-Aware SC (RASC): reduces samples by ~88% with maintained accuracy
- CISC: 40–50% cost reduction
- Early-Stopping SC: up to 80% sample reduction
- Adaptive SC: uses Bayesian stopping criteria

### Does It Help Cheap/Weak Models?

**Yes — grade A, the most model-agnostic technique on this list.** Self-consistency works by turning sampling variance into signal: even a weak model that is right 40% of the time will produce a correct plurality in 10 samples most of the time (depending on error correlation). The key assumption — that independent sampling produces sufficiently diverse errors — holds broadly across model sizes. The lift is proportional to the model's baseline accuracy: if a model is right 20% of the time, majority vote across 10 still won't exceed ~50–60%. But in the 40–70% accuracy range (typical cheap-model hard-task performance), self-consistency gives substantial gains.

### Does the Lift Survive Hard Tasks?

**Partially — diminishing returns at the hard tail.** On tasks where the model is systematically wrong (not just randomly wrong), majority vote selects the wrong systematic answer. For FRAMES-class hard tasks where the cheap model scores ~0.42 baseline, self-consistency can push toward ~0.55–0.60 depending on N, before hitting the "model doesn't have the knowledge to generate a correct path" ceiling. For MMMU-class harder tasks, gains are real but small (+3–4 pp even at N=128).

The sweet spot: tasks in the 35–70% base accuracy range. Below 35%, the model is systematically wrong and voting cannot rescue it. Above 70%, the ceiling is tight.

### Failure Mode

Minority-mode correct answers: if the correct answer is an unusual reasoning path that the model takes rarely, majority vote will suppress it. This is particularly problematic for creative or underrepresented problem types. Also: cost scales linearly with N but gains are log-linear, so N beyond 20–40 rarely justifies cost.

### Verdict

**The most reliable, most model-agnostic lift technique. Use as a default baseline for all cheap-model ablations.** Very well-understood cost/benefit tradeoff. Combine with adaptive early-stopping (RASC/CISC) to reduce cost by ~50% without accuracy loss. This is the "floor" benchmark — any more complex scaffolding should beat it to justify its cost.

**Grade: A. The cheap reliable baseline. Use N=10–20 with early stopping.**

---

## 6. Self-Discover / Step-Back / Decomposition Prompting

**Mechanism**: Before solving, have the model select from a menu of "atomic reasoning modules" (critical thinking, step-by-step decomposition, analogical reasoning, etc.) and compose them into a task-specific reasoning structure. This structure then guides the actual solution generation. Critically, the reasoning structure selection happens *once* at task level and can be reused across problem instances. Zhou et al. 2024 (NeurIPS, arxiv:2402.03620).

Step-back prompting (Zheng et al. 2023): instead of answering directly, first ask "what is the general principle needed to solve this?" then use that principle in the answer.

### Lift Numbers

| Benchmark | Lift vs. CoT | Notes |
|-----------|-------------|-------|
| BigBench-Hard (BBH) | +32% vs CoT | GPT-4 + PaLM 2 |
| Grounded agent reasoning (T4D) | +32% | GPT-4 |
| MATH | substantial | specific numbers not reported |
| vs. CoT-Self-Consistency | +20% with 10–40× fewer inference calls | the key efficiency result |

Source: Self-Discover NeurIPS 2024 (arxiv:2402.03620); VentureBeat 2024 writeup.

### Cost Multiplier

**×1.5–3× total**, but the discovery phase is amortized across instances. Two-phase: (1) SELECT + ADAPT + IMPLEMENT the reasoning structure (1–2 calls); (2) USE the structure to solve the problem (1 call). If the discovered structure is reused across many similar problems, marginal cost approaches ×1×. Critically, Self-Discover claims 10–40× fewer inference calls than CoT-Self-Consistency for comparable accuracy.

### Does It Help Cheap/Weak Models?

**Uncertain — grade B.** The original paper reports strong results on GPT-4 and PaLM 2-L, with a cross-model transfer experiment showing structures discovered with GPT-4 transfer to Llama2 — but the transfer direction matters (strong→weak, not weak→weak). Effects on instance-level Self-Discover (arxiv:2507.03347, July 2025) found that structure formatting influences reasoning; a key open question is whether weaker models can reliably *select* appropriate reasoning modules (the selection step requires meta-reasoning about the task).

### Does the Lift Survive Hard Tasks?

**Yes for the right task types.** BBH is a genuine hard benchmark; +32% vs. CoT is substantial and represents contamination-resistant improvement. The technique is best for tasks with knowable structure: mathematical reasoning, causal chains, scientific reasoning. Weaker for tasks that are fundamentally knowledge-bounded (if the model lacks the knowledge, no reasoning structure will retrieve it).

### Verdict

**High-value, moderate-cost, strongest for structured hard reasoning.** The efficiency claim (+20% over SC with 10–40× fewer calls) is the key differentiator — if it holds at cheap-model scale, Self-Discover is the most cost-efficient structured reasoning upgrade available. The ablation: does the cheap model reliably execute the reasoning module selection step? If it follows the structure reliably, gains will transfer. If it ignores the structure or selects wrong modules, gains won't materialize.

**Grade: A for strong models on hard structured tasks; B for cheap models (selection quality uncertain).**

---

## 7. Verifier/Critic-Gated Loops — Generation-Verification Gap Exploitation

**Mechanism**: LLMs exhibit a well-documented asymmetry: they are more reliable at *judging* the correctness of a solution than *producing* one (generation-verification gap). This enables cheap-generate + verify-select patterns:
- **BoN with learned verifier**: generate N candidates, score each with a reward model / LM judge / rule-based critic, return the highest-scoring one.
- **Process Reward Models (PRMs)**: score each reasoning *step*, not just the final answer. Enables step-level search.
- **Weaver (2025)**: ensemble multiple weak, imperfect verifiers using statistical aggregation to build a strong composite verifier.

Sources: Generative Verifiers (arxiv:2408.15240); Weaver/Shrinking the Gen-Ver Gap (arxiv:2506.18203, Hazy Research blog 2025-06-18); Scoring Verifiers (arxiv:2502.13820).

### Lift Numbers

| Method | Task | Generator | Verifier | Score | Delta |
|--------|------|-----------|----------|-------|-------|
| Weaver BoN | MATH/code avg | Llama 3.3 70B Instruct | Ensemble 70B judges | 87.7% avg | matches o3-mini |
| Weaver | Gen-ver gap | 70B non-reasoning model | weak verifier ensemble | -14.5 pp gap reduction | — |
| Weaver compact verifier | full accuracy | 400M cross-encoder | trained from Weaver output | 98.7% of Weaver | 99.97% compute reduction |
| BoN with math verifier | GSM8K | GPT-3.5 N=10 | unit-test / execution | +15–25 pp | vs. N=1 |
| PRM-guided beam search | math reasoning | GPT-3.5 | PRM | +10–20 pp | vs. CoT |

Sources: Weaver arxiv:2506.18203; Generative Verifiers arxiv:2408.15240; various BoN studies 2024.

### Cost Multiplier

Generation: ×N (same as self-consistency). Verification: typically ×N additional calls (one verifier pass per candidate) unless using a compact/fast verifier. With a 400M compact verifier (Weaver result), verification adds near-zero marginal cost. For rule-based verifiers (code execution, unit tests), verification is also cheap. The win: generation can stay cheap (many samples from cheap model), verification can stay cheap (rule-based or compact verifier), and the combination beats expensive generation-from-strong-model.

### Does It Help Cheap/Weak Models?

**Yes — this is the technique most specifically designed for cheap generators.** The Weaver result is the headline: a 70B non-reasoning model (cheap generator) + weak verifier ensemble achieves o3-mini-level accuracy. The framework is explicitly designed around the premise that generation is cheap and noisy, and verification is a separable, more tractable problem. Key insight from generation-verification gap research: even a cheap model's verification is better than its generation, so using itself as a verifier (different from self-refine!) in a BoN scheme is valuable.

For code specifically: running the generated code against test cases is a zero-cost oracle verifier. This converts code generation into a pure search problem.

### Does the Lift Survive Hard Tasks?

**Yes, with caveats.** For math and code where ground truth is verifiable, BoN+verifier is the most robust lift technique available. The gain scales with N and with verifier quality. For tasks without a reliable verifier (open-ended reasoning, multi-hop factual Q&A), the gains depend on LM judge quality, which degrades on hard tasks. The key: the harder the task, the more important verifier quality becomes.

### Failure Mode

Verifier distribution shift: verifiers trained on one domain fail on another. LM judges can be gamed by confident-sounding wrong answers. Ensemble diversity matters — if all weak verifiers make the same systematic error (common failure mode), ensemble doesn't help. For open-ended tasks, "verifier" quality is fundamental.

### Verdict

**The single highest-ROI technique for cheap model code/math lift. Use BoN with a domain-appropriate verifier.** For code: execution against tests. For math: numeric checking. For factual/agentic: PRM or LM judge ensemble. This pattern achieves frontier-level accuracy on specific tasks using cheap generators + cheap verifiers. The Weaver pattern (weak verifier ensemble) is directly applicable to our pipeline without any training.

**Grade: A for verifiable tasks (code, math); B for open reasoning with LM judge.**

---

## 8. ADaPT — Recursive As-Needed Task Decomposition (Agentic)

**Mechanism**: Separate planner and executor modules. The executor attempts a task; if it fails, the planner decomposes it into sub-tasks with logical operators (AND/OR). Each sub-task is recursively assigned to ADaPT. This is adaptive — decomposition only happens when needed (failed execution), not upfront for all tasks. Prasad et al., NAACL Findings 2024 (arxiv:2311.05772).

### Lift Numbers

| Benchmark | Baseline (plan-only) | ADaPT | Delta |
|-----------|---------------------|-------|-------|
| ALFWorld | baseline | +28.3 pp | +28.3 pp |
| WebShop | baseline | +27 pp | +27 pp |
| TextCraft | baseline | +33 pp | +33 pp |

Sources: ADaPT paper (arxiv:2311.05772); Allen AI landing page.

### Cost Multiplier

×2–5× depending on recursion depth. Adaptive triggering means simple tasks add minimal overhead (just one failed attempt before decomposition is triggered). Complex tasks may recurse 2–3 levels deep. Total cost is proportional to problem complexity, not uniformly high.

### Does It Help Cheap/Weak Models?

**Specifically designed for this scenario.** ADaPT's premise is that weaker executors fail more often — the decomposition is triggered by failure, making it a natural fit for weak-model + hard-task combinations. The planner can be a stronger model while the executor is cheap, enabling model tiering. Alternatively, a single cheap model serves both roles; the recursive decomposition compensates for its limited single-step horizon.

### Does the Lift Survive Hard Tasks?

**Best on long-horizon agentic tasks.** ALFWorld, WebShop, TextCraft are all multi-step agentic tasks that require combining many steps. The 28–33 pp gains are consistent and substantial. The technique targets the specific failure mode of "long horizon with a fallible executor" — which is exactly the scenario where cheap models struggle most. On pure reasoning tasks (math, QA), the gain is less clear because there is no "sub-task executor" to recurse into.

### Failure Mode

Decomposition quality bounded by planner quality. If the planner is also weak, it may produce incorrect sub-task decompositions that route the executor into dead ends. Also: AND sub-tasks create multiplicative failure rates (both must succeed); OR sub-tasks are safer.

### Verdict

**High-value for multi-step agentic tasks. The correct architecture for cheap-model agentic scaffolding.** Directly addresses the "cheap model cannot reliably complete long tasks in one shot" problem without requiring a stronger model. Combine with Plan-and-Solve (for initial plan quality) and verifier-gated selection (for sub-task execution quality) for maximum benefit.

**Grade: A for long-horizon agentic tasks; B for pure reasoning tasks.**

---

## Cross-Cutting Finding: The Overthinking / Turn-Budget Cliff

Independent research streams (2024–2025) converge on a critical failure mode for all iterative scaffolding techniques:

**Finding (Grade A)**: In multi-step reasoning chains, errors compound exponentially. If each reasoning step has 90% accuracy, a 5-step chain has only 59% end-to-end success probability. Past an optimal reasoning length, accuracy *decreases* — accuracy plateaus and then declines as reasoning length exceeds a certain threshold. LRMs exhibit "overthinking" where extended CoT chains introduce unnecessary steps and compounding errors.

**The agentic danger (Grade A, arxiv:2502.08235)**: In agentic tasks, excessive internal reasoning before acting creates a "Reasoning-Action Dilemma" — the model reasons about hypotheticals instead of observing the environment, causing it to drift from ground truth.

**Implication for cheap models**: Cheap models have shorter reliable reasoning horizons. They benefit from techniques that expand capability (decomposition, planning) but are harmed by open-ended loops (self-refine cycles without convergence, Reflexion without good oracle feedback, deep ToT trees). The turn-budget cliff is steeper for cheap models.

**Practical rule**: Cap any iterative loop at 3–5 iterations maximum. Prefer shallow, structured expansion (Plan-and-Solve, one-shot ADaPT decomposition) over deep iterative loops (Reflexion N=10, Self-Refine N=7). Monitor per-step error signal rather than running fixed budgets.

---

## Summary Table

| Technique | Evidence Grade | Lift on Hard Tasks | Cheap-Model Lift | Cost Multiplier | Backfires on Weak? |
|-----------|---------------|-------------------|-----------------|-----------------|-------------------|
| **Reflexion** | B | Moderate (+11–22 pp, AlfWorld) | Unreliable (12% of runs helpful) | ×3–5× | Yes — error entrenchment |
| **Plan-and-Solve** | A | Good (+5–32 pp, structured) | Yes — directly attacks weak-model skip errors | ×1.5–2× | Rarely |
| **Self-Refine** | B | Weak on hard reasoning (+2–5 pp) | Weak unguided; strong if oracle provided | ×3–6× per round | Yes — error polishing |
| **ToT / LATS / GoT** | A (strong models) | Yes, structured search (+71 pp G24) | No — GPT-3.5 gets +19 pp, GPT-4 gets +71 pp | ×10–100× | Yes — bad evaluation |
| **Self-Consistency** | A | Moderate (+10–30 pp, diminishes) | Yes — most model-agnostic | ×N (linear) | No |
| **Self-Discover** | A (strong); B (cheap) | Good (+32 pp BBH, 10–40× cheaper vs. SC) | Uncertain — selection step needs meta-reasoning | ×1.5–3× (amortized) | Rarely |
| **Verifier-Gated BoN** | A (verifiable tasks) | Yes, best for code/math | Yes — explicitly cheap-generator-friendly | ×N gen + ×small verify | No |
| **ADaPT Decomposition** | A (agentic) | Yes (+28–33 pp agentic) | Yes — designed for weak executors | ×2–5× (adaptive) | Rarely |

---

## Prioritized Shortlist for Cheap-Model Intelligence Lift Per Dollar

### Rank 1: Verifier-Gated Best-of-N (with rule-based or compact verifier)

**Why**: Directly exploits the generation-verification gap. Cheap generator + cheap verifier can match frontier accuracy on verifiable tasks. The Weaver result (2025) is the headline: 70B non-reasoning model + weak verifier ensemble = o3-mini accuracy. For code, test execution is a free oracle verifier. Gain is large, cost is controllable (N is a tunable parameter), and it does not require the cheap model to self-evaluate (which is unreliable).

**Ablation design**:
- Baseline: cheap model, N=1, greedy decode, ReAct
- A1: cheap model, N=5, majority vote (Self-Consistency baseline)
- A2: cheap model, N=5, execution-based verifier select (BoN oracle)
- A3: cheap model, N=5, LM judge verifier select (BoN learned)
- A4: cheap model, N=10, compact verifier (Weaver-style ensemble)
- Measure: pass@1 on FRAMES subset, HumanEval, and a held-out agentic task set
- Key metric: lift-per-dollar vs. escalating to frontier model

**Expected lift**: +15–30 pp on code/math verifiable tasks vs. N=1 baseline. Verify the hypothesis that cheap-generate + verify-select beats expensive single-generation.

---

### Rank 2: Plan-and-Solve (combined with ADaPT recursion for agentic tasks)

**Why**: Lowest cost-multiplier of any structured technique (×1.5–2×). Directly addresses the primary failure mode of cheap models on structured reasoning: missing-step errors and step skipping. For agentic multi-step tasks, extending with ADaPT's adaptive recursion converts single-step failure into recoverable multi-step execution without pre-committing to a full plan.

**Ablation design**:
- Baseline: cheap model, ReAct loop, no explicit planning
- P1: cheap model, explicit "plan first" prefix before each major action (Plan-and-Solve prompt)
- P2: cheap model, P1 + ADaPT recursion on sub-task failure (planner decomposes failed sub-tasks)
- P3: P2 + verifier-gated selection (Rank 1 technique) applied per sub-task
- Measure: FRAMES score, ALFWorld-class agentic success rate, turn count
- Key metric: task completion rate improvement per additional token spent

**Expected lift**: +10–20 pp on structured/agentic tasks at ×2× cost. Compound effect with Rank 1 verifier is the target.

---

### Rank 3: Self-Consistency with Early-Stopping (adaptive N)

**Why**: The most model-agnostic, most well-understood, most predictable lift. Use as the baseline comparator for all other experiments. The adaptive SC variants (RASC, CISC) give 40–88% sample cost reduction while matching fixed-N accuracy, making this practical. On the cheap-model hard-task regime (~0.42 FRAMES baseline), N=10–20 with majority vote is expected to push toward 0.52–0.58.

**Ablation design**:
- SC-1: cheap model, N=5, temperature=0.7, majority vote
- SC-2: cheap model, N=10, majority vote
- SC-3: cheap model, N=20, majority vote
- SC-4: cheap model, adaptive N with CISC early-stopping (target: half cost of SC-10)
- SC-5: cheap model, SC-4 + Plan-and-Solve prefix (verify compound effect)
- Measure: FRAMES score vs. token spend. Plot accuracy curve as function of cumulative token cost.

**Expected lift**: +8–18 pp from N=1→N=10, with diminishing returns past N=20.

---

## The Single Best Experiment

**Verifier-Gated BoN vs. Self-Consistency vs. Plan-and-Solve, controlled per dollar:**

Run a three-way ablation on a cheap model (DeepSeek-V4-Pro or equivalent) on two task types:
1. Code/math tasks with execution oracle (true oracle verifier)
2. Multi-hop reasoning (FRAMES subset, no oracle — LM judge verifier)

Normalize all conditions to the same *dollar spend* (not same N). At ×10× the cost of a single-pass baseline:
- How much does Self-Consistency (N=10) buy?
- How much does BoN-with-oracle (N=10) buy?
- How much does Plan-and-Solve (single call, ×1.5×) buy?
- How much does combining all three buy?

**Hypothesis** (prior backed by literature): BoN-oracle > SC > Plan-and-Solve alone on verifiable tasks. On open reasoning: SC ≈ BoN-LM-judge > Plan-and-Solve alone. The compound (Plan-and-Solve prefix + BoN oracle) should exceed any single technique. If so, the architecture for cheap-model intelligence lift is: structured planning input → diverse generation (N=5–10) → verifier-gated output selection.

This experiment directly tests whether cheap-model intelligent scaffolding can match or approach frontier single-pass results, which is the core hypothesis for ADR-200-class decisions.

---

## References

All numbered per evidence-grading above:

1. Shinn et al. 2023, "Reflexion: Language Agents with Verbal Reinforcement Learning" (NeurIPS 2023) — https://github.com/noahshinn/reflexion
2. Self-Reflection in LLM Agents 2024 — https://arxiv.org/pdf/2405.06682
3. Wang et al. 2023, "Plan-and-Solve Prompting" (ACL 2023) — https://arxiv.org/abs/2305.04091
4. Madaan et al. 2023, Self-Refine — https://systems-analysis.ru/eng/Self-Refine_Prompting
5. CoRefine 2025 — https://arxiv.org/pdf/2602.08948
6. Yao et al. 2023, "Tree of Thoughts" (NeurIPS 2023) — https://proceedings.neurips.cc/paper_files/paper/2023/file/271db9922b8d1f4dd7aaef84ed5ac703-Paper-Conference.pdf
7. Zhou et al. 2023 / 2024, "Language Agent Tree Search" (ICML 2024) — https://arxiv.org/abs/2310.04406
8. Besta et al. 2023, "Graph of Thoughts" — https://arxiv.org/abs/2308.09687
9. "Understanding When Tree of Thoughts Succeeds" 2024 — https://arxiv.org/pdf/2410.17820
10. Wang et al. 2022, "Self-Consistency Improves CoT" — https://arxiv.org/pdf/2203.11171
11. "Reevaluating Self-Consistency in Multi-Agent Systems" 2024 — https://arxiv.org/pdf/2511.00751
12. Inference Scaling Laws (ICLR 2025) — https://proceedings.iclr.cc/paper_files/paper/2025/file/8c3caae2f725c8e2a55ecd600563d172-Paper-Conference.pdf
13. Zhou et al. 2024, "Self-Discover" (NeurIPS 2024) — https://arxiv.org/abs/2402.03620
14. Self-Discover NeurIPS proceedings — https://proceedings.neurips.cc/paper_files/paper/2024/file/e41efb03e20ca3c231940a3c6917ef6f-Paper-Conference.pdf
15. Weaver / "Shrinking the Generation-Verification Gap with Weak Verifiers" — https://arxiv.org/pdf/2506.18203 / https://hazyresearch.stanford.edu/blog/2025-06-18-weaver
16. Generative Verifiers (arxiv:2408.15240) — https://arxiv.org/html/2408.15240v1
17. Scoring Verifiers 2025 — https://arxiv.org/html/2502.13820v3
18. Prasad et al. 2023/2024, "ADaPT" (NAACL Findings 2024) — https://arxiv.org/abs/2311.05772
19. "The Danger of Overthinking" 2025 — https://arxiv.org/pdf/2502.08235
20. "Stop Overthinking" survey 2025 — https://arxiv.org/pdf/2503.16419
21. "Reasoning on a Budget" survey 2025 — https://arxiv.org/html/2507.02076v1
22. "Scaling Test-time Compute for LLM Agents" 2025 — https://arxiv.org/html/2506.12928v1
23. "Illusions of reflection" 2024 — https://arxiv.org/html/2510.18254v1

---

*Generated: 2026-06-28. Evidence from papers through June 2026.*
