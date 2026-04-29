//! Bidirectional converter between SvelteFlow graph JSON and catgo-graph's GraphTemplate.
//!
//! The SvelteFlow format is what CatGO's frontend editor produces:
//! ```json
//! { "nodes": [{ "id": "n1", "type": "vasp_relax", "x": 80, "y": 200, "params": {...} }],
//!   "edges": [{ "id": "e1", "from": "n1", "to": "n2", "fromH": "structure", "toH": "structure" }] }
//! ```
//!
//! The GraphTemplate format is catgo-graph's typed Rust representation.
//! Round-trip fidelity is maintained via metadata fields.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::core::*;
use crate::graph::template::*;

/// Errors that can occur during conversion.
#[derive(Debug, thiserror::Error)]
pub enum ConversionError {
    #[error("JSON parse error: {0}")]
    JsonParse(#[from] serde_json::Error),

    #[error("Missing required field '{field}' in node '{node_id}'")]
    MissingField { node_id: String, field: String },

    #[error("Invalid graph structure: {reason}")]
    InvalidStructure { reason: String },
}

// ---------------------------------------------------------------------------
// SvelteFlow types (matching frontend format)
// ---------------------------------------------------------------------------

/// A node in SvelteFlow format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SFNode {
    pub id: String,
    #[serde(rename = "type", default)]
    pub node_type: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub params: serde_json::Value,
    /// Svelte Flow's `data` field (may contain label, config).
    #[serde(default)]
    pub data: serde_json::Value,
}

/// An edge in SvelteFlow format (supports both from/to and source/target).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SFEdge {
    pub id: String,
    /// Source node ID (SvelteFlow format uses "source", CatGO format uses "from")
    #[serde(alias = "source")]
    pub from: Option<String>,
    /// Target node ID
    #[serde(alias = "target")]
    pub to: Option<String>,
    /// Source handle name
    #[serde(alias = "sourceHandle", rename = "fromH")]
    pub from_handle: Option<String>,
    /// Target handle name
    #[serde(alias = "targetHandle", rename = "toH")]
    pub to_handle: Option<String>,
    /// Edge label
    #[serde(default)]
    pub label: Option<String>,
    /// Edge type for conditional edges
    #[serde(rename = "type", default)]
    pub edge_type: Option<String>,
    /// Condition JSON for conditional edges
    #[serde(default)]
    pub condition: Option<serde_json::Value>,
}

/// Top-level SvelteFlow graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SvelteFlowGraph {
    pub nodes: Vec<SFNode>,
    pub edges: Vec<SFEdge>,
}

// ---------------------------------------------------------------------------
// SvelteFlow → GraphTemplate
// ---------------------------------------------------------------------------

/// Convert SvelteFlow JSON string to a GraphTemplate.
///
/// - Node IDs are preserved as-is
/// - `type` → `tool` field (the node_type becomes the tool name)
/// - Edges → `depends_on` relationships
/// - Node params → `input_bindings`
/// - Position/visual metadata preserved in `NodeTemplate.metadata`
/// - Conditional edges → `skip_condition`
pub fn svelteflow_to_template(
    json: &str,
    template_id: &str,
) -> Result<GraphTemplate, ConversionError> {
    let graph: SvelteFlowGraph = serde_json::from_str(json)?;
    svelteflow_graph_to_template(&graph, template_id)
}

