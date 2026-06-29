# aggregateUsage (gen2 Cloud Function)

Pub/Sub-triggered rollup folder for Cognitum Fugu (ADR-203 §5.1, §7.1).

```
[Pub/Sub: completions-usage] --> aggregateUsage --> usage_rollups/{accountId}/{YYYY-MM}
```

- Trigger: `completions-usage` topic.
- Fold: per-tier / per-model token + price totals (mirrors agentbbs-gcp `aggregateSysopReport`).
- Ingress: `ALLOW_INTERNAL_ONLY`.
- Separate deploy unit from the Cloud Run `apicompletions` service (rollout step 6).

The pure `fold` / `aggregate` rollup logic (per-tier + per-model buckets + running totals,
UTC `YYYY-MM` periods) is **implemented** (`src/index.ts`) against a structural `RollupStore`
(in-memory for tests, firebase-admin Firestore in prod). The `firebase-functions/v2`
`onMessagePublished('completions-usage')` trigger is a thin deploy-time wrapper (Phase 6).
