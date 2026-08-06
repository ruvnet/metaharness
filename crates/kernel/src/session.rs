// SPDX-License-Identifier: MIT
//
// Session subsystem: crash-recoverable, forkable session log core per
// ADR-241 §2.3. Append-only JSONL event log; every event carries a
// monotonic per-branch index; a branch forks by referencing a parent
// (branch, index); replaying a branch lineage root→tip reconstructs
// state deterministically, verified by a sha256 state hash.
//
// Deliberately out of scope (per the ADR): daemon, socket attach/detach,
// kernel snapshots. Flywheel stays the loop-level audit layer.
//
// CROSS-LANGUAGE LOCKSTEP: the JSONL codec and state hash must be
// reproducible from TS:
//   - `serialize_event` uses serde_json struct-order keys:
//     index, branch, parent, kind, payload (parent keys: branch, index).
//     TS must construct objects in the same key order before
//     JSON.stringify to emit identical lines.
//   - `state_hash` folds one sha256 over the CANONICAL JSON of each
//     lineage event (see `to_canonical_json`): objects with keys sorted
//     recursively (byte-wise ascending), compact separators, then the
//     UTF-8 bytes of each event's canonical string are fed to a single
//     sha256 in lineage order (root→tip); digest is lowercase hex.

//! Recoverable session log: JSONL codec, validation, replay, fork, hash.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Reference to the fork point of a branch: an existing (branch, index).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParentRef {
    /// Branch the fork point lives on.
    pub branch: String,
    /// Event index on that branch.
    pub index: u64,
}

/// One event in the append-only session log.
///
/// Serialized key order (struct order) is a lockstep contract:
/// `index, branch, parent, kind, payload`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    /// 0-based monotonic index within `branch`.
    pub index: u64,
    /// Branch this event belongs to.
    pub branch: String,
    /// Fork point; required on the first event of every non-root branch.
    pub parent: Option<ParentRef>,
    /// Event kind (e.g. "turn", "tool", "fork").
    pub kind: String,
    /// Arbitrary event payload.
    pub payload: serde_json::Value,
}

/// Summary of a deterministic branch replay.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySummary {
    /// Number of events in the branch lineage root→tip.
    pub event_count: u64,
    /// State hash over the lineage (see `state_hash`).
    pub state_hash: String,
}

/// Session log errors.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    /// A JSONL line failed to parse; carries the 1-based line number.
    #[error("session: line {line}: invalid JSON: {message}")]
    Corrupted {
        /// 1-based line number of the corrupted line.
        line: usize,
        /// The underlying serde_json parse error.
        message: String,
    },
    /// The requested branch has no events in the log.
    #[error("session: unknown branch '{0}'")]
    UnknownBranch(String),
    /// The log (or a requested operation on it) is structurally invalid.
    #[error("session: {0}")]
    Invalid(String),
}

/// Parse a JSONL session log. Blank / whitespace-only lines are skipped
/// (they still count toward line numbering). A corrupted line yields
/// `SessionError::Corrupted` with its 1-based line number.
pub fn parse_log(jsonl: &str) -> Result<Vec<SessionEvent>, SessionError> {
    let mut events = Vec::new();
    for (i, line) in jsonl.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let event: SessionEvent =
            serde_json::from_str(line).map_err(|e| SessionError::Corrupted {
                line: i + 1,
                message: e.to_string(),
            })?;
        events.push(event);
    }
    Ok(events)
}

/// Serialize one event to a JSONL line (no trailing newline).
///
/// Key order is struct order — `index, branch, parent, kind, payload` —
/// which serde_json preserves. The TS side must construct objects in the
/// same key order before `JSON.stringify` to emit byte-identical lines.
pub fn serialize_event(event: &SessionEvent) -> String {
    serde_json::to_string(event).expect("SessionEvent always serializes")
}

