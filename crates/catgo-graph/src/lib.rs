pub mod core;
pub mod graph;
pub mod runtime;
pub mod tools;
pub mod storage;
pub mod repair;
pub mod api;

// Re-export key types for convenient access
pub use core::{EngineError, NodeStatus, GraphRunStatus, StructuredError, ErrorCategory, AttemptStatus};
pub use graph::template::{GraphTemplate, NodeTemplate, RetryPolicy, BackoffPolicy, SkipCondition, SubgraphRef};
pub use graph::composer::{TemplateProvider, expand_subgraphs};
pub use graph::run::{GraphRun, NodeRun, NodeAttempt, ArtifactRef, ArtifactKind, ToolExecutionResult};
pub use tools::traits::{Tool, ToolExecutionContext};
pub use tools::registry::ToolRegistry;
pub use tools::file_writer::FileWriterTool;
pub use tools::stats::StatsTool;
pub use tools::vasp::VaspTool;
pub use tools::http_bridge::HttpBridgeTool;
pub use tools::native::{
    register_native_tools, EnergyCompareTool, ConvergenceCheckTool,
    ConditionTool, LoopTool, MergeTool,
    StructureInputTool, DopingGenTool, StrainDeformTool, SupercellGenTool, DefectGenTool,
};
pub use storage::traits::{StateStore, ArtifactStore};
pub use runtime::{GraphEngine, RuntimeConfig};
pub use runtime::executor::ExecutionEvent;
pub use repair::traits::{RepairHandler, RepairContext, RepairOutcome};
pub use repair::RepairRegistry;
pub use api::graph_api::TemplateRegistry;
pub use graph::subgraph_validate::validate_subgraph_refs;
pub use api::dto::{NodeHierarchyDetail, GroupSummary, GraphHierarchyDetail};
pub use graph::rewrite::{RewriteRule, RewriteCondition, ConditionOperator, RewriteEvent, RewriteLimits};
pub use api::dto::{RewriteEventSummary, RewriteSourceInfo};
pub use tokio_util::sync::CancellationToken;
