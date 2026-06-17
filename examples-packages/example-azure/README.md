# @metaharness/example-azure

**MetaHarness scaffold for Microsoft Azure — resource management, Blob storage, and Azure OpenAI via DefaultAzureCredential**

> **Illustrative output.** Code samples and example transcripts shown in this README are representative — actual output depends on your Azure subscription, resource configuration, deployed models, and environment. Run the commands to see real results.

[![npm version](https://img.shields.io/npm/v/@metaharness/example-azure?label=npm)](https://www.npmjs.com/package/@metaharness/example-azure)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-azure)](https://www.npmjs.com/package/@metaharness/example-azure)
[![license](https://img.shields.io/npm/l/@metaharness/example-azure)](LICENSE)
[![node](https://img.shields.io/node/v/@metaharness/example-azure)](https://nodejs.org)
[![built with metaharness](https://img.shields.io/badge/built%20with-metaharness-6c6ef2)](https://github.com/ruvnet/agent-harness-generator)

---

## Intro

`@metaharness/example-azure` scaffolds a ready-to-run multi-agent harness pre-wired to the Microsoft Azure JavaScript SDK. One command gives you a project directory containing specialized agents, a scoped MCP policy, a `/azure` slash command, and safe defaults that prevent accidental mutations to your Azure environment.

**What it is**: a development scaffold and learning tool. It demonstrates how to structure an agent harness that drives Azure resource management (`@azure/arm-resources`), Blob storage (`@azure/storage-blob`), and Azure OpenAI chat completions (`openai` + `@azure/openai`) using `DefaultAzureCredential` from `@azure/identity`.

**What it is not**: a production-hardened, compliance-certified, or security-audited deployment. It is not HIPAA-compliant, PCI-DSS-certified, or FedRAMP-authorized out of the box. Conduct your own security review before using agent-driven Azure automation in any regulated or production context. This scaffold does NOT replace a qualified security architect or cloud compliance program.

---

## Features

| MetaHarness capability | How this example shows it |
|---|---|
| **Tiered model routing** | Haiku for fan-out planning and verification re-checks; Sonnet for executor reasoning; Opus only for mutation approval |
| **MCP default-deny** | `.harness/mcp-policy.json` grants only 6 read tools + 2 write tools (write tools require `allow_mutations` flag); all calls logged to `.harness/mcp-audit.jsonl` |
| **Slash command** | `/azure <goal>` routes to planner → executor → verifier |
| **Specialized agents** | `planner` (Haiku), `executor` (Sonnet), `verifier` (Haiku) |
| **Verification gate** | Verifier re-lists resource groups and blob containers after executor runs, cross-checks counts and names before reporting done |
| **Read-only by default** | Mutation tools (create resource group, upload blob) require `--allow-mutations` flag AND explicit confirmation |

### Azure-specific capabilities demonstrated

- List all resource groups in a subscription with location, tags, and provisioning state
- List blob containers in a storage account with access tier and public-access settings
- Send chat completions through an Azure OpenAI deployment using Entra ID keyless auth
- Dry-run mode: executor logs what it _would_ do for any write operation when mutations are disabled
- Local Azurite integration: blob operations route to the local emulator when `AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true`

---

## Quickstart

```bash
npx @metaharness/example-azure@latest my-bot
cd my-bot && npm install && npm run doctor
```

`npm run doctor` checks that `DefaultAzureCredential` can acquire a token, that `AZURE_SUBSCRIPTION_ID` is set, and that the MCP policy file is present and valid.

### Scaffold on a specific host

```bash
# Default: Claude Code
npx @metaharness/example-azure@latest my-bot

# GitHub Actions workflow
npx @metaharness/example-azure@latest my-bot --host github-actions

# All hosts at once
npx @metaharness/example-azure@latest my-bot --host all
```

Supported hosts: `claude-code`, `codex`, `copilot`, `github-actions`, `hermes`, `openclaw`, `opencode`, `pi-dev`, `rvm`. Host wiring delegates to `@metaharness/host-<id>`.

---

## Configuration

### Required environment variables

Copy `.env.example` to `.env` (already in `.gitignore`) and fill in your values:

```bash
# Azure identity — service principal (used by EnvironmentCredential)
AZURE_TENANT_ID=your-entra-tenant-id
AZURE_CLIENT_ID=your-app-registration-client-id
AZURE_CLIENT_SECRET=your-client-secret

# Target subscription
AZURE_SUBSCRIPTION_ID=your-subscription-id

# Blob storage
AZURE_STORAGE_ACCOUNT_NAME=yourstorageaccount
# For local Azurite development (overrides real storage):
# AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true

# Azure OpenAI
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=gpt-4o
# API version (defaults to 2024-10-21 if unset)
AZURE_OPENAI_API_VERSION=2024-10-21
```

### How to get credentials

1. **Azure subscription**: Sign up at https://azure.microsoft.com/free/ (free account includes $200 credit).
2. **Service principal**: `az ad sp create-for-rbac --name my-harness-sp --role Reader --scopes /subscriptions/<id>` — copy `appId` (AZURE_CLIENT_ID), `tenant` (AZURE_TENANT_ID), `password` (AZURE_CLIENT_SECRET).
3. **Storage Blob Data Reader role**: `az role assignment create --assignee <clientId> --role "Storage Blob Data Reader" --scope /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>`.
4. **Cognitive Services OpenAI User role**: `az role assignment create --assignee <clientId> --role "Cognitive Services OpenAI User" --scope /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<resource>`.
5. **Azure OpenAI endpoint**: Azure portal > your OpenAI resource > Keys and Endpoint. The endpoint format is `https://<resource-name>.openai.azure.com/`.

### Local development without real Azure (Azurite)

```bash
npm run azurite          # starts Azurite on localhost:10000/10001/10002
# Then set in .env:
# AZURE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true
```

The harness detects `UseDevelopmentStorage=true` and routes all blob operations to Azurite automatically. You still need a real Azure subscription for ARM resource listing and Azure OpenAI calls.

### Developer auth (no service principal needed)

```bash
az login                 # or: azd auth login
# Then unset AZURE_CLIENT_ID/AZURE_TENANT_ID/AZURE_CLIENT_SECRET —
# DefaultAzureCredential falls through to AzureCliCredential automatically.
```

---

## Usage

### Slash command

```
/azure list all resource groups in eastus
/azure audit storage account mystorage and show public-access containers
/azure summarise Azure OpenAI usage and estimate token spend
```

The command routes: planner (Haiku, decomposes goal) → executor (Sonnet, drives SDK) → verifier (Haiku, re-checks against live platform) → result.

### Natural-language prompts

```
"List every resource group in my subscription with its location and tags."

"Check my storage account 'mystorage' for containers with public blob access
 enabled and report them as a potential misconfiguration."

"Ask the gpt-4o deployment: what are the top 3 Azure security best practices
 for a startup? Use keyless Entra ID auth."
```

### Enabling mutations (opt-in)

The harness defaults to read-only. To allow writes, set the flag at scaffold time:

```bash
npx @metaharness/example-azure@latest my-bot --allow-mutations
```

Or set `HARNESS_ALLOW_MUTATIONS=true` in `.env` after scaffolding. With mutations enabled, the executor will:

1. Generate a dry-run plan (logged to `.harness/mcp-audit.jsonl`)
2. Present the plan and ask for explicit confirmation
3. Only then call the write SDK method (e.g. `resourceGroups.createOrUpdate`, `BlockBlobClient.upload`)
4. Verifier re-checks the result via a read-back call

---

## Safety

- **Secrets via ENV only**: no credentials are ever written to scaffolded files. `.env.example` contains only placeholder values. `.gitignore` covers `.env`, `*.pem`, `*.pfx`, and `.harness/mcp-audit.jsonl`.
- **Read-only by default**: mutation MCP tools (`azure.resourceGroups.createOrUpdate`, `azure.blobs.uploadBlob`) are granted in the policy but carry `requires_flag: allow_mutations`. The harness sets `HARNESS_ALLOW_MUTATIONS=false` by default.
- **No Azure sandbox**: Azure has no universal test-key mode. Read-only RBAC roles (Reader, Storage Blob Data Reader) prevent mutations at the platform level even if code attempts them. For local blob development, use Azurite.
- **MCP audit log**: every tool call is appended to `.harness/mcp-audit.jsonl` with timestamp, tool name, calling agent, flag state, and whether it was allowed or denied.
- **Verification gate**: the verifier agent always re-checks output against the live API before the harness reports done. Discrepancies are flagged, not silently dropped.
- **Not for production / not certified**: this scaffold is a developer starting point. It is not a security-hardened deployment and carries no compliance certifications (HIPAA, PCI-DSS, FedRAMP, ISO 27001, SOC 2). Azure platform certifications apply to Azure itself, not to code you build on top of it.

---

## How it works

### Agents

```
planner (Haiku)
  Receives: natural-language goal
  Emits: structured task list (which subscription, resource groups,
         storage account, OpenAI deployment, what to check)

executor (Sonnet)
  Receives: task list from planner
  Drives: ResourceManagementClient.resourceGroups.list()
          BlobServiceClient.listContainers()
          AzureOpenAI.chat.completions.create()
  Applies: mutation gate (dry-run if allow_mutations=false)
  Emits: raw SDK results + plan confirmation for writes

verifier (Haiku)
  Receives: executor's reported results
  Re-calls: same list APIs independently
  Cross-checks: counts, names, container settings
  Emits: verified result or discrepancy report
```

### Routing tiers

| Tier | Model | Task |
|---|---|---|
| 1 | WASM booster | Template fills — no LLM |
| 2 | Haiku | Planner decomposition; verifier re-check |
| 3 | Sonnet | Executor: SDK calls, policy reasoning, error handling |
| 3+ | Opus | Mutation approval (escalated only when allow_mutations=true) |

### MCP policy (granted tools)

Defined in `.harness/mcp-policy.json` (default-deny):

| Tool | Tier | Mutation flag required |
|---|---|---|
| `azure.resourceGroups.list` | 2 | No |
| `azure.resourceGroups.get` | 2 | No |
| `azure.subscriptions.list` | 2 | No |
| `azure.blobs.listContainers` | 2 | No |
| `azure.blobs.listBlobs` | 2 | No |
| `azure.openai.chatComplete` | 3 | No |
| `azure.resourceGroups.createOrUpdate` | 3 | Yes (`allow_mutations`) |
| `azure.blobs.uploadBlob` | 3 | Yes (`allow_mutations`) |

All other tools: denied. All calls audited to `.harness/mcp-audit.jsonl`.

---

## Links

- Azure Identity JS README: https://learn.microsoft.com/en-us/javascript/api/overview/azure/identity-readme
- `@azure/identity` npm: https://www.npmjs.com/package/@azure/identity
- `@azure/arm-resources` npm: https://www.npmjs.com/package/@azure/arm-resources
- `@azure/storage-blob` npm: https://www.npmjs.com/package/@azure/storage-blob
- Azure OpenAI JS library: https://learn.microsoft.com/en-us/javascript/api/overview/azure/openai-readme
- `openai` npm (AzureOpenAI client): https://www.npmjs.com/package/openai
- Azurite local emulator: https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azurite
- DefaultAzureCredential overview: https://aka.ms/azsdk/js/identity/credential-chains
- ADR-054 (this design): https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-054-example-azure.md
- ADR-051 (examples program): https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md
