# ADR-324: TypeScript World Intel with bounded WASM kernels

Status: Proposed, initial implementation. Date: 2026-11-17.

## Context

World Intel upstream (`marc-shade/world-intel-mcp`, MIT, inspected at `fdebf9a8de6e00ed688053dd647cafedc179708b`) provides 160 Python MCP tools. The requested direction is MetaHarness, TypeScript plus WASM rather than a Python subprocess wrapper. Existing Python installation and ChatGPT skill are separate and unchanged.

## Decision

Create `@metaharness/world-intel` inside this monorepo. Native official MCP SDK stdio transport and public-source HTTP adapters are TypeScript. Use existing MetaHarness policy, verification and receipts as an execution boundary, with no paid-model or self-improvement loop. Implement deterministic geospatial kernels in AssemblyScript with checked-in build output and TS parity tests. Compile with pinned compiler and test rebuilt bytes.

Ship a narrow working initial slice: USGS events, US NWS alerts, World Bank indicators and local status. No native remote MCP listener, persistent collector, broad environment inheritance, secrets, financial action, event-driven outreach or hosted dashboard. Do not claim parity with all upstream tools/prompts/resources. Do not replace the existing installed Python server until a separately authorized migration with acceptance coverage.

## Evidence and acceptance

Required: strict TS build; transport/schema/cache/adversarial tests; official SDK client/server integration; real WASM instantiation and deterministic parity tests; MetaHarness allow/deny/freshness and receipt verification; explicit live USGS smoke with timestamp. Fixture-backed NWS/World Bank checks are not live validation. Monorepo-wide CI is separate from this package's scoped checks.

## Expansion gates

Inventory upstream capabilities, prioritize concrete use cases, and port adapters incrementally with tests and provenance. A remote ChatGPT endpoint needs authenticated transport, tenant isolation, bounded source access and operational ownership. WASM is a numeric compute boundary, not a replacement for network I/O or a security sandbox for the Node process. Benchmark against TS before making acceleration claims.

## Rollback

Revert this isolated package, lockfile registration and ordered-build entry. No production data migration, credential, installation or deployed service is touched.
