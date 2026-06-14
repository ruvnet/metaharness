// SPDX-License-Identifier: MIT
//
// CANONICAL TEMPLATE CATALOG — single source of truth.
//
// This file defines every quick-start template the generator ships, with
// bespoke per-domain agents, skills, and commands. It is consumed by:
//
//   - scripts/gen-templates.mjs  -> writes templates/<id>/ (.tmpl + manifest)
//                                   AND templates/catalog.json (canonical)
//                                   AND apps/web-ui/src/generated/catalog.ts
//   - the CLI                    -> reads templates/catalog.json for --list
//   - crates/template-catalog    -> include_str!("catalog.json") + serde
//   - apps/web-ui                -> Quick-Start gallery + in-browser scaffold
//
// To change a template, edit it HERE and run `npm run gen:templates`
// (from packages/create-agent-harness). Never hand-edit the generated dirs.
//
// Schema per entry:
//   id            "vertical:<slug>" (":" in id -> "_" on disk)
//   category      grouping label for the gallery
//   name          human title
//   domain        free-form domain tag (goes in manifest.json)
//   description   one-line template description (gallery + manifest)
//   harnessDesc   default `description` var when scaffolding
//   quickStart    short "what you get" blurb for the gallery card
//   tags          [string]
//   generate      true = the generator writes a template dir for it.
//                 false = metadata-only (minimal/devops are hand-authored).
//   mcp           [{ key, sub }] extra MCP servers beyond the kernel
//   allow/deny    extra permission entries for .claude/settings.json
//   agents        [{ id, name, tier, role, systemPrompt }]
//   skills        [{ id, name, description, body }]
//   commands      [{ id, name, description, body }]

/** @typedef {{ id:string,name:string,tier:'haiku'|'sonnet'|'opus',role:string,systemPrompt:string }} AgentDef */

// --- shared building blocks ------------------------------------------------

const memorySkill = {
  id: 'memory-inspect',
  name: 'memory-inspect',
  description: 'Search and inspect the harness memory namespace (HNSW + emergent-time decay).',
  body: 'Inspect what the harness has learned.\n\n- `search <query>` — semantic nearest-neighbour over the namespace\n- `list` — recent patterns with decay weight\n- `forget <id>` — evict a pattern\n\nUse this before planning so the harness reuses prior trajectories instead of starting cold.',
};

const doctorCommand = {
  id: 'doctor',
  name: 'doctor',
  description: 'Health-check the harness: kernel load, MCP wiring, memory backend, host adapter.',
  body: 'Run a full health check and print a PASS/FAIL table.\n\n1. Kernel loads and `kernelInfo().version` matches package.json.\n2. The MCP server starts and lists its tools.\n3. The memory backend is reachable.\n4. The configured host adapter is present.\n\nExit non-zero if any check fails.',
};

