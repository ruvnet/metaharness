# Security model

`@metaharness/field-memory` accepts outcome evidence from multiple principals
and changes future routing. Treat it as a policy-enforcement component, not a
neutral cache.

## Assets

| Asset | Security property |
| --- | --- |
| Routing field | Integrity, availability, reversibility |
| Outcome reward and cost aggregates | Integrity, confidentiality |
| Principal and trust-domain ledgers | Integrity, unlinkability outside deployment |
| `identityHashKey` | Confidentiality, continuity, at least 32 random bytes |
| Idempotency markers | Integrity, bounded retention |
| Exported state | Authenticity, confidentiality, schema integrity |
| RuVector index and record registry | Consistency, metric and dimension stability |

## Entry points

* `update()` accepts embeddings, outcome values, identifiers, timestamps,
  idempotency keys, and an opaque principal proof.
* `choose()` accepts a query embedding, candidate allow-list, prior choice, and
  optional time.
* `importState()` accepts authenticated JSON or an object graph.
* `FieldStorageAdapter` and `RuVectorRecordRegistry` cross into deployment-owned
  persistence and locking.
* `PrincipalVerifier` crosses into deployment-owned identity, signature,
  receipt, and authorization logic.

## Trust boundaries

1. Caller to verifier. Every principal, domain, and outcome claim is untrusted
   until the injected verifier validates it against the exact update.
2. Field memory to storage. The adapter must preserve dimensions, metrics,
   unique IDs, global mutation serialization, detached records, and atomic
   replacement claims.
3. Process to shared deployment. `writerScope: "process"` protects only writers
   using that process-local lock. Multiple processes require a registry or
   adapter with `writerScope: "distributed"` and one global field lock.
4. Snapshot to restore. State HMAC verification authenticates a snapshot only
   to holders of `identityHashKey`; transport authorization and access control
   remain deployment responsibilities.

## Abuse cases and mitigations

| Abuse case | Mitigation | Residual risk |
| --- | --- | --- |
| Caller spoofs another principal | Verifier output, not caller ID, drives HMAC ledgers | Compromised or permissive verifier defeats the boundary |
| Replayed receipt | Principal-scoped HMAC idempotency marker | Replay after configured retention window is intentionally possible |
| One principal poisons a basin | Bounded update plus per-centroid principal cap | Attacker can target many authorized centroids |
| Many principals from one domain collude | Per-centroid trust-domain cap | Multiple admitted domains bypass the cap |
| Sybil identities | Verifier-controlled admission and opaque principal identity | Package cannot establish real-world uniqueness |
| Singleton shifts an established centroid | Sub-threshold head embeddings remain quarantined from ANN | Authorized export still reveals singleton aggregates |
| Opposing embeddings create a zero cosine centroid | Zero-direction heads/records remain quarantined; unrounded sums preserve valid minimum-weight directions | Cancellation can delay routing availability |
| Early attractor collapse | Zero default hysteresis, decay, drift window, cost penalty | Biased verified rewards can still form a bad attractor |
| Stale centroid occupies ANN top K | `choose()` compacts against the trusted clock before search | O(C * H * B * D) worst-case pre-search latency and storage load |
| Concurrent writers bypass caps | Required global `atomicMutate` storage transaction | Process-only adapters are unsafe across processes |
| Mutable RuVector HNSW tombstones hide live rows | Require native effective-options `configurationVerified`, flat type, and in-place mode; mutate only through the corrected flat path | Requires RuVector PR #831 or later; native crash recovery still needs reconciliation |
| RuVector implicit schema collision | Adapter binds verified `getIndexInfo()` path, dimension, canonical cosine metric, flat type, and in-place mode | Caller can still mutate the supplied DB externally after construction |
| Native/registry split revision | Search requires matching field-schema revision metadata | Consistency check only, not tamper authentication; mismatch is unavailable until reconciliation |
| Metric changes on clear | Adapter never uses `VectorIndex.clear()` | External maintenance can still mutate index semantics |
| Forged or malformed snapshot | HMAC-SHA-256 plus strict schema, size, uniqueness, time, sum, cap, and derived-vector checks | Anyone holding the HMAC key can mint a valid state |
| Wrong key after restore | HMAC key fingerprint and authenticated state | Key loss makes the state intentionally unrestorable |
| Parser resource exhaustion | 16 MiB JSON limit, one-million-scalar object limit, policy cardinality bounds | JSON string allocation happens before structural parsing |
| Numeric overflow or NaN | Finite checks, Euclidean magnitude cap, scaled normalization, rejecting arithmetic overflow | Adversarial but finite values can still reduce model utility within bounds |

## Deployment requirements

1. Load `identityHashKey` from a secrets manager. Use at least 32 random bytes.
   Never put it in source, logs, state exports, or caller-controlled config.
2. Verify signatures, issuer, audience, tenant, expiry, receipt uniqueness,
   reward provenance, cost provenance, and authorization over the exact update.
3. Return stable, deployment-scoped principal and trust-domain identifiers from
   the verifier. The package HMACs them before persistence.
4. Enforce global principal rate limits, domain admission, centroid creation
   quotas, and anomaly detection outside this package. Built-in influence caps
   are per centroid.
5. Open RuVector with `indexType: "flat"` using a release containing PR #831's
   selector, native effective-options verification, and index metadata. The
   adapter intentionally rejects 0.2.41 and HNSW. Use a durable distributed
   `RuVectorRecordRegistry` when
   more than one process writes or when the native index survives restart. The
   process-local registry is suitable only for tests and ephemeral services.
6. Back up the registry, index, authenticated state, policy, and HMAC key as one
   recovery unit. Test restore before production use.
7. Restrict snapshot and registry access. Aggregate state may expose rare
   observations even though raw episodes are absent.
8. Monitor cap rejections, cardinality rejections, new-centroid rates, support
   concentration, domain concentration, drift, compaction time, and rollback
   failures.
9. Keep `importState()` behind an administrative authorization boundary. Use a
   unique identity key per logical field and enforce a deployment-owned
   monotonic snapshot version or epoch. HMAC authenticity alone does not stop
   cross-field substitution under a reused key or rollback to an older valid
   snapshot.

## Residual risks

The package does not prove an outcome is truthful, a principal is a unique
human or organization, a centroid ID is semantically legitimate, or a reward is
safe to optimize. Those are verifier and governance responsibilities.

Repeated mutable replacements on the published RuVector 0.2.41 HNSW wrapper
were observed to become unsearchable even when the native length remained one.
The adapter therefore requires the corrected flat mutation path and verifies
the wrapper's index metadata before use; direct flat testing remained searchable
through 100 replacements. Native or process crashes can still split the index
and registry. Production operators need reconciliation that treats the durable
registry as authoritative and rebuilds the index through a deployment-owned
atomic swap.

Native revision metadata is not MACed. A storage writer can forge vectors and
revision tags; storage-writer compromise remains inside the deployment's
trusted persistence boundary. The revision check prevents accidental
split-revision pairing after a partial mutation, not malicious tampering.

The support gate reduces routing membership exposure and prevents singleton
centroid movement. It does not provide differential privacy. Apply formal
privacy accounting or noise outside this package if the deployment requires a
quantified privacy guarantee.

## Reporting

Follow the repository-level security reporting process in
[`../../SECURITY.md`](../../SECURITY.md). Do not include live keys, proofs,
principal identifiers, snapshots, or exploit data in a public issue.