/// Validate a session log. Returns all violations ('session: '-prefixed);
/// empty vec = valid.
///
/// Rules:
///   - per-branch indexes are 0-based and monotonic +1 in log order;
///   - duplicate (branch, index) pairs are rejected;
///   - the first event of the log defines the root branch; every other
///     branch's first event must carry a `parent` referencing a
///     (branch, index) that already exists at or before its creation
///     point in the log.
pub fn validate_log(events: &[SessionEvent]) -> Vec<String> {
    let mut errors = Vec::new();
    let mut seen: BTreeSet<(String, u64)> = BTreeSet::new();
    let mut next_index: BTreeMap<String, u64> = BTreeMap::new();
    let root = events.first().map(|e| e.branch.clone());
    for e in events {
        let key = (e.branch.clone(), e.index);
        if seen.contains(&key) {
            errors.push(format!(
                "session: duplicate event ('{}', {})",
                e.branch, e.index
            ));
            continue;
        }
        match next_index.get(&e.branch) {
            None => {
                if e.index != 0 {
                    errors.push(format!(
                        "session: branch '{}' first event must have index 0, got {}",
                        e.branch, e.index
                    ));
                }
                if root.as_deref() != Some(e.branch.as_str()) {
                    match &e.parent {
                        None => errors.push(format!(
                            "session: branch '{}' first event must carry a parent ref",
                            e.branch
                        )),
                        Some(p) => {
                            if !seen.contains(&(p.branch.clone(), p.index)) {
                                errors.push(format!(
                                    "session: branch '{}' parent ('{}', {}) does not exist at its creation point",
                                    e.branch, p.branch, p.index
                                ));
                            }
                        }
                    }
                }
            }
            Some(&expected) => {
                if e.index != expected {
                    errors.push(format!(
                        "session: branch '{}' index {} is not monotonic (expected {})",
                        e.branch, e.index, expected
                    ));
                }
            }
        }
        seen.insert(key);
        next_index.insert(e.branch.clone(), e.index + 1);
    }
    errors
}

/// Canonical JSON: object keys sorted recursively (byte-wise ascending),
/// arrays in order, compact separators (`,` and `:`), scalars rendered by
/// serde_json. This is the lockstep hashing form — the TS mirror must
/// produce the identical string (sort keys recursively, then stringify
/// with no whitespace).
pub fn to_canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| {
                    let key = serde_json::to_string(k).expect("string key serializes");
                    format!("{}:{}", key, to_canonical_json(&map[k.as_str()]))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        serde_json::Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(to_canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        scalar => serde_json::to_string(scalar).expect("scalar serializes"),
    }
}

/// Collect the lineage of `branch` root→tip: recursively resolve the
/// branch's fork point, taking ancestor events up to (and including) the
/// fork index, then the branch's own events (optionally truncated at
/// `up_to`). Cycle-safe via `visited`.
fn lineage_up_to<'a>(
    events: &'a [SessionEvent],
    branch: &str,
    up_to: Option<u64>,
    visited: &mut Vec<String>,
) -> Vec<&'a SessionEvent> {
    if visited.iter().any(|b| b == branch) {
        return Vec::new();
    }
    visited.push(branch.to_string());
    let mut out = Vec::new();
    if let Some(first) = events.iter().find(|e| e.branch == branch) {
        if let Some(p) = &first.parent {
            out.extend(lineage_up_to(events, &p.branch, Some(p.index), visited));
        }
    }
    out.extend(events.iter().filter(|e| {
        e.branch == branch
            && match up_to {
                Some(k) => e.index <= k,
                None => true,
            }
    }));
    out
}

/// Deterministic state hash of a branch: walk the lineage root→tip and
/// fold a single sha256 over the UTF-8 bytes of each event's canonical
/// JSON (`to_canonical_json` of the serialized event), in lineage order.
/// Returns lowercase hex. An unknown branch hashes an empty lineage
/// (the sha256 of zero bytes).
pub fn state_hash(events: &[SessionEvent], branch: &str) -> String {
    let mut visited = Vec::new();
    let lineage = lineage_up_to(events, branch, None, &mut visited);
    let mut hasher = Sha256::new();
    for e in lineage {
        let value = serde_json::to_value(e).expect("SessionEvent serializes");
        hasher.update(to_canonical_json(&value).as_bytes());
    }
    hex::encode(hasher.finalize())
}

/// Replay a branch: validates the whole log, resolves the branch lineage
/// root→tip, and returns its event count and state hash.
pub fn replay(events: &[SessionEvent], branch: &str) -> Result<ReplaySummary, SessionError> {
    let errors = validate_log(events);
    if !errors.is_empty() {
        return Err(SessionError::Invalid(errors.join("; ")));
    }
    if !events.iter().any(|e| e.branch == branch) {
        return Err(SessionError::UnknownBranch(branch.to_string()));
    }
    let mut visited = Vec::new();
    let lineage = lineage_up_to(events, branch, None, &mut visited);
    Ok(ReplaySummary {
        event_count: lineage.len() as u64,
        state_hash: state_hash(events, branch),
    })
}