/// Convert a parsed SvelteFlowGraph to a GraphTemplate.
pub fn svelteflow_graph_to_template(
    graph: &SvelteFlowGraph,
    template_id: &str,
) -> Result<GraphTemplate, ConversionError> {
    // Build dependency map: target_node_id → [source_node_ids]
    let mut deps: HashMap<String, Vec<String>> = HashMap::new();
    // Build edge metadata map for conditional edges: target_node_id → condition
    let mut conditions: HashMap<String, serde_json::Value> = HashMap::new();
    // Track all edge info for metadata preservation
    let mut edge_metadata: Vec<serde_json::Value> = Vec::new();

    for edge in &graph.edges {
        let source = edge.from.as_deref().unwrap_or("");
        let target = edge.to.as_deref().unwrap_or("");

        if source.is_empty() || target.is_empty() {
            continue;
        }

        deps.entry(target.to_string())
            .or_default()
            .push(source.to_string());

        // Handle conditional edges
        if edge.edge_type.as_deref() == Some("conditional") {
            if let Some(cond) = &edge.condition {
                conditions.insert(target.to_string(), cond.clone());
            }
        }

        // Preserve edge data for round-trip
        edge_metadata.push(serde_json::json!({
            "id": edge.id,
            "from": source,
            "to": target,
            "fromH": edge.from_handle,
            "toH": edge.to_handle,
            "label": edge.label,
            "type": edge.edge_type,
            "condition": edge.condition,
        }));
    }

    // Convert nodes
    let nodes: Vec<NodeTemplate> = graph
        .nodes
        .iter()
        .map(|sf_node| {
            let depends_on = deps
                .get(&sf_node.id)
                .cloned()
                .unwrap_or_default();

            // Extract params from either node.params or node.data.config
            let input_bindings = if !sf_node.params.is_null() && sf_node.params != serde_json::json!({}) {
                sf_node.params.clone()
            } else if let Some(config) = sf_node.data.get("config") {
                config.clone()
            } else {
                serde_json::json!({})
            };

            // Build skip condition from conditional edge
            let skip_condition = conditions.get(&sf_node.id).and_then(|cond| {
                // Try to parse condition into SkipCondition
                // Expected format: { "expression": "${nodes.X.outputs.Y}", "equals": value }
                if let (Some(expr), Some(eq)) = (
                    cond.get("expression").and_then(|v| v.as_str()),
                    cond.get("equals"),
                ) {
                    Some(SkipCondition {
                        expression: expr.to_string(),
                        equals: eq.clone(),
                    })
                } else {
                    None
                }
            });

            // Preserve SvelteFlow visual metadata for round-trip fidelity
            let mut metadata: Metadata = HashMap::new();
            metadata.insert("sf_x".into(), serde_json::json!(sf_node.x));
            metadata.insert("sf_y".into(), serde_json::json!(sf_node.y));
            if !sf_node.data.is_null() {
                metadata.insert("sf_data".into(), sf_node.data.clone());
            }

            // Extract label from data if present
            if let Some(label) = sf_node.data.get("label").and_then(|v| v.as_str()) {
                metadata.insert("label".into(), serde_json::json!(label));
            }

            NodeTemplate {
                id: sf_node.id.clone(),
                tool: sf_node.node_type.clone(),
                depends_on,
                input_bindings,
                output_spec: None,
                retry_policy: None,
                timeout_seconds: None,
                repair_policy: None,
                execution_mode: ExecutionMode::default(),
                skip_condition,
                subgraph: None,
                metadata,
            }
        })
        .collect();

    // Build template metadata preserving edge info for round-trip
    let mut template_metadata: Metadata = HashMap::new();
    template_metadata.insert("sf_edges".into(), serde_json::json!(edge_metadata));

    Ok(GraphTemplate {
        id: template_id.to_string(),
        version: "1.0.0".into(),
        description: None,
        inputs_schema: serde_json::json!({}),
        nodes,
        outputs: Vec::new(),
        metadata: template_metadata,
        rewrite_rules: Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// GraphTemplate → SvelteFlow
// ---------------------------------------------------------------------------

/// Convert a GraphTemplate back to SvelteFlow JSON string.
///
/// Uses metadata stored during `svelteflow_to_template` for position/visual data.
/// If metadata is missing, generates reasonable defaults.
pub fn template_to_svelteflow(template: &GraphTemplate) -> Result<String, ConversionError> {
    let graph = template_to_svelteflow_graph(template)?;
    Ok(serde_json::to_string(&graph)?)
}

/// Convert a GraphTemplate to a SvelteFlowGraph struct.
pub fn template_to_svelteflow_graph(
    template: &GraphTemplate,
) -> Result<SvelteFlowGraph, ConversionError> {
    // Try to recover edges from metadata first (round-trip)
    let edges = if let Some(sf_edges) = template.metadata.get("sf_edges") {
        // Round-trip path: reconstruct edges from preserved metadata
        let raw_edges: Vec<serde_json::Value> =
            serde_json::from_value(sf_edges.clone()).unwrap_or_default();
        raw_edges
            .into_iter()
            .filter_map(|e| {
                Some(SFEdge {
                    id: e.get("id")?.as_str()?.to_string(),
                    from: e.get("from").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    to: e.get("to").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    from_handle: e.get("fromH").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    to_handle: e.get("toH").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    label: e.get("label").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    edge_type: e.get("type").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    condition: e.get("condition").cloned(),
                })
            })
            .collect()
    } else {
        // Generate edges from depends_on (one-way conversion, no handle info)
        let mut edges = Vec::new();
        let mut edge_counter = 0;
        for node in &template.nodes {
            for dep in &node.depends_on {
                edge_counter += 1;
                edges.push(SFEdge {
                    id: format!("e-gen-{}", edge_counter),
                    from: Some(dep.clone()),
                    to: Some(node.id.clone()),
                    from_handle: Some("output".into()),
                    to_handle: Some("input".into()),
                    label: None,
                    edge_type: None,
                    condition: None,
                });
            }
        }
        edges
    };

    // Convert nodes
    let mut y_offset = 100.0;
    let nodes: Vec<SFNode> = template
        .nodes
        .iter()
        .map(|nt| {
            let x = nt
                .metadata
                .get("sf_x")
                .and_then(|v| v.as_f64())
                .unwrap_or(200.0);
            let y = nt
                .metadata
                .get("sf_y")
                .and_then(|v| v.as_f64())
                .unwrap_or_else(|| {
                    let val = y_offset;
                    y_offset += 150.0;
                    val
                });
            let data = nt
                .metadata
                .get("sf_data")
                .cloned()
                .unwrap_or(serde_json::json!({}));

            SFNode {
                id: nt.id.clone(),
                node_type: nt.tool.clone(),
                x,
                y,
                params: nt.input_bindings.clone(),
                data,
            }
        })
        .collect();

    Ok(SvelteFlowGraph { nodes, edges })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_graph_json() -> &'static str {
        r#"{
            "nodes": [
                {"id": "n1", "type": "structure_input", "x": 80, "y": 200, "params": {}},
                {"id": "n2", "type": "vasp_relax", "x": 380, "y": 200, "params": {"ENCUT": 520, "EDIFF": "1e-5"}},
                {"id": "n3", "type": "vasp_static", "x": 680, "y": 200, "params": {"ENCUT": 520}}
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "fromH": "structure", "toH": "structure"},
                {"id": "e2", "from": "n2", "to": "n3", "fromH": "structure", "toH": "structure"}
            ]
        }"#
    }

    #[test]
    fn test_svelteflow_to_template() {
        let template = svelteflow_to_template(sample_graph_json(), "test-wf-1").unwrap();

        assert_eq!(template.id, "test-wf-1");
        assert_eq!(template.nodes.len(), 3);

        // Check node types
        assert_eq!(template.nodes[0].tool, "structure_input");
        assert_eq!(template.nodes[1].tool, "vasp_relax");
        assert_eq!(template.nodes[2].tool, "vasp_static");

        // Check dependencies
        assert!(template.nodes[0].depends_on.is_empty());
        assert_eq!(template.nodes[1].depends_on, vec!["n1"]);
        assert_eq!(template.nodes[2].depends_on, vec!["n2"]);

        // Check input bindings
        assert_eq!(template.nodes[1].input_bindings["ENCUT"], 520);

        // Check metadata preserves positions
        assert_eq!(template.nodes[0].metadata["sf_x"], serde_json::json!(80.0));
    }

    #[test]
    fn test_round_trip() {
        let original = sample_graph_json();
        let template = svelteflow_to_template(original, "rt-test").unwrap();
        let back_json = template_to_svelteflow(&template).unwrap();
        let graph: SvelteFlowGraph = serde_json::from_str(&back_json).unwrap();

        // Verify structure preserved
        assert_eq!(graph.nodes.len(), 3);
        assert_eq!(graph.edges.len(), 2);

        // Verify node IDs and types
        assert_eq!(graph.nodes[0].id, "n1");
        assert_eq!(graph.nodes[0].node_type, "structure_input");
        assert_eq!(graph.nodes[1].id, "n2");
        assert_eq!(graph.nodes[1].node_type, "vasp_relax");

        // Verify edges
        assert_eq!(graph.edges[0].from.as_deref(), Some("n1"));
        assert_eq!(graph.edges[0].to.as_deref(), Some("n2"));
        assert_eq!(graph.edges[0].from_handle.as_deref(), Some("structure"));

        // Verify positions
        assert!((graph.nodes[0].x - 80.0).abs() < 0.01);
        assert!((graph.nodes[0].y - 200.0).abs() < 0.01);
    }

    #[test]
    fn test_empty_graph() {
        let json = r#"{"nodes": [], "edges": []}"#;
        let template = svelteflow_to_template(json, "empty").unwrap();
        assert!(template.nodes.is_empty());
    }

    #[test]
    fn test_svelteflow_source_target_format() {
        // Test that source/target format (standard SvelteFlow) also works
        let json = r#"{
            "nodes": [
                {"id": "n1", "type": "structure_input", "x": 0, "y": 0, "params": {}},
                {"id": "n2", "type": "vasp_relax", "x": 200, "y": 0, "params": {}}
            ],
            "edges": [
                {"id": "e1", "source": "n1", "target": "n2", "sourceHandle": "out", "targetHandle": "in"}
            ]
        }"#;
        let template = svelteflow_to_template(json, "alt-format").unwrap();
        assert_eq!(template.nodes[1].depends_on, vec!["n1"]);
    }

    #[test]
    fn test_conditional_edge() {
        let json = r#"{
            "nodes": [
                {"id": "n1", "type": "condition", "x": 0, "y": 0, "params": {}},
                {"id": "n2", "type": "vasp_relax", "x": 200, "y": 0, "params": {}}
            ],
            "edges": [
                {
                    "id": "e1", "from": "n1", "to": "n2", "fromH": "true", "toH": "input",
                    "type": "conditional",
                    "condition": {"expression": "${nodes.n1.outputs.result}", "equals": false}
                }
            ]
        }"#;
        let template = svelteflow_to_template(json, "cond-test").unwrap();
        let n2 = &template.nodes[1];
        assert!(n2.skip_condition.is_some());
        let sc = n2.skip_condition.as_ref().unwrap();
        assert_eq!(sc.expression, "${nodes.n1.outputs.result}");
        assert_eq!(sc.equals, serde_json::json!(false));
    }

    #[test]
    fn test_node_with_data_config() {
        let json = r#"{
            "nodes": [
                {"id": "n1", "type": "vasp_relax", "x": 0, "y": 0, "params": {},
                 "data": {"label": "My Relaxation", "config": {"ENCUT": 400}}}
            ],
            "edges": []
        }"#;
        let template = svelteflow_to_template(json, "data-config").unwrap();
        // When params is empty, should fall through to data.config
        assert_eq!(template.nodes[0].input_bindings["ENCUT"], 400);
        // Label should be in metadata
        assert_eq!(template.nodes[0].metadata["label"], serde_json::json!("My Relaxation"));
    }

    #[test]
    fn test_template_without_metadata_generates_edges() {
        // A template created from scratch (no sf_edges metadata)
        let template = GraphTemplate {
            id: "manual".into(),
            version: "1.0.0".into(),
            description: None,
            inputs_schema: serde_json::json!({}),
            nodes: vec![
                NodeTemplate {
                    id: "a".into(),
                    tool: "structure_input".into(),
                    depends_on: vec![],
                    input_bindings: serde_json::json!({}),
                    output_spec: None,
                    retry_policy: None,
                    timeout_seconds: None,
                    repair_policy: None,
                    execution_mode: ExecutionMode::default(),
                    skip_condition: None,
                    subgraph: None,
                    metadata: HashMap::new(),
                },
                NodeTemplate {
                    id: "b".into(),
                    tool: "vasp_relax".into(),
                    depends_on: vec!["a".into()],
                    input_bindings: serde_json::json!({"ENCUT": 520}),
                    output_spec: None,
                    retry_policy: None,
                    timeout_seconds: None,
                    repair_policy: None,
                    execution_mode: ExecutionMode::default(),
                    skip_condition: None,
                    subgraph: None,
                    metadata: HashMap::new(),
                },
            ],
            outputs: vec![],
            metadata: HashMap::new(),
            rewrite_rules: vec![],
        };
        let graph = template_to_svelteflow_graph(&template).unwrap();
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].from.as_deref(), Some("a"));
        assert_eq!(graph.edges[0].to.as_deref(), Some("b"));
    }
}
