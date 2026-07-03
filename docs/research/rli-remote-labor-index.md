# Research: Remote Labor Index (RLI) — the closest external oracle for economic-work capability

- **Date**: 2026-07-02
- **Author**: research pass for ADR-229 (RLI as economic-work capability oracle for tier placement)
- **Primary sources**:
  - Paper: Scale AI / CAIS, *"Remote Labor Index: Measuring AI Automation of Remote Work"*, [arXiv:2510.26787](https://arxiv.org/abs/2510.26787) ([PDF](https://arxiv.org/pdf/2510.26787), [HTML](https://arxiv.org/html/2510.26787v1))
  - Live leaderboard: [labs.scale.com/leaderboard/rli](https://labs.scale.com/leaderboard/rli)
  - Project site: [remotelabor.ai](https://remotelabor.ai) · Blog: [scale.com/blog/rli](https://scale.com/blog/rli) · [scale.com/research/rli](https://scale.com/research/rli)
  - Sibling boards: [Scale Coding leaderboard](https://labs.scale.com/leaderboard/coding) · [Scale MCP Atlas](https://labs.scale.com/leaderboard/mcp_atlas)
  - Independent tracker: [Epoch AI — RLI](https://epoch.ai/benchmarks/rli)

> **Why this doc exists.** RLI is the closest external benchmark we have found to the thing our business-vertical roadmap is actually trying to sell: an AI completing a *whole* unit of remote, economically-valuable work to a standard a paying client would accept. It is the natural external oracle for the BenchPress tier-placement layer (ADR-206) and the north-star validation signal for the harnessaas Business Process Learning Harness (harnessaas ADR-0024). This doc summarizes what RLI measures, how, what it found, and — critically — how it maps to *our* system. Every external claim is linked.

---

## 1. What RLI measures

RLI evaluates **end-to-end completion of real freelance projects**, not isolated skills. Each task is a real job that a human freelancer was actually paid to do on Upwork, with a real deliverable (a rendered video, a CAD file, a legal contract, a data-analysis report, a 3D model, a branded logo set, a working web app). The AI agent is given the client brief plus provided assets and must produce the full deliverable; a panel of expert human judges then decides whether the output meets the bar.

**Metric — Automation Rate.** *"The percentage of projects where an AI's deliverable is judged at least as good as the human standard"* — operationally, whether *"a reasonable client would accept it"* as commissioned work ([leaderboard](https://labs.scale.com/leaderboard/rli)). This is a binary accept/reject per project, judged against the delivered human work product, then averaged across the set. It is deliberately **not** a partial-credit or unit-test-pass metric — the deliverable either clears the professional bar or it does not.

**Secondary metric — pairwise Elo.** Beyond the binary accept/reject, judges also make head-to-head quality comparisons between agents' deliverables, yielding an Elo ranking. The distinction matters: Automation Rate answers *"would this be accepted as paid work?"* (an absolute economic bar); Elo answers *"which agent's output is relatively better?"* (a ranking that moves even when both outputs are below the acceptance bar). A model can win on Elo while still automating almost nothing — relative quality improving faster than absolute acceptance is exactly the regime today's frontier sits in.

### Dataset & methodology
- **240 real projects** — **230 private/held-out** + **10 public** ([leaderboard](https://labs.scale.com/leaderboard/rli), [remotelabor.ai](https://remotelabor.ai)). The private split makes RLI **contamination-resistant**: the test items are not on the public web to be trained on.
- **23 Upwork domains** (see §4), spanning documents, code, audio, video, 3D/CAD, and multimodal deliverables.
- **Economic grounding** — total value **$143,991**; **median $200 / mean $632.60** per project; **median 11.5 h / mean 28.9 h** of human time; **~6,000+ hours** of real work in aggregate, with the largest projects **>$10,000 and >100 hours** ([remotelabor.ai](https://remotelabor.ai)). All costs and completion times come directly from the human professionals who did the work.
- **Judging** — expert manual review, **3 independent annotators**, **94.4% inter-annotator agreement** ([leaderboard](https://labs.scale.com/leaderboard/rli)).
- **Generation budget** — **max $30 per task** (a hard cap on how much inference/tooling an agent may spend attempting each project).

---

## 2. The ranking (two snapshots — the ceiling is moving)

RLI has **two materially different published numbers**, and honest use requires citing both:

**(a) Paper snapshot — Oct 2025 (arXiv:2510.26787).** At publication the top agent was **Manus at 2.5%**, with Grok 4, Sonnet 4.5, GPT-5, ChatGPT agent, and Gemini 2.5 Pro all in the **0.8%–2.1%** band. The paper's headline framing: *"AI agents perform near the floor on RLI, with the highest-performing agent achieving an automation rate of 2.5%."*

**(b) Live leaderboard — current (July 2026, [labs.scale.com/leaderboard/rli](https://labs.scale.com/leaderboard/rli)):**

| Rank | Model / Agent | Automation Rate |
|---:|---|---:|
| 1 | **Fable-5** | **16.10%** |
| 2 | Opus 4.8 | 8.33% |
| 3 | Codex GPT-5.5 | 6.25% |
| 4 | claude-opus-4-6 (CoWork) | 4.17% |
| 5 | claude-opus-4-5-thinking | 3.75% |
| 6 | Manus 1.6 (Max) | 2.92% |
| 7 | gpt-5.2 (medium) | 2.50% |
| 7 | Manus 1.5 / Manus 1.0 | 2.50% |
| 10 | Claude Sonnet 4.5 | 2.08% |
| 10 | gpt-5.2 (default) | 2.08% |
| 11 | gpt-5 | 1.67% |
| 12 | ChatGPT agent / gemini-3-pro-preview | 1.25% |
| 14 | gemini-2.5-pro-preview | 0.83% |

**Reading the two together.** In ~9 months the frontier moved from **2.5% → 16.10%** (~6× on the top line), but the *shape* is unchanged: a steep drop-off after #1, most contenders under 3%, and the very best still completing only **~1 in 6** real projects. The ceiling is rising but remains far below "AI does remote knowledge work."

**Key structural facts for us:**
- **Fable-5 (16.10%) is ~2× Opus-4.8 (8.33%)** and ~2.6× Codex GPT-5.5 — Fable is, by this external and contamination-resistant measure, the **economic-work frontier**, and by a wide margin.
- **Opus-4.8 is a clear #2** — the natural failover for high-value work when Fable is unavailable or over-budget.
- **Sonnet-4.5 (2.08%)** sits with the gpt-5.2 / gpt-5 pack — a mid capability point on *whole-project* economic work, well below the two leaders.

---

## 3. Failure-mode taxonomy — *where* agents fail

The paper categorizes why deliverables get rejected (categories overlap; one deliverable can trip several) ([arXiv:2510.26787](https://arxiv.org/html/2510.26787v1), corroborated by [Scale blog](https://scale.com/blog/rli)):

| Failure mode | Share of failures | What it looks like |
|---|---:|---|
| **Poor quality** | **45.6%** | "Child-like" / amateur output — images, code, 3D models below professional standard even when "complete." |
| **Incomplete deliverables** | **35.7%** | Missing pieces of the requested scope; partial work presented as finished. |
| **Corrupted / file-integrity errors** | **17.6%** | Files that won't open, wrong formats, broken exports — the deliverable is unusable regardless of content. |
| **Inconsistencies** | **14.8%** | Multimodal mismatches — e.g., audio not matching video, spec not matching artifact. |

**The load-bearing insight for our roadmap:** the dominant failure is not "the agent gave up" — it is **"poor quality" (45.6%)** and **"incomplete" (35.7%)**. Agents routinely *produce something* that is coherent but below the professional acceptance bar, or that covers only part of the scope. This is exactly the regime where (a) a self-judged reward signal is dangerous (the agent thinks it's done), and (b) **task decomposition + human-acceptance checkpoints** are the mitigation, not "a bigger model." File-integrity failures (17.6%) are additionally a *pure harness/tooling* problem — deterministic export/validation guards, not model capability.

---

## 4. The 23 domains

Video & Animation · 3D Modeling & CAD · Graphic & Editorial Design · Audio & Music Production · Building & Landscape Architecture · Product Design · NFT, AR/VR & Game Art · Art & Illustration · Interior & Trade Show Design · Web Development · Branding & Logo Design · Game Design & Development · Management Consulting & Analysis · Data Entry & Transcription · Data Analysis & Testing · Language Tutoring & Interpretation · Data Extraction / ETL · Presentation Design · Web & Mobile Design · Corporate & Contract Law · Translation & Localization · Market Research & Product Reviews ([arXiv:2510.26787](https://arxiv.org/html/2510.26787v1)).

Two observations that map onto our vertical roadmap:
- Most domains are **heavy-deliverable, multimodal, multi-hour** (video, 3D/CAD, architecture, game dev) — not decomposable into a single cheap-executor call.
- A minority are **text/data-centric and more decomposable**: Data Entry & Transcription, Data Extraction/ETL, Translation & Localization, Market Research, Presentation Design, and parts of Data Analysis & Testing. These are where governed cheap automation of *sub-tasks* is plausible today.

---

## 5. Sibling Scale boards — where OUR models actually rank

RLI is a whole-project economic bar. Two adjacent Scale boards ground the *tier-level* capability of the specific models we route to.

### 5a. MCP Atlas (agentic tool-use) — April 2026, Pass Rate on 1,000 tasks (500 public + 500 private) ([mcp_atlas](https://labs.scale.com/leaderboard/mcp_atlas))

| Rank | Model | Pass Rate |
|---:|---|---:|
| 1 | gemini-3.5-flash (high) | 83.60% |
| 1 | **Claude Fable 5** | **83.30%** |
| 1 | **claude-opus-4-8 (max)** | **82.20%** |
| 1 | Muse Spark | 82.20% |
| 7 | **glm-5p1** | **75.60%** |
| 7 | gpt-5.5 (xhigh) | 75.30% |
| 13 | claude-sonnet-4-6 | 69.50% |
| 15 | **kimi-k2p5** | **64.40%** |
| 19 | **glm-4p7** | **58.10%** |
| 25 | claude-haiku-4-5 | 40.20% |

**This is the single most important external corroboration for our cheap tier.** On agentic tool-use (the substrate our decomposed sub-tasks actually run on), **GLM-5.1 hits 75.6% — rank 7, within ~7 points of Fable-5/Opus-4.8 and ahead of GPT-5.5**. Kimi-K2.5 reaches 64.4%. This independently confirms the "cheap CN models ≈ frontier on everyday agentic tool-use" finding in our own cheap-vs-frontier research: for *bounded, tool-shaped* sub-tasks, the cheap tier is genuinely close to frontier. (DeepSeek is not listed on MCP Atlas; our own gold data places deepseek-v4-pro below GLM-5.2 on the darwin loop.)

### 5b. Coding leaderboard — **stale snapshot, use with care** ([coding](https://labs.scale.com/leaderboard/coding))
Scale's public Coding board (1,000 prompts, Elo-style) is a **2024–2025-era snapshot**: o1-mini (1237) tops it, with DeepSeek R1 (1100) and DeepSeek V3 (985) mid-pack and no Fable/Opus-4.8/GLM-5.x entries at all. It predates every model we currently route to and should **not** be used for present-day placement — it is included only to note that Scale's *coding* board is not a live signal, whereas RLI and MCP Atlas are.

**Net:** the two live boards give a coherent, externally-sourced 2-D picture that matches our internal gold data — **Fable ≈ Opus-4.8 at the top; GLM-5.1/Kimi close behind on bounded agentic work; a steep cliff on whole-project economic work (RLI) that only Fable meaningfully climbs.**

---

## 6. How RLI maps to OUR system

| RLI concept | Our system | Mapping |
|---|---|---|
| Automation Rate (whole-project accept/reject) | harnessaas ADR-0024 **Business Process Learning Harness** — "can we deliver a client-acceptable business outcome?" | RLI *is* the external analog of the ADR-0024 success metric. Its acceptance bar is the model for ADR-0024's heuristic verifier. |
| "A reasonable client would accept it" | ADR-0024 heuristic/fuzzy verifier | RLI's human-acceptance standard is the **north-star** the verifier should approximate — not self-judged reward. |
| Fable-5 = economic-work frontier (~2× Opus) | ADR-206 BenchPress tier placement | External, contamination-resistant confirmation that **Fable is the Sage/high-value tier**; Opus-4.8 failover; Sonnet mid. A free eval column we didn't have to run. |
| 23 multi-hour multimodal domains | ADR-0024 vertical roadmap | Defines **where decomposition + human checkpoints belong**: most domains are not single cheap-executor tasks. |
| Failure modes (45.6% poor quality, 35.7% incomplete, 17.6% corrupt) | Our escalation + verifier + tooling design | Poor-quality/incomplete ⇒ decomposition + human-acceptance gates; corrupt-file ⇒ deterministic export/validation guards in the harness. |
| 16% ceiling even at the frontier | Whole roadmap expectation-setting | Even the best agent completes ~1 in 6 real projects. Our cheap-tier learning loop sits **far** below this. Product value = governed, measured, learning-over-time automation of *decomposable sub-tasks* with frontier escalation + human approval — **not** RLI-class autonomous project completion. |

**Placement in the BenchPress frame (ADR-206).** RLI is exactly the kind of *external, gold-quality, contamination-resistant eval column* BenchPress's "you don't need to run every eval" thesis wants: it gives us a frontier-vs-frontier economic-capability ranking **for free** (Scale ran it; we cite it), instead of spending $60–125/model to discover the same ordering ourselves. It is a high-signal column to import into the score matrix — with the caveat that it only covers frontier agents, so it constrains the *top* of the tier ladder, not the cheap tier (which MCP Atlas covers).

---

## 7. Limitations (cite honestly)

- **Small N per domain.** 240 projects across 23 domains ≈ ~10 tasks/domain; per-domain automation rates are noisy and should not be over-read (a swing of 1–2 tasks moves a domain rate by 10–20 points).
- **Expert-judgment subjectivity.** Despite 94.4% inter-annotator agreement, the accept/reject bar is a human quality call, not a deterministic test. It is the *right* bar for economic work, but it is not reproducible the way a unit test is.
- **$30 budget cap.** The per-task budget bounds how hard an agent may try; a higher cap could raise scores. Our own escalation economics differ, so absolute RLI numbers don't transfer to our cost model — only the *ordering* and the *ceiling* do.
- **Snapshot in time.** The 2.5%→16% shift in ~9 months shows the numbers move fast. Any tier decision keyed to RLI must be re-checked against the live leaderboard, not this doc's frozen table.
- **Frontier-only coverage.** RLI's board is frontier agents; it says nothing directly about GLM/Kimi/DeepSeek. Cheap-tier placement must lean on MCP Atlas + our own gold data, not RLI.

---

## 8. One-paragraph takeaway

RLI is the best external proxy we have for "AI does a whole unit of paid remote work to a client-acceptable standard," and it is contamination-resistant (230/240 held out) and human-judged against real deliverables. Its **primary value to us is generative**: RLI's task shape + acceptance standard + domain taxonomy are the template for the internal north-star eval our business-vertical loop optimizes against — this feeds the HarnessaaS **RLI-Mini** pipeline (RLI-style tasks → workflow genomes → deliverable verifier packs → optimize *cost-per-accepted-deliverable*). **Secondarily**, it confirms for free that **Fable-5 is the economic-work frontier at ~2× Opus-4.8** (a tier-calibration signal), and its sibling MCP Atlas board confirms that **our cheap tier (GLM-5.1 at 75.6%) is genuinely close to frontier on bounded agentic tool-use**. But the headline number is a discipline check: **even the frontier completes only ~16% of real projects**, and the dominant failure is confidently-produced-but-below-bar work. That is the empirical case for our actual product shape — governed, measured, continuously-learning cheap automation of *decomposable* sub-tasks, with frontier escalation and human-acceptance checkpoints — and against any claim of RLI-class autonomous completion. ADR-229 turns this into concrete target-generation, tier, and vertical-scoping decisions.
