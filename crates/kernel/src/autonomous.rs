// SPDX-License-Identifier: MIT
//
// Autonomous subsystem: the optional `autonomous` block on HarnessSpec
// per ADR-241 §2.2 — persistent goal (+ token budget), heartbeat re-entry,
// quality gate command, and a hard turn ceiling.
//
// CROSS-LANGUAGE LOCKSTEP (ADR-029 style): the validator error strings
// below are a byte-for-byte contract with the TS validator in
// `packages/kernel-js`. Do NOT reword them without changing both sides
// and their lockstep fixtures.

//! Autonomous-mode spec (goal / heartbeat / gate / max-turns) + validator.

use serde::{Deserialize, Serialize};
use serde_json::Number;

/// Persistent objective for an autonomous run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    /// The goal text the harness re-reads each turn.
    pub text: String,
    /// Optional token budget for pursuing the goal (JSON key: `tokenBudget`).
    /// Held as a raw JSON number so non-integer inputs (1.5, 1e20) reach the
    /// validator instead of failing to parse; validated via `as_i64()`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<Number>,
}

/// Periodic re-entry instruction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    /// Cadence expression (host-interpreted, e.g. "30m" or a cron line).
    pub cadence: String,
    /// Instruction delivered on each heartbeat firing.
    pub instruction: String,
}

/// The optional `autonomous` block on HarnessSpec (ADR-241 §2.2).
///
/// Semantics follow the ADR-159 `budgets`/`guards` discipline: hitting a
/// budget or failing the gate halts deterministically; reaching a limit is
/// not success.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutonomousSpec {
    /// Persistent objective (+ budget).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<Goal>,
    /// Periodic re-entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heartbeat: Option<Heartbeat>,
    /// Quality gate a turn must pass, e.g. "npm run check"
    /// (JSON key: `gateCommand`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate_command: Option<String>,
    /// Hard turn ceiling (JSON key: `maxTurns`). Raw JSON number so
    /// non-integer inputs reach the validator; validated via `as_i64()`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<Number>,
}

