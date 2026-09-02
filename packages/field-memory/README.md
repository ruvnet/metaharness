# @metaharness/field-memory

Experimental, governed attractor memory for MetaHarness routing. It converts
verified aggregate outcomes into a cost-aware probability landscape without
putting predecessor prompts, solutions, or tool traces into the context window.

The package implements the layout validated by the field-memory mechanism
experiments:

* one vector-index entry per centroid;
* every configuration reward head packed behind that centroid;
* configuration-specific timestamps, exponential decay, and drift windows;
* support-gated quarantine for rare heads;
* verified-principal and trust-domain influence budgets;
* zero hysteresis by default, with an optional score-margin and semantic-
  continuity gate;
* deterministic compaction and authenticated, bounded state snapshots.

Packing four configuration heads behind one centroid uses one index entry
instead of four. In the synthetic discovery benchmark that removed the
`retrievalK < configurationCount` censorship failure and cut serialized state
64.66 percent. Those are mechanism results, not production task-quality claims.

## Core invariants

1. A centroid is the atomic retrieval unit. ANN search never selects some
   configuration heads while hiding sibling heads.
2. No outcome enters the field until the injected verifier maps its proof to a
   verified principal and trust domain.
3. Each accepted update is bounded by the request, per-update limit,
   per-centroid principal budget, per-centroid trust-domain budget, and
   per-centroid aggregate budget.
4. Heads below `minimumSupport`, or whose active cosine contributions cancel to
   a zero direction, cannot enter the ANN index or move a searchable centroid.
5. `hysteresisMargin` is zero unless explicitly enabled. Persistence applies
   only when the previous score is within the margin and query continuity
   clears `semanticContinuityThreshold`.
6. Every mutation uses the storage adapter's globally serialized
   `atomicMutate` operation. The enforcement scope is exposed as
   `writerScope: "process" | "distributed"`.
7. Successful state snapshots are canonical JSON authenticated with
   HMAC-SHA-256 and round-trip under the same policy and identity key. Export
   fails closed above the documented import budgets.

## Usage

```ts
import {
  createFieldMemory,
  InMemoryFieldStorage,
  type PrincipalVerifier,
} from '@metaharness/field-memory';

type SignedOutcome = {
  subject: string;
  tenant: string;
  valid: boolean;
};

const verifier: PrincipalVerifier<SignedOutcome> = async (proof, update) => {
  // Verify the signature, audience, tenant, expiry, outcome receipt, and the
  // exact update fields here. Never trust a principal ID supplied by the caller.
  if (!proof.valid) return null;
  return {
    principalId: proof.subject,
    trustDomain: proof.tenant,
  };
};

const identityHashKey = await secrets.getBytes('field-memory-identity-hmac');

const memory = createFieldMemory({
  storage: new InMemoryFieldStorage({ dimension: 384, metric: 'cosine' }),
  verifier,
  identityHashKey, // at least 32 random bytes; reuse after restore
  config: {
    dimension: 384,
    retrievalK: 8,
    minimumSupport: 3,
    decayHalfLifeMs: 7 * 86_400_000,
    driftWindowMs: 30 * 86_400_000,
    bucketSizeMs: 86_400_000,
    maxContributionWeight: 1,
    principalInfluenceCap: 3,
    trustDomainInfluenceCap: 12,
    costPenaltyWeight: 0.1,
    costScale: 1,
    hysteresisMargin: 0,
    semanticContinuityThreshold: 0.85,
  },
});

await memory.update({
  centroidId: 'typescript-maintenance',
  embedding,
  configurationId: 'sonnet-with-tests',
  reward: 0.91,             // finite, normalized to [-1, 1]
  cost: 0.18,               // caller-defined units, bounded by policy
  observedAt: Date.now(),
  idempotencyKey: receiptId,
  principalProof: signedOutcome,
});

const choice = await memory.choose({
  embedding: queryEmbedding,
  allowedConfigurations: ['cheap', 'balanced', 'frontier'],
  previous: {
    configurationId: previousRoute,
    queryEmbedding: previousQueryEmbedding,
  },
});

if (choice) execute(choice.configurationId);
```

`update()` returns one of `accepted`, `privacy-buffered`, `duplicate`,
`verification-failed`, `principal-cap`, `trust-domain-cap`, `aggregate-cap`,
`cardinality-cap`, or `stale`. A buffered update is retained as an aggregate but
does not affect searchable routing until support reaches policy and its active
embedding aggregate has a usable direction.

Idempotency is scoped to the verified principal. Two principals may use the
same external receipt ID; a replay by the same principal is rejected.

## Choice function

For each eligible head, time-bucketed evidence decays toward a zero prior:

```text
rewardScore = sum(decay * reward * weight) / (priorWeight + effectiveWeight)
costScore   = sum(decay * cost * weight)   / (priorWeight + effectiveWeight)

score = semanticWeight * similarity
      + rewardScore
      - costPenaltyWeight * costScore / costScale
```

Scores from retrieved centroids are affinity weighted per configuration.
Tie-breaking is deterministic by configuration ID. `choose()` compacts expired
records against its trusted injected clock before ANN search because filtering
after top K would allow a stale, high-similarity centroid to censor an active
centroid. Caller-supplied query time cannot drive destructive maintenance.