/// Build the first event of a fork of `new_branch` at (`at_branch`,
/// `at_index`). Fails if the fork point does not exist in the log or the
/// new branch already has events.
pub fn fork(
    events: &[SessionEvent],
    at_branch: &str,
    at_index: u64,
    new_branch: &str,
) -> Result<SessionEvent, SessionError> {
    if !events
        .iter()
        .any(|e| e.branch == at_branch && e.index == at_index)
    {
        return Err(SessionError::Invalid(format!(
            "fork point ('{at_branch}', {at_index}) does not exist"
        )));
    }
    if events.iter().any(|e| e.branch == new_branch) {
        return Err(SessionError::Invalid(format!(
            "branch '{new_branch}' already exists"
        )));
    }
    Ok(SessionEvent {
        index: 0,
        branch: new_branch.to_string(),
        parent: Some(ParentRef {
            branch: at_branch.to_string(),
            index: at_index,
        }),
        kind: "fork".to_string(),
        payload: serde_json::Value::Null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(branch: &str, index: u64, parent: Option<(&str, u64)>) -> SessionEvent {
        SessionEvent {
            index,
            branch: branch.into(),
            parent: parent.map(|(b, i)| ParentRef {
                branch: b.into(),
                index: i,
            }),
            kind: "turn".into(),
            payload: serde_json::json!({ "n": index }),
        }
    }

    fn root_log(n: u64) -> Vec<SessionEvent> {
        (0..n).map(|i| ev("root", i, None)).collect()
    }

    #[test]
    fn serialize_event_uses_struct_key_order() {
        let line = serialize_event(&ev("root", 0, None));
        let idx_index = line.find("\"index\"").unwrap();
        let idx_branch = line.find("\"branch\"").unwrap();
        let idx_parent = line.find("\"parent\"").unwrap();
        let idx_kind = line.find("\"kind\"").unwrap();
        let idx_payload = line.find("\"payload\"").unwrap();
        assert!(idx_index < idx_branch);
        assert!(idx_branch < idx_parent);
        assert!(idx_parent < idx_kind);
        assert!(idx_kind < idx_payload);
    }

    #[test]
    fn parse_serialize_round_trips() {
        let events = root_log(3);
        let jsonl: Vec<String> = events.iter().map(serialize_event).collect();
        let parsed = parse_log(&jsonl.join("\n")).unwrap();
        assert_eq!(parsed, events);
    }

    #[test]
    fn corrupted_line_reports_the_right_line_number() {
        let good = serialize_event(&ev("root", 0, None));
        let jsonl = format!("{good}\n{good}\nnot json at all\n{good}");
        match parse_log(&jsonl) {
            Err(SessionError::Corrupted { line, .. }) => assert_eq!(line, 3),
            other => panic!("expected Corrupted, got {other:?}"),
        }
    }

    #[test]
    fn blank_lines_are_skipped_but_counted() {
        let good = serialize_event(&ev("root", 0, None));
        let jsonl = format!("{good}\n\n   \nbroken");
        match parse_log(&jsonl) {
            Err(SessionError::Corrupted { line, .. }) => assert_eq!(line, 4),
            other => panic!("expected Corrupted, got {other:?}"),
        }
    }

    #[test]
    fn valid_single_branch_log_passes() {
        assert!(validate_log(&root_log(4)).is_empty());
    }

    #[test]
    fn valid_forked_log_passes() {
        let mut events = root_log(3);
        events.push(ev("b", 0, Some(("root", 1))));
        events.push(ev("b", 1, None));
        assert!(validate_log(&events).is_empty());
    }

    #[test]
    fn non_monotonic_index_is_rejected() {
        let mut events = root_log(2);
        events.push(ev("root", 3, None)); // skips index 2
        let errors = validate_log(&events);
        assert_eq!(
            errors,
            vec!["session: branch 'root' index 3 is not monotonic (expected 2)"]
        );
    }

    #[test]
    fn duplicate_branch_index_is_rejected() {
        let mut events = root_log(2);
        events.push(ev("root", 1, None));
        let errors = validate_log(&events);
        assert_eq!(errors, vec!["session: duplicate event ('root', 1)"]);
    }

    #[test]
    fn branch_first_event_must_start_at_zero() {
        let mut events = root_log(1);
        events.push(ev("b", 5, Some(("root", 0))));
        let errors = validate_log(&events);
        assert_eq!(
            errors,
            vec!["session: branch 'b' first event must have index 0, got 5"]
        );
    }

    #[test]
    fn non_root_branch_without_parent_is_rejected() {
        let mut events = root_log(1);
        events.push(ev("b", 0, None));
        let errors = validate_log(&events);
        assert_eq!(
            errors,
            vec!["session: branch 'b' first event must carry a parent ref"]
        );
    }

    #[test]
    fn parent_must_exist_at_creation_point() {
        let mut events = root_log(2);
        // References root index 5, which never exists.
        events.push(ev("b", 0, Some(("root", 5))));
        let errors = validate_log(&events);
        assert_eq!(
            errors,
            vec!["session: branch 'b' parent ('root', 5) does not exist at its creation point"]
        );
        // References root index 2, which only appears AFTER the fork event.
        let mut late = root_log(2);
        late.push(ev("c", 0, Some(("root", 2))));
        late.push(ev("root", 2, None));
        let errors = validate_log(&late);
        assert_eq!(
            errors,
            vec!["session: branch 'c' parent ('root', 2) does not exist at its creation point"]
        );
    }

    #[test]
    fn canonical_json_sorts_keys_recursively() {
        let a: serde_json::Value =
            serde_json::from_str(r#"{"b":1,"a":{"z":[1,2],"y":true}}"#).unwrap();
        assert_eq!(to_canonical_json(&a), r#"{"a":{"y":true,"z":[1,2]},"b":1}"#);
    }

    #[test]
    fn hash_is_invariant_to_payload_key_order() {
        let line1 = r#"{"index":0,"branch":"root","parent":null,"kind":"turn","payload":{"b":1,"a":2}}"#;
        let line2 = r#"{"index":0,"branch":"root","parent":null,"kind":"turn","payload":{"a":2,"b":1}}"#;
        let e1 = parse_log(line1).unwrap();
        let e2 = parse_log(line2).unwrap();
        assert_eq!(state_hash(&e1, "root"), state_hash(&e2, "root"));
    }

    #[test]
    fn state_hash_is_deterministic_lowercase_hex() {
        let events = root_log(3);
        let h1 = state_hash(&events, "root");
        let h2 = state_hash(&events, "root");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn fork_lineage_shares_root_to_k_prefix_hash_inputs() {
        // root: 0,1,2,3; fork "b" at ('root', 1); b: 0 (fork), 1.
        let mut events = root_log(4);
        let fork_event = fork(&events, "root", 1, "b").unwrap();
        events.push(fork_event.clone());
        events.push(ev("b", 1, None));
        assert!(validate_log(&events).is_empty());

        // Manual fold: root[0], root[1], b[0], b[1] — proving the branch
        // hash consumes the shared root→k prefix, not the whole root.
        let mut hasher = Sha256::new();
        for e in [&events[0], &events[1], &fork_event, &events[5]] {
            let v = serde_json::to_value(e).unwrap();
            hasher.update(to_canonical_json(&v).as_bytes());
        }
        let manual = hex::encode(hasher.finalize());
        assert_eq!(state_hash(&events, "b"), manual);

        // Divergence: b's hash differs from root's tip hash.
        assert_ne!(state_hash(&events, "b"), state_hash(&events, "root"));
    }

    #[test]
    fn replay_counts_lineage_events() {
        let mut events = root_log(4);
        events.push(fork(&events, "root", 1, "b").unwrap());
        events.push(ev("b", 1, None));
        let root_summary = replay(&events, "root").unwrap();
        assert_eq!(root_summary.event_count, 4);
        assert_eq!(root_summary.state_hash, state_hash(&events, "root"));
        let b_summary = replay(&events, "b").unwrap();
        // root[0..=1] + b[0..=1]
        assert_eq!(b_summary.event_count, 4);
        assert_eq!(b_summary.state_hash, state_hash(&events, "b"));
    }

    #[test]
    fn replay_rejects_unknown_branch_and_invalid_log() {
        let events = root_log(2);
        assert!(matches!(
            replay(&events, "nope"),
            Err(SessionError::UnknownBranch(_))
        ));
        let mut bad = root_log(2);
        bad.push(ev("root", 5, None));
        assert!(matches!(replay(&bad, "root"), Err(SessionError::Invalid(_))));
    }

    #[test]
    fn fork_rejects_missing_point_and_existing_branch() {
        let events = root_log(2);
        assert!(fork(&events, "root", 9, "b").is_err());
        assert!(fork(&events, "root", 0, "root").is_err());
        let f = fork(&events, "root", 1, "b").unwrap();
        assert_eq!(f.index, 0);
        assert_eq!(
            f.parent,
            Some(ParentRef {
                branch: "root".into(),
                index: 1
            })
        );
    }
}
