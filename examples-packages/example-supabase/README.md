# @metaharness/example-supabase

**RLS-aware data agent over Postgres + Auth + Storage — anon vs. service-role keys, pgvector RAG, verification-gated output.**

> **Illustrative output disclaimer**: This package scaffolds an *example* agent harness. The queries, RLS policy snippets, and pgvector patterns shown in generated files are illustrative. They demonstrate the integration pattern; they are not a production-hardened data access layer and have not been reviewed for GDPR, SOC 2, or any other compliance framework. Review Supabase's security documentation before connecting an agent to production data.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-supabase?label=npm)](https://www.npmjs.com/package/@metaharness/example-supabase)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-supabase)](https://www.npmjs.com/package/@metaharness/example-supabase)
[![license](https://img.shields.io/npm/l/@metaharness/example-supabase)](./LICENSE)
[![node](https://img.shields.io/node/v/@metaharness/example-supabase)](https://nodejs.org/)
[![built with metaharness](https://img.shields.io/badge/built%20with-metaharness-6E40C9)](https://github.com/ruvnet/agent-harness-generator)

---

## Intro

`@metaharness/example-supabase` is one package in the [MetaHarness SDK showcase series](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md) (ADR-051). Running it with `npx` scaffolds a ready-to-run agent harness pre-wired to your Supabase project using the official `@supabase/supabase-js` v2 SDK.

**What it is**: a scaffold that drops a three-agent harness (planner, executor, verifier) into a new directory, configured for the host of your choice (Claude Code, Codex, Copilot, GitHub Actions, and others). It demonstrates the correct anon vs. service-role key distinction, RLS-filtered querying, pgvector semantic search with per-user data isolation, and Storage bucket inspection — all read-only by default.

**What it is NOT**: a framework, an ORM, a production data API, or a compliance tool. It does not manage migrations, schema design, or auth flows beyond what is needed to illustrate the integration pattern.

---

## Features

| MetaHarness capability | How this example shows it |
|---|---|
| **Tiered model routing** (ADR-026) | Planner + Executor use a cheap (Haiku-class) model for intent parsing and SQL generation; the Verifier uses a frontier (Sonnet-class) model for RLS consistency checks and final answer synthesis |
| **MCP default-deny** (ADR-022) | `.harness/mcp-policy.json` grants only five read tools by default; five mutation tools are gated behind `--allow-writes` / `--admin` flags; every call is appended to `.harness/mcp-audit.jsonl` |
| **Slash command** | `/supabase-query` — natural-language data question routed through all three agents |
| **Specialized agents** | `planner` (intent → task list), `executor` (queries → raw results), `verifier` (RLS consistency check → verified answer) |
| **Verification gate** (ADR-050) | The verifier agent reads back row counts and compares them against the active auth context before emitting a "done" signal; mismatches are surfaced as warnings, not silently discarded |
| **RLS-aware key tiers** | Demonstrates anon vs. authenticated vs. service_role Postgres roles with concrete before/after row counts |
| **pgvector RAG with RLS** | `match_documents` RPC shows that vector similarity search silently respects per-user RLS policies |
| **Storage inspection** | Lists public and private bucket objects under the current auth context |

---

## Quickstart

```bash
npx @metaharness/example-supabase@latest my-bot
cd my-bot
npm install
npm run doctor
```

The `doctor` script checks that:

- Node >= 20 is available
- `SUPABASE_URL` and `SUPABASE_KEY` are set
- The Supabase project (or local stack) is reachable
- The `pgvector` extension and a `document_sections` table exist (optional — prints setup SQL if absent)

To scaffold for a different host:

```bash
# Single host
npx @metaharness/example-supabase@latest my-bot --host codex

# All supported hosts at once
npx @metaharness/example-supabase@latest my-bot --host all
```

Supported hosts: `claude-code` (default), `codex`, `copilot`, `github-actions`, `hermes`, `openclaw`, `opencode`, `pi-dev`, `rvm`.

---

## Configuration

### Required environment variables

| Variable | Description | Where to get it |
|---|---|---|
| `SUPABASE_URL` | Your project URL | Supabase Dashboard → Project Settings → API, or `http://127.0.0.1:54321` for local |
| `SUPABASE_KEY` | Publishable key (new: `sb_publishable_…`; legacy: anon JWT) | Dashboard → API → Publishable key |

### Optional environment variables

| Variable | Description | When needed |
|---|---|---|
| `SUPABASE_SECRET_KEY` | Secret key (new: `sb_secret_…`; legacy: service_role JWT) | Only with `--admin` flag |

**Never commit either key to source control.** The scaffold places both variables in `.harness/.env` (gitignored) and generates a `.harness/.env.example` with placeholder values.

### Legacy key names (pre-November 2025 projects)

If your Supabase project was created before November 2025, you will have legacy JWT keys. Map them as follows:

```bash
# Legacy → new env var names (values are your existing JWT strings)
SUPABASE_KEY=<your SUPABASE_ANON_KEY value>
SUPABASE_SECRET_KEY=<your SUPABASE_SERVICE_ROLE_KEY value>
```

### Local development (recommended starting point)

Supabase does not offer a test-key prefix equivalent to Stripe's `sk_test_`. The safe path for local development is the Supabase CLI Docker stack:

```bash
npm install -g supabase          # or: brew install supabase/tap/supabase
supabase init                    # in your project root
supabase start                   # starts Postgres + Auth + Storage + Realtime locally
supabase status -o env           # prints SUPABASE_URL, SUPABASE_KEY, SUPABASE_SECRET_KEY
```

Copy the output of `supabase status -o env` into `.harness/.env`. The local stack runs at `http://127.0.0.1:54321` and uses deterministic local keys safe to discard after development.

---

## Usage

### Slash command

```
/supabase-query <natural language question>
```

Examples:

```
/supabase-query How many documents does the current user own?
/supabase-query Find the three most similar documents to "neural network training tips"
/supabase-query List all public storage buckets and their object counts
```

The command routes through planner → executor → verifier and labels every response with the active auth context (`anon`, `authenticated as <email>`, or `admin (RLS bypassed)`).

### Representative prompt (no slash command)

```
Using my Supabase project, show me which rows in the "posts" table are visible
to an anonymous visitor versus a signed-in user with email alice@example.com.
Explain any RLS policies that explain the difference.
```

### Running with user authentication

```bash
SUPABASE_USER_EMAIL=alice@example.com \
SUPABASE_USER_PASSWORD=hunter2 \
npx @metaharness/example-supabase@latest my-bot --user
```

Or export the variables and pass `--user`:

```bash
export SUPABASE_USER_EMAIL=alice@example.com
export SUPABASE_USER_PASSWORD=hunter2
npm start -- --user
```

### Enabling write operations (explicit opt-in)

```bash
npm start -- --allow-writes
```

When `--allow-writes` is set, the planner emits a console warning and the MCP policy unlocks the `supabase__insert`, `supabase__update`, `supabase__delete`, and `supabase__storage_upload` tools. All mutations are logged to `.harness/mcp-audit.jsonl`.

### Enabling service-role / admin access (explicit opt-in)

```bash
npm start -- --admin
```

Requires `SUPABASE_SECRET_KEY` to be set. Creates a second Supabase client under the `service_role` Postgres role (RLS bypassed). Every query made via the admin client is annotated `ADMIN_BYPASS` in `.harness/mcp-audit.jsonl`. Do not use `--admin` against production data without reviewing the audit log.

---

## Safety

- **Read-only by default.** No INSERT, UPDATE, DELETE, or Storage upload is performed unless `--allow-writes` is explicitly passed.
- **RLS is your boundary, not the agent.** The agent uses the publishable key (`anon` role) by default; your RLS policies determine what data is visible. If a table has no RLS policy, the `anon` role can read every row in that table. Run `npm run doctor` to check for tables accessible to `anon` without RLS enabled.
- **Secret key is never the default.** `SUPABASE_SECRET_KEY` is only loaded when `--admin` is passed. If you do not pass `--admin`, the variable is never read even if it is present in the environment.
- **Secrets via ENV only.** Neither `SUPABASE_KEY` nor `SUPABASE_SECRET_KEY` appears in any scaffolded source file. `.harness/.env` is appended to `.gitignore` by the scaffold.
- **Audit log.** Every MCP tool call — including which key tier was used — is appended to `.harness/mcp-audit.jsonl` with an ISO timestamp and arguments hash.
- **Not-for-production.** This example is illustrative. Connecting any agent to a Supabase production project requires you to independently review your RLS policies, key rotation schedule, and audit log practices. This scaffold does not constitute security or compliance advice.

---

## How it works

### Agents and routing

```
User prompt
    │
    ▼
[planner agent — cheap tier]
    Parses intent, resolves table/bucket/vector-column names,
    emits a structured task list: [{op, table, filter, limit}]
    │
    ▼
[executor agent — cheap tier]
    Runs Supabase queries via @supabase/supabase-js:
      • supabase.from(table).select(cols).limit(n)   — anon or authenticated
      • supabase.rpc('match_documents', {embedding, threshold, count})
      • supabase.storage.from(bucket).list()
    Collects raw results; paginates if needed.
    │
    ▼
[verifier agent — frontier tier]
    Reads back row counts; checks that visible rows are consistent
    with auth.uid() for the signed-in user; flags any anomaly.
    Emits final answer with auth-context label.
    Gates "done" — no answer leaves the harness unverified.
```

### MCP policy — granted tools (default read-only)

```json
{
  "default": "deny",
  "audit_log": true,
  "grants": [
    "supabase__query",
    "supabase__rpc",
    "supabase__auth_sign_in",
    "supabase__auth_sign_out",
    "supabase__storage_list"
  ]
}
```

Opt-in tools (require explicit flags): `supabase__insert`, `supabase__update`, `supabase__delete`, `supabase__storage_upload`, `supabase__admin_query`.

### Key-tier flow

```
SUPABASE_KEY (publishable)
  └─► createClient(url, key)  →  Postgres anon role  →  RLS applies
        │
        ├─ sign in with email/password
        │    └─► supabase.auth.signInWithPassword()
        │         auth JWT attached to subsequent requests
        │         →  Postgres authenticated role  →  RLS with auth.uid()
        │
        └─ [--admin flag only]
SUPABASE_SECRET_KEY (secret)
  └─► createClient(url, secret)  →  Postgres service_role  →  RLS bypassed
        All calls annotated ADMIN_BYPASS in audit log
```

### pgvector RLS pattern

```sql
-- Example Postgres function (generated by doctor --setup-pgvector):
create or replace function match_documents(
  query_embedding vector(1536),
  match_threshold float,
  match_count     int
)
returns table (id uuid, content text, similarity float)
language sql security invoker set search_path = ''
as $$
  select id, content, 1 - (embedding <=> query_embedding) as similarity
  from   document_sections
  where  1 - (embedding <=> query_embedding) > match_threshold
  order  by embedding <=> query_embedding
  limit  match_count;
$$;
```

Because the function uses `security invoker`, the caller's Postgres role (and therefore their RLS policies) applies to the underlying table scan. An `anon` caller sees only their permitted rows; an `authenticated` caller sees their own documents. The verifier confirms the returned set is consistent with `auth.uid()`.

---

## Links

- `@supabase/supabase-js` on npm: https://www.npmjs.com/package/@supabase/supabase-js
- Supabase JavaScript Reference: https://supabase.com/docs/reference/javascript/introduction
- Row Level Security guide: https://supabase.com/docs/guides/database/postgres/row-level-security
- API key migration guide: https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys
- pgvector + RAG with permissions: https://supabase.com/docs/guides/ai/rag-with-permissions
- Local development guide: https://supabase.com/docs/guides/local-development
- ADR-060 (this package): https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-060-example-supabase.md
- ADR-051 (examples program): https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md
- MetaHarness generator: https://github.com/ruvnet/agent-harness-generator
