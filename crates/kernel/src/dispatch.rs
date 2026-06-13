// SPDX-License-Identifier: MIT
//
// MCP tool dispatch chain.
//
// Per ADR-002 §dispatch, the kernel owns the tool-dispatch envelope:
//   1. Look up the tool in the ToolRegistry
//   2. Validate the args against the tool's input_schema (shape-check only;
//      semantic validation is the tool's own job)
//   3. Check the caller's claims authorize the capability + resource
//   4. Emit a ToolCallEnvelope describing the dispatch decision
//
// The kernel does NOT execute the tool — that's the host's job. The kernel
// outputs the envelope the host invokes. This keeps tool execution side
// effects out of the wasm bundle.

//! MCP tool dispatch chain (envelope + auth check).

use crate::claims::{self, AuthDecision, Claim};
use crate::mcp::{ToolRegistry, ToolSpec};
use serde::{Deserialize, Serialize};

/// A request to dispatch a tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRequest {
    /// Target server name.
    pub server: String,
    /// Tool name within the server.
    pub tool: String,
    /// Arguments as a JSON object.
    pub args: serde_json::Value,
    /// Claims the caller is presenting.
    #[serde(default)]
    pub claims: Vec<Claim>,
    /// Optional resource scope to authorize against.
    #[serde(default)]
    pub resource: Option<String>,
}

/// The dispatch decision the kernel produces.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Dispatch {
    /// Tool exists, args shape valid, claims authorize. Host should invoke.
    Invoke {
        spec: ToolSpec,
        normalized_args: serde_json::Value,
    },
    /// Tool not found in the registry.
    NotFound { server: String, tool: String },
    /// Args don't match the declared input_schema's top-level shape.
    BadArgs { reason: String },
    /// Claims did not authorize the call.
    Denied { reason: String },
}

/// Dispatch a tool call.
///
/// Implementation note: schema validation here is intentionally shape-only
/// (must be an object). Full JSON-Schema validation is the tool's own job,
/// because the schema vocabulary is open-ended and pulling in a JSON-Schema
/// validator would bloat the wasm bundle by ~200 KB. Per ADR-002a's size
/// budget, that's not worth it.
pub fn dispatch(
    request: &ToolCallRequest,
    registry: &ToolRegistry,
    now_unix: i64,
) -> Dispatch {
    let spec = match registry.get(&request.server, &request.tool) {
        Some(s) => s.clone(),
        None => return Dispatch::NotFound {
            server: request.server.clone(),
            tool: request.tool.clone(),
        },
    };

    if !request.args.is_object() {
        return Dispatch::BadArgs {
            reason: "args must be a JSON object".into(),
        };
    }

    // Capability convention: tool.invoke.<server>.<tool>
    let capability = format!("tool.invoke.{}.{}", request.server, request.tool);
    match claims::check(&request.claims, &capability, request.resource.as_deref(), now_unix) {
        AuthDecision::Allowed => Dispatch::Invoke {
            spec,
            normalized_args: request.args.clone(),
        },
        AuthDecision::Denied { reason } => Dispatch::Denied { reason },
    }
}

/// Convenience: dispatch with a wildcard claim (development / SelfPeer
/// federation path). Skips the claims check entirely.
pub fn dispatch_unauthenticated(request: &ToolCallRequest, registry: &ToolRegistry) -> Dispatch {
    let spec = match registry.get(&request.server, &request.tool) {
        Some(s) => s.clone(),
        None => return Dispatch::NotFound {
            server: request.server.clone(),
            tool: request.tool.clone(),
        },
    };
    if !request.args.is_object() {
        return Dispatch::BadArgs { reason: "args must be a JSON object".into() };
    }
    Dispatch::Invoke { spec, normalized_args: request.args.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::ToolSpec;

    fn now() -> i64 { 1_700_000_000 }

    fn registry_with(tools: Vec<ToolSpec>) -> ToolRegistry {
        let mut r = ToolRegistry::new();
        for t in tools {
            r.register(t).unwrap();
        }
        r
    }

    fn tool(server: &str, name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            server: server.into(),
            description: "t".into(),
            input_schema: serde_json::json!({ "type": "object" }),
        }
    }

    fn allow_claim(cap: &str) -> Claim {
        Claim {
            capability: cap.into(),
            resource: None,
            expires_at: now() + 1000,
        }
    }

    #[test]
    fn dispatch_invokes_when_claim_allows() {
        let r = registry_with(vec![tool("memory", "store")]);
        let req = ToolCallRequest {
            server: "memory".into(),
            tool: "store".into(),
            args: serde_json::json!({}),
            claims: vec![allow_claim("*")],
            resource: None,
        };
        let d = dispatch(&req, &r, now());
        assert!(matches!(d, Dispatch::Invoke { .. }));
    }

    #[test]
    fn dispatch_denies_when_claim_missing() {
        let r = registry_with(vec![tool("memory", "store")]);
        let req = ToolCallRequest {
            server: "memory".into(),
            tool: "store".into(),
            args: serde_json::json!({}),
            claims: vec![],
            resource: None,
        };
        let d = dispatch(&req, &r, now());
        assert!(matches!(d, Dispatch::Denied { .. }));
    }

    #[test]
    fn dispatch_returns_notfound() {
        let r = registry_with(vec![]);
        let req = ToolCallRequest {
            server: "memory".into(),
            tool: "missing".into(),
            args: serde_json::json!({}),
            claims: vec![allow_claim("*")],
            resource: None,
        };
        assert!(matches!(dispatch(&req, &r, now()), Dispatch::NotFound { .. }));
    }

    #[test]
    fn dispatch_rejects_non_object_args() {
        let r = registry_with(vec![tool("x", "y")]);
        let req = ToolCallRequest {
            server: "x".into(),
            tool: "y".into(),
            args: serde_json::json!("string-not-object"),
            claims: vec![allow_claim("*")],
            resource: None,
        };
        let d = dispatch(&req, &r, now());
        assert!(matches!(d, Dispatch::BadArgs { .. }));
    }

    #[test]
    fn capability_string_is_specific() {
        // Allow tool.invoke.memory.* but try to invoke a tool on a
        // different server -> should be denied.
        let r = registry_with(vec![tool("alerts", "fire")]);
        let req = ToolCallRequest {
            server: "alerts".into(),
            tool: "fire".into(),
            args: serde_json::json!({}),
            claims: vec![allow_claim("tool.invoke.memory.*")],
            resource: None,
        };
        let d = dispatch(&req, &r, now());
        assert!(matches!(d, Dispatch::Denied { .. }));
    }

    #[test]
    fn dispatch_unauthenticated_skips_claim_check() {
        let r = registry_with(vec![tool("x", "y")]);
        let req = ToolCallRequest {
            server: "x".into(),
            tool: "y".into(),
            args: serde_json::json!({}),
            claims: vec![],
            resource: None,
        };
        let d = dispatch_unauthenticated(&req, &r);
        assert!(matches!(d, Dispatch::Invoke { .. }));
    }
}
