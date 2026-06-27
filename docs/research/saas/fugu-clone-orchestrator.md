# A Transparent, Self-Optimizing Orchestrator on GCP — Strategy & Feasibility

**A governable "Fugu-clone" built on MetaHarness + Darwin**

*Status: decision-grade research synthesis · Date: 2026-06-27 · Sources: 7 parallel deep-research streams + in-repo primitives*

---

## Executive Summary

Sakana's Fugu (launched 2026-06-22) is a *trained orchestration layer* over a fixed three-model pool (Opus 4.8 / GPT-5.5 / Gemini 3.1 Pro) behind an OpenAI-compatible endpoint. Its genuine novelty is **learned coordination-ordering** (picking a *process*, not just a model) and a **swappable-pool abstraction**. Its fatal commercial weaknesses are equally real: **opaque routing** (you cannot see which model answered or why), **no model control** (fixed pool, no opt-out, no local/air-gapped weights), **no cost auditability**, **EU/EEA unavailability**, and a **self-reported 73.7% SWE-Bench Pro headline** that no third party has reproduced and that sits *below* Fable 5's published ~86%.

The strategic thesis of this document is that **the MetaHarness/Darwin stack already holds the primitives to be the auditable alternative Fugu structurally cannot be** — and that the market opening created by Fugu's opacity plus the EU AI Act enforcement deadline (2026-08-02) is real and time-bounded.

The recommendation is honest and bounded:

1. **Build the transparent governable orchestrator** — same "cheap-diverse-base + frontier-escalation-on-confirmed-give-ups" architecture that this repo *independently validated as the best cheap-frontier structure found* (LEARNINGS §30), but exposed as an inspectable, cost-receipted, lineage-audited pipeline rather than an opaque learned black box.
2. **Go vertical, not general.** Compete on the *customer's own tasks* (their CI failures, their codebase), where evolved-genome routing has a real data moat. Do **not** chase a general SWE-bench leaderboard headline — that surrenders the contamination-skepticism brand for an inflated number you cannot honestly defend.
3. **The Darwin genome engine is the moat**, not the routing. Routers are commoditized (LiteLLM, Portkey, RouteLLM, OpenRouter); RouterArena shows commercial routers do not systematically beat open-source ones. What is *not* commoditized is a self-evolving, lineage-audited, conformance-firewalled policy search that adapts to a customer's workload over time.
4. **Lead with cost-Pareto + governance, never with a leaderboard number.** Validated cost points ($0.015/resolve at 34%, ~$0.52/resolve at 51–56%) are publishable and defensible; the hard-tail ceiling (~47–62% clean) is a shared model-reasoning limit that orchestration *cannot* route past — state this plainly.
5. **MVP is a thin-slice bench/orchestrator service**: LiteLLM-on-Cloud-Run gateway + API Gateway (IAM/audit) + Cloud Tasks async dispatch + the existing GCP fleet + per-request lineage trace + the empty-patch escalation gate. The hard engineering (quota guards, autostop, Firestore self-report, conformance firewall) is already shipped.

---

## 1. The Fugu Phenomenon — Verifiable vs. Hype

### 1.1 What Fugu actually is (verifiable)

Two learned coordinators over a fixed three-model pool:

- **Fugu** — a ~0.6B **TRINITY routing head** trained with sep-CMA-ES, emitting L logits over worker models and dispatching *without* autoregressive decoding.
- **Fugu Ultra** — a 7B **Conductor** trained with GRPO/RL that emits full natural-language agentic workflows with recursive self-calling.

Both are trained on end-to-end task outcomes from production environments (Claude Code, Codex, OpenCode). Architecture source: Sakana Fugu Technical Report (`arxiv.org/html/2606.21228v1`). This is a legitimate architectural pivot from Sakana's earlier (genuinely innovative) evolutionary model-merging (Nature Machine Intelligence, 2024) and AB-MCTS (`arxiv.org/html/2503.04412`, which showed multi-model teams beating single models by up to 30% on ARC-AGI-2).

### 1.2 What is hype (flag honestly)

