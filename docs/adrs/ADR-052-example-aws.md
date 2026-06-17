# ADR-052: example-aws — Amazon Web Services SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Amazon Web Services is the dominant cloud platform for agents deployed in production. When a generated harness needs to provision compute, store artefacts, invoke serverless functions, or query a managed database, the answer is almost always one or more AWS services. AWS SDK for JavaScript v3 (`@aws-sdk/*`) is the current-generation, fully modular SDK: each service ships as its own npm package under the `@aws-sdk/` scope, enabling tree-shaking and keeping install size proportional to what an agent actually uses.

The combination of S3 (object storage), EC2 (virtual machines), Lambda (serverless), DynamoDB (key-value / document store), and STS (identity / role chaining) covers the core of what an infrastructure-facing agent realistically drives. An agent that can query and — under explicit opt-in — provision resources across these five services demonstrates the full lifecycle: describe → plan → verify → (optional) execute.

AWS has no universal "sandbox" mode, but it provides two credible safe alternatives: (1) EC2's native `DryRun` parameter, which validates IAM permissions without performing the action and returns a predictable `DryRunOperation` error on success; and (2) LocalStack, an open-source AWS emulator that listens at `http://localhost:4566` and is controlled by the standard `AWS_ENDPOINT_URL` environment variable recognised by all AWS SDK v3 clients. The example defaults to LocalStack-compatible operation (read + dry-run) and requires an explicit `--allow-mutations` flag before any write, deploy, or charge action reaches live AWS.

ADR-051 defines the contract every example package must satisfy. This ADR records the platform-specific decisions for the AWS showcase.

---

## Decision

### Chosen SDK

Primary packages (all `@aws-sdk/*` v3, currently `3.1070.0` as of 2026-06-17):

| Package | Service |
|---|---|
| `@aws-sdk/client-s3` | S3 — object storage, bucket listing, presigned URLs |
| `@aws-sdk/client-ec2` | EC2 — instance describe, run-instances with DryRun |
| `@aws-sdk/client-dynamodb` | DynamoDB — scan, query, put-item |
| `@aws-sdk/client-lambda` | Lambda — list functions, invoke |
| `@aws-sdk/client-sts` | STS — AssumeRole, GetCallerIdentity |
| `@aws-sdk/credential-providers` | Credential chain utilities (fromNodeProviderChain, fromTemporaryCredentials) |

All packages follow the same ESM import pattern:

```js
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
```

No monolithic `aws-sdk` v2 package is used. v2 is in maintenance mode and is explicitly excluded.

### Headline capability

The showcase demonstrates an agent that can:

1. **Discover** — list S3 buckets, EC2 instances, Lambda functions, and DynamoDB tables across a specified region.
2. **Plan** — analyse the discovered resources and produce a structured infra report with cost-risk annotations.
3. **Verify** — re-check the plan by performing dry-run EC2 operations (DryRun: true) and read-back S3/DynamoDB metadata; gate the "done" signal on this confirmation.
4. **Execute (opt-in only)** — launch EC2 instances, invoke Lambda, or write DynamoDB items, gated behind `--allow-mutations`.

The `/aws-infra` slash command drives the discovery-and-report workflow. The `/aws-role` slash command wraps STS AssumeRole so an agent can elevate to a cross-account role and re-scope its credentials.

### Agent / skill design

Three specialized agents are scaffolded:

| Agent | Role | Model tier |
|---|---|---|
| **aws-planner** | Receives the user goal; calls the discovery tools; produces a structured JSON plan with service targets and proposed actions | Tier 2 (Haiku) |
| **aws-executor** | Receives the approved plan; calls mutating APIs (dry-run by default); returns structured results | Tier 3 (Sonnet / Opus) |
| **aws-verifier** | Re-reads the resources affected by the plan (list, describe, get-item); diffs against expected state; emits a pass/fail verification report | Tier 2 (Haiku) |

The planner and verifier are Tier 2 because their tasks are structured extraction and comparison, not open-ended reasoning. The executor is Tier 3 because it must interpret ambiguous user intent, handle partial-failure paths, and decide whether to proceed or halt before touching live infrastructure.

### Routing tiers (ADR-026)

| Tier | Handler | Used for |
|---|---|---|
| 1 — Agent Booster (WASM) | <1 ms, $0 | Simple ENV validation, JSON reshaping, ARN pattern matching |
| 2 — Haiku | ~500 ms, $0.0002 | Discovery fan-out, resource listing, diff comparison, report templating |
| 3 — Sonnet / Opus | 2–5 s, $0.003–$0.015 | Infra plan decisions, cross-account role reasoning, mutation approval |

### MCP policy (ADR-022 default-deny)

The scaffolded `.harness/mcp-policy.json` grants **only**:

```json
{
  "version": "1",
  "default": "deny",
  "grants": [
    { "tool": "aws_s3_list_buckets",         "reason": "discovery" },
    { "tool": "aws_s3_head_object",          "reason": "read-back verification" },
    { "tool": "aws_ec2_describe_instances",  "reason": "discovery" },
    { "tool": "aws_ec2_run_instances_dryrun","reason": "dry-run plan validation" },
    { "tool": "aws_lambda_list_functions",   "reason": "discovery" },
    { "tool": "aws_dynamodb_describe_table", "reason": "discovery" },
    { "tool": "aws_sts_get_caller_identity", "reason": "auth sanity check" },
    { "tool": "aws_sts_assume_role",         "reason": "cross-account / role elevation" }
  ],
  "mutations_require_flag": "--allow-mutations",
  "audit_log": ".harness/mcp-audit.jsonl"
}
```

Every tool call is appended to `.harness/mcp-audit.jsonl` with timestamp, agent name, tool name, and a SHA-256 of the parameters. Mutating tools (`aws_s3_put_object`, `aws_ec2_run_instances`, `aws_lambda_invoke`, `aws_dynamodb_put_item`) are absent from the grants list by default and must be added by the operator after reviewing the policy file.

### Auth model

AWS SDK v3 resolves credentials through the standard provider chain via `fromNodeProviderChain()`:

1. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ optional `AWS_SESSION_TOKEN`) environment variables — preferred for CI/CD and agent harnesses.
2. SSO profile via `~/.aws/sso/cache` (useful for developer workstations with AWS Identity Center).
3. Web identity token (`AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`).
4. Shared credentials file (`~/.aws/credentials` / `~/.aws/config`).
5. EC2/ECS/Lambda instance metadata (IMDS) — used when the harness itself runs inside AWS.

Region is resolved from `AWS_REGION` (preferred) or `AWS_DEFAULT_REGION`. Both are accepted by every v3 client.

For cross-account or least-privilege workflows the `/aws-role` command wraps `AssumeRoleCommand` from `@aws-sdk/client-sts` and injects the returned temporary credentials into the downstream client via `fromTemporaryCredentials()`. The role ARN is supplied via `AWS_ROLE_ARN`; the session name defaults to `metaharness-session`.

### Safety gates

| Concern | Default posture | Opt-in to relax |
|---|---|---|
| Mutating EC2 (launch/terminate) | `DryRun: true` on all RunInstances calls | `--allow-mutations` flag |
| S3 writes (put, delete) | Not granted in MCP policy | Add tool grant + `--allow-mutations` |
| Lambda invoke | Not granted in MCP policy | Add tool grant + `--allow-mutations` |
| DynamoDB writes | Not granted in MCP policy | Add tool grant + `--allow-mutations` |
| Local emulation | `AWS_ENDPOINT_URL=http://localhost:4566` routes all calls to LocalStack | Unset env var to use live AWS |
| Credential exposure | Secrets are ENV-only; scaffold writes no credentials to any file | Never relax |
| IAM scope | README recommends a read-only IAM policy (`ReadOnlyAccess` managed policy) for discovery; executor role is separate | Operator responsibility |

EC2 DryRun returns error code `DryRunOperation` when the caller has permissions (the action would have succeeded) and `UnauthorizedOperation` when they do not. The verifier agent interprets `DryRunOperation` as "permission confirmed, action not taken" and surfaces this in the verification report.

---

## Consequences

### Positive

- Turns the most-asked "can the harness drive real AWS infra?" question into a one-command proof.
- `DryRun` + LocalStack combination gives genuinely safe defaults without requiring a separate AWS account.
- Modular `@aws-sdk/*` v3 packages keep the scaffold's install footprint to only the five services demonstrated.
- STS role chaining shows enterprise patterns (cross-account, least-privilege) that are directly reusable.
- The three-agent (planner / executor / verifier) pattern maps cleanly onto ADR-050's verification gate.

### Limitations

- AWS has no universal sandbox; services other than EC2 lack native dry-run. The LocalStack path is the primary safe default for non-EC2 services; it requires Docker and is an approximation of real AWS behaviour.
- `DryRun` is EC2-specific. S3, Lambda, and DynamoDB mutations are guarded by MCP policy exclusion rather than a platform-level dry-run mechanism.
- Credential resolution via IMDS (Tier 5 in the chain) adds latency in Lambda/ECS environments; the scaffold documents this and recommends explicit env var injection for predictable performance.
- AWS service quotas and IAM permission boundaries are account-specific; the example cannot pre-validate these and documents that the operator must supply an appropriately-scoped IAM policy.

### Not-for-production disclaimer

This example is illustrative. It is not audited for production security, not PCI-DSS compliant, and does not constitute a reference architecture for any regulated workload. The scaffolded MCP policy is a starting point, not a hardened baseline. Review IAM policies, enable CloudTrail, and consult AWS Well-Architected guidance before using patterns from this example in production.