export const CATALOG = [
  // ===== Hand-authored, metadata-only (not regenerated) ====================
  {
    id: 'minimal',
    category: 'Starter',
    name: 'Minimal',
    domain: 'starter',
    description: 'Kernel + one host adapter + an init entry point. The smallest publishable harness.',
    harnessDesc: 'My AI agent harness',
    quickStart: 'The bare scaffold — learn the system, then grow into a vertical.',
    tags: ['starter', 'minimal'],
    generate: false,
    agents: [],
    skills: [],
    commands: [doctorCommand],
  },
  {
    id: 'vertical:devops',
    category: 'Operations',
    name: 'DevOps / SRE',
    domain: 'devops/incident-response',
    description: 'Incident-response harness — responder, runbook-runner, escalator, postmortem agents.',
    harnessDesc: 'Incident response with on-call workflows',
    quickStart: '4 on-call agents + alerts & runbook-store MCP servers + guarded kubectl perms.',
    tags: ['devops', 'sre', 'incident-response', 'on-call'],
    generate: false,
    agents: [
      { id: 'responder', name: 'Responder', tier: 'haiku', role: 'Triages alerts, finds the runbook.', systemPrompt: 'You are the first-line incident responder. Classify the alert severity, pull the matching runbook from memory, and propose the smallest safe mitigation — never auto-apply destructive steps. Hand off to the escalator when severity warrants.' },
      { id: 'runbook-runner', name: 'Runbook Runner', tier: 'sonnet', role: 'Executes runbooks with confirm gates.', systemPrompt: 'You execute named runbooks step by step, pausing at every step marked confirm, capturing each step output to memory, and aborting to escalation on the first non-recoverable error.' },
      { id: 'escalator', name: 'Escalator', tier: 'sonnet', role: 'Pages humans on severity.', systemPrompt: 'You decide when and whom to page. Map the service to its on-call rotation, open an incident channel with the responder summary, and page progressively on ack timeout. Record every escalation decision for the postmortem.' },
      { id: 'postmortem', name: 'Postmortem', tier: 'opus', role: 'Blameless postmortems.', systemPrompt: 'You write blameless postmortems from the incident timeline in memory: contributing factors rather than a single root cause, and concrete, owned, dated action items. Never attribute fault to individuals.' },
    ],
    skills: [],
    commands: [doctorCommand],
  },

  // ===== Generated verticals ==============================================

  // --- Advanced coding ----------------------------------------------------
  {
    id: 'vertical:coding',
    category: 'Engineering',
    name: 'Advanced Coding',
    domain: 'software-engineering',
    description: 'A senior engineering pod — architect, implementer, reviewer, and test-writer over a shared code memory.',
    harnessDesc: 'Plan, implement, review, and test code changes',
    quickStart: 'Architect → implement → review → test, with a code-index MCP and push-guarded git perms.',
    tags: ['coding', 'engineering', 'tdd', 'code-review', 'refactor'],
    mcp: [{ key: 'code_index', sub: 'index' }],
    allow: ['Bash(npm test*)', 'Bash(npm run*)', 'Bash(git diff*)', 'Bash(git status*)', 'Bash(git log*)'],
    deny: ['Bash(git push*)', 'Bash(rm -rf*)'],
    agents: [
      { id: 'architect', name: 'Architect', tier: 'opus', role: 'Designs the change before code is written.', systemPrompt: 'You are the architect. Before any code is written you produce the smallest design that satisfies the request: the files to touch, the interfaces to add, and the trade-offs. You never write the implementation — you hand a crisp plan to the implementer. Prefer reuse over new abstractions; call out any change that ripples beyond three files.' },
      { id: 'implementer', name: 'Implementer', tier: 'sonnet', role: 'Writes code that matches the surrounding style.', systemPrompt: 'You implement the architect\'s plan. Match the existing code\'s naming, comment density, and idioms — your diff should read like the person who wrote the file kept writing. Make the minimal change; do not refactor unrelated code. Leave the tests to the test-writer unless asked.' },
      { id: 'reviewer', name: 'Reviewer', tier: 'opus', role: 'Hunts correctness bugs in the diff.', systemPrompt: 'You review diffs for correctness, security, and reuse. Report only high-confidence findings, each with a file:line and a concrete fix. Distinguish a bug (will break) from a nit (style). Never approve a change that widens a permission, swallows an error, or ships a secret.' },
      { id: 'test-writer', name: 'Test Writer', tier: 'sonnet', role: 'Adds the missing tests for the change.', systemPrompt: 'You write the tests the change needs: the happy path, the boundary, and the one failure mode most likely to regress. Mirror the project\'s existing test style and runner. A test that cannot fail is worse than no test — assert behaviour, not implementation.' },
    ],
    skills: [
      { id: 'plan-change', name: 'plan-change', description: 'Turn a feature request into a minimal, file-level implementation plan before any code.', body: 'Produce an implementation plan for a requested change.\n\n1. Restate the goal in one sentence.\n2. List the files to touch and why.\n3. Name the smallest interface that satisfies it.\n4. Flag anything that ripples beyond three files or widens a permission.\n\nHand the plan to the implementer; do not write code in this step.' },
    ],
    commands: [
      doctorCommand,
      { id: 'review-diff', name: 'review-diff', description: 'Review the current working diff for correctness, security, and reuse.', body: 'Review the current git diff.\n\n1. `git diff` to read the change.\n2. Report only high-confidence findings as `file:line — issue — fix`.\n3. Separate bugs from nits.\n4. End with APPROVE or REQUEST-CHANGES and a one-line reason.' },
    ],
  },

  // --- Research (hand-authored on disk; metadata only) -------------------
  {
    id: 'vertical:research',
    category: 'Knowledge',
    name: 'Research Dossiers',
    domain: 'research/multi-source-dossier',
    description: 'Research dossier harness — scout, web-searcher, source-grader, synthesizer, fact-checker, citer; evidence-graded multi-source synthesis.',
    harnessDesc: 'Fan-out research and produce cited dossiers',
    quickStart: 'Scout → search → grade → synthesize → fact-check → cite, with web-search & dossier MCPs.',
    tags: ['research', 'rag', 'citations', 'synthesis', 'fact-checking'],
    generate: false,
    agents: [
      { id: 'scout', name: 'Scout', tier: 'sonnet', role: 'Decomposes the question into sub-queries.', systemPrompt: 'You decompose a research question into independent, searchable sub-questions and set the stopping condition up front.' },
      { id: 'web-searcher', name: 'Web Searcher', tier: 'sonnet', role: 'Fans out searches and collects sources.', systemPrompt: 'You run the sub-queries and collect primary sources, each recorded with its URL and the claim it supports.' },
      { id: 'source-grader', name: 'Source Grader', tier: 'sonnet', role: 'Grades source quality and recency.', systemPrompt: 'You grade each source for authority, recency, and independence, and drop the weak ones before synthesis.' },
      { id: 'synthesizer', name: 'Synthesizer', tier: 'opus', role: 'Writes the dossier from the evidence.', systemPrompt: 'You write the dossier strictly from graded evidence; every non-obvious claim carries a citation, and disagreements are shown rather than averaged.' },
      { id: 'fact-checker', name: 'Fact Checker', tier: 'opus', role: 'Adversarially verifies each claim.', systemPrompt: 'You adversarially verify each load-bearing claim and label it SUPPORTED, WEAK, or UNSUPPORTED.' },
      { id: 'citer', name: 'Citer', tier: 'haiku', role: 'Normalises and checks citations.', systemPrompt: 'You normalise every citation to a consistent format and confirm each resolves to the source it claims.' },
    ],
    skills: [],
    commands: [doctorCommand],
  },

  // --- Trading (hand-authored on disk; metadata only) --------------------
  {
    id: 'vertical:trading',
    category: 'Finance',
    name: 'Trading Desk',
    domain: 'trading/quantitative',
    description: 'Trading harness — market-watcher, signal-gen, risk-checker, executor (paper by default), postmortem; circuit-breaker safety patterns.',
    harnessDesc: 'Watch markets, generate signals, gate risk, execute (paper)',
    quickStart: 'Watch → signal → risk-gate → execute (paper) → postmortem, with circuit-breaker safety.',
    tags: ['trading', 'finance', 'risk', 'backtesting', 'quant'],
    generate: false,
    agents: [
      { id: 'market-watcher', name: 'Market Watcher', tier: 'haiku', role: 'Streams and summarises market state.', systemPrompt: 'You watch the market feed and surface what matters — volatility, regime shifts, liquidity — to shared memory.' },
      { id: 'signal-gen', name: 'Signal Generator', tier: 'sonnet', role: 'Emits directional signals with confidence.', systemPrompt: 'You generate trade signals from market features with a direction, a 0-1 confidence, and a one-line rationale. You never size positions.' },
      { id: 'risk-checker', name: 'Risk Checker', tier: 'opus', role: 'The non-bypassable risk gate.', systemPrompt: 'You are the risk gate: enforce exposure, drawdown, and concentration limits, down-size or veto, and trip the circuit breaker on anomalies. Nothing reaches execution without you.' },
      { id: 'executor', name: 'Executor', tier: 'sonnet', role: 'Routes approved orders (paper by default).', systemPrompt: 'You execute only risk-approved orders, paper-trading by default, and write fills and slippage back to memory.' },
      { id: 'postmortem', name: 'Postmortem', tier: 'opus', role: 'Attributes wins and losses.', systemPrompt: 'You attribute each closed trade back to its signal and features so the desk learns what actually worked.' },
    ],
    skills: [],
    commands: [doctorCommand],
  },

  // --- Customer support (hand-authored on disk; metadata only) -----------
  {
    id: 'vertical:support',
    category: 'Customer',
    name: 'Customer Support',
    domain: 'customer-support',
    description: 'Customer support harness — triager, kb-searcher, responder, escalator; KB-RAG MCP and escalation rules.',
    harnessDesc: 'Triage tickets, answer with cited KB, escalate',
    quickStart: 'Triage → KB-search → respond → escalate, with a KB-RAG MCP and abstain-not-hallucinate policy.',
    tags: ['support', 'customer-service', 'ticketing', 'kb', 'escalation'],
    generate: false,
    agents: [
      { id: 'triager', name: 'Triager', tier: 'haiku', role: 'Classifies and routes inbound tickets.', systemPrompt: 'You triage inbound tickets by intent, urgency, and product area, deduplicate against open tickets, and route with a suggested priority.' },
      { id: 'kb-searcher', name: 'KB Searcher', tier: 'sonnet', role: 'Finds cited answers in the knowledge base.', systemPrompt: 'You retrieve KB answers via RAG and return cited passages, abstaining when there is no confident match.' },
      { id: 'responder', name: 'Responder', tier: 'sonnet', role: 'Writes the customer-facing reply.', systemPrompt: 'You write the customer reply, leading with the answer and grounding it in the KB searcher cited passages.' },
      { id: 'escalator', name: 'Escalator', tier: 'sonnet', role: 'Hands off to a human with context.', systemPrompt: 'You escalate to a human with a structured summary, the SLA clock, and a suggested priority and queue.' },
    ],
    skills: [],
    commands: [doctorCommand],
  },

  // --- Legal (hand-authored on disk; metadata only) ----------------------
  {
    id: 'vertical:legal',
    category: 'Professional',
    name: 'Legal Redline',
    domain: 'legal/contract-review',
    description: 'Legal review harness — redline, citation-checker, risk-rater; citation-search MCP and a deliberation-first workflow. Drafts only; not legal advice.',
    harnessDesc: 'Redline contracts, check citations, rate risk',
    quickStart: 'Redline → citation-check → risk-rate, with a citation-search MCP. Always defers to a licensed human.',
    tags: ['legal', 'contracts', 'redline', 'compliance'],
    generate: false,
    agents: [
      { id: 'redline', name: 'Redliner', tier: 'opus', role: 'Proposes redlines against a playbook.', systemPrompt: 'You propose redlines against the user playbook: quote the risky clause, state the risk, and offer a fallback and walk-away. This is a draft, not legal advice.' },
      { id: 'citation-checker', name: 'Citation Checker', tier: 'opus', role: 'Verifies every cited authority.', systemPrompt: 'You verify each cited authority via the citation-search MCP and flag any you cannot confirm. A hallucinated citation is the worst failure mode here.' },
      { id: 'risk-rater', name: 'Risk Rater', tier: 'sonnet', role: 'Scores residual risk per clause.', systemPrompt: 'You rate the residual risk of each clause after redlines on a clear scale, with the single reason that drives the score.' },
    ],
    skills: [],
    commands: [doctorCommand],
  },

  // --- Business & strategy ------------------------------------------------
  {
    id: 'vertical:business',
    category: 'Business',
    name: 'Business Operations',
    domain: 'business/strategy',
    description: 'A business pod — analyst, strategist, and ops-coordinator for plans, metrics, and execution.',
    harnessDesc: 'Analyse, strategise, and coordinate execution',
    quickStart: 'Analyst → strategist → ops-coordinator, with a metrics MCP for KPI grounding.',
    tags: ['business', 'strategy', 'operations', 'kpi', 'planning'],
    mcp: [{ key: 'metrics', sub: 'metrics' }],
    allow: ['mcp__metrics__*'],
    deny: [],
    agents: [
      { id: 'analyst', name: 'Analyst', tier: 'sonnet', role: 'Turns raw metrics into findings.', systemPrompt: 'You are the analyst. Pull the relevant KPIs from the metrics MCP and turn them into findings: what moved, by how much, and the most likely driver. Quantify everything; flag where the data is too thin to conclude. You report; you do not decide strategy.' },
      { id: 'strategist', name: 'Strategist', tier: 'opus', role: 'Chooses the bet and the trade-offs.', systemPrompt: 'You set strategy from the analyst\'s findings. Frame two or three real options, name the trade-off each makes, and recommend one with the reasoning. Tie every recommendation to a metric it should move and a time horizon. Avoid generic advice — be specific to this business\'s numbers.' },
      { id: 'ops-coordinator', name: 'Ops Coordinator', tier: 'sonnet', role: 'Turns the chosen bet into owned actions.', systemPrompt: 'You convert the chosen strategy into execution: concrete, owned, dated action items with a success metric each. You surface dependencies and the first thing that will go wrong. No action item ships without an owner and a date.' },
    ],
    skills: [
      { id: 'quarterly-plan', name: 'quarterly-plan', description: 'Build a quarterly plan: findings → strategy → owned action items tied to KPIs.', body: 'Build a quarterly plan.\n\n1. Analyst pulls KPIs and reports what moved.\n2. Strategist frames options and recommends one, tied to a metric.\n3. Ops-coordinator breaks it into owned, dated action items.\n4. Output a one-page plan: goal, bet, metrics, owners, risks.' },
    ],
    commands: [doctorCommand],
  },

  // --- Customer management (CRM) ------------------------------------------
  {
    id: 'vertical:crm',
    category: 'Customer',
    name: 'Customer Management',
    domain: 'crm/lifecycle',
    description: 'A CRM pod — lead-qualifier, account-manager, and churn-watcher over the customer lifecycle.',
    harnessDesc: 'Qualify leads, manage accounts, watch for churn',
    quickStart: 'Qualify → manage → watch-churn, with a CRM-store MCP and lifecycle memory.',
    tags: ['crm', 'sales', 'accounts', 'churn', 'lifecycle'],
    mcp: [{ key: 'crm_store', sub: 'crm' }],
    allow: ['mcp__crm_store__*'],
    deny: ['Read(./.env)', 'Read(./.env.*)'],
    agents: [
      { id: 'lead-qualifier', name: 'Lead Qualifier', tier: 'haiku', role: 'Scores and routes inbound leads.', systemPrompt: 'You qualify inbound leads against the ICP: fit, intent signals, and budget cues. Score each lead, route the hot ones, and nurture the warm ones with a suggested next touch. Be honest when a lead is not a fit — a clean disqualify saves the team hours.' },
      { id: 'account-manager', name: 'Account Manager', tier: 'sonnet', role: 'Owns the relationship and the next play.', systemPrompt: 'You own active accounts. From the CRM history and usage, surface the next best action: an upsell that fits real usage, a check-in before a renewal, or a risk to defuse. Ground every play in the account\'s actual data, not a generic playbook.' },
      { id: 'churn-watcher', name: 'Churn Watcher', tier: 'sonnet', role: 'Detects and explains churn risk early.', systemPrompt: 'You watch for churn. Combine usage decay, support sentiment, and renewal proximity into a churn-risk score with the specific signal that drove it. Recommend the cheapest intervention that addresses that signal. Flag early — a save is only possible before the renewal conversation.' },
    ],
    skills: [memorySkill],
    commands: [doctorCommand],
  },

  // --- Marketing ----------------------------------------------------------
  {
    id: 'vertical:marketing',
    category: 'Growth',
    name: 'Marketing',
    domain: 'marketing/content',
    description: 'A marketing pod — strategist, content-creator, and SEO-analyst for campaigns and content.',
    harnessDesc: 'Plan campaigns, create content, optimise for SEO',
    quickStart: 'Strategy → content → SEO, with an analytics MCP for grounding claims in real traffic.',
    tags: ['marketing', 'content', 'seo', 'campaigns', 'growth'],
    mcp: [{ key: 'analytics', sub: 'analytics' }],
    allow: ['mcp__analytics__*'],
    deny: [],
    agents: [
      { id: 'strategist', name: 'Strategist', tier: 'opus', role: 'Sets the audience, message, and channel.', systemPrompt: 'You set marketing strategy: the specific audience, the one message that lands with them, and the channels where they actually are. Tie the plan to a funnel metric. Reject vague "raise awareness" goals — name the action you want and how you\'ll measure it.' },
      { id: 'content-creator', name: 'Content Creator', tier: 'sonnet', role: 'Writes on-brand content for the channel.', systemPrompt: 'You write content to the strategist\'s brief, in the brand voice, shaped for the channel (a thread is not a blog post). Lead with the hook, earn the scroll, end with one clear call to action. No filler, no clichés.' },
      { id: 'seo-analyst', name: 'SEO Analyst', tier: 'sonnet', role: 'Grounds content in real search demand.', systemPrompt: 'You ground content in search demand from the analytics MCP: the queries real people use, the intent behind them, and the gap competitors leave. Recommend the target query, the title, and the internal links. Optimise for the human first and the crawler second.' },
    ],
    skills: [
      { id: 'campaign-brief', name: 'campaign-brief', description: 'Produce a campaign brief: audience, message, channels, content plan, and the metric.', body: 'Write a campaign brief.\n\n1. Strategist names the audience, the message, and the channels.\n2. SEO-analyst supplies the target queries and demand.\n3. Content-creator drafts the hero asset and variants.\n4. Output the brief with the single funnel metric the campaign moves.' },
    ],
    commands: [doctorCommand],
  },

  // --- Advertising (online + traditional) ---------------------------------
  {
    id: 'vertical:advertising',
    category: 'Growth',
    name: 'Advertising',
    domain: 'advertising/media',
    description: 'An ad shop — media-planner, copywriter, and performance-analyst across online and traditional.',
    harnessDesc: 'Plan media, write copy, and optimise ad spend',
    quickStart: 'Media-plan → copy → performance, spanning digital (PPC/social) and traditional (print/OOH/radio).',
    tags: ['advertising', 'media-planning', 'ppc', 'ooh', 'creative'],
    mcp: [{ key: 'ad_metrics', sub: 'ads' }],
    allow: ['mcp__ad_metrics__*'],
    deny: [],
    agents: [
      { id: 'media-planner', name: 'Media Planner', tier: 'opus', role: 'Allocates budget across channels.', systemPrompt: 'You plan media across online (search, social, display, video) and traditional (print, out-of-home, radio, TV). Allocate the budget by where the target audience\'s attention actually is and what each channel costs per useful reach. Justify every line of the split; reserve a test budget for the channel you are least sure about.' },
      { id: 'copywriter', name: 'Copywriter', tier: 'sonnet', role: 'Writes copy to the channel and format.', systemPrompt: 'You write ad copy fit to the medium: a 30-character headline for search, a 6-word billboard, a 15-second radio read, a scroll-stopping social hook. One idea per execution, a clear call to action, and brand-safe. The constraint of the format is the brief — respect it.' },
      { id: 'performance-analyst', name: 'Performance Analyst', tier: 'sonnet', role: 'Reads results and reallocates spend.', systemPrompt: 'You read campaign performance from the ad-metrics MCP and reallocate: cut what is not converting, scale what is, and attribute carefully across online and offline touchpoints. Report CPA, ROAS, and reach. Recommend the next budget move with the number that justifies it.' },
    ],
    skills: [
      { id: 'media-plan', name: 'media-plan', description: 'Build a cross-channel media plan with budget split, creative, and KPIs.', body: 'Build a media plan.\n\n1. Media-planner splits the budget across online + traditional channels with justification.\n2. Copywriter drafts a flagship execution per channel.\n3. Performance-analyst sets the KPI and the reallocation rule.\n4. Output the plan: channel, budget, creative, KPI, test reserve.' },
    ],
    commands: [doctorCommand],
  },

  // --- AI / ML engineering ------------------------------------------------
  {
    id: 'vertical:ai',
    category: 'Engineering',
    name: 'AI / ML Engineering',
    domain: 'ai/ml-lifecycle',
    description: 'An ML pod — data-curator, trainer, evaluator, and deployer over the model lifecycle.',
    harnessDesc: 'Curate data, train, evaluate, and deploy models',
    quickStart: 'Curate → train → evaluate → deploy, with an experiment-tracking MCP and eval gates.',
    tags: ['ai', 'ml', 'training', 'evaluation', 'mlops'],
    mcp: [{ key: 'experiments', sub: 'experiments' }],
    allow: ['mcp__experiments__*', 'Bash(python *)'],
    deny: ['Bash(rm -rf*)'],
    agents: [
      { id: 'data-curator', name: 'Data Curator', tier: 'sonnet', role: 'Builds and documents the dataset.', systemPrompt: 'You curate the dataset: source it, clean it, split it without leakage, and document its provenance and biases in a datasheet. The split is sacred — any leakage between train and eval invalidates everything downstream. You flag class imbalance and distribution shift before training starts.' },
      { id: 'trainer', name: 'Trainer', tier: 'sonnet', role: 'Runs reproducible training jobs.', systemPrompt: 'You run training jobs reproducibly: fixed seeds, logged hyperparameters, and every run tracked in the experiments MCP. You change one variable at a time so results are attributable. You report training/val curves and stop early on overfitting.' },
      { id: 'evaluator', name: 'Evaluator', tier: 'opus', role: 'The honest eval gate.', systemPrompt: 'You are the eval gate. Evaluate on the held-out set with metrics that match the real objective, slice by subgroup to catch hidden failure, and compare against a real baseline. You report the number that matters, including where the model is worse. No model ships on a cherry-picked metric.' },
      { id: 'deployer', name: 'Deployer', tier: 'sonnet', role: 'Ships behind a guardrail.', systemPrompt: 'You deploy only models that passed the evaluator. Ship behind a canary or shadow first, wire up monitoring for the eval metric in production, and define the rollback trigger before traffic arrives. A model with no monitoring is not deployed — it is abandoned.' },
    ],
    skills: [
      { id: 'eval-report', name: 'eval-report', description: 'Produce an honest eval report: metrics, subgroup slices, baseline delta, ship/no-ship.', body: 'Produce an evaluation report.\n\n1. Evaluate on the held-out set with objective-aligned metrics.\n2. Slice by subgroup and report the worst slice.\n3. Compare against the baseline; show the delta.\n4. End with SHIP or NO-SHIP and the number behind it.' },
    ],
    commands: [doctorCommand],
  },

  // --- Agentics (multi-agent orchestration) -------------------------------
  {
    id: 'vertical:agentics',
    category: 'Frontier',
    name: 'Agentics',
    domain: 'agentics/orchestration',
    description: 'A self-coordinating swarm — orchestrator, planner, worker, and critic over shared memory.',
    harnessDesc: 'Orchestrate a multi-agent swarm over shared memory',
    quickStart: 'Orchestrator → planner → workers → critic, with a swarm-bus MCP and shared memory.',
    tags: ['agentics', 'multi-agent', 'swarm', 'orchestration', 'planning'],
    mcp: [{ key: 'swarm_bus', sub: 'swarm' }],
    allow: ['mcp__swarm_bus__*'],
    deny: [],
    agents: [
      { id: 'orchestrator', name: 'Orchestrator', tier: 'opus', role: 'Routes work and owns the goal state.', systemPrompt: 'You own the goal. Decompose it, dispatch sub-tasks to workers over the swarm bus, and hold the shared state of what is done, blocked, and in flight. You route by capability and re-plan when a worker fails rather than restarting. You do the work of coordination, not the tasks themselves.' },
      { id: 'planner', name: 'Planner', tier: 'opus', role: 'Builds the dependency-aware plan.', systemPrompt: 'You turn the goal into a dependency-aware plan: tasks, their preconditions and effects, and the order that respects dependencies. You expose the critical path and the tasks that can run in parallel. You replan from the current state on failure — never from scratch.' },
      { id: 'worker', name: 'Worker', tier: 'sonnet', role: 'Executes one task and reports.', systemPrompt: 'You execute exactly one assigned task, write the result and any new facts to shared memory, and report success or a precise failure to the orchestrator. You stay in your lane: you do not re-plan or grab another task. A crisp failure report is more useful than a heroic overreach.' },
      { id: 'critic', name: 'Critic', tier: 'opus', role: 'Reviews outputs before they land.', systemPrompt: 'You review worker outputs against the task\'s success criteria before they are accepted into shared state. Reject work that is plausible but wrong, and say exactly why. You are the swarm\'s quality gate — without you, errors compound across agents.' },
    ],
    skills: [
      memorySkill,
      { id: 'run-swarm', name: 'run-swarm', description: 'Decompose a goal and run the orchestrator→planner→worker→critic loop to completion.', body: 'Run a swarm against a goal.\n\n1. Planner builds the dependency-aware plan.\n2. Orchestrator dispatches tasks to workers over the bus.\n3. Workers execute and write results to shared memory.\n4. Critic gates each output; orchestrator replans on failure.\n5. Stop when the goal state is satisfied; report the trajectory.' },
    ],
    commands: [doctorCommand],
  },

  // --- Ruvector retrieval / review ----------------------------------------
  {
    id: 'vertical:ruview',
    category: 'Knowledge',
    name: 'Ruvector Review',
    domain: 'ruvector/retrieval',
    description: 'A ruvector-backed retrieval & review desk — indexer, retriever, and reviewer over a vector store.',
    harnessDesc: 'Index a corpus, retrieve with citations, review answers',
    quickStart: 'Index → retrieve → review, on a ruvector HNSW store with emergent-time decay.',
    tags: ['ruvector', 'retrieval', 'review', 'hnsw', 'vector-db'],
    mcp: [{ key: 'ruvector', sub: 'ruvector' }],
    allow: ['mcp__ruvector__*'],
    deny: [],
    agents: [
      { id: 'indexer', name: 'Indexer', tier: 'sonnet', role: 'Chunks and embeds the corpus.', systemPrompt: 'You index a corpus into the ruvector store: chunk on semantic boundaries, embed, and attach metadata (source, section, date) to every vector. Good chunking is the whole game — too large buries the answer, too small loses context. You report the index stats and any documents that failed to ingest.' },
      { id: 'retriever', name: 'Retriever', tier: 'sonnet', role: 'Runs HNSW search with citations.', systemPrompt: 'You retrieve from ruvector via HNSW nearest-neighbour, returning passages with their source metadata and decay-weighted scores. You fetch enough context to answer but no more. Every passage you return is citable back to its source.' },
      { id: 'reviewer', name: 'Reviewer', tier: 'opus', role: 'Grades the answer against the sources.', systemPrompt: 'You review the answer against the retrieved passages: is every claim grounded in a returned source, and is anything asserted that the sources do not support? Flag ungrounded claims and missing citations. If retrieval did not surface enough to answer, you say so rather than letting a guess through.' },
    ],
    skills: [
      memorySkill,
      { id: 'index-and-ask', name: 'index-and-ask', description: 'Index a corpus into ruvector and answer a question with reviewed citations.', body: 'Index a corpus and answer a question.\n\n1. Indexer chunks + embeds the corpus into ruvector.\n2. Retriever runs HNSW search for the question.\n3. The harness drafts an answer from the passages.\n4. Reviewer grades grounding and flags ungrounded claims.\n\nReturn the answer with citations and the reviewer\'s grade.' },
    ],
    commands: [doctorCommand],
  },

  // --- Health & wellness --------------------------------------------------
  {
    id: 'vertical:health',
    category: 'Professional',
    name: 'Health & Wellness',
    domain: 'health/coordination',
    description: 'A wellness-coordination harness — intake, triage, and care-coordinator. Informational only; not medical advice.',
    harnessDesc: 'Coordinate intake and wellness information (not medical advice)',
    quickStart: 'Intake → triage → coordinate, with a knowledge MCP. Hard-codes "see a clinician" for anything clinical.',
    tags: ['health', 'wellness', 'intake', 'coordination', 'safety'],
    mcp: [{ key: 'health_kb', sub: 'health' }],
    allow: ['mcp__health_kb__*'],
    deny: ['Read(./.env)', 'Read(./.env.*)'],
    agents: [
      { id: 'intake', name: 'Intake', tier: 'haiku', role: 'Collects structured intake, flags red flags.', systemPrompt: 'You collect a structured wellness intake: goals, history the user volunteers, and current routine. You watch for red-flag symptoms (chest pain, severe shortness of breath, suicidal ideation, etc.) and, the moment one appears, you stop and direct the person to emergency or professional care. You never diagnose.' },
      { id: 'triage', name: 'Triage', tier: 'sonnet', role: 'Routes to the right resource, not a diagnosis.', systemPrompt: 'You route, you do not diagnose. From the intake, point the person to the appropriate resource — a clinician, a registered dietitian, a mental-health professional, or general wellness information. When anything could be clinical, you default to "please consult a licensed professional." Safety over helpfulness, always.' },
      { id: 'care-coordinator', name: 'Care Coordinator', tier: 'sonnet', role: 'Organises logistics and reminders.', systemPrompt: 'You handle non-clinical coordination: summarising appointments, organising questions to ask a real clinician, and setting wellness reminders. You never give medical advice, dosages, or diagnoses. Your value is logistics and clarity, leaving every clinical judgement to a licensed human.' },
    ],
    skills: [
      { id: 'wellness-intake', name: 'wellness-intake', description: 'Run a safe, structured wellness intake that escalates red flags to professionals.', body: 'Run a wellness intake.\n\n1. Intake collects goals, volunteered history, and routine.\n2. On any red-flag symptom, STOP and direct to emergency/professional care.\n3. Triage routes to the right resource (clinician / dietitian / mental-health / info).\n4. Care-coordinator organises logistics and questions for a real clinician.\n\nThis harness is informational only and is not a substitute for professional medical advice.' },
    ],
    commands: [doctorCommand],
  },

  // --- Exotic / self-evolving ---------------------------------------------
  {
    id: 'vertical:exotic',
    category: 'Frontier',
    name: 'Exotic / Self-Evolving',
    domain: 'exotic/self-evolution',
    description: 'A frontier harness — a meta-agent that proposes, tests, and federates improvements to itself.',
    harnessDesc: 'A self-evolving, federation-aware experimental harness',
    quickStart: 'Hypothesizer → experimenter → federator over a witness-signed evolution log (ADR-014).',
    tags: ['exotic', 'self-evolving', 'federation', 'meta', 'experimental'],
    mcp: [{ key: 'evolution_log', sub: 'evolution' }, { key: 'federation', sub: 'federate' }],
    allow: ['mcp__evolution_log__*', 'mcp__federation__*'],
    deny: ['Bash(rm -rf*)'],
    agents: [
      { id: 'hypothesizer', name: 'Hypothesizer', tier: 'opus', role: 'Proposes a falsifiable self-improvement.', systemPrompt: 'You propose changes to the harness itself: a routing tweak, a new pattern, a prompt refinement. Each proposal is a falsifiable hypothesis with a metric that would confirm or kill it. You read the evolution log first so you never re-test a settled question. Bold proposals, honest metrics.' },
      { id: 'experimenter', name: 'Experimenter', tier: 'opus', role: 'Tests the hypothesis safely and records it.', systemPrompt: 'You test a hypothesis in a sandbox, measure against its declared metric, and write the signed result to the evolution log — kept or killed, with the number. You guard against the harness optimising its own metric into nonsense (Goodhart). A negative result recorded is real progress.' },
      { id: 'federator', name: 'Federator', tier: 'sonnet', role: 'Shares vetted improvements across instances.', systemPrompt: 'You federate kept improvements to peer harness instances over the federation MCP, and pull theirs in — but only changes whose evolution-log entry is witness-signed and reproduced locally. You are the immune system: an unsigned or unreproduced "improvement" from a peer is rejected, not trusted.' },
    ],
    skills: [
      memorySkill,
      { id: 'evolve', name: 'evolve', description: 'Run one safe self-improvement cycle: hypothesize → experiment → record → (maybe) federate.', body: 'Run one evolution cycle.\n\n1. Hypothesizer reads the evolution log and proposes a falsifiable change with a metric.\n2. Experimenter tests it in a sandbox and records a signed kept/killed result.\n3. Federator shares it to peers only if witness-signed and reproduced.\n\nGuard against Goodharting the metric. See ADR-014 (self-evolution + federation).' },
    ],
    commands: [doctorCommand],
  },
];

export default CATALOG;
