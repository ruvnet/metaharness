# @metaharness/example-aws

**AWS infra agent, scaffolded in one command — S3, EC2, Lambda, DynamoDB, STS.**

> **Illustrative output only.** The harness scaffolded by this package demonstrates how a metaharness agent can interact with AWS services. It is not a production-ready infrastructure tool, not audited for security compliance, and not a substitute for proper IAM design, CloudTrail enablement, or AWS Well-Architected review. All mutation operations (instance launch, S3 write, Lambda invoke, DynamoDB write) are disabled by default and require an explicit opt-in flag.

[![npm version](https://img.shields.io/npm/v/%40metaharness%2Fexample-aws?style=flat-square)](https://www.npmjs.com/package/@metaharness/example-aws)
[![npm downloads](https://img.shields.io/npm/dm/%40metaharness%2Fexample-aws?style=flat-square)](https://www.npmjs.com/package/@metaharness/example-aws)
[![license](https://img.shields.io/npm/l/%40metaharness%2Fexample-aws?style=flat-square)](LICENSE)
[![node](https://img.shields.io/node/v/%40metaharness%2Fexample-aws?style=flat-square)](https://nodejs.org)
[![built with metaharness](https://img.shields.io/badge/built%20with-metaharness-6366f1?style=flat-square)](https://github.com/ruvnet/agent-harness-generator)

---

## What this is

`@metaharness/example-aws` scaffolds a metaharness agent harness pre-wired to the AWS SDK for JavaScript v3 (`@aws-sdk/*`). Running the npx command drops a project directory containing:

- Three specialized agents: **aws-planner**, **aws-executor**, and **aws-verifier**
- A `/aws-infra` slash command that drives a discover-plan-verify workflow across S3, EC2, Lambda, and DynamoDB
- A `/aws-role` slash command that wraps STS AssumeRole for cross-account / least-privilege patterns
- A scoped MCP policy (default-deny) granting only the discovery and dry-run tools needed
- Tiered model routing: cheap Haiku tier for fan-out and extraction, frontier Sonnet/Opus tier for planning decisions
- A verification gate that re-reads affected resources before reporting "done"
- Host adapter configs for all nine metaharness hosts

**This is NOT:**
- A Terraform or CDK replacement
- A production infrastructure management tool
- A compliance-certified AWS automation framework
- A substitute for AWS IAM best practices or CloudTrail

---

## Features

| Capability | How it is shown |
|---|---|
| **S3 discovery** | List buckets, head objects, check bucket metadata |
| **EC2 dry-run** | `RunInstancesCommand` with `DryRun: true` — validates IAM permissions without launching an instance; interprets `DryRunOperation` / `UnauthorizedOperation` error codes |
| **Lambda inventory** | List functions, inspect runtime and last-modified |
| **DynamoDB describe** | Describe tables, read provisioned throughput |
| **STS role chaining** | `AssumeRoleCommand` → inject temporary credentials via `fromTemporaryCredentials()` |
| **Tiered routing** | Haiku for discovery fan-out; Sonnet/Opus for plan decisions and mutation approval |
| **MCP default-deny** | `.harness/mcp-policy.json` grants eight tools; mutations absent by default; every call logged to `.harness/mcp-audit.jsonl` |
| **Verification gate** | aws-verifier re-reads resources after any plan; diffs expected vs actual state; blocks "done" signal until confirmed |
| **LocalStack sandbox** | Set `AWS_ENDPOINT_URL=http://localhost:4566` to route all SDK calls to a local emulator — no live AWS required |
| **Multi-host** | `--host all` emits configs for claude-code, codex, copilot, github-actions, hermes, openclaw, opencode, pi-dev, rvm |

---

## Quickstart

```bash
npx @metaharness/example-aws@latest my-aws-bot
cd my-aws-bot
npm install
npm run doctor
```

`harness doctor` checks Node version, validates the MCP policy schema, confirms that environment variables are present (or warns if missing), and verifies that the host adapter config is well-formed.

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | Yes (or use profile) | AWS access key ID |
| `AWS_SECRET_ACCESS_KEY` | Yes (or use profile) | AWS secret access key |
| `AWS_SESSION_TOKEN` | If using temporary credentials | STS session token |
| `AWS_REGION` | Yes | Default region, e.g. `us-east-1` |
| `AWS_DEFAULT_REGION` | Alternative to `AWS_REGION` | Fallback region setting |
| `AWS_ROLE_ARN` | For `/aws-role` command | ARN of the role to assume |
| `AWS_ENDPOINT_URL` | For local emulation | Override endpoint, e.g. `http://localhost:4566` for LocalStack |

**Never put credentials in any file in the scaffold.** The scaffold writes no credentials anywhere. Use a `.env` file that is listed in `.gitignore`, or inject via your CI/CD secret manager.

### Where to get credentials

- **IAM user** (not recommended for new workloads): AWS Console → IAM → Users → Security credentials → Create access key
- **Recommended**: AWS IAM Identity Center (SSO) — run `aws configure sso`, then the SDK resolves credentials from `~/.aws/sso/cache` automatically
- **In CI**: inject `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as repository secrets

For safe discovery-only use, attach the AWS-managed `ReadOnlyAccess` policy to your IAM principal. For dry-run EC2 validation you additionally need `ec2:RunInstances` in a policy that allows it with a condition denying non-DryRun calls.

### LocalStack (sandbox / no live AWS)

Start LocalStack:

```bash
pip install localstack
localstack start -d      # or: docker run -p 4566:4566 localstack/localstack
```

Then set:

```bash
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_REGION=us-east-1
```

All SDK v3 clients in the scaffold respect `AWS_ENDPOINT_URL` automatically. LocalStack emulates S3, EC2, Lambda, DynamoDB, and STS without touching live AWS or incurring charges.

### Credential provider chain

The scaffold uses `fromNodeProviderChain()` from `@aws-sdk/credential-providers`, which resolves credentials in this order:

1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` environment variables
2. AWS SSO profile cache
3. Web identity token (`AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`)
4. Shared credentials file (`~/.aws/credentials`)
5. EC2/ECS/Lambda instance metadata (IMDS)

---

## Usage

### Slash commands

**`/aws-infra [region]`** — Discover and report on infra in the given region (defaults to `AWS_REGION`). The aws-planner agent fans out to S3, EC2, Lambda, and DynamoDB; the aws-verifier re-reads the key metadata and emits a structured JSON report with pass/fail on each service.

**`/aws-role <role-arn> [session-name]`** — Assume the specified IAM role via STS and inject the temporary credentials into subsequent agent calls. Session name defaults to `metaharness-session`.

### Representative prompts

```
"List all S3 buckets and tell me which ones have versioning disabled."

"Describe the running EC2 instances in us-west-2 and flag any that are not tagged with a cost-center."

"Check whether my IAM principal has permission to launch a t3.micro in the default VPC — don't actually launch one."

"List all Lambda functions with a Node.js 18 runtime and report which ones have not been updated in 90 days."
```

### Enabling mutations (explicit opt-in)

All mutating operations are excluded from the MCP policy by default. To enable them:

1. Open `.harness/mcp-policy.json` in the scaffolded project.
2. Add the specific tool grants you need (e.g. `aws_s3_put_object`, `aws_ec2_run_instances`, `aws_lambda_invoke`, `aws_dynamodb_put_item`).
3. Run the scaffold or agent with the `--allow-mutations` flag.

The audit log at `.harness/mcp-audit.jsonl` records every tool invocation regardless of whether mutations are enabled.

---

## Safety

- **Secrets via ENV only.** The scaffold writes no credentials to any file. Add `*.env` and `.env*` to your `.gitignore`.
- **Read-only and dry-run by default.** The MCP policy grants eight read-only and dry-run tools. No S3 write, EC2 launch, Lambda invoke, or DynamoDB write is possible without explicit policy changes.
- **EC2 DryRun.** When the aws-executor calls `RunInstancesCommand`, `DryRun: true` is set unconditionally until `--allow-mutations` is active. A `DryRunOperation` error confirms permission; `UnauthorizedOperation` confirms denial. No instance is launched in either case.
- **LocalStack first.** The recommended development workflow is `AWS_ENDPOINT_URL=http://localhost:4566`. Only unset this variable when you are ready to test against live AWS.
- **Audit log.** Every MCP tool call is appended to `.harness/mcp-audit.jsonl` with timestamp, agent, tool name, and a SHA-256 hash of the parameters.
- **Not for production.** This example is illustrative. It is not PCI-DSS compliant, not audited for the AWS Well-Architected Framework, and not a substitute for proper IAM least-privilege design, CloudTrail logging, or security review.

---

## How it works

### Agents

```
User prompt
    |
    v
aws-planner (Haiku)
  - calls aws_s3_list_buckets, aws_ec2_describe_instances,
    aws_lambda_list_functions, aws_dynamodb_describe_table
  - emits structured JSON plan
    |
    v
aws-executor (Sonnet / Opus)
  - interprets plan
  - calls aws_ec2_run_instances_dryrun for any EC2 action
  - calls mutating tools ONLY if --allow-mutations + grant present
  - emits structured result
    |
    v
aws-verifier (Haiku)
  - re-reads S3 metadata, EC2 state, Lambda config
  - diffs expected vs actual
  - emits pass/fail verification report
  - blocks "done" signal until verification passes
```

### Routing tiers

| Tier | Model | Task |
|---|---|---|
| 1 — WASM Booster | <1 ms, $0 | ENV validation, ARN pattern matching, JSON reshaping |
| 2 — Haiku | ~500 ms | Discovery fan-out, resource listing, diff comparison, report templating |
| 3 — Sonnet / Opus | 2–5 s | Infra plan decisions, mutation approval, cross-account reasoning |

### MCP policy — granted tools

The `.harness/mcp-policy.json` grants these eight tools by default:

| Tool | Purpose |
|---|---|
| `aws_s3_list_buckets` | S3 discovery |
| `aws_s3_head_object` | S3 read-back verification |
| `aws_ec2_describe_instances` | EC2 discovery |
| `aws_ec2_run_instances_dryrun` | EC2 permission validation without launch |
| `aws_lambda_list_functions` | Lambda discovery |
| `aws_dynamodb_describe_table` | DynamoDB discovery |
| `aws_sts_get_caller_identity` | Auth sanity check |
| `aws_sts_assume_role` | Cross-account / role elevation |

Mutating tools are absent. Every call is logged to `.harness/mcp-audit.jsonl`.

---

## Links

- [AWS SDK for JavaScript v3 — Developer Guide](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/)
- [AWS SDK v3 API Reference](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)
- [AWS SDK v3 credential providers — npm](https://www.npmjs.com/package/@aws-sdk/credential-providers)
- [AWS static credentials reference](https://docs.aws.amazon.com/sdkref/latest/guide/feature-static-credentials.html)
- [EC2 RunInstances — DryRun](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/ec2/command/RunInstancesCommand)
- [STS AssumeRole examples (JavaScript v3)](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_sts_code_examples.html)
- [LocalStack — AWS emulator](https://docs.localstack.cloud)
- [ADR-052 — design record for this example](https://github.com/ruvnet/agent-harness-generator/tree/main/docs/adrs/ADR-052-example-aws.md)
- [ADR-051 — examples program](https://github.com/ruvnet/agent-harness-generator/tree/main/docs/adrs/ADR-051-third-party-sdk-showcase-examples.md)
