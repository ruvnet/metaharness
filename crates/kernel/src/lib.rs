// SPDX-License-Identifier: MIT
//
// ruflo-kernel — cross-platform kernel for agent-harness-generator.
//
// Seven subsystems per ADR-002:
//   - mcp       MCP server registration (stdio + Streamable HTTP)
//   - hooks     Lifecycle event router (5 handler types per ADR-004)
//   - memory    AgentDB + HNSW + ReasoningBank bridge
//   - routing   3-tier model routing decision
//   - intel     Intelligence pipeline (RETRIEVE → JUDGE → DISTILL → CONSOLIDATE)
//   - claims    Claims-based authorization
//   - witness   Ed25519 signed-manifest provenance

#![forbid(unsafe_code)]
#![warn(missing_docs, rust_2018_idioms)]

//! Cross-platform kernel for the agent-harness-generator project.

pub mod claims;
pub mod hooks;
pub mod intel;
pub mod mcp;
pub mod memory;
pub mod routing;
pub mod witness;

/// Kernel-wide error type.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// MCP registration / dispatch failed.
    #[error("mcp: {0}")]
    Mcp(String),
    /// Hooks runner failed.
    #[error("hooks: {0}")]
    Hooks(String),
    /// Memory bridge failed.
    #[error("memory: {0}")]
    Memory(String),
    /// Router could not produce a tier decision.
    #[error("routing: {0}")]
    Routing(String),
    /// Intelligence pipeline phase failed.
    #[error("intel: {0}")]
    Intel(String),
    /// Claims check denied.
    #[error("claims: {0}")]
    Claims(String),
    /// Witness manifest sign/verify failed.
    #[error("witness: {0}")]
    Witness(String),
    /// Generic catch-all for foreign errors.
    #[error("other: {0}")]
    Other(String),
}

/// Convenience alias.
pub type Result<T> = std::result::Result<T, Error>;

/// Build-time metadata exposed to bindings.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KernelInfo {
    /// Semver string from Cargo.toml.
    pub version: &'static str,
    /// Git commit short SHA.
    pub git_sha: &'static str,
    /// Target triple this kernel was compiled for.
    pub target: &'static str,
}

/// Return kernel build identification.
pub fn kernel_info() -> KernelInfo {
    KernelInfo {
        version: env!("CARGO_PKG_VERSION"),
        git_sha: option_env!("RUFLO_KERNEL_GIT_SHA").unwrap_or("unknown"),
        target: option_env!("RUFLO_KERNEL_TARGET").unwrap_or("unknown"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_info_returns_version() {
        let info = kernel_info();
        assert!(!info.version.is_empty());
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn error_variants_render() {
        let e = Error::Mcp("test".into());
        assert!(format!("{e}").contains("mcp"));
    }
}
