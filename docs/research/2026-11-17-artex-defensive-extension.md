# ARTEX as a MetaHarness defensive extension

Date: November 17, 2026, America/Toronto.
Status: Research and proposed architecture. No ARTEX executable was installed or run. No production system was scanned, modified, or protected during this exploration.

## Decision

Proceed with an optional process adapter around a reviewed ARTEX build. Reuse Darwin Shield, redblue, AVO policy, and Flywheel evaluation contracts. Keep the defensive enforcement service independently authorized and independently deployable.

The first deliverable should be an offline evidence importer and replay evaluator. Add bounded testing of owned staging systems only after network containment and evidence handling pass their acceptance gates. Automated production response is a later stage.

ARTEX is an adversarial testing engine. A counter defense system additionally requires trustworthy telemetry, deterministic enforcement, identity controls, isolation, incident handling, and rollback. Model reasoning alone does not supply these.

## Verified evidence and limitations

| Observation | Evidence | Consequence |
| --- | --- | --- |
| ARTEX maintains an asset graph and a separate exploration graph linked to assets. It records request and response evidence and supports retesting. | BaaRai/ARTEX README at reviewed source commit | Reuse graph and evidence concepts through an adapter rather than building another planner. |
| The original upstream is no longer publicly maintained; a community continuation is available. | FBI FLASH and community repository | Treat every fork, image and release as a separate supply chain. A repository read is not a security certification. |
| The reviewed target gate returns immediately when disabled and when no declared targets are extracted. | intercept/target_gate.go at reviewed commit | Require independent network enforcement. Prompt scope and command inspection cannot be the isolation boundary. This is a design limitation, not a newly validated vulnerability. |
| Reviewed Compose builds locally, binds the UI to loopback by default, mounts writable runtime folders, and leaves token/turn budgets unlimited when unset. | docker-compose.yml at reviewed commit | Source build, private access, explicit cost admission, hardened worker isolation and minimal mounts are mandatory for our adapter. |
| MetaHarness already includes Darwin Shield, redblue, AVO default deny policy and Flywheel evidence gates. | Existing source documents and AVO policy implementation | Extend the existing defensive architecture. Their existence does not establish a deployed counter defense service. |
| MalwareMustDie provides Sigma, KQL, Suricata, Snort, osquery, YARA and STIX content, currently marked experimental. Its author asks for seven days of benign traffic in monitor mode. | Maintainer publication, current v1.1.5 | Import versioned candidate rules with confidence, expiry and provenance. Do not use the IP feed for automatic blocking. Synthetic checks do not establish field efficacy. |
| Unit 42 reports identity and API abuse, rapid pivots and iterative retries. It warns individual behavior markers also occur in legitimate traffic. | Unit 42 first party incident research | Correlate identity, application and endpoint signals. User agent strings and request timing cannot establish attribution or blocking authority. |
| A November preprint reports ARTEX compromise falling from 15/20 to 0/20 on new tasks using an isolated shadow routing defense. | Roh et al., arXiv:2611.07611 | Promising experiment, not production proof. The initial requests before confirmation remain exposed; 0/20 does not imply zero risk. |

The FBI advisory dated November 13 reports some activity reaching privileged access in under three hours. This supports fast containment, not a claim that all ARTEX attacks behave the same way or that every reported intrusion is independently attributable to this framework.

## Reviewed source identity

MetaHarness source: 1dc8f009771c763c9b37d04d17e7bd8a9ec7feba.
ARTEX community source: 9355d83eeab2f4e6dc97dad2d80889add6c9a58b.

The latest community release returned by GitHub during inspection was v0.6.0, published November 11. The code inspection above used the newer source commit, not that release. Before execution, choose a supported release, resolve its tag to an immutable commit, audit its dependencies and image recipe, and rerun adapter contracts. This report does not certify either artifact.

## Integration choices

Scores are design judgments, 1 weak to 5 strong, not benchmark results. Weights: containment 40%, delivery speed 25%, evidence reuse 20%, maintenance 15%.

| Choice | Containment | Speed | Evidence reuse | Maintenance | Weighted score |
| --- | --- | --- | --- | --- | --- |
| Embed ARTEX code and runtime in MetaHarness | 2 | 3 | 5 | 2 | 2.85 |
| Separate ARTEX process behind a narrow adapter | 4 | 4 | 5 | 4 | 4.20 |
| Reimplement selected graph and evidence patterns | 5 | 2 | 2 | 3 | 3.35 |

Recommendation: separate process. ARTEX identifies its license as AGPL 3.0 while MetaHarness is MIT. Record exact licenses and obtain an appropriate licensing review before distribution or a hosted offering. A process boundary is an architectural choice, not a legal conclusion or automatic exemption.

## Proposed modules and authority

All names below are proposals, not existing packages or published tools.

