// Firestore access (ADR-203 §7.1). Emulator-aware: when FIRESTORE_EMULATOR_HOST is set
// all access goes to the local emulator ($0, §7.3). Collections:
//   api_keys (reuse), audit_log (reuse), usage_ledger (new), usage_rollups (new),
//   api_keys/{keyHash}/usage_ticks (new, TTL'd — §5.3 counter), idempotency (new),
//   tier_config (new, hot-reloadable pools).
// TODO(impl): lazily init firebase-admin and expose a typed handle. Kept as a stub so the
// skeleton builds without the (heavy) GCP SDK installed.

export interface FirestoreHandle {
  /** Placeholder — replaced by the firebase-admin Firestore instance during impl. */
  readonly ready: boolean;
}

let handle: FirestoreHandle | null = null;

export function getFirestore(): FirestoreHandle {
  if (handle) return handle;
  // TODO(impl): admin.initializeApp(); return admin.firestore();
  handle = { ready: false };
  return handle;
}
