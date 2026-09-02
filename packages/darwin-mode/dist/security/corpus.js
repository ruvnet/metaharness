// SPDX-License-Identifier: MIT
//
// Darwin Shield — the benchmark corpus (DARWIN-SHIELD-BENCH, ADR-155 §benchmarks).
//
// A self-contained, deterministic substrate so the whole pipeline is reproducible
// without Docker, Semgrep, CodeQL, or live repos (none of which are available in
// a sealed runner). Three dataset types per ADR-155:
//
//   1. seeded vulns  — known injected weaknesses (the ground-truth true positives)
//   2. real-CVE-like — pre-fix snapshots with a known weakness + an accepted patch
//   3. clean repos   — no weaknesses; a finding here is a FALSE POSITIVE
//
// Each site carries the features a real harness would key on (taint role,
// callgraph degree, sink proximity, recency, complexity) plus two latent
// difficulty knobs that drive the capability model in `agents.ts`:
//
//   detectionThreshold — how much harness "power" is needed to FIND it (subtlety)
//   fpThreshold        — how much "resistance" is needed to NOT mis-report a decoy
//
// The point: a stronger harness (more tools, hybrid context, more reviewers,
// memory) crosses more thresholds → higher true-positive rate and lower
// false-positive rate. That is the gradient Darwin Mode climbs.
/** Convenience: every real (ground-truth) vulnerable site across the corpus. */
export function groundTruth(corpus) {
    return corpus.repos.flatMap((r) => r.sites.filter((s) => s.isVulnerable));
}
/** Convenience: every decoy (a finding on one of these is a false positive). */
export function decoys(corpus) {
    return corpus.repos.flatMap((r) => r.sites.filter((s) => !s.isVulnerable));
}
function vuln(siteId, file, symbol, language, weakness, difficulty, // 0..1 subtlety
extra = {}) {
    return {
        siteId,
        file,
        symbol,
        language,
        weakness,
        isVulnerable: true,
        taintRole: 'sink',
        callgraphDegree: 6,
        sinkProximity: 0.8,
        recentChange: 0.5,
        complexity: 0.5,
        detectionThreshold: difficulty,
        fpThreshold: 0,
        acceptedPatch: `Validate and bound the input flowing into ${symbol}; add a regression test asserting the rejected case.`,
        riskTags: [weakness],
        ...extra,
    };
}
function decoy(siteId, file, symbol, language, looksLike, trickiness, // 0..1 — how strongly it pattern-matches a real bug
extra = {}) {
    return {
        siteId,
        file,
        symbol,
        language,
        weakness: looksLike,
        isVulnerable: false,
        taintRole: 'sanitizer',
        callgraphDegree: 3,
        sinkProximity: 0.4,
        recentChange: 0.3,
        complexity: 0.4,
        detectionThreshold: 1,
        fpThreshold: trickiness,
        riskTags: [looksLike],
        ...extra,
    };
}
/**
 * The default benchmark corpus. Mixed languages, mixed difficulty, with a
 * realistic decoy load so false-positive control matters. Difficulty is spread
 * so that a weak harness finds the easy bugs and mis-flags the trickier decoys,
 * while an evolved harness crosses the harder thresholds and resists the decoys —
 * producing the ADR-155 acceptance deltas.
 */
