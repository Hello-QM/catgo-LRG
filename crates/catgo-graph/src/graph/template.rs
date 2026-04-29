use serde::{Deserialize, Serialize};
use crate::core::*;

/// Specification for a graph output
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphOutputSpec {
    pub name: String,
    /// Source expression, e.g. "${nodes.evaluate_oer.outputs.overpotential}"
    pub source: String,
}

/// Specification for node outputs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeOutputSpec {
    pub keys: Vec<String>,
}

/// Retry policy for a node
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryPolicy {
    #[serde(default = "default_max_attempts")]
    pub max_attempts: u32,
    #[serde(default)]
    pub backoff: BackoffPolicy,
    #[serde(default)]
    pub retry_on: Vec<ErrorCategory>,
}

fn default_max_attempts() -> u32 { 1 }

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { max_attempts: 1, backoff: BackoffPolicy::default(), retry_on: vec![] }
    }
}

/// Backoff strategy
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum BackoffPolicy {
    None,
    Fixed { seconds: u64 },
    Exponential { base_seconds: u64, max_seconds: u64 },
}

impl Default for BackoffPolicy {
    fn default() -> Self { Self::None }
}

/// Reference to a repair policy (name-based lookup)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairPolicyRef {
    pub handler: String,
    pub config: serde_json::Value,
    /// Maximum number of repair attempts before giving up. Defaults to 3.
    #[serde(default = "default_max_repair_attempts")]
    pub max_repair_attempts: u32,
}

fn default_max_repair_attempts() -> u32 { 3 }

/// Condition for conditionally skipping a node.
///
/// If the expression resolves to a value equal to `equals`, the node is
/// marked `Skipped` instead of `Ready`.
///
/// Expression format: `${nodes.<node_id>.outputs.<key>}`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkipCondition {
    /// Expression to evaluate, e.g. "${nodes.relax.outputs.converged}"
    pub expression: String,
    /// The value to compare against. Node is skipped when expression equals this value.
    pub equals: serde_json::Value,
}

/// Reference to a subgraph template for inline expansion.
/// When a node has `subgraph: Some(ref)`, it is expanded into the referenced
/// template's nodes during graph composition, rather than being executed as a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubgraphRef {
    /// Template ID to look up in the TemplateProvider
    pub template_id: String,
    /// Optional exact version pin. If set, expansion will request this specific version.
    /// If None, the provider returns its default (typically the latest registered).
    #[serde(default)]
    pub version: Option<String>,
    /// Maps subgraph input parameter names to values/expressions.
    /// Keys are the subgraph's input names; values are literal JSON values
    /// or `${...}` expressions that resolve in the parent graph's context.
    #[serde(default)]
    pub input_map: serde_json::Value,
}

/// A single node in a graph template
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeTemplate {
    pub id: NodeId,
    #[serde(default)]
    pub tool: ToolName,
    #[serde(default)]
    pub depends_on: Vec<NodeId>,
    #[serde(default)]
    pub input_bindings: serde_json::Value,
    pub output_spec: Option<NodeOutputSpec>,
    pub retry_policy: Option<RetryPolicy>,
    pub timeout_seconds: Option<u64>,
    pub repair_policy: Option<RepairPolicyRef>,
    #[serde(default)]
    pub execution_mode: ExecutionMode,
    /// Optional condition for skipping this node.
    /// If present and evaluates to true, the node is Skipped instead of Ready.
    /// Uses a simple expression: `${nodes.X.outputs.Y} == value` or `${nodes.X.outputs.Y} != value`
    #[serde(default)]
    pub skip_condition: Option<SkipCondition>,
    /// If set, this node is a subgraph reference instead of a tool call.
    /// The subgraph template is expanded inline during graph composition.
    /// Mutually exclusive with `tool` (one must be set, not both).
    #[serde(default)]
    pub subgraph: Option<SubgraphRef>,
    #[serde(default)]
    pub metadata: Metadata,
}

/// A reusable workflow definition (the "recipe")
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphTemplate {
    #[serde(alias = "graph_id")]
    pub id: GraphTemplateId,
    pub version: String,
    pub description: Option<String>,
    #[serde(default = "default_inputs_schema")]
    pub inputs_schema: serde_json::Value,
    pub nodes: Vec<NodeTemplate>,
    #[serde(default)]
    pub outputs: Vec<GraphOutputSpec>,
    #[serde(default)]
    pub metadata: Metadata,
    /// Explicit rewrite rules for dynamic graph extension.
    /// When a source node succeeds and its outputs satisfy the condition,
    /// the referenced subgraph template is injected into the running graph.
    #[serde(default)]
    pub rewrite_rules: Vec<crate::graph::rewrite::RewriteRule>,
}

fn default_inputs_schema() -> serde_json::Value {
    serde_json::json!({})
}
