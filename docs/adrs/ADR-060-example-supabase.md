# ADR-060: example-supabase — Supabase SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Supabase is an open-source Firebase alternative built on Postgres. As of mid-2026 it is one of the most commonly chosen backends for agent-driven applications because a single project gives an agent access to a relational database, Row Level Security (RLS), Auth (JWT-based sign-in with anonymous, password, OAuth, magic-link), Storage (S3-compatible object store), Realtime (Postgres Change Data Capture over websockets), and pgvector (HNSW vector similarity search for RAG) — all behind a single API key model.

The design challenge for an agent harness is the **key-tier distinction**. Supabase ships two credential tiers with very different security semantics:

- **Publishable key** (legacy name: `anon key`; new prefix `sb_publishable_…`) — exposes the Postgres `anon` role. Safe to include in client-side code. Access is bounded entirely by RLS policies on each table. If RLS is not enabled on a table that the `anon` role can reach, the table is effectively public.
- **Secret key** (legacy name: `service_role key`; new prefix `sb_secret_…`) — exposes the Postgres `service_role` role, which **bypasses RLS entirely**. Server-side only. Never expose in a browser or in source code.

For an AI agent harness this distinction is directly load-bearing: an agent running user-facing queries should use the publishable key so RLS enforces per-user data isolation; an agent performing administrative bulk operations (migrations, seeding, backups) should use the secret key from a privileged backend context. Getting this wrong exposes every tenant's data.

A secondary challenge is **test/sandbox mode**. Supabase does not offer a separate sandbox endpoint or test key equivalent to Stripe's `sk_test_` prefix. The canonical safe-development path is `supabase start` (CLI-managed Docker stack), which spins a full local Postgres + Auth + Storage + Realtime environment at `http://127.0.0.1:54321` with deterministic local keys surfaced by `supabase status -o env`. Any destructive operation that would mutate a production project is therefore gated behind the user's deliberate choice to point the agent at a remote project URL.

This ADR records the design decisions for the `@metaharness/example-supabase` showcase package, which demonstrates how a metaharness-generated agent correctly handles both key tiers, enforces RLS in normal operation, and integrates with pgvector for RAG-pattern queries — all read-only by default with mutations gated behind an explicit opt-in.

## Decision

### Chosen SDK

`@supabase/supabase-js` — the official isomorphic JavaScript client published by Supabase, Inc. As of 2026-06-17 the latest release is **v2.108.x**. Import style:

```js
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY          // publishable key — safe with RLS
)

// For administrative agents only:
const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY   // secret key — bypasses RLS
)
```

The package is isomorphic (Node ≥ 18, browsers, Deno via JSR, Edge Functions). It covers auth, database (PostgREST auto-API over Postgres), storage, realtime, and Edge Function invocation from a single dependency.

**Key naming note**: Supabase is mid-migration from legacy JWT-based keys to a new asymmetric key scheme. New projects (created after November 2025) receive `sb_publishable_…` and `sb_secret_…` keys. Legacy projects still use `anon` and `service_role` JWT tokens; legacy keys will be retired in late 2026. This example uses the new env var names (`SUPABASE_KEY`, `SUPABASE_SECRET_KEY`) which map to the new key scheme, with a migration note in the README for users on legacy keys.

### Headline Capability

RLS-aware data agent over Postgres with auth and storage — the agent demonstrates:

1. **Querying under RLS with the publishable key**: the `anon` Postgres role can only see rows the RLS policies permit; the agent surfaces which policies are in effect and which rows are visible.
2. **Querying as an authenticated user**: the agent signs in with email+password (or anonymous sign-in), issues queries under the `authenticated` Postgres role, and shows that the row set expands relative to `anon`.
3. **pgvector semantic search with RLS**: the agent runs a `match_documents`-style RPC (Postgres function calling `<=>` similarity operator) and demonstrates that RLS silently filters the returned vectors to only those owned by the current user.
4. **Storage bucket operations**: the agent inspects bucket visibility (public vs. private), lists objects the current auth context can see, and optionally (opt-in) uploads a test file.
5. **Service-role administrative view** (opt-in only): with `--admin` flag, the agent creates an `admin` client using `SUPABASE_SECRET_KEY` and shows the unfiltered row count, illustrating the RLS bypass.

### Agent and Skill Design

Three specialized agents, one slash command:

| Agent | Tier | Role |
|---|---|---|
| `planner` | Cheap (Haiku-class) | Parses the user's intent, resolves table/bucket names, emits a structured task list for the executor |
| `executor` | Cheap (Haiku-class) | Runs the Supabase queries/RPCs, handles pagination, collects raw results |
| `verifier` | Frontier (Sonnet-class) | Reads back the executor's output, cross-references row counts, checks that RLS-visible data is consistent with the signed-in user's identity, and gates the "done" signal |

Slash command: **`/supabase-query`** — accepts a natural-language description of a data question, routes it through planner → executor → verifier, and returns a verified answer with the active auth context (anon / authenticated / admin) clearly labelled in the output.

### Routing Tiers (ADR-026)

| Tier | Handler | When used |
|---|---|---|
| 1 (WASM Booster) | Skip LLM | Table/column name normalization; JSON→table formatting |
| 2 (Cheap — Haiku-class) | Planner + Executor agents | Intent parsing; SQL generation; result pagination |
| 3 (Frontier — Sonnet-class) | Verifier agent | RLS consistency check; security-sensitive decisions; final answer synthesis |