export function defaultCorpus() {
    return {
        id: 'darwin-shield-bench',
        version: '1.0.0',
        repos: [
            {
                repo: 'corpus/rust/svc-gateway',
                commit: 'a1b2c3d',
                kind: 'seeded',
                languages: ['rust'],
                frameworks: ['axum', 'tokio'],
                sites: [
                    vuln('rs-1', 'src/auth.rs', 'verify_token', 'rust', 'CWE-287 auth bypass', 0.25, { taintRole: 'sink', sinkProximity: 0.9, callgraphDegree: 11 }),
                    vuln('rs-2', 'src/parse.rs', 'decode_frame', 'rust', 'CWE-125 out-of-bounds read', 0.55, { complexity: 0.8 }),
                    vuln('rs-3', 'src/exec.rs', 'run_hook', 'rust', 'CWE-78 command injection', 0.7, { sinkProximity: 0.95 }),
                    decoy('rs-d1', 'src/util.rs', 'sanitize_path', 'rust', 'path traversal', 0.7),
                    decoy('rs-d2', 'src/log.rs', 'format_line', 'rust', 'format string', 0.45),
                ],
            },
            {
                repo: 'corpus/ts/web-api',
                commit: 'e4f5a6b',
                kind: 'seeded',
                languages: ['ts'],
                frameworks: ['express'],
                sites: [
                    vuln('ts-1', 'src/query.ts', 'buildQuery', 'ts', 'CWE-89 SQL injection', 0.3, { sinkProximity: 0.92, callgraphDegree: 9 }),
                    vuln('ts-2', 'src/render.ts', 'renderTemplate', 'ts', 'CWE-79 XSS', 0.5),
                    vuln('ts-3', 'src/deserialize.ts', 'loadState', 'ts', 'CWE-502 unsafe deserialization', 0.75, { complexity: 0.85 }),
                    decoy('ts-d1', 'src/escape.ts', 'escapeHtml', 'ts', 'XSS', 0.75),
                    decoy('ts-d2', 'src/ids.ts', 'genId', 'ts', 'weak randomness', 0.5),
                ],
            },
            {
                repo: 'corpus/py/data-pipe',
                commit: 'c7d8e9f',
                kind: 'real-cve',
                languages: ['py'],
                frameworks: ['flask'],
                sites: [
                    vuln('py-1', 'pipe/yaml_load.py', 'load_config', 'py', 'CWE-502 unsafe yaml.load', 0.35, { sinkProximity: 0.9 }),
                    vuln('py-2', 'pipe/template.py', 'render', 'py', 'CWE-1336 SSTI', 0.65, { complexity: 0.75 }),
                    decoy('py-d1', 'pipe/safe_yaml.py', 'safe_load_config', 'py', 'unsafe deserialization', 0.8),
                ],
            },
            {
                repo: 'corpus/go/scheduler',
                commit: 'b3a2c1d',
                kind: 'seeded',
                languages: ['go'],
                frameworks: ['net/http'],
                sites: [
                    vuln('go-1', 'pkg/path.go', 'ServeFile', 'go', 'CWE-22 path traversal', 0.4, { sinkProximity: 0.88 }),
                    vuln('go-2', 'pkg/ssrf.go', 'fetchURL', 'go', 'CWE-918 SSRF', 0.6),
                    decoy('go-d1', 'pkg/clean.go', 'cleanPath', 'go', 'path traversal', 0.65),
                ],
            },
            {
                repo: 'corpus/ts/clean-lib',
                commit: 'f0e1d2c',
                kind: 'clean',
                languages: ['ts'],
                frameworks: [],
                sites: [
                    decoy('cl-d1', 'src/math.ts', 'clamp', 'ts', 'integer overflow', 0.4),
                    decoy('cl-d2', 'src/str.ts', 'truncate', 'ts', 'buffer overflow', 0.55),
                    decoy('cl-d3', 'src/url.ts', 'parseUrl', 'ts', 'SSRF', 0.7),
                ],
            },
        ],
    };
}
/** Build a clean, gated `Finding` from a corpus site (never carries exploit code). */
export function findingFromSite(site, repo, commit, confidence, verdict) {
    return {
        id: `f-${site.siteId}`,
        repo,
        commit,
        file: site.file,
        symbol: site.symbol,
        weakness: site.weakness,
        confidence,
        evidence: [
            `${site.weakness} reachable at ${site.file}:${site.symbol}`,
            `taint role=${site.taintRole}, sink proximity=${site.sinkProximity}`,
        ],
        ...(site.acceptedPatch ? { patch: site.acceptedPatch } : {}),
        ...(site.isVulnerable ? { test: `regression test asserting ${site.symbol} rejects the malicious input` } : {}),
        verdict,
        exploitCodeAllowed: false,
    };
}
//# sourceMappingURL=corpus.js.map