/// Validate an autonomous block. Returns the full list of violations;
/// an empty vec means the spec is valid. Absent optional fields are valid.
///
/// LOCKSTEP CONTRACT: each string must match the TS validator byte-for-byte.
pub fn validate_autonomous(spec: &AutonomousSpec) -> Vec<String> {
    let mut errors = Vec::new();
    if let Some(goal) = &spec.goal {
        if goal.text.trim().is_empty() {
            errors.push("autonomous.goal.text must be non-empty".to_string());
        }
        if let Some(budget) = &goal.token_budget {
            // `as_i64()` is None for non-integers (1.5) and i64 overflow (1e20);
            // both count as out-of-range, same as the TS side.
            if !matches!(budget.as_i64(), Some(b) if b > 0) {
                errors.push("autonomous.goal.tokenBudget must be > 0".to_string());
            }
        }
    }
    if let Some(hb) = &spec.heartbeat {
        if hb.cadence.trim().is_empty() {
            errors.push("autonomous.heartbeat.cadence must be non-empty".to_string());
        }
        if hb.instruction.trim().is_empty() {
            errors.push("autonomous.heartbeat.instruction must be non-empty".to_string());
        }
    }
    if let Some(gate) = &spec.gate_command {
        if gate.trim().is_empty() {
            errors.push("autonomous.gateCommand must be non-empty".to_string());
        }
    }
    if let Some(turns) = &spec.max_turns {
        // Non-integer or overflow → out-of-range, same string as the TS side.
        if !matches!(turns.as_i64(), Some(t) if t >= 1) {
            errors.push("autonomous.maxTurns must be >= 1".to_string());
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_from(json: &str) -> AutonomousSpec {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn empty_spec_is_valid() {
        assert!(validate_autonomous(&AutonomousSpec::default()).is_empty());
    }

    #[test]
    fn fully_populated_valid_spec_passes() {
        let s = spec_from(
            r#"{
                "goal": { "text": "ship it", "tokenBudget": 100000 },
                "heartbeat": { "cadence": "30m", "instruction": "re-read goal" },
                "gateCommand": "npm run check",
                "maxTurns": 50
            }"#,
        );
        assert!(validate_autonomous(&s).is_empty());
    }

    #[test]
    fn camel_case_keys_round_trip() {
        let s = spec_from(r#"{ "goal": { "text": "g", "tokenBudget": 1 }, "gateCommand": "c", "maxTurns": 2 }"#);
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"tokenBudget\""));
        assert!(json.contains("\"gateCommand\""));
        assert!(json.contains("\"maxTurns\""));
        let back: AutonomousSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    /// Table-driven: every lockstep error string, byte-for-byte.
    #[test]
    fn validator_emits_each_lockstep_error_string() {
        let cases: &[(&str, &str)] = &[
            (
                r#"{ "goal": { "text": "   " } }"#,
                "autonomous.goal.text must be non-empty",
            ),
            (
                r#"{ "goal": { "text": "g", "tokenBudget": 0 } }"#,
                "autonomous.goal.tokenBudget must be > 0",
            ),
            (
                r#"{ "goal": { "text": "g", "tokenBudget": -5 } }"#,
                "autonomous.goal.tokenBudget must be > 0",
            ),
            (
                r#"{ "heartbeat": { "cadence": "", "instruction": "i" } }"#,
                "autonomous.heartbeat.cadence must be non-empty",
            ),
            (
                r#"{ "heartbeat": { "cadence": "30m", "instruction": " " } }"#,
                "autonomous.heartbeat.instruction must be non-empty",
            ),
            (
                r#"{ "gateCommand": "  " }"#,
                "autonomous.gateCommand must be non-empty",
            ),
            (
                r#"{ "maxTurns": 0 }"#,
                "autonomous.maxTurns must be >= 1",
            ),
            (
                r#"{ "maxTurns": -1 }"#,
                "autonomous.maxTurns must be >= 1",
            ),
        ];
        for (json, want) in cases {
            let errors = validate_autonomous(&spec_from(json));
            assert_eq!(errors, vec![want.to_string()], "spec: {json}");
        }
    }

    #[test]
    fn validator_accumulates_all_errors() {
        let s = spec_from(
            r#"{
                "goal": { "text": "", "tokenBudget": -1 },
                "heartbeat": { "cadence": "", "instruction": "" },
                "gateCommand": "",
                "maxTurns": 0
            }"#,
        );
        let errors = validate_autonomous(&s);
        assert_eq!(
            errors,
            vec![
                "autonomous.goal.text must be non-empty",
                "autonomous.goal.tokenBudget must be > 0",
                "autonomous.heartbeat.cadence must be non-empty",
                "autonomous.heartbeat.instruction must be non-empty",
                "autonomous.gateCommand must be non-empty",
                "autonomous.maxTurns must be >= 1",
            ]
        );
    }

    #[test]
    fn absent_optional_fields_are_valid() {
        let s = spec_from(r#"{ "goal": { "text": "g" } }"#);
        assert!(validate_autonomous(&s).is_empty());
    }

    /// JSON `null` for any optional field is treated as absent — it must
    /// deserialize cleanly (to None) and validate with no errors.
    #[test]
    fn null_fields_deserialize_to_none_and_are_valid() {
        let s = spec_from(
            r#"{ "goal": null, "heartbeat": null, "gateCommand": null, "maxTurns": null }"#,
        );
        assert!(s.goal.is_none());
        assert!(s.heartbeat.is_none());
        assert!(s.gate_command.is_none());
        assert!(s.max_turns.is_none());
        assert!(validate_autonomous(&s).is_empty());

        let g = spec_from(r#"{ "goal": { "text": "g", "tokenBudget": null } }"#);
        assert!(g.goal.as_ref().unwrap().token_budget.is_none());
        assert!(validate_autonomous(&g).is_empty());
    }

    /// Absent optional fields must be skipped on serialization so a valid
    /// partial block round-trips to TS without `null` noise.
    #[test]
    fn goal_only_spec_serializes_without_null_noise() {
        let s = spec_from(r#"{ "goal": { "text": "x" } }"#);
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"goal":{"text":"x"}}"#
        );
    }

    /// CROSS-LANGUAGE LOCKSTEP (ADR-029 style, like template-catalog):
    /// consume the SAME fixture the TS validator tests use
    /// (`packages/projects/__tests__/harness-spec.test.ts`) and assert
    /// every case's errors byte-for-byte, in the same order.
    const LOCKSTEP_FIXTURE: &str = include_str!(
        "../../../packages/projects/__tests__/fixtures/autonomous-cases.json"
    );

    #[derive(Deserialize)]
    struct LockstepCase {
        name: String,
        spec: AutonomousSpec,
        errors: Vec<String>,
    }

    #[test]
    fn ts_lockstep_fixture_every_case_matches_byte_for_byte() {
        let cases: Vec<LockstepCase> =
            serde_json::from_str(LOCKSTEP_FIXTURE).expect("fixture parses");
        assert_eq!(cases.len(), 20, "fixture case count drifted");
        for case in &cases {
            assert_eq!(
                validate_autonomous(&case.spec),
                case.errors,
                "fixture case: {}",
                case.name
            );
        }
    }
}
