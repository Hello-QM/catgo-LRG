//! Integration tests for subgraph reference validation.
//!
//! Tests the `validate_subgraph_refs` function with YAML fixtures, invalid
//! configurations, and the intended usage pattern (validate before expand).

mod helpers;

use std::collections::HashMap;

use catgo_graph::*;
use catgo_graph::graph::composer::{expand_subgraphs, TemplateProvider};
use catgo_graph::graph::subgraph_validate::validate_subgraph_refs;
use catgo_graph::graph::template::{GraphOutputSpec, SubgraphRef};
use serde_json::json;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/// A simple map-based TemplateProvider for integration tests.
struct MapProvider {
    templates: HashMap<String, GraphTemplate>,
}

impl MapProvider {
    fn new() -> Self {
        Self {
            templates: HashMap::new(),
        }
    }

    fn insert(&mut self, template: GraphTemplate) {
        self.templates.insert(template.id.clone(), template);
    }
}

impl TemplateProvider for MapProvider {
    fn get_template(&self, id: &str) -> Option<GraphTemplate> {
        self.templates.get(id).cloned()
    }
}

/// Create a tool node.
fn tool_node(id: &str, tool: &str, deps: Vec<&str>) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: tool.to_string(),
        depends_on: deps.into_iter().map(|d| d.to_string()).collect(),
        input_bindings: json!({}),
        output_spec: None,
        retry_policy: None,
        timeout_seconds: None,
        repair_policy: None,
        execution_mode: Default::default(),
        skip_condition: None,
        subgraph: None,
        metadata: Default::default(),
    }
}

/// Create a subgraph node.
fn subgraph_node(
    id: &str,
    template_id: &str,
    input_map: serde_json::Value,
    deps: Vec<&str>,
) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: String::new(),
        depends_on: deps.into_iter().map(|d| d.to_string()).collect(),
        input_bindings: json!({}),
        output_spec: None,
        retry_policy: None,
        timeout_seconds: None,
        repair_policy: None,
        execution_mode: Default::default(),
        skip_condition: None,
        subgraph: Some(SubgraphRef {
            template_id: template_id.to_string(),
            version: None,
            input_map,
        }),
        metadata: Default::default(),
    }
}

/// Create a GraphTemplate.
fn make_template(
    id: &str,
    nodes: Vec<NodeTemplate>,
    inputs_schema: serde_json::Value,
    outputs: Vec<GraphOutputSpec>,
) -> GraphTemplate {
    GraphTemplate {
        id: id.to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema,
        nodes,
        outputs,
        metadata: Default::default(),
        rewrite_rules: vec![],
    }
}

// ---------------------------------------------------------------------------
// 1. YAML fixtures pass validation (backward compatibility)
// ---------------------------------------------------------------------------

#[test]
fn test_yaml_fixtures_pass_validation() {
    // Load both YAML fixtures
    let inner_yaml = include_str!("fixtures/reusable_stats.yaml");
    let inner: GraphTemplate =
        serde_yaml::from_str(inner_yaml).expect("reusable_stats.yaml should parse");

    let parent_yaml = include_str!("fixtures/pipeline_with_subgraph.yaml");
    let parent: GraphTemplate =
        serde_yaml::from_str(parent_yaml).expect("pipeline_with_subgraph.yaml should parse");

    let mut provider = MapProvider::new();
    provider.insert(inner);

    // Existing fixtures should pass validation
    let result = validate_subgraph_refs(&parent, &provider);
    assert!(
        result.is_ok(),
        "Existing YAML fixtures should pass subgraph validation, got: {:?}",
        result.err()
    );
}

// ---------------------------------------------------------------------------
// 2. Legacy templates without subgraph nodes pass validation
// ---------------------------------------------------------------------------

