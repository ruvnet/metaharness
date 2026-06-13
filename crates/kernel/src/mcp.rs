// SPDX-License-Identifier: MIT
//! MCP server registration intent and tool dispatch (stub).

use serde::{Deserialize, Serialize};

/// Declarative MCP-server intent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerSpec {
    /// Server name.
    pub name: String,
    /// Stdio command (mutually exclusive with `url`).
    pub command: Option<Vec<String>>,
    /// Streamable HTTP URL (mutually exclusive with `command`).
    pub url: Option<String>,
    /// Env vars to set in the spawned MCP server's process.
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

/// Sanity-check a server spec.
pub fn validate(spec: &McpServerSpec) -> crate::Result<()> {
    if spec.name.is_empty() {
        return Err(crate::Error::Mcp("server name is empty".into()));
    }
    match (&spec.command, &spec.url) {
        (Some(c), None) if !c.is_empty() => Ok(()),
        (None, Some(u)) if !u.is_empty() => Ok(()),
        (Some(_), Some(_)) => Err(crate::Error::Mcp(
            "command and url are mutually exclusive".into(),
        )),
        _ => Err(crate::Error::Mcp(
            "either command or url must be set".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_accepts_stdio() {
        let s = McpServerSpec {
            name: "x".into(),
            command: Some(vec!["npx".into(), "-y".into(), "demo".into()]),
            url: None,
            env: vec![],
        };
        assert!(validate(&s).is_ok());
    }

    #[test]
    fn validate_rejects_empty_name() {
        let s = McpServerSpec {
            name: "".into(),
            command: Some(vec!["x".into()]),
            url: None,
            env: vec![],
        };
        assert!(validate(&s).is_err());
    }

    #[test]
    fn validate_rejects_both() {
        let s = McpServerSpec {
            name: "x".into(),
            command: Some(vec!["x".into()]),
            url: Some("https://x".into()),
            env: vec![],
        };
        assert!(validate(&s).is_err());
    }

    #[test]
    fn validate_rejects_neither() {
        let s = McpServerSpec {
            name: "x".into(),
            command: None,
            url: None,
            env: vec![],
        };
        assert!(validate(&s).is_err());
    }
}
