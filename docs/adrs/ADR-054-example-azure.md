# ADR-054: example-azure — Microsoft Azure SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Microsoft Azure is the second-largest public cloud platform, widely adopted in enterprise environments. Agents that work with Azure must navigate three interconnected concerns: identity (Microsoft Entra ID / formerly Azure Active Directory), resource governance (subscriptions, resource groups, RBAC), and AI-augmented workloads (Azure OpenAI Service). Azure is the dominant cloud for regulated industries — financial services, healthcare, government — meaning the agent harness must default to safe, read-only operations and surface explicit opt-in gates for any mutation.

The Azure JavaScript SDK (`@azure/*`) is the canonical client surface. `@azure/identity` v4.x (current: 4.13.1 as of mid-2026) provides `DefaultAzureCredential`, which chains environment variables, managed identity, Azure CLI, and Azure Developer CLI authentication in order — making the same credential code work in CI, on a developer laptop, and inside an Azure-hosted workload without branching. `@azure/arm-resources` provides `ResourceManagementClient` for listing and managing resource groups and subscriptions. `@azure/storage-blob` v12 provides `BlobServiceClient` for container and blob operations. For Azure OpenAI, the recommended import as of `@azure/openai` v2.x is `import { AzureOpenAI } from "openai"` with the `@azure/openai` package installed alongside to supply Azure-specific type augmentations and `getBearerTokenProvider`; the `openai` npm package (not a separate `@azure/openai`-only client) is the primary runtime dependency.

Azure has no universal "sandbox" mode. Safe-by-default is achieved through: read-only RBAC roles (Reader, Storage Blob Data Reader, Cognitive Services OpenAI User) that prevent any mutation even if code attempts it; Azurite (the local storage emulator) for Blob operations; and prompt-level dry-run logic in the agent (listing resources, generating a plan, and presenting it for approval before any `PUT`/`DELETE` is issued). Mutation — creating resource groups, uploading blobs, provisioning resources — is gated behind an explicit `--allow-mutations` flag in the scaffolded harness.

This ADR records the design decisions for the `@metaharness/example-azure` showcase package, conforming to the ADR-051 contract.

---

## Decision

### Chosen SDK packages

| Package | Version (verified June 2026) | Role |
|---|---|---|
| `@azure/identity` | 4.13.1 | `DefaultAzureCredential` — all auth |
| `@azure/arm-resources` | latest stable (5.x series) | `ResourceManagementClient` — resource groups + subscriptions |
| `@azure/storage-blob` | 12.32.0 | `BlobServiceClient` — container/blob operations |
| `openai` | latest stable | `AzureOpenAI` client for completions |
| `@azure/openai` | 2.0.0 | Azure-specific type augmentations + `getBearerTokenProvider` |

`@azure/arm-resources` is chosen over the higher-level `@azure/arm-subscriptions` for its broader resource-group CRUD surface, which is the most natural "infrastructure at a glance" capability. The `openai` + `@azure/openai` dual-package approach follows Microsoft's own migration guide (from `@azure/openai` v1 to the `openai`-native client), which became the recommended pattern in late 2024.

### Headline capabilities showcased

1. **Resource group inventory** — list all resource groups in a subscription with location and tag metadata (read-only, safe by default).
2. **Blob container audit** — list containers in a storage account, surface access tier and public-access settings (read-only; uses Azurite locally).
3. **Azure OpenAI completion** — send a chat completion through an Azure-hosted model deployment, demonstrating Entra ID keyless auth via `getBearerTokenProvider` + `DefaultAzureCredential`.
4. **Mutation gate** — create a resource group or upload a blob, gated behind `--allow-mutations`; agent presents a dry-run plan first and requires confirmation before issuing the ARM `PUT`.

### Agent and skill design

The scaffold emits three specialized agents and one `/azure` slash command:

