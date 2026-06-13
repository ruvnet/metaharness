// SPDX-License-Identifier: MIT
#![deny(clippy::all)]

use napi_derive::napi;

#[napi(js_name = "kernelInfo")]
pub fn kernel_info() -> napi::Result<serde_json::Value> {
    let info = ruflo_kernel::kernel_info();
    serde_json::to_value(info).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi(js_name = "mcpValidate")]
pub fn mcp_validate(spec_json: String) -> napi::Result<Option<String>> {
    let spec: ruflo_kernel::mcp::McpServerSpec = serde_json::from_str(&spec_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid spec json: {e}")))?;
    match ruflo_kernel::mcp::validate(&spec) {
        Ok(()) => Ok(None),
        Err(e) => Ok(Some(e.to_string())),
    }
}

#[napi(js_name = "version")]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