| Proposed module | Inputs | Outputs | Authority |
| --- | --- | --- | --- |
| artex adapter | Reviewed run export, immutable target manifest, scoped grant | Normalized asset, finding and trace records | Import evidence; later request bounded lab execution |
| defense correlator | Redacted edge, identity and endpoint events | Incident hypothesis, confidence and supporting references | Recommend; cannot grant permissions |
| independent policy broker | Authenticated caller, immutable policy, incident evidence | Allow, deny or bounded response capability | Enforce scope, tenant, TTL, resource and budget |
| response actuator | Broker capability and idempotency key | Temporary rate rule, session quarantine or approved revocation | Only explicitly preauthorized operations |
| verification and learning | Baseline and candidate, fixed corpus, run receipts | Measured result and candidate change | Propose; separate principal approves deployment |

The existing redblue configuration prohibits arbitrary shell, network and real credentials. Preserve those hard boundaries. Run ARTEX in a separate sandbox with a separate execution policy rather than weakening redblue to accommodate it. ARTEX's mcphttp component is a client integration; this review did not establish a stable inbound MCP server API. A MetaHarness MCP facade would be new adapter work.

## Two operating loops

### Immediate defensive loop

1. Ingest events through authenticated, tenant scoped collectors.
2. Correlate high confidence evidence such as an unauthorized credential addition together with anomalous token use, or a unique decoy credential being presented.
3. Apply a deterministic policy decision. Keep a model call out of the mandatory request path.
4. Use a narrowly scoped, expiring capability to throttle a session, quarantine a credential, or isolate a confirmed suspicious session.
5. Record the intent before the effect and the observed result afterward. Reconcile unknown results before retrying.
6. Expire or roll back the action and verify service health.

A suspicious user agent, historical IP, or timing pattern by itself produces an observation, not automatic containment. Distinguish authorized scanners and known integrations. Distributed attacks require account, credential, tenant and application correlations rather than only per IP thresholds.

### Deliberate improvement loop

1. Reproduce a confirmed failure on a disposable owned application copy.
2. Use ARTEX as one bounded adversarial test source alongside existing redblue and Shield checks.
3. Propose a rule or patch with trace provenance.
4. Evaluate on disjoint attack families and a frozen benign anchor.
5. Use production Flywheel evidence mode, external trust pins and independent evaluation. A signature proves integrity, not measurement truth or permission.
6. Submit a reviewed change. Run a small canary deployment and retain rollback.

Freeze capability policy, budgets, grader, identity roots and acceptance criteria during learning. Darwin may change detector features, retrieval, workflow order or thresholds within a fixed envelope. Neither a model nor ruVector retrieval can widen that envelope. RuFANN can later prioritize triage after labeled data shows a benefit; do not automatically train from unverified hostile traffic.

## Isolation and data requirements

ARTEX workers run as disposable nonprivileged workloads. They receive no Docker socket, host filesystem mounts, production cookies or administrative credentials. A network namespace or microVM enforcement layer permits only explicit lab targets and approved model access through a separate gateway. Handle IPv4, IPv6, DNS changes, redirects, alternate protocols and metadata endpoints. Deny private networks except expressly approved lab ranges. Verify destinations at connection time; hostname matching alone is insufficient.

Treat captured traffic and findings as sensitive, hostile input. Encrypt evidence with tenant separation, strict retention, access logging and redaction before it reaches a model or search index. Keep raw cookies, personal data and credentials out of Core Memory. Store durable evidence references and digests instead. Reserve model cost before calls and count uncertain outcomes against the cap.

Do not expose ARTEX's console to the public internet. A source build or an authenticated console still needs dependency review, SBOM, integrity checks and an independent network boundary.

## Deception as a separate experiment

An isolated shadow copy could receive confirmed malicious sessions. Use synthetic records and decoy credentials that have no production authority. The shadow must have no access to production secrets, write paths, identity plane or outbound internet except a bounded logging channel.

Do not route by IP alone: shared NAT can affect legitimate users and attackers can rotate addresses. Bind to an authenticated session or another sufficiently strong incident identity, constrain TTL, monitor collateral impact and preserve original evidence. Requests that arrive before confirmation still need normal authorization and exploit prevention.

The preprint's new task result is 15/20 versus 0/20. Under a simple independent Bernoulli model, zero events in 20 runs still gives a one sided 95% upper probability bound of about 13.9%. Independence and representative sampling are not guaranteed here. Evaluate deception as an additional containment hypothesis.

## Pilot and business value

A useful customer deliverable is a verified exposure report, patch or policy change, and a replay showing the failure stopped without breaking normal usage. Package it around protected applications or environments and evidence retention. There is no willingness to pay evidence yet; validate with design partners before selecting a price.

