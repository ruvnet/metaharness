// SPDX-License-Identifier: MIT
//! Lifecycle hook events and handler contract (stub).

use serde::{Deserialize, Serialize};

/// Hook events shared across hosts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HookEvent {
    /// Session start.
    SessionStart,
    /// User prompt submission.
    UserPromptSubmit,
    /// Before a tool is invoked.
    PreToolUse,
    /// After a tool finishes (success path).
    PostToolUse,
    /// After a tool finishes (failure path).
    PostToolUseFailure,
    /// Session stop.
    Stop,
    /// Subagent start.
    SubagentStart,
    /// Subagent stop.
    SubagentStop,
    /// File changed.
    FileChanged,
}

/// Decision a hook handler can return.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionDecision {
    /// Allow the action.
    Allow,
    /// Deny the action.
    Deny,
    /// Ask the user.
    Ask,
    /// Defer to the next handler in the chain.
    Defer,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_serializes() {
        let s = serde_json::to_string(&HookEvent::SessionStart).unwrap();
        assert_eq!(s, "\"SessionStart\"");
    }

    #[test]
    fn permission_serializes() {
        let s = serde_json::to_string(&PermissionDecision::Deny).unwrap();
        assert_eq!(s, "\"Deny\"");
    }
}
