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

/// Returns the package version.
#[wasm_bindgen(js_name = version)]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