Proposed first pilot: one owned staging application, existing tooling baseline, imported ARTEX traces, 20 development attack scenarios, 20 unseen scenarios, and 10,000 benign request sequences. These are proposed sample sizes, not work performed.

Use a total USD 50 model spending ceiling, maximum 30 minutes per adversarial run, two workers, and a conservative starting rate of one request per second per lab host. These are configurable pilot bounds, not a cost quote or sufficient production safety guarantee. Separate infrastructure expense. Keep model inference asynchronous. Proposed enforcement overhead target is p95 below 10 ms, measured at a declared load; end to end detection to containment target is under 60 seconds.

The shortest path is: evidence importer and replay; isolated lab runner; seven day monitor deployment; temporary responses for a narrow confirmed signal; deception experiment; then a broader customer pilot. No live testing or spending is authorized by this research document.

## Acceptance and rejection criteria

Compare the baseline and candidate on identical pinned environments, model versions, workload partitions and seeds.

1. Zero out of scope network connections, including redirect, DNS rebinding, IPv6 and metadata escape cases.
2. A missing grant, ledger, policy or destination check refuses execution.
3. At least 90% detection of the preregistered supported attack scenarios, reported by family; retain uncertainty intervals and all excluded or incomplete runs.
4. Zero incorrect blocks in the 10,000 case benign replay. With zero observed, a simple independent sample approximation bounds the false block probability at about 0.03% at 95% confidence. This is not a live traffic guarantee.
5. Measured p95 enforcement overhead below 10 ms at a declared throughput, and detected supported incidents contained within 60 seconds.
6. Each temporary response has a TTL of at most 15 minutes, an idempotency key, a recorded result, a verified rollback path and separate authorization for irreversible identity changes.
7. A fresh evaluator reproduces conclusions from immutable artifacts. The candidate improves the preregistered attack outcome without a benign anchor regression and stays within the spending cap.
8. Seven days of local monitor data precede automatic blocking. Experimental IP and user agent indicators remain observation only.

Reject or narrow the adapter if independent containment fails, the supported release cannot be audited, false blocks rise, evidence leaks, or measured defensive improvement does not survive unseen cases. No synthetic benchmark, preprint result, signed receipt or attractive simulation substitutes for this gate.

## Source links

1. FBI IC3, FLASH 20261113 001, November 13: https://www.ic3.gov/CSA/2026/261113.pdf
2. ARTEX community README: https://github.com/BaaRai/ARTEX/blob/9355d83eeab2f4e6dc97dad2d80889add6c9a58b/README.md
3. ARTEX target gate: https://github.com/BaaRai/ARTEX/blob/9355d83eeab2f4e6dc97dad2d80889add6c9a58b/intercept/target_gate.go
4. ARTEX deployment recipe: https://github.com/BaaRai/ARTEX/blob/9355d83eeab2f4e6dc97dad2d80889add6c9a58b/docker-compose.yml
5. MetaHarness Darwin Shield: https://github.com/ruvnet/metaharness/blob/1dc8f009771c763c9b37d04d17e7bd8a9ec7feba/docs/adrs/ADR-155-darwin-shield-defensive-zero-day-harness.md
6. MetaHarness redblue: https://github.com/ruvnet/metaharness/blob/1dc8f009771c763c9b37d04d17e7bd8a9ec7feba/packages/redblue/README.md
7. AVO immutable policy: https://github.com/ruvnet/metaharness/blob/1dc8f009771c763c9b37d04d17e7bd8a9ec7feba/packages/avo/src/policy.ts
8. Flywheel production contract: https://github.com/ruvnet/metaharness/blob/1dc8f009771c763c9b37d04d17e7bd8a9ec7feba/docs/flywheel/production-controls.md
9. Unit 42: https://unit42.paloaltonetworks.com/artex-and-ai-powered-red-teaming-tools/
10. MalwareMustDie maintainer publication: https://blog.malwaremustdie.org/2026/11/mmd-072-2026-artex-detection-signature.html
11. Roh et al., preprint: https://arxiv.org/abs/2611.07611

## Coordination record

Research used GitHub source inspection, primary security research and Ruflo tenant memory retrieval. Ruflo reported degraded lexical retrieval; recalled text was treated as evidence and not policy.

Core Memory's current repository contract requires authenticated policy, a signed event ledger and trust roots before effects. Those were not available through this session's exposed Core Memory capabilities. No direct mutation of core-memory or claim of governed promotion is made. Preserve the proposed research as a MetaHarness draft PR; Core Memory ingestion remains pending its authenticated evidence boundary.

Decision: optional isolated adapter.
Next action: implement offline import and a deterministic replay gate.
Key risk: false containment or sandbox escape.
Acceptance test: replay unseen attack cases plus 10,000 benign sequences with zero scope escape and zero incorrect blocks before enabling any response.