#[test]
fn test_legacy_fixture_no_subgraphs_passes() {
    let yaml = include_str!("fixtures/data_pipeline.yaml");
    let template: GraphTemplate =
        serde_yaml::from_str(yaml).expect("data_pipeline.yaml should parse");

    // Empty provider — no subgraph templates needed
    let provider = MapProvider::new();

    assert!(
        validate_subgraph_refs(&template, &provider).is_ok(),
        "Legacy template with no subgraph nodes should pass validation"
    );
}

// ---------------------------------------------------------------------------
// 3. Invalid subgraph YAML — unknown input key caught
// ---------------------------------------------------------------------------

#[test]
fn test_invalid_subgraph_unknown_input_key() {
    let inner_yaml = include_str!("fixtures/reusable_stats.yaml");
    let inner: GraphTemplate = serde_yaml::from_str(inner_yaml).unwrap();

    let mut provider = MapProvider::new();
    provider.insert(inner);

    // Create a parent that passes an undeclared input key
    let parent = make_template(
        "bad_parent",
        vec![
            tool_node("prep", "file_writer", vec![]),
            subgraph_node(
                "analyze",
                "reusable_stats_v1",
                json!({
                    "values": "${inputs.data}",
                    "nonexistent_key": "oops"
                }),
                vec!["prep"],
            ),
        ],
        json!({}),
        vec![],
    );

    let err = validate_subgraph_refs(&parent, &provider).unwrap_err();
    let msg = format!("{}", err);
    assert!(
        msg.contains("nonexistent_key"),
        "Error should mention the unknown key, got: {}",
        msg
    );
}

// ---------------------------------------------------------------------------
// 4. Invalid subgraph YAML — missing required input caught
// ---------------------------------------------------------------------------

#[test]
fn test_invalid_subgraph_missing_required_input() {
    let inner_yaml = include_str!("fixtures/reusable_stats.yaml");
    let inner: GraphTemplate = serde_yaml::from_str(inner_yaml).unwrap();

    let mut provider = MapProvider::new();
    provider.insert(inner);

    // Create a parent that omits the required "values" input
    let parent = make_template(
        "bad_parent",
        vec![subgraph_node(
            "analyze",
            "reusable_stats_v1",
            json!({
                "label": "test_only"
            }),
            vec![],
        )],
        json!({}),
        vec![],
    );

    let err = validate_subgraph_refs(&parent, &provider).unwrap_err();
    let msg = format!("{}", err);
    assert!(
        msg.contains("values") && msg.contains("required"),
        "Error should mention missing required input 'values', got: {}",
        msg
    );
}

// ---------------------------------------------------------------------------
// 5. Validate-then-expand usage pattern
// ---------------------------------------------------------------------------

#[test]
fn test_validate_before_expand_pattern() {
    let inner_yaml = include_str!("fixtures/reusable_stats.yaml");
    let inner: GraphTemplate = serde_yaml::from_str(inner_yaml).unwrap();

    let parent_yaml = include_str!("fixtures/pipeline_with_subgraph.yaml");
    let parent: GraphTemplate = serde_yaml::from_str(parent_yaml).unwrap();

    let mut provider = MapProvider::new();
    provider.insert(inner);

    // Step 1: validate (early error detection)
    validate_subgraph_refs(&parent, &provider)
        .expect("Validation should pass for valid fixtures");

    // Step 2: expand (would fail with bad error messages without validation)
    let expanded = expand_subgraphs(&parent, &provider)
        .expect("Expansion should succeed after validation passes");

    // Verify expansion produced expected nodes
    let node_ids: Vec<&str> = expanded.nodes.iter().map(|n| n.id.as_str()).collect();
    assert!(node_ids.contains(&"prepare"));
    assert!(node_ids.contains(&"analyze/compute"));
    assert!(node_ids.contains(&"analyze/save"));
    assert!(node_ids.contains(&"report"));
}

// ---------------------------------------------------------------------------
// 6. Invalid output reference caught by validation
// ---------------------------------------------------------------------------