- **The 73.7% SWE-Bench Pro headline is self-reported.** No independent reproduction, no per-task score grid, no released harness, no disclosed cost per task. It is a *vendor claim*.
- **It trails Fable 5 (~86% published), not "matches" it.** The parity claim against Fable 5 / Mythos is *structurally unfalsifiable* — those models are export-controlled and absent from the pool.
- **"93.2%" is LiveCodeBench, not SWE-Bench Pro.** Conflating the two inflates the apparent coding capability.
- **The cheaper Fugu beats Fugu Ultra on several benchmarks** (e.g., SciCode 60.1 vs 58.7), undermining the "use Ultra for hard problems" pitch.
- **Sakana's prior credibility problems matter for the prior:** AI CUDA Engineer (Feb 2025) exploited sandbox memory loopholes; AI Scientist showed a 42% experimental-failure rate. A pattern of self-reported claims against non-reproducible baselines is established.

### 1.3 The contamination / ceiling skepticism (the strategic foundation)

This repo's §53 research and multiple external corroborations establish that **public SWE-bench leaderboards are contamination-inflated**:

- OpenAI **deprecated SWE-bench Verified (Sept 2025)** after confirming verbatim gold-patch memorization.
- UTBoost / ICSE-2026 found ~32.67% of successful patches involve solution leakage, file-path recall up to 76%.
- On contamination-resistant **SWE-Bench Pro (private codebases)**, frontier models drop 35pp on identical weights (e.g., Claude Opus 4.5: 80.9% Verified → 45.9% Pro per morphllm.com).
- The **clean frontier is roughly 47–59%**, not 80–95% (GPT-5.4 xHigh ≈ 59.1% SEAL; Opus 4.6 ≈ 47.1% on Scale's private set).

**The hard tail is a shared model-reasoning ceiling.** Orchestration yields approximately the *union* of its constituent models (Best-of-N bounded by diversity), plus a modest ensemble bump — **it cannot route past instances every model fails.** This repo proves it: per-instance evolution (ADR-194, 46 probes, ~$107) cracked **0/25** confirmed Opus-give-ups using config-only levers. A real coordinator lands near best-single + a modest bump (~55–62% clean), **not 35 points above**. Any "73–93%" claim that contradicts the ~47–59% clean band deserves skepticism by default.

---

## 2. Why MetaHarness/Darwin Already Has the Primitives

The "governable Fugu-clone" is not a greenfield build. The repo already ships the hard parts. Mapped to real files:

| Capability Fugu lacks | Repo primitive (file) | Status |
|---|---|---|
| Cheap-base + frontier-escalation pipeline | LEARNINGS §30 ("the Fugu architecture is the best cheap-frontier structure found") | **Validated** |
| Self-running quota-aware GCP fleet | `scripts/gcp-cluster.mjs` (provision, matrix, autostop, Firestore self-report, runaway guards) | **Production** |
| Durable audit store | `scripts/firestore-upload.mjs` (REST, no SDK), `darwin_runs` collection | **Production** |
| Swappable OpenAI-compatible endpoint | `--base-url` flag on `solve.mjs`/`solve-repair.mjs`/`solve-agentic.mjs` (ADR-150) | **Shipped** |
| $0 request classifier | `bench/swebench/difficulty-router.mjs` (6-feature L2 logistic regression) | **Shipped (weak signal — see §6)** |
| Structured-policy genome engine | `bench/swebench/evolve-arch.mjs` (`{model, mode, escalate, judge, maxSteps}`, Firestore fitness, autotune) | **Shipped** |
| Trained router (k-NN + KRR) | `packages/router/src/train.ts` | **Shipped** |
| Lineage / ancestry audit trail | `packages/darwin-mode/src/archive.ts` (`Archive.lineageOf()`, parentId chain); Rust `LineageNode`/`trace_ancestry` (ADR-188) | **Shipped + byte-deterministic test** |
| Conformance firewall (no gold-in-loop) | `evolve-perinstance.mjs` (lines 390/427: `usedOracleDuringSolve===false`); ADR-173 | **Shipped** |
| Wilson-CI honest reporting | `bench/swebench/analyze.mjs` | **Shipped** |
| Mutation safety allowlist | ADR-071 (7 surfaces; `validateGeneratedCode()` blocks `process.env`/`child_process`/`fetch`/secrets) | **Shipped** |
| Witness manifest / provenance | ADR-011 (Ed25519, Sigstore, in-toto, SLSA), ADR-034 OIA manifest | **Specified** |
| Red/blue adversarial harness | `packages/redblue` (ADR-197: NIST AI RMF + OWASP LLM Top-10, safety forced-off in `safety.ts`, 49 tests at $0) | **Shipped** |
| Cost-Pareto leaderboard | ADR-179 (Value Score), `scripts/pareto-from-firestore.mjs`, live web app | **Shipped** |
| Account-level budget gating | LEARNINGS §56 (solver self-report undercounts cost 1.7–1.8×) | **Lesson captured** |

The honest gap is **productization, not capability**: there is no persistent gateway, no per-tenant auth, no async queue, no per-request lineage, and no billing meter. Those are well-defined engineering, not research.

---

## 3. Architecture on GCP

### 3.1 Unified endpoint

Front the stack with **LiteLLM Proxy on Cloud Run** (min-instances=1 for latency SLO, CPU-only, no GPU). It provides the OpenAI-compatible surface, per-tenant **virtual API keys**, per-key budget tracking, RBAC, automatic provider fallback, and an admin UI — *without rewriting a line of solver code* (they already speak `--base-url`). Wrap it in **GCP API Gateway** for IAM auth + Cloud Audit Logs + 99.95% SLA. Known LiteLLM ceiling: connection-pool exhaustion at ~250 concurrent users → plan Postgres + Redis from day one if multi-tenant concurrency is expected.

### 3.2 Model pool (the swappable advantage)

Unlike Fugu's fixed three-model pool, Darwin's adapter layer accepts **any OpenRouter-compatible endpoint** — including local/open-weight models (ADR-150) and air-gapped deployments. This is a genuine enterprise/self-hosting advantage. For a persistent local-inference tier, **Cloud Run L4 GPU (min-instances=1)** serving a vLLM container is the clean fallback for the still-open Mac-mini blocker (the GUI Ollama app binds 127.0.0.1 only).

### 3.3 Darwin-as-conductor

The conductor is **evolutionary search over a structured policy genome**, optimizing a cost×quality fitness:

```
Value Score = w · resolve%  +  (1 − w) · cheapness     (cheapness: log-scaled $5→0, $0.005→100)
```

- The **two-tier fitness loop** (GCP VM fleet → `darwin_runs` Firestore → `evolve-arch.mjs` re-evolution) is the working conductor. ADR-141 proves MAP-Elites diversity + crossover + averaged fitness reaches the **global** cost-Pareto optimum that naive greedy search misses.
- The **LLM-as-mutation-operator** (`llmPropose`) generates *hypotheses* (informed genome seeds), but **only the 2-phase statistical gate (n=25 filter → n=100 confirm + 95% CI) promotes** — never the LLM. This is the explicit anti-Goodhart firewall.
- The `w` slider is the **primary customer-configurable knob**: low budget → w=0.3 (maximize cheapness); quality-critical → w=0.8+.
- **Non-stationary schedules** (ADR-187/188, Chebyshev/DCFR) generalize to routing: be aggressive early (explore candidates, high uncertainty), stabilize late (commit) — the entropy-guided adaptive-compute lever.

### 3.4 Async dispatch (the missing layer)

A full SWE-bench instance solve takes 10–30 min (15 steps); Cloud Run's HTTP timeout (default 60s, max 3600s) cannot hold it synchronously. The architecture **must** use **Cloud Tasks**: `POST gateway → enqueue task → Cloud Run worker (or GCP VM) pulls + solves → writes Firestore → webhook callback`. This decouples solve latency from request timeout and provides backpressure.

### 3.5 Auditability & lineage (the differentiator)

Today the audit chain is **broken at request grain**: the runner self-reports aggregate run results, but the genome that selected the model/mode is *not* stored per request. The required fix:

- Add a `request_id` to `darwin_runs` and a **lineage sub-collection** recording `{request_id, genome_key, mkey, model, mode, difficulty_score, provider_route}` on every solve dispatch.
- Surface `Archive.lineageOf()` (already byte-deterministic per the e2e reproducibility test) as a customer-facing **compliance export**: "export your full evolution lineage as tamper-evident JSONL." This is the direct answer to **EU AI Act Article 12** logging requirements.
- Bind the export to the ADR-011 **witness manifest** (Ed25519, SLSA) for tamper-evidence.

### 3.6 Silent-stall hardening (SLA prerequisite)

Every documented silent failure must become a hard error + dead-letter before any SLA: (1) missing metadata returns 404 HTML, not empty string → use `curl -f`; (2) Docker Hub rate-limit silently scores missing images `False` → sequential pre-pull + hard-error; (3) `AbortSignal`-less judge fetch hung the full-300 run at 142/300 → `AbortSignal.timeout` everywhere (the Firestore `curl` calls in `gcp-cluster.mjs` still lack timeouts). External longitudinal study (`arxiv.org/html/2606.14589v1`) catalogs 28 silent-failure manifestations in production LLM runtimes — silent is the dominant failure mode.

---

## 4. The Economics — Resolve-per-Dollar, Honest Ranges

### 4.1 Measured cost-Pareto points (conformant, Wilson-CI-gated)

| Config | Resolve | Benchmark | $/instance | $/resolve | Source |
|---|---|---|---|---|---|
| DeepSeek-V4-Flash single | 34% | Lite | $0.005 | ~$0.015 | swe-pareto.json |
| GLM-5.2 single | 37% | Lite (n=300) | $0.018 | ~$0.049 | LEARNINGS §25 |
| **GLM→Opus empty-patch cascade** | **51.3%** [45.7, 56.9] | **Lite (n=300)** | **$0.267** | **~$0.52** | LEARNINGS §28, replicated §47 |
| GLM→Opus cascade | 55.6% [51.2, 59.9] | Verified (n=500) | ~$0.15 | ~$0.27 | RESULTS §32–33 |
| Single-shot 3-tier | 58.3% [52.7, 63.8] | Lite (n=300) | ~$0.74 | ~$1.27 | ADR-154 / RESULTS §17 |
| Opus+GLM xbo (pilot) | 72% (n=25 only) | Lite | $0.52 | ~$0.72 | LEARNINGS §32 — **NOT a submittable claim** |
| Estimated frontier scaffolds | 58–60% | — | ~$2.5–4.2 | ~$2.5–4.2 | swe-pareto.json estimates |

**The honest comparison:** Darwin's cascade is **6–40× cheaper per resolved instance** than frontier-only scaffolds at *equal or slightly lower resolve*, in the **medium-resolve tier (~45–56% conformant)**.

### 4.2 The empty-patch gate is the single best routing signal

An empty patch is *mathematically 0% resolve probability*, so escalating it carries **zero regression risk** — 100%-precision give-up signal. **Route on binary output signals, not classifier scores.** This generalizes to syntax error / empty diff / size-0 patch. It is the default cascade primitive, and it is cheaper and more reliable than any learned router.

### 4.3 Cross-domain corroboration

DRACO research-quality bench: Gemini-2.5-Flash ($1/Mtok, quality 82) **Pareto-dominates** Claude-Opus-4 ($45/Mtok, quality 76) — higher quality at 1/42 the cost. GPT-5's quality-93 dossier costs **48× more** than Gemini-Flash's quality-82 (+13% quality for +4,739% cost). The cheap-beats-frontier phenomenon is not coding-specific.

### 4.4 Honest savings range & where it collapses

- **40–85% bill reduction** is achievable, but the upper end requires >80% of traffic to be classifiable as "easy."
- **GCP compute is a rounding error** (~1% of spend for cheap models). Price purely on token consumption with **account-level metering** — solver self-report undercounts Opus cost 1.7–1.8× (a $20 cap overshot to $58.78; LEARNINGS §56).
- **The cascade DOES NOT transfer to enterprise repos (SWE-Bench Pro).** GLM→Opus returned **1/25 (4%)** on Pro; Pro needs ~250-turn budgets that climb to Opus-class spend, collapsing the cost advantage. **Never quote the $0.27/instance number for large multi-file/multi-language repos.**

---

## 5. General-Purpose vs. Vertical — RECOMMENDATION

### Recommendation: **GO VERTICAL.** Primary wedge = proprietary-codebase CI/CD automation for mid-market engineering teams. Adjacent wedge = cloud-cost / FinOps optimization.

**Rationale:**

1. **General is a commodity trap.** Every vendor routes the same frontier models through comparable scaffolds and competes on contamination-inflated headlines. RouterArena confirms no router wins across all metrics; commercial routers don't beat open-source ones. A general MetaHarness would be "just another router" facing severe pricing pressure from free LiteLLM/Portkey/RouteLLM.
2. **Vertical makes the benchmark the customer's own tasks** — their proprietary codebase, their CI failures, their cost ledger — exactly where general platforms underperform (every coding agent does worse on legacy code than greenfield). The evolved genome on the customer's repo + test signal is a **data moat that compounds the longer it runs** and **cannot be replicated without the customer's private outcomes.**
3. **The product wedge already exists:** Test-Driven Repair (RESULTS §30, ADR-175) — hand Darwin a failing CI test, get a verified-fix PR at **$0.01–0.08/instance, 68.3% with-test resolve.** This is *deliberately leaderboard-nonconformant* (oracle-ON), which is fine: the customer doesn't care about SWE-bench, they care about their CI queue. **Revenue = per-resolved-issue (outcome-aligned), not per-seat.**
4. **Vertical-tuned genome beats a general router by construction** (RESULTS §135: deepseek-chat resolves 3/3 while gemini-flash resolves 2/3 on one corpus; positions swap on a different distribution). A fixed undisclosed routing policy (Fugu) cannot adapt to a customer's distribution; an evolving genome learns it.
5. **Market math favors vertical:** vertical AI agents grow 2–3× faster than horizontal SaaS (36.5% vs 18.9% CAGR); FinOps alone is $15.77B (2026). `packages/aws-finops/` already exists as a vertical directory — the lowest-friction adjacent build.

**Do NOT** position as a general leaderboard competitor. ADR-177 is explicit: the cheap-lever conformant search is exhausted at ~33% projected for a full-300 Opus best-of-3 — below top-10. The n=25 72% xbo pilot is a *signal*, not a claim. Surrendering the transparency/contamination-skepticism brand for an inflated headline destroys the core differentiator and is strategically unnecessary.

---

## 6. The Governance Moat — Transparency vs. Black Box

The governance thesis is structurally sound and grounded in shipped code, not slideware.

| EU AI Act / enterprise requirement | Fugu | MetaHarness/Darwin |
|---|---|---|
| Per-query model attribution | **None (black box)** | Lineage sub-collection + `Archive.lineageOf()` |
| Routing transparency | **Proprietary, hidden** | Inspectable genome policy diffs (PR-reviewable) |
| Article 12 audit logs (6-month, tamper-evident) | Not exposed | Byte-deterministic lineage JSONL + Ed25519 witness (ADR-011) |
| Adversarial / red-team artifact | None | `packages/redblue` → NIST AI RMF + OWASP LLM Top-10 (ADR-197) |
| Conformance / anti-contamination | Unverified self-report | Conformance firewall (`usedOracleDuringSolve===false`), Wilson CI |
| EU/EEA availability | **Blocked (pending GDPR)** | GCP EU-region deployable (data-residency ADR needed — see §8) |

**Key governance positioning points:**

- **"Our numbers are structurally impossible to contaminate — by code, not policy."** The conformance firewall is the primary differentiator from leaderboard-gaming black boxes.
- **"You can read a policy diff in a pull request; you cannot meaningfully audit a prompt perturbation."** The genome thesis (mutate *policies*, not prompts) is itself a transparency claim with real technical backing.
- **Disclose the E2 router null result proactively** (AUC ≈ 0.505 on difficulty prediction, ~0.55–0.6 5-fold CV). Honest negative results signal a conformance culture sophisticated regulated buyers reward.
- **Timeliness:** EU AI Act enforcement begins **2026-08-02** (fines to 7% global turnover / €15M / 3%). Fugu is EU-unavailable. ISO 42001 now appears in ~40% of EU enterprise AI RFPs (72% of buyers screen for it). The existing ADR governance system (allowlist + witness + redblue) covers large portions of ISO 42001 Annex A — a **gap analysis + certification sprint** is the logical next step.

---

## 7. Go-to-Market & Packaging

### 7.1 Buyer sequence (not one persona)

1. **ML/platform engineer** — economic driver: reduce inference spend (lands on cost savings). *Always the champion.*
2. **AI governance / security officer** — economic driver: EU AI Act compliance, audit trails. *Often the economic buyer.*
3. **CTO / VP Eng** — economic driver: reproducible, defensible vendor-selection evidence.

### 7.2 Open-core boundary

- **OSS core (acquisition flywheel — already exists):** kernel eval loop, CLI, conformance firewall, Wilson CI, cost ledger, witness manifest (ADR-011), HarnessSpec (ADR-159), `lineage.json` schema, the public cost-Pareto leaderboard web app. **Do not gate these.**
- **Commercial SaaS:** Darwin evolution engine (genome search, GCP fleet, autotune with runaway guards), Opportunity Scanner (ADR-165), `packages/redblue` adversarial harness, multi-tenant Firestore leaderboard, EU AI Act artifact generation, OIA manifest export (ADR-034).

### 7.3 Pricing ladder

1. **Entry — outcome-based** ($/resolved-task or % of demonstrated savings). Aligns with the 2026 shift to outcome pricing (Intercom $0.99/resolution, HubSpot $0.50). Candidate savings-share 20–30% (cascade saves >90% vs frontier-only — needs WTP validation).
2. **Team — per-seat** ($19–$200/seat/mo; comps: LangSmith $39, Confident AI $19.99) for evolution + shared leaderboard + collaborative genome management.
3. **Enterprise — flat subscription + "Compliance Pack"** (audit trail, OIA manifest, EU AI Act artifacts, SSO/RBAC, SLA, data residency).

**Avoid per-token markup** (pure gateway reseller) — LiteLLM/Portkey already commoditized it open-source.

### 7.4 Adjacent products (top-of-funnel, separable)

- **Benchmark-as-a-Service** (the conformance firewall + decontamination methodology). Market gap: 99/100 models on llm-stats are self-attested; Datacurve found 32% error in a widely-cited coding benchmark. Price per evaluation run / benchmark slot.
- **redblue red-team** as a standalone assessment ($5K–$75K range per Repello AI comps). Needs professional-services wrapping + liability framing before regulated-industry sale.

### 7.5 Motion

Developer-led (OSS core → npm → CLI), **not** top-down enterprise sale. Conversion: free OSS → per-seat team → enterprise governance tier. Budget a 12–18 month land-to-expand cycle for enterprise deals. Positioning vs LangSmith/Braintrust: *"LangSmith tells you how well you did; MetaHarness makes your harness better automatically."*

**Confidence note:** GTM dimension is **medium** confidence (market sizing and pricing are externally-sourced estimates, not measured); all technical and cost dimensions are **high** confidence (repo-grounded).

---

## 8. Risks & Honest Limits

| Risk | Severity | Mitigation |
|---|---|---|
| **Shared hard-tail ceiling** — orchestration cannot route past instances all models fail (0/25 confirmed give-ups cracked at ~$107) | Structural | **Market the truth:** "cost-Pareto optimum for your quality bar," not "beat frontier." Honest band: ~47–62% clean. |
| **Cascade collapses on enterprise repos** (4% on Pro, 250-turn budgets) | High | Vertical TDR product uses customer's *own* tests; do not quote Lite cost on Pro-shaped work. |
| **Router race-to-zero** (LiteLLM/Portkey/RouteLLM free) | High | Lead with genome + audit moat, **not** routing. |
| **Vendor lock-in fear** (76–81% of enterprises cite it) | Medium | OSS core + open schema (HarnessSpec, lineage.json). |
| **Cost-meter inaccuracy** (solver self-report undercounts 1.7–1.8×) | High (billing) | Account-level metering, not solver-side. ADR-capture the budget-guard fix. |
| **Silent stalls** (HTML-as-metadata, rate-limit→False, hung fetch) | High (SLA) | Hard-error + dead-letter on every path; `AbortSignal.timeout` everywhere. |
| **Productization gaps** (no gateway/queue/auth/billing/per-request lineage) | Medium | Defined engineering (§3, §9), not research. |
| **Cloud Run timeout < solve time** (60s vs 10–30 min) | High | Cloud Tasks async + webhook callback (mandatory). |
| **EU data residency** (US-central Firestore is GDPR-noncompliant for EU customers) | High | ADR-capture EU-region deployment before any EU sale. |
| **Brand fragility** — any gold-in-loop leak destroys the contamination-skeptic position | Critical | Enforce conformance firewall architecturally; never publish n=25 extrapolations as claims. |

**Open measurement that gates the governance narrative:** the §32 Opus+GLM xbo 72% (n=25) needs an **n=300 confirmation** before *any* public claim. A false n=25 extrapolation would undermine the very conformance credibility being sold.

---

## 9. A Concrete MVP Build Plan — Thin-Slice Bench/Orchestrator Service

**Goal:** a single-tenant, auditable, OpenAI-compatible solve endpoint that demonstrates transparent routing + cost receipts + lineage export. Reuse everything shipped.

### Phase 0 — Hardening (prerequisite, ~1 week)
- Add `AbortSignal.timeout` to the Firestore `curl` calls in `gcp-cluster.mjs`.
- Convert the three known silent failures to hard errors + dead-letter.
- Add `request_id` to the `darwin_runs` schema.

### Phase 1 — Gateway + async dispatch (~2 weeks)
- Deploy **LiteLLM Proxy on Cloud Run** (min-instances=1, CPU-only). Single virtual key.
- Front with **GCP API Gateway** (IAM auth + Cloud Audit Logs). WIF/CD pipeline already plumbed in `setup-gcp.sh`.
- Wire **Cloud Tasks**: `POST /solve → enqueue → existing GCP VM runner → Firestore → webhook`.
- Solvers point `--base-url` at the LiteLLM proxy (zero solver code change).

### Phase 2 — Transparent routing + receipts (~2 weeks)
- Implement the **empty-patch escalation gate** as the default cascade (100%-precision, $0).
- Expose `difficulty-router.mjs` as a **soft logging signal** (NOT a hard gate — out-of-sample AUC unvalidated; deploy with A/B monitoring).
- Emit a **per-request cost receipt**: `{request_id, model, mode, tokens, cost, difficulty_score, route}`.
- Write the **lineage sub-collection** on every dispatch.

### Phase 3 — Lineage export + Pareto dashboard (~1 week)
- Customer-facing **lineage export** (`Archive.lineageOf()` → tamper-evident JSONL, bound to ADR-011 witness).
- Move `pareto-from-firestore.mjs` to a **Cloud Run backend with a service account** (not developer creds), regenerated on Cloud Scheduler.

### Phase 4 — Vertical TDR demo (~2 weeks)
- Onboarding flow: customer connects repo + test command → baseline → `evolve` → archive → deploy winning genome.
- Per-resolved-issue metering via account-level cost gate.

**Deferred (post-MVP):** multi-tenant Postgres+Redis LiteLLM, per-tenant Firestore namespaces, per-tenant WIF SAs, redblue-as-a-service, ISO 42001 certification, n=300 conformant Pro run.

---

## 10. Bottom Line

Fugu created the category and the credibility gap simultaneously. The MetaHarness/Darwin stack already holds the primitives to fill that gap as the **auditable, governable, cost-transparent alternative** — but only if it stays honest: vertical not general, cost-Pareto not leaderboard, genome+lineage moat not commodity routing, and the shared hard-tail ceiling stated plainly rather than papered over with an inflated headline. The technical risk is low (productization, not research); the brand risk is the only existential one, and it is entirely within our control.
