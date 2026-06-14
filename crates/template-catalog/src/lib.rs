// SPDX-License-Identifier: MIT
//
//! Canonical quick-start template catalog, embedded at compile time.
//!
//! The single source of truth is
//! `packages/create-agent-harness/templates/catalog.def.mjs`, from which
//! `scripts/gen-templates.mjs` emits `templates/catalog.json`. That JSON is
//! `include_str!`'d here so the Rust core, the `create-agent-harness` CLI, and
//! the web UI all agree on the same template set without drift.
//!
//! Keep this in lockstep: regenerate (`npm run gen:templates`) whenever the
//! definition changes — the test below fails loudly if the embedded JSON stops
//! parsing or the catalog shrinks unexpectedly.

use serde::Deserialize;

/// Raw JSON embedded from the canonical catalog.
const CATALOG_JSON: &str =
    include_str!("../../../packages/create-agent-harness/templates/catalog.json");

/// A single agent listed by a template.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentMeta {
    pub id: String,
    pub name: String,
    pub tier: String,
    pub role: String,
}

/// A skill or command listed by a template (same shape).
#[derive(Debug, Clone, Deserialize)]
pub struct ItemMeta {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// One quick-start template.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateMeta {
    pub id: String,
    pub dir: String,
    pub category: String,
    pub name: String,
    pub domain: String,
    pub description: String,
    pub harness_desc: String,
    pub quick_start: String,
    pub tags: Vec<String>,
    pub generate: bool,
    pub mcp_servers: Vec<String>,
    pub agent_count: usize,
    pub skill_count: usize,
    pub command_count: usize,
    pub agents: Vec<AgentMeta>,
    pub skills: Vec<ItemMeta>,
    pub commands: Vec<ItemMeta>,
}

/// The whole catalog.
#[derive(Debug, Clone, Deserialize)]
pub struct Catalog {
    pub schema: u32,
    pub templates: Vec<TemplateMeta>,
}

impl Catalog {
    /// Parse the embedded catalog. Infallible in practice (the JSON is a build
    /// artifact), but returns a `Result` so callers can surface corruption.
    pub fn load() -> Result<Self, serde_json::Error> {
        serde_json::from_str(CATALOG_JSON)
    }

    /// Templates the generator materialises as on-disk dirs (`generate: true`).
    pub fn generated(&self) -> impl Iterator<Item = &TemplateMeta> {
        self.templates.iter().filter(|t| t.generate)
    }

    /// Look up a template by its `vertical:<slug>` id.
    pub fn by_id(&self, id: &str) -> Option<&TemplateMeta> {
        self.templates.iter().find(|t| t.id == id)
    }

    /// Distinct category labels, in first-seen order.
    pub fn categories(&self) -> Vec<&str> {
        let mut seen = Vec::new();
        for t in &self.templates {
            if !seen.contains(&t.category.as_str()) {
                seen.push(t.category.as_str());
            }
        }
        seen
    }
}

/// Convenience: load the embedded catalog or panic with a clear message.
/// Use in contexts where a corrupt build artifact should abort.
pub fn catalog() -> Catalog {
    Catalog::load().expect("embedded templates/catalog.json must be valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_json_parses() {
        let c = Catalog::load().expect("catalog.json parses");
        assert_eq!(c.schema, 1);
        // iter 96 bumped to 19 with vertical:gaming. iter-86's
        // healthcheck catalogCount cross-check enforces 3-way sync
        // (catalog.json + TS test + this assertion) pre-push, so the
        // iter-83 drift mode can't recur.
        assert_eq!(c.templates.len(), 19, "expected 19 templates");
    }

    #[test]
    fn ids_are_unique() {
        let c = catalog();
        let mut ids: Vec<&str> = c.templates.iter().map(|t| t.id.as_str()).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "template ids must be unique");
    }

    #[test]
    fn covers_every_requested_category() {
        let c = catalog();
        for id in [
            "vertical:coding",
            "vertical:business",
            "vertical:ruview",
            "vertical:health",
            "vertical:crm",
            "vertical:marketing",
            "vertical:advertising",
            "vertical:research",
            "vertical:ai",
            "vertical:agentics",
            "vertical:exotic",
        ] {
            assert!(c.by_id(id).is_some(), "missing template {id}");
        }
    }

    #[test]
    fn generated_templates_have_agents_and_a_dir() {
        let c = catalog();
        let generated: Vec<_> = c.generated().collect();
        assert!(generated.len() >= 10, "expected >= 10 generated templates");
        for t in generated {
            assert!(!t.dir.is_empty(), "{} has no dir", t.id);
            assert_eq!(
                t.agent_count,
                t.agents.len(),
                "{} agent_count mismatch",
                t.id
            );
            assert!(
                t.agent_count > 0,
                "generated template {} has no agents",
                t.id
            );
        }
    }

    #[test]
    fn every_template_reports_the_kernel_mcp_server() {
        let c = catalog();
        for t in &c.templates {
            assert!(
                t.mcp_servers.iter().any(|s| s == "{{name}}"),
                "{} is missing the kernel MCP server",
                t.id
            );
        }
    }
}
