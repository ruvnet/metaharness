# aggregateUsage (gen2 Cloud Function)

Pub/Sub-triggered rollup folder for Cognitum Fugu (ADR-203 §5.1, §7.1).

```
[Pub/Sub: completions-usage] --> aggregateUsage --> usage_rollups/{accountId}/{YYYY-MM}
```

- Trigger: `completions-usage` topic.
- Fold: per-tier / per-model token + price totals (mirrors agentbbs-gcp `aggregateSysopReport`).
- Ingress: `ALLOW_INTERNAL_ONLY`.
- Separate deploy unit from the Cloud Run `apicompletions` service (rollout step 6).

Skeleton stub — `firebase-functions` wiring + transactional fold land in Phase 6.