Default compaction therefore adds an O(C * H * B * D) worst-case maintenance
pass before choice, where C is the number of centroids, H is packed heads per
centroid, B is active time buckets, and D is embedding dimension. Scoring is
O(K * H * B * D) because each retrieved head validates its active embedding
direction as well as reward/cost buckets; K is retrieval depth. With defaults,
K=8, H<=64, and B<=31, scoring visits at most 15,872 head-buckets and performs
up to 15,872 * D component aggregations, in addition to ANN search and the
maintenance pass. Measure both against the deployment's latency budget.

## RuVector adapter

The package does not import or require a native module. It ships a structural
adapter for an already-open `ruvector.VectorDb`:

```ts
import { resolve } from 'node:path';
import { VectorDb } from 'ruvector';
import {
  createRuVectorFieldStorage,
  InMemoryRuVectorRecordRegistry,
} from '@metaharness/field-memory';

const storagePath = resolve(process.cwd(), 'state', 'field-memory.ruvector.db');
const db = new VectorDb({
  dimensions: 384,
  storagePath,              // adapter rejects relative paths
  distanceMetric: 'cosine',
  indexType: 'flat',         // requires the flat selector from RuVector PR #831+
});

const storage = createRuVectorFieldStorage({
  db,
  storagePath,
  dimension: 384,
  metric: 'cosine',
  registry: new InMemoryRuVectorRecordRegistry(), // process-local development only
});
```

The v0.1 adapter supports only RuVector's canonical cosine-distance contract
(`similarity = 1 - distance`) and rejects caller-defined score semantics. It
fails closed unless the supplied wrapper exposes
`configurationVerified === true`, `indexType === "flat"`, and
`mutationMode === "in-place"`. Repeated delete/insert replacement was observed to make
the published RuVector 0.2.41 HNSW wrapper stop returning a live centroid even
while `len() === 1`; versioned physical IDs only delayed that failure. A direct
flat-index run remained searchable through 100 replacements. The required
wrapper selector, native effective-options verification, and index metadata are supplied by RuVector PR
#831 (or a later release containing that change). The adapter therefore rejects
0.2.41 instead of presenting an unsafe compatibility claim.

Within a verified flat cosine index, searchable replacements use the corrected
explicit-ID in-place upsert. The adapter verifies native revision metadata
against the registry before scoring, oversamples and deduplicates search
results, and never calls `VectorIndex.clear()`, which was observed to reset the
requested metric.

RuVector does not expose a reliable list-all-records transaction. The adapter
therefore requires an explicit record registry. Production deployments must
implement `RuVectorRecordRegistry` with durable records and a global
`withLock()` shared by every process plus an exact O(1) `count()` inside that
transaction. `InMemoryRuVectorRecordRegistry` is explicitly process-local and
loses its registry on restart.

`atomicReplace` is false unless the caller supplies `replaceAllAtomically`, a
deployment transaction that replaces both the RuVector index and durable
registry. `importState()` fails closed when atomic replacement is unavailable.

## State and compaction

```ts
await memory.compact({ now: Date.now() });
const state = await memory.exportStateJson();

const restored = createFieldMemory({
  config,
  storage: replacementStorage,
  verifier,
  identityHashKey,
});
await restored.importState(state, { mode: 'replace' });
```

Successful exports are byte deterministic for identical state and reversible
under the same policy, identity key, and an atomically replaceable adapter. They
include schema version, policy, a non-secret identity-key fingerprint, packed
aggregates, and an HMAC. Export and import both enforce a 16 MiB encoded limit
and a one-million-scalar object budget; export fails with `RangeError` instead
of creating a snapshot that its own importer cannot accept. Import additionally
enforces policy cardinalities, unique IDs and bucket starts, aligned timestamps,
aggregate consistency, influence caps, centroid derivation, HMAC authenticity,
and identity-key continuity.

`importState()` is a privileged administrative operation, not an end-user
endpoint. Use a unique `identityHashKey` for each logical field; HMAC alone does
not prevent cross-field substitution when a key and policy are reused. The
deployment must authorize imports and persist a monotonic snapshot version (or
epoch) outside this payload so an older, otherwise valid snapshot cannot roll
back influence caps or idempotency history.

Do not export the HMAC key. Stored HMAC identifiers are one-way and cannot be
rehash-migrated without their source values. Rotation therefore requires a
rebuild from externally retained authorized evidence, discarding the field, or
a separately designed dual-key migration. Losing or silently changing the key
makes existing snapshots unrestorable and resets historical influence controls.

## Honest privacy and governance bounds

There is no raw episode retrieval or reconstruction API. Prompts, solutions,
tool traces, and proofs are never stored.

The support gate is routing quarantine, not confidentiality. An authorized
state export contains head-level aggregate embeddings, rewards, costs, support
hashes, and timestamps. For a singleton, an aggregate can equal that single
observation. Treat snapshots and durable registries as sensitive governed data.

Principal and trust-domain budgets are per centroid. They do not prevent a
verified attacker from spreading influence across many centroid IDs, and they
do not solve Sybil attacks. The verifier and deployment admission layer must
enforce global principal rate limits, trust-domain admission, centroid creation
authorization, and signed outcome semantics.

See [SECURITY.md](./SECURITY.md) for the complete threat model and deployment
requirements.

## Acceptance gate

Do not promote field memory from experimental routing until a held-out replay
shows at least 5 percent utility lift over ordinary top-K retrieval at equal
inference budgets, membership-inference AUC no greater than 0.55, less than 5
points of degradation under a 10 percent single-principal poison cohort, and at
least 90 percent post-drift recovery within sixteen verified labels per task
family.