### MCP Policy (ADR-022 default-deny)

Scaffolded to `.harness/mcp-policy.json`. Granted tools only:

```json
{
  "default": "deny",
  "audit_log": true,
  "grants": [
    { "tool": "supabase__query",        "reason": "SELECT via PostgREST" },
    { "tool": "supabase__rpc",          "reason": "call Postgres functions (pgvector match)" },
    { "tool": "supabase__auth_sign_in", "reason": "sign in to obtain user JWT" },
    { "tool": "supabase__auth_sign_out","reason": "clean up session" },
    { "tool": "supabase__storage_list", "reason": "list bucket objects (read-only)" }
  ],
  "opt_in_grants": [
    { "tool": "supabase__insert",       "flag": "--allow-writes",  "reason": "INSERT rows" },
    { "tool": "supabase__update",       "flag": "--allow-writes",  "reason": "UPDATE rows" },
    { "tool": "supabase__delete",       "flag": "--allow-writes",  "reason": "DELETE rows" },
    { "tool": "supabase__storage_upload","flag": "--allow-writes", "reason": "upload objects" },
    { "tool": "supabase__admin_query",  "flag": "--admin",         "reason": "service-role bypass" }
  ]
}
```

All tool invocations are written to `.harness/mcp-audit.jsonl` with timestamp, tool name, arguments hash, and result status.

### Auth Model

| Key | Env var | Postgres role | RLS behaviour |
|---|---|---|---|
| Publishable (new) / anon (legacy) | `SUPABASE_KEY` | `anon` | RLS applies; only rows matching `anon` policies are visible |
| User JWT (from `auth.signInWithPassword`) | obtained at runtime | `authenticated` | RLS applies using `auth.uid()` to resolve per-user policies |
| Secret (new) / service_role (legacy) | `SUPABASE_SECRET_KEY` | `service_role` | RLS bypassed entirely — administrative access |

`SUPABASE_URL` is always required. For local development: `http://127.0.0.1:54321` (from `supabase start`). For hosted projects: `https://<project-ref>.supabase.co`.

Legacy key holders (pre-November 2025 projects) map: `SUPABASE_KEY` = their `SUPABASE_ANON_KEY` value, `SUPABASE_SECRET_KEY` = their `SUPABASE_SERVICE_ROLE_KEY` value.

### Safety Gates

- **Default mode**: agent uses publishable key only; signs in as `anon`; all queries are read-only `SELECT` and `storage.list`. No INSERT / UPDATE / DELETE / upload.
- **`--user <email> --password <pass>` flag**: agent signs in as a real user; queries run under the `authenticated` Postgres role. Still read-only unless `--allow-writes` is also set.
- **`--allow-writes` opt-in**: enables INSERT / UPDATE / DELETE / storage upload tools. Requires the user to explicitly pass this flag. The planner emits a warning in its output confirming mutation mode is active.
- **`--admin` opt-in**: enables the `admin` createClient using `SUPABASE_SECRET_KEY`. All RLS bypass operations are logged to `.harness/mcp-audit.jsonl` with an `ADMIN_BYPASS` annotation. Requires both `SUPABASE_SECRET_KEY` to be set and this flag.
- **Local-first recommendation**: README instructs users to point the agent at a local `supabase start` stack first. Remote production URLs work but carry no automatic guard against accidental data modification beyond the flag gates above.
- **Secrets via ENV only**: `SUPABASE_KEY` and `SUPABASE_SECRET_KEY` are never written to any scaffolded file. The `.harness/.env.example` file lists placeholder names; actual `.harness/.env` is listed in the scaffolded `.gitignore`.

## Consequences

### Positive

- Gives developers a working pattern for the most security-sensitive part of Supabase: key-tier selection. Getting anon vs. authenticated vs. service_role right is the most common Supabase mistake; the harness encodes the correct default.
- pgvector + RLS demonstration addresses a real 2026 AI-agent use-case: multi-tenant RAG where each user's documents must remain isolated.
- Local-stack-first approach means the example runs safely with zero cloud credentials during evaluation.
- The three-agent design (planner → executor → verifier) maps cleanly to how real data agents work: intent → retrieval → validation.

### Limitations

- Supabase does not offer a test-key prefix (unlike Stripe). The local Docker stack is the only true sandbox; the README explicitly states this and links to `supabase start` docs.
- The example does not scaffold Realtime subscriptions (Postgres CDC); that is a streaming use-case that requires persistent connections ill-suited to a one-shot scaffold demo. Mentioned as a future extension.
- Edge Functions (Deno) are not demonstrated; the example stays in Node ≥ 20 for compatibility with the metaharness CLI runtime.
- The pgvector `match_documents` RPC pattern requires the user's Supabase project to have the `pgvector` extension enabled and a `document_sections` table with an `embedding vector(1536)` column and RLS enabled. The scaffold emits a `doctor` check that tests for this and prints a setup SQL snippet if it is absent.

### Not-for-production disclaimer

This example is illustrative. It is not a production-hardened data access layer, is not GDPR-compliant out of the box, and does not constitute security advice. Enabling `--admin` (service-role bypass) in production without additional audit controls carries significant data-exposure risk. Review Supabase's own security documentation and RLS policy guidance before deploying any agent that modifies production data.