#[test]
fn test_invalid_output_reference_caught() {
    let inner_yaml = include_str!("fixtures/reusable_stats.yaml");
    let inner: GraphTemplate = serde_yaml::from_str(inner_yaml).unwrap();

    let mut provider = MapProvider::new();
    provider.insert(inner);

    // Create a parent where the report node references a nonexistent output
    let parent = make_template(
        "bad_output_parent",
        vec![
            subgraph_node(
                "analyze",
                "reusable_stats_v1",
                json!({
                    "values": "${inputs.data}"
                }),
                vec![],
            ),
            {
                let mut n = tool_node("report", "file_writer", vec!["analyze"]);
                n.input_bindings = json!({
                    "result": "${nodes.analyze.outputs.nonexistent_output}"
                });
                n
            },
        ],
        json!({}),
        vec![],
    );

    let err = validate_subgraph_refs(&parent, &provider).unwrap_err();
    let msg = format!("{}", err);
    assert!(
        msg.contains("nonexistent_output"),
        "Error should mention nonexistent output, got: {}",
        msg
    );
}

// ---------------------------------------------------------------------------
// 7. Validation catches malformed expression before expansion
// ---------------------------------------------------------------------------

#[test]
fn test_malformed_expression_caught_early() {
    let inner_yaml = include_str!("fixtures/reusable_stats.yaml");
    let inner: GraphTemplate = serde_yaml::from_str(inner_yaml).unwrap();

    let mut provider = MapProvider::new();
    provider.insert(inner);

    let parent = make_template(
        "bad_expr_parent",
        vec![subgraph_node(
            "analyze",
            "reusable_stats_v1",
            json!({
                "values": "${bad.syntax.here}"
            }),
            vec![],
        )],
        json!({}),
        vec![],
    );

    let err = validate_subgraph_refs(&parent, &provider).unwrap_err();
    let msg = format!("{}", err);
    assert!(
        msg.contains("malformed"),
        "Error should indicate malformed expression, got: {}",
        msg
    );
}

// ---------------------------------------------------------------------------
// 8. Multiple subgraph nodes validated independently
// ---------------------------------------------------------------------------

#[test]
fn test_multiple_subgraph_nodes_validated() {
    let mut provider = MapProvider::new();

    // Two different sub-templates
    let stats = make_template(
        "stats_v1",
        vec![tool_node("compute", "compute_stats", vec![])],
        json!({
            "type": "object",
            "required": ["values"],
            "properties": {
                "values": { "type": "array" }
            }
        }),
        vec![GraphOutputSpec {
            name: "mean".into(),
            source: "${nodes.compute.outputs.mean}".into(),
        }],
    );
    provider.insert(stats);

    let formatter = make_template(
        "formatter_v1",
        vec![tool_node("format", "echo", vec![])],
        json!({
            "type": "object",
            "required": ["text"],
            "properties": {
                "text": { "type": "string" }
            }
        }),
        vec![],
    );
    provider.insert(formatter);

    // Parent with two subgraph nodes — both valid
    let parent = make_template(
        "multi_sub_parent",
        vec![
            subgraph_node("stats", "stats_v1", json!({"values": "${inputs.data}"}), vec![]),
            subgraph_node(
                "fmt",
                "formatter_v1",
                json!({"text": "${inputs.label}"}),
                vec!["stats"],
            ),
        ],
        json!({}),
        vec![],
    );

    assert!(validate_subgraph_refs(&parent, &provider).is_ok());

    // Now break one — "fmt" references wrong key
    let bad_parent = make_template(
        "multi_sub_bad",
        vec![
            subgraph_node("stats", "stats_v1", json!({"values": "${inputs.data}"}), vec![]),
            subgraph_node(
                "fmt",
                "formatter_v1",
                json!({"wrong_key": "${inputs.label}"}),
                vec!["stats"],
            ),
        ],
        json!({}),
        vec![],
    );

    let err = validate_subgraph_refs(&bad_parent, &provider).unwrap_err();
    let msg = format!("{}", err);
    assert!(
        msg.contains("wrong_key") && msg.contains("fmt"),
        "Error should mention the specific node and key, got: {}",
        msg
    );
}
