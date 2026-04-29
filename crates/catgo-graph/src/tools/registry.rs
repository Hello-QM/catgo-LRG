use std::collections::HashMap;
use std::sync::Arc;
use crate::tools::traits::Tool;

/// Registry of available tools, keyed by name
#[derive(Default)]
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    pub fn list(&self) -> Vec<String> {
        let mut names: Vec<_> = self.tools.keys().cloned().collect();
        names.sort();
        names
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::mock::EchoTool;

    #[test]
    fn test_register_and_get() {
        let mut registry = ToolRegistry::new();
        let tool = Arc::new(EchoTool::new("my_echo"));
        registry.register(tool);

        let retrieved = registry.get("my_echo");
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().name(), "my_echo");
    }

    #[test]
    fn test_get_missing_returns_none() {
        let registry = ToolRegistry::new();
        assert!(registry.get("nonexistent").is_none());
    }

    #[test]
    fn test_list_returns_sorted_names() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(EchoTool::new("charlie")));
        registry.register(Arc::new(EchoTool::new("alpha")));
        registry.register(Arc::new(EchoTool::new("bravo")));

        let names = registry.list();
        assert_eq!(names, vec!["alpha", "bravo", "charlie"]);
    }

    #[test]
    fn test_overwrite_replaces_tool() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(EchoTool::new("tool_a")));
        registry.register(Arc::new(EchoTool::new("tool_a")));

        // After overwrite, still exactly one entry for "tool_a"
        assert_eq!(registry.list().len(), 1);
        assert!(registry.get("tool_a").is_some());
    }

    #[test]
    fn test_list_empty_registry() {
        let registry = ToolRegistry::new();
        assert!(registry.list().is_empty());
    }
}
