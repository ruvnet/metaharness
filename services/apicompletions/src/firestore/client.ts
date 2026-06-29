// Firestore access (ADR-203 §7.1). Emulator-aware: when FIRESTORE_EMULATOR_HOST is set
// all access goes to the local emulator ($0, §7.3). Collections:
//   api_keys (reuse), audit_log (reuse), usage_ledger (new), usage_rollups (new),
//   api_keys/{keyHash}/usage_ticks (new, TTL'd — §5.3 counter), idempotency (new),
//   tier_config (new, hot-reloadable pools).
//
// The production stores (metering ledger, scatter-gather rate-limit ticks, idempotency)
// are written against the MINIMAL STRUCTURAL interfaces below rather than a hard
// firebase-admin import. This keeps the standalone package's `tsc` build green and its
// install fast (firebase-admin / @google-cloud/pubsub stay deferred deps, §package.json)
// while the shape stays byte-compatible with `admin.firestore()` so the production
// binding is a one-line `new FirestoreLedgerStore(admin.firestore())`. The same DI
// posture as `KeyStore`/`InMemoryKeyStore` (§6) — tests inject in-memory fakes at $0.

/** Structural subset of a firebase-admin `DocumentSnapshot`. */
export interface DocSnapshotLike {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

/** Structural subset of a firebase-admin `AggregateQuerySnapshot` (COUNT(), §5.3). */
export interface AggregateSnapshotLike {
  data(): { count: number };
}

/** Structural subset of a firebase-admin `Query` supporting the COUNT() window scan. */
export interface QueryLike {
  where(field: string, op: string, value: unknown): QueryLike;
  count(): { get(): Promise<AggregateSnapshotLike> };
}

/** Structural subset of a firebase-admin `DocumentReference`. */
export interface DocRefLike {
  set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<unknown>;
  get(): Promise<DocSnapshotLike>;
  collection(path: string): CollectionRefLike;
}

/** Structural subset of a firebase-admin `CollectionReference`. */
export interface CollectionRefLike extends QueryLike {
  doc(id: string): DocRefLike;
}

/**
 * Structural subset of a firebase-admin `Transaction` (ADR-204 §5.2 Reserve-and-Commit).
 * The RESERVE/COMMIT txns read at most two single docs (account + agent-shard) and never
 * scan a subcollection on the hot path (§5.2 fix 2 — no `sumReserved()` read lock).
 */
export interface TransactionLike {
  get(ref: DocRefLike): Promise<DocSnapshotLike>;
  set(ref: DocRefLike, data: Record<string, unknown>, opts?: { merge?: boolean }): void;
  update(ref: DocRefLike, data: Record<string, unknown>): void;
}

/** Structural subset of a firebase-admin `Firestore` instance. */
export interface FirestoreLike {
  collection(path: string): CollectionRefLike;
  doc(path: string): DocRefLike;
  /** ADR-204 §5.2 — atomic Reserve / Commit transactions on the budget docs. */
  runTransaction<T>(fn: (txn: TransactionLike) => Promise<T>): Promise<T>;
}

/** Structural subset of a `@google-cloud/pubsub` Topic.publishMessage handle. */
export interface PubSubTopicLike {
  publishMessage(message: { json: unknown }): Promise<string>;
}

export interface FirestoreHandle {
  /** Placeholder — replaced by the firebase-admin Firestore instance during impl. */
  readonly ready: boolean;
}

let handle: FirestoreHandle | null = null;

export function getFirestore(): FirestoreHandle {
  if (handle) return handle;
  // TODO(impl): admin.initializeApp(); return admin.firestore() as unknown as FirestoreLike.
  handle = { ready: false };
  return handle;
}
