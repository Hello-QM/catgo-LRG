use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::core::errors::StructuredError;
use crate::core::ids::{GraphRunId, NodeId};
use crate::graph::run::{ArtifactRef, NodeRun};

/// Context for repair execution.
#[derive(Debug, Clone)]
pub struct RepairContext {
    pub run_id: GraphRunId,
    pub node_id: NodeId,
    pub work_dir: String,
}

/// Outcome of a repair attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairOutcome {
    /// If set, the repaired inputs to use for re-execution.
    pub repaired_inputs: Option<serde_json::Value>,
    /// Human-readable notes about what was repaired.
    pub notes: String,
    /// Artifacts produced during repair (e.g. modified input files).
    pub artifacts: Vec<ArtifactRef>,
}

/// Trait for domain-specific repair handlers.
///
/// The runtime calls these when a node has a `repair_policy` and fails.
/// Repair handlers analyze the failure and attempt to fix the inputs
/// (e.g. adjusting convergence parameters for SCF non-convergence).
#[async_trait]
pub trait RepairHandler: Send + Sync {
    /// Name of this repair handler (must match `RepairPolicyRef.handler`).
    fn name(&self) -> &str;

    /// Attempt to repair a failed node.
    ///
    /// Returns `Ok(RepairOutcome)` with repaired inputs if repair is possible,
    /// or `Err(StructuredError)` if repair fails or is not applicable.
    async fn repair(
        &self,
        ctx: RepairContext,
        node_run: &NodeRun,
    ) -> Result<RepairOutcome, StructuredError>;
}

/// Registry of repair handlers, keyed by handler name.
pub struct RepairRegistry {
    handlers: HashMap<String, Arc<dyn RepairHandler>>,
}

impl RepairRegistry {
    pub fn new() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }

    /// Register a repair handler.
    pub fn register(&mut self, handler: Arc<dyn RepairHandler>) {
        self.handlers.insert(handler.name().to_string(), handler);
    }

    /// Look up a repair handler by name.
    pub fn get(&self, name: &str) -> Option<Arc<dyn RepairHandler>> {
        self.handlers.get(name).cloned()
    }

    /// List all registered handler names.
    pub fn list(&self) -> Vec<String> {
        let mut names: Vec<String> = self.handlers.keys().cloned().collect();
        names.sort();
        names
    }
}

impl Default for RepairRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mock repair handler for testing the registry and trait.
    struct MockRepairHandler {
        handler_name: String,
        should_succeed: bool,
    }

    impl MockRepairHandler {
        fn new(name: &str, should_succeed: bool) -> Self {
            Self {
                handler_name: name.to_string(),
                should_succeed,
            }
        }
    }

    #[async_trait]
    impl RepairHandler for MockRepairHandler {
        fn name(&self) -> &str {
            &self.handler_name
        }

        async fn repair(
            &self,
            _ctx: RepairContext,
            _node_run: &NodeRun,
        ) -> Result<RepairOutcome, StructuredError> {
            if self.should_succeed {
                Ok(RepairOutcome {
                    repaired_inputs: Some(serde_json::json!({"repaired": true})),
                    notes: format!("{} repaired successfully", self.handler_name),
                    artifacts: vec![],
                })
            } else {
                Err(StructuredError {
                    category: crate::core::errors::ErrorCategory::RepairFailed,
                    code: Some("MOCK_REPAIR_FAIL".into()),
                    message: format!("{} repair failed", self.handler_name),
                    retryable: false,
                    details: serde_json::json!({}),
                })
            }
        }
    }

    fn make_repair_context() -> RepairContext {
        RepairContext {
            run_id: "run-001".to_string(),
            node_id: "node-A".to_string(),
            work_dir: "/tmp/test".to_string(),
        }
    }

    #[test]
    fn test_repair_registry_register_and_get() {
        let mut registry = RepairRegistry::new();
        let handler = Arc::new(MockRepairHandler::new("scf_repair", true));
        registry.register(handler);

        let retrieved = registry.get("scf_repair");
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().name(), "scf_repair");
    }

    #[test]
    fn test_repair_registry_get_missing() {
        let registry = RepairRegistry::new();
        assert!(registry.get("nonexistent").is_none());
    }

    #[test]
    fn test_repair_registry_list() {
        let mut registry = RepairRegistry::new();
        registry.register(Arc::new(MockRepairHandler::new("charlie", true)));
        registry.register(Arc::new(MockRepairHandler::new("alpha", true)));
        registry.register(Arc::new(MockRepairHandler::new("bravo", true)));

        let names = registry.list();
        assert_eq!(names, vec!["alpha", "bravo", "charlie"]);
    }

    #[test]
    fn test_repair_registry_overwrite() {
        let mut registry = RepairRegistry::new();
        registry.register(Arc::new(MockRepairHandler::new("scf_repair", true)));
        registry.register(Arc::new(MockRepairHandler::new("scf_repair", false)));

        // Should still have exactly one entry
        assert_eq!(registry.list().len(), 1);
        assert!(registry.get("scf_repair").is_some());
    }

    #[tokio::test]
    async fn test_mock_repair_handler_success() {
        let handler = MockRepairHandler::new("scf_repair", true);
        let ctx = make_repair_context();
        let node_run = NodeRun::new("node-A".to_string());

        let result = handler.repair(ctx, &node_run).await;
        assert!(result.is_ok());

        let outcome = result.unwrap();
        assert_eq!(outcome.notes, "scf_repair repaired successfully");
        assert!(outcome.repaired_inputs.is_some());
        assert_eq!(
            outcome.repaired_inputs.unwrap(),
            serde_json::json!({"repaired": true})
        );
        assert!(outcome.artifacts.is_empty());
    }

    #[tokio::test]
    async fn test_mock_repair_handler_failure() {
        let handler = MockRepairHandler::new("ionic_repair", false);
        let ctx = make_repair_context();
        let node_run = NodeRun::new("node-A".to_string());

        let result = handler.repair(ctx, &node_run).await;
        assert!(result.is_err());

        let err = result.unwrap_err();
        assert_eq!(err.category, crate::core::errors::ErrorCategory::RepairFailed);
        assert_eq!(err.code, Some("MOCK_REPAIR_FAIL".to_string()));
        assert!(err.message.contains("ionic_repair repair failed"));
        assert!(!err.retryable);
    }
}
