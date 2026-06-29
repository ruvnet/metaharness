# Security Policy

## Supported versions

The project is pre-1.0. Only the **latest published `0.x` version** receives security fixes during this phase. Once 1.0 ships, the policy widens to the current major plus the previous major's most-recent minor for 6 months.

| Version | Supported |
|---|---|
| `0.x` (latest) | ✅ |
| Older `0.x` | ❌ — please upgrade |

## Reporting a vulnerability

**Do NOT open a public issue.** Use one of these private channels:

1. **GitHub Security Advisory** — preferred. Go to [Security → Report a vulnerability](https://github.com/ruvnet/metaharness/security/advisories/new). The form gives us a private repo where we collaborate on the fix without disclosing details before a coordinated release.
2. **Email** — `ruv@ruv.net` with subject `SECURITY: agent-harness-generator`. Include:
   - The affected package (`@metaharness/kernel`, `@metaharness/host-*`, `create-agent-harness`)
   - Affected versions
   - Reproduction steps
   - Severity assessment (low/medium/high/critical)
   - Whether the vulnerability is public anywhere

We respond within **2 business days** acknowledging receipt and within **10 business days** with a triage assessment. Coordinated disclosure timeline: 90 days from triage to public advisory, faster if a fix lands sooner.

## Vulnerability categories we care about

Listed in roughly the order we triage:

1. **Supply chain — kernel or generator publishing** — anything that could let an attacker publish a malicious kernel or generator under our names. Includes GCP Workload Identity Federation misconfigurations, npm provenance bypasses, witness manifest forgery.
2. **WASM sandbox escape** — anything that lets WASM code execute outside its expected scope (we use the standard wasm-bindgen boundary; deviations are reportable).
3. **Generated harness defaults that are insecure** — if `create-agent-harness` emits a default that lets a harness's users execute attacker-controlled code, that's our bug, not theirs.
4. **Host-adapter injection** — anything where adapter-emitted config (TOML, JSON, YAML, sh) can be poisoned by a `HarnessSpec` field. The `tomlEscape`, JSON serialize, and shell quoting paths are the surface.
5. **Memory-safety bugs in the Rust kernel** — even though we `#![forbid(unsafe_code)]` in the kernel today, allocator/CVE-class issues via deps still count.
6. **CVE-equivalent issues in our deps** that we don't transitively patch via Renovate within 7 days of upstream disclosure.

## Security guarantees we make

- The kernel is `#![forbid(unsafe_code)]`. PRs that loosen this require an ADR + a maintainer signoff with rationale.
- Every kernel release is signed by our witness key. The CI publish step **rejects** an unsigned manifest.
- Every npm release ships with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) (SLSA L2).
- `cargo-audit`, `cargo-deny`, `npm audit --omit=dev --audit-level=high`, and CodeQL run on every push and weekly via cron. Findings block release.
- The publish pipeline never sees a long-lived NPM token. Tokens are ephemeral, fetched from GCP Secret Manager via Workload Identity Federation per-run.

## What we don't guarantee (yet)

- **Witness key rotation playbook** — ADR-011 specifies dual-sign rotation but the playbook is iter-5 work. Until then, key compromise requires republishing all affected versions with a new key + advisory.
- **Reproducible builds** for the native NAPI-RS targets — wasm is byte-deterministic by design; native builds may vary by toolchain version. We plan to lock in reproducibility via the Cargo.lock + `rust-toolchain.toml` pin, but this isn't covered by automated CI yet.
- **Bug bounty** — no formal program. Acknowledgement in CHANGELOG and a CVE credit if applicable; that's it for now.

## Hall of fame

Security researchers who responsibly disclose are credited here once the advisory is public.

*(Empty — no reports yet. Yours could be first.)*

## References

- [SLSA v1.0](https://slsa.dev/spec/v1.0/) — what our provenance level claims
- [in-toto Attestation Framework](https://github.com/in-toto/attestation)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [Socket.dev typosquatting research](https://socket.dev/blog/author-typosquatting-on-npm)