**`agents/planner.md` (Tier 2 — Haiku)**
Fan-out agent. Accepts a natural-language request ("summarise my Azure footprint"), decomposes it into sub-tasks (which subscription/resource group, which storage account, what OpenAI deployment), and emits a structured task plan. Uses cheap-tier model because the work is extraction and structuring, not reasoning.

**`agents/executor.md` (Tier 3 — Sonnet/Opus)**
Drives SDK calls: calls `ResourceManagementClient.resourceGroups.list()`, `BlobServiceClient.listContainers()`, and `AzureOpenAI.chat.completions.create()`. Holds the MCP tool grants from `.harness/mcp-policy.json`. Applies the mutation gate: if `--allow-mutations` is absent, any ARM write or blob upload is replaced with a logged dry-run record. Uses frontier-tier model because it must reason about partial failures, pagination, and policy decisions.

**`agents/verifier.md` (Tier 2 — Haiku)**
Re-reads the output of executor against the live platform: lists the same resource groups a second time and cross-checks against the executor's report; for blobs, re-lists containers and confirms the reported count. Flags discrepancies before the harness surfaces the result as done. This is the verification gate required by ADR-050.

**`/azure` slash command**
Invoked as `/azure <goal>` (e.g. `/azure list all resource groups in eastus`, `/azure audit storage account mystorage`, `/azure summarise OpenAI usage this month`). Routes to planner → executor → verifier in sequence.

### Tiered model routing (ADR-026)

| Tier | Model | Used for |
|---|---|---|
| 1 | Agent Booster / WASM | Simple template fills — skip LLM |
| 2 | Haiku | Planner decomposition, verifier re-check |
| 3 | Sonnet | Executor reasoning: policy gates, error handling, plan confirmation |

The frontier tier (Opus) is reserved for the mutation gate: when `--allow-mutations` is present and the executor is about to issue a destructive call, it escalates to Opus for a final confirmation reasoning step before submitting.

### MCP policy — granted tools only

`.harness/mcp-policy.json` (default-deny, per ADR-022):

```json
{
  "version": 1,
  "default": "deny",
  "audit_log": ".harness/mcp-audit.jsonl",
  "grants": [
    { "tool": "azure.resourceGroups.list",        "tier": 2 },
    { "tool": "azure.resourceGroups.get",         "tier": 2 },
    { "tool": "azure.subscriptions.list",         "tier": 2 },
    { "tool": "azure.blobs.listContainers",       "tier": 2 },
    { "tool": "azure.blobs.listBlobs",            "tier": 2 },
    { "tool": "azure.openai.chatComplete",        "tier": 3 },
    { "tool": "azure.resourceGroups.createOrUpdate", "tier": 3, "requires_flag": "allow_mutations" },
    { "tool": "azure.blobs.uploadBlob",           "tier": 3, "requires_flag": "allow_mutations" }
  ]
}
```

All write tools require the `allow_mutations` flag at the harness level. All tool calls are appended to `.harness/mcp-audit.jsonl` with timestamp, tool name, caller agent, and flag state.

### Auth model

`DefaultAzureCredential` is used for all clients. The credential chain, in order:

1. `EnvironmentCredential` — reads `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET` (or `AZURE_CLIENT_CERTIFICATE_PATH`)
2. `WorkloadIdentityCredential` — Kubernetes workload identity
3. `ManagedIdentityCredential` — Azure-hosted workloads (App Service, AKS, Functions, VMs)
4. `AzureCliCredential` — developer local (`az login`)
5. `AzureDeveloperCliCredential` — developer local (`azd auth login`)

For Azure OpenAI, the scope `https://cognitiveservices.azure.com/.default` is passed to `getBearerTokenProvider(credential, scope)` to obtain the bearer token, enabling keyless Entra ID auth without an API key.

