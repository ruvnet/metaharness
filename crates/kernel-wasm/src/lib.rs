// SPDX-License-Identifier: MIT
#![allow(clippy::unused_unit)]

use serde_wasm_bindgen::to_value;
use wasm_bindgen::prelude::*;

/// Return kernel build metadata as a JS object.
#[wasm_bindgen(js_name = kernelInfo)]
pub fn kernel_info() -> Result<JsValue, JsValue> {
    let info = ruflo_kernel::kernel_info();
    to_value(&info).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Validate an MCP server spec (returns `null` on success, error string otherwise).
#[wasm_bindgen(js_name = mcpValidate)]
pub fn mcp_validate(spec_json: &str) -> Result<JsValue, JsValue> {
    let spec: ruflo_kernel::mcp::McpServerSpec = serde_json::from_str(spec_json)
        .map_err(|e| JsValue::from_str(&format!("invalid spec json: {e}")))?;
    match ruflo_kernel::mcp::validate(&spec) {
        Ok(()) => Ok(JsValue::NULL),
        Err(e) => Ok(JsValue::from_str(&e.to_string())),
    }
}

/// Validate an autonomous spec block (ADR-241 §2.2).
/// Returns a JS array of lockstep error strings; empty array = valid.
#[wasm_bindgen(js_name = autonomousValidate)]
pub fn autonomous_validate(spec_json: &str) -> Result<JsValue, JsValue> {
    let spec: ruflo_kernel::autonomous::AutonomousSpec = serde_json::from_str(spec_json)
        .map_err(|e| JsValue::from_str(&format!("invalid spec json: {e}")))?;
    let errors = ruflo_kernel::autonomous::validate_autonomous(&spec);
    to_value(&errors).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Validate a JSONL session log (ADR-241 §2.3).
/// Returns a JS array of 'session: '-prefixed error strings; empty = valid.
#[wasm_bindgen(js_name = sessionValidate)]
pub fn session_validate(log_jsonl: &str) -> Result<JsValue, JsValue> {
    let events = ruflo_kernel::session::parse_log(log_jsonl)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let errors = ruflo_kernel::session::validate_log(&events);
    to_value(&errors).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Deterministic state hash (lowercase sha256 hex) of a branch lineage
/// in a JSONL session log.
#[wasm_bindgen(js_name = sessionStateHash)]
pub fn session_state_hash(log_jsonl: &str, branch: &str) -> Result<String, JsValue> {
    let events = ruflo_kernel::session::parse_log(log_jsonl)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(ruflo_kernel::session::state_hash(&events, branch))
}

/// Replay a branch of a JSONL session log.
/// Returns `{ eventCount, stateHash }` on success, error string otherwise.
#[wasm_bindgen(js_name = sessionReplay)]
pub fn session_replay(log_jsonl: &str, branch: &str) -> Result<JsValue, JsValue> {
    let events = ruflo_kernel::session::parse_log(log_jsonl)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let summary = ruflo_kernel::session::replay(&events, branch)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    to_value(&summary).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Returns the package version.
#[wasm_bindgen(js_name = version)]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
