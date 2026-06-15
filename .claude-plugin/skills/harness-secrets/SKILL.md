---
name: harness-secrets
description: GCP Secret Manager integration: validate setup, fetch values, or confirm an NPM_TOKEN is non-revoked via `npm whoami`. Used for publish-time token rotation without long-lived keys in CI.
---

# harness-secrets

> Codex skill for GCP Secret Manager — check / fetch / validate-token.

## Modes

### check
Validates the full GCP setup (`gcloud` on PATH, active project, auth principal, secret exists, WIF pool present). Use this when bootstrapping a new GCP project for publish.

```
/harness-secrets mode=check
/harness-secrets mode=check secret=NPM_TOKEN_DEV
/harness-secrets mode=check project=my-gcp-project secret=NPM_TOKEN
```

### fetch
Fetches a secret value to stdout. Use in pipelines:

```
/harness-secrets mode=fetch secret=NPM_TOKEN
/harness-secrets mode=fetch secret=GH_TOKEN version=3
```

### validate-token
Fetches `NPM_TOKEN` and runs `npm whoami` against the registry. No publish — just confirms the token isn't revoked. Use this BEFORE you tag a release.

```
/harness-secrets mode=validate-token
/harness-secrets mode=validate-token secret=NPM_TOKEN_STAGING
```

## Equivalent CLI

```bash
harness secrets check --secret=NPM_TOKEN
harness secrets fetch NPM_TOKEN --version=3
harness secrets validate-token
```

## Why this exists

So you can refresh + verify the publish-time GCP secret WITHOUT triggering a real publish.