Required env vars:
- `AZURE_SUBSCRIPTION_ID` — target subscription
- `AZURE_TENANT_ID` — Entra ID tenant (if using service principal)
- `AZURE_CLIENT_ID` — service principal or managed identity client ID
- `AZURE_CLIENT_SECRET` — service principal secret (or use cert / federated token)
- `AZURE_STORAGE_ACCOUNT_NAME` — storage account for blob operations
- `AZURE_OPENAI_ENDPOINT` — Azure OpenAI resource endpoint (`https://<resource>.openai.azure.com/`)
- `AZURE_OPENAI_DEPLOYMENT` — model deployment name (e.g. `gpt-4o`)

### Safety gates

- **Read-only by default**: the scaffolded harness assigns only Reader + Storage Blob Data Reader + Cognitive Services OpenAI User roles in its setup instructions. Even if mutation tools exist in the MCP grant list, they carry `requires_flag: allow_mutations`.
- **No sandbox mode**: Azure has no universal test-key mode. Safety is achieved through RBAC (no write permission at the IAM level), Azurite for local blob development, and dry-run logic in the executor that logs what it _would_ do without calling the SDK.
- **`--allow-mutations` flag**: must be passed explicitly to `npx @metaharness/example-azure my-bot --allow-mutations`. The scaffolded `HARNESS_ALLOW_MUTATIONS=false` default in `.env.example` enforces the safe default even when the flag is accidentally set.
- **Azurite integration**: the scaffold ships an `npm run azurite` convenience script that starts the local Blob/Queue/Table emulator. When `AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true` is detected, the harness automatically routes blob operations to Azurite, preventing accidental real-storage writes.
- **Secrets never in files**: all secrets are loaded exclusively from environment variables. The scaffold emits `.env.example` with placeholder values and `.gitignore` entries covering `.env`, `*.pem`, and `*.pfx`.

---

## Consequences

### Positive

- Demonstrates `DefaultAzureCredential`'s environment-to-managed-identity graduation path: the same harness code runs on a developer laptop (via `az login`) and in Azure (via managed identity) without modification.
- Covers the three most common Azure agent touchpoints — ARM resource management, Blob storage, and Azure OpenAI — in a single scaffold, giving teams a credible starting point for enterprise automation.
- The mutation gate + Azurite defaults mean the harness can be run in CI against a real Azure subscription (read-only) or fully locally (Azurite) without cost or risk.
- Tiered routing keeps Azure OpenAI token spend proportional to task complexity; extraction (Haiku) stays cheap, decisions (Sonnet/Opus) use appropriate power.
- All MCP tool calls are audited to `.harness/mcp-audit.jsonl` — satisfying enterprise compliance requirements for agent action logging.

### Honest limitations

- Azure has no universal "test mode" or sandbox subscription equivalent to Stripe test keys. The read-only RBAC defaults are the safety mechanism; developers need a real Azure subscription to test end-to-end (or use Azurite for blob-only scenarios). A free Azure account (https://azure.microsoft.com/free/) provides $200 credits.
- `@azure/openai` v2.0.0 marked itself as "last published 2 years ago" on npm in mid-2026. The recommended pattern is to use the `openai` package directly with `@azure/openai` for type augmentations; if `@azure/openai` v2 is stale, the scaffold should pin `openai` at latest and `@azure/openai` at `^2.0.0` and note in the README that the primary runtime is `openai`.
- The verifier agent can only re-check state that is observable via the SDK (list calls). It cannot verify that a resource group creation _will_ succeed before attempting it; the mutation gate's dry-run is a logging stub, not an ARM what-if API call. For true pre-flight validation, operators should integrate the ARM `what-if` deployment API (separate from this scaffold's scope).
- This example is not certified for HIPAA, PCI-DSS, FedRAMP, or any regulated workload. Azure compliance certifications apply to the Azure platform itself; the harness is a development scaffold, not a production-hardened application.

> **Not for production**: this scaffold is an illustrative starting point for developers. It is not a security-hardened, compliance-certified, or production-ready deployment. Conduct your own security review and regulatory assessment before using agent-driven Azure automation in production or regulated environments.
