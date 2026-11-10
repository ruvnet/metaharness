# 0.1.3 — 2026-11-10

`npm install @metaharness/agntcy` works without a `@buf:registry` line in `.npmrc`. The AGNTCY Directory SDK (`agntcy-dir`, plus `@bufbuild/protobuf` and `@buf/agntcy_dir.bufbuild_es`, which `oasf/publish.ts` imports directly and which were previously undeclared) moved to `optionalDependencies` and is loaded only inside `publishToDirectory()`. Without it, publishing returns `{ published: false, reason }` with the install hint.

# 0.1.2 — 2026-11-09

Package metadata and README (ADR-356). No API changes.

# 0.1.1 — 2026-10-21

Align Directory configuration forwarding with agntcy-dir 1.8.1, preserving TLS and OIDC mode selection.
