//! Edge case and backward compatibility tests for nested subgraph expansion.
//!
//! These tests focus on boundary conditions, error handling, and correctness
//! guarantees of the `expand_subgraphs` function in the composer module.

use catgo_graph::*;
use catgo_graph::graph::composer::{expand_subgraphs, TemplateProvider};
use catgo_graph::graph::template::SubgraphRef;
use catgo_graph::graph::validate::validate_template;
use serde_json::json;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/// Simple TemplateProvider backed by a HashMap.
struct MapProvider {
    templates: HashMap<String, GraphTemplate>,
}

impl MapProvider {
    fn new() -> Self {
        Self {
            templates: HashMap::new(),
        }
    }

    fn add(&mut self, template: GraphTemplate) {
        self.templates.insert(template.id.clone(), template);
    }
}

impl TemplateProvider for MapProvider {
    fn get_template(&self, id: &str) -> Option<GraphTemplate> {
        self.templates.get(id).cloned()
    }
}

fn make_tool_node(id: &str, tool: &str, deps: Vec<&str>) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: tool.to_string(),
        depends_on: deps.into_iter().map(String::from).collect(),
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

fn make_subgraph_node(
    id: &str,
    template_id: &str,
    deps: Vec<&str>,
    input_map: serde_json::Value,
) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: "".to_string(),
        depends_on: deps.into_iter().map(String::from).collect(),
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

fn make_template(id: &str, nodes: Vec<NodeTemplate>) -> GraphTemplate {
    GraphTemplate {
        id: id.to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes,
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    }
}

// ---------------------------------------------------------------------------
// Test 1: No subgraphs passthrough
// ---------------------------------------------------------------------------

/// Template with no subgraph nodes passes through expand_subgraphs unchanged.
#[test]
fn test_no_subgraphs_passthrough() {
    let template = make_template(
        "plain",
        vec![
            make_tool_node("a", "echo", vec![]),
            make_tool_node("b", "echo", vec!["a"]),
            make_tool_node("c", "echo", vec!["a"]),
            make_tool_node("d", "echo", vec!["b", "c"]),
        ],
    );

    let provider = MapProvider::new();
    let expanded = expand_subgraphs(&template, &provider)
        .expect("expand_subgraphs should succeed on template with no subgraphs");

    // Node count unchanged
    assert_eq!(expanded.nodes.len(), template.nodes.len());

    // Node IDs unchanged
    let orig_ids: Vec<&str> = template.nodes.iter().map(|n| n.id.as_str()).collect();
    let exp_ids: Vec<&str> = expanded.nodes.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(orig_ids, exp_ids, "Node IDs should be identical after passthrough");

    // Dependencies unchanged
    for (orig, exp) in template.nodes.iter().zip(expanded.nodes.iter()) {
        assert_eq!(
            orig.depends_on, exp.depends_on,
            "Dependencies for '{}' should be unchanged",
            orig.id
        );
    }

    // Tool names unchanged
    for (orig, exp) in template.nodes.iter().zip(expanded.nodes.iter()) {
        assert_eq!(
            orig.tool, exp.tool,
            "Tool for '{}' should be unchanged",
            orig.id
        );
    }
}

// ---------------------------------------------------------------------------
// Test 2: Missing subgraph template error
// ---------------------------------------------------------------------------

/// Subgraph references a template that doesn't exist -> clean error.
#[test]
fn test_missing_subgraph_template_error() {
    let parent = make_template(
        "parent",
        vec![
            make_tool_node("a", "echo", vec![]),
            make_subgraph_node("sub", "does_not_exist", vec!["a"], json!({})),
        ],
    );

    let provider = MapProvider::new(); // empty

    let result = expand_subgraphs(&parent, &provider);
    assert!(
        result.is_err(),
        "expand_subgraphs should error when referenced template is missing"
    );

    let err_msg = format!("{}", result.unwrap_err());
    assert!(
        err_msg.contains("does_not_exist") || err_msg.contains("not found"),
        "Error should mention the missing template name. Got: {}",
        err_msg
    );
}

// ---------------------------------------------------------------------------
// Test 3: Subgraph cycle detection (A -> B -> A)
// ---------------------------------------------------------------------------

/// Template A has subgraph node referencing template B, which has subgraph
/// node referencing template A -> should produce error (not infinite loop).
#[test]
fn test_subgraph_cycle_detection() {
    // Template A: tool node + subgraph node referencing B
    let template_a = make_template(
        "template_a",
        vec![
            make_tool_node("start", "echo", vec![]),
            make_subgraph_node("sub_b", "template_b", vec!["start"], json!({})),
        ],
    );

    // Template B: tool node + subgraph node referencing A (cycle!)
    let template_b = make_template(
        "template_b",
        vec![
            make_tool_node("inner", "echo", vec![]),
            make_subgraph_node("sub_a", "template_a", vec!["inner"], json!({})),
        ],
    );

    let mut provider = MapProvider::new();
    provider.add(template_a.clone());
    provider.add(template_b);

    let result = expand_subgraphs(&template_a, &provider);
    assert!(
        result.is_err(),
        "Cycle A -> B -> A should be detected as an error, not cause infinite recursion"
    );

    let err_msg = format!("{}", result.unwrap_err());
    // The error should mention cycle or recursion
    assert!(
        err_msg.to_lowercase().contains("cycle")
            || err_msg.to_lowercase().contains("depth")
            || err_msg.to_lowercase().contains("recursive"),
        "Error should mention cycle detection. Got: {}",
        err_msg
    );
}

// ---------------------------------------------------------------------------
// Test 4: Self-referencing subgraph
// ---------------------------------------------------------------------------

/// Template references itself as subgraph -> should produce error.
#[test]
fn test_self_referencing_subgraph() {
    let template = make_template(
        "self_ref",
        vec![
            make_tool_node("a", "echo", vec![]),
            make_subgraph_node("sub", "self_ref", vec!["a"], json!({})),
        ],
    );

    let mut provider = MapProvider::new();
    provider.add(template.clone());

    let result = expand_subgraphs(&template, &provider);
    assert!(
        result.is_err(),
        "Self-referencing subgraph should be detected as an error"
    );

    let err_msg = format!("{}", result.unwrap_err());
    assert!(
        err_msg.to_lowercase().contains("cycle")
            || err_msg.to_lowercase().contains("self")
            || err_msg.to_lowercase().contains("depth"),
        "Error should indicate self-reference or cycle. Got: {}",
        err_msg
    );
}

// ---------------------------------------------------------------------------
// Test 5: Deeply nested subgraphs (3 levels)
// ---------------------------------------------------------------------------

/// Template A -> subgraph B -> subgraph C (3 levels).
/// Verify expansion produces correct flat node list with proper prefixing.
#[test]
fn test_deeply_nested_subgraphs() {
    // Level 3 (innermost): template_c with a single node
    let template_c = make_template(
        "template_c",
        vec![make_tool_node("inner_node", "echo", vec![])],
    );

    // Level 2: template_b with a tool node and a subgraph node referencing C
    let template_b = make_template(
        "template_b",
        vec![
            make_tool_node("b_step", "echo", vec![]),
            make_subgraph_node("sub_c", "template_c", vec!["b_step"], json!({})),
        ],
    );

    // Level 1 (parent): template_a with a tool node and subgraph referencing B
    let template_a = make_template(
        "template_a",
        vec![
            make_tool_node("a_start", "echo", vec![]),
            make_subgraph_node("sub_b", "template_b", vec!["a_start"], json!({})),
            make_tool_node("a_end", "echo", vec!["sub_b"]),
        ],
    );

    let mut provider = MapProvider::new();
    provider.add(template_b);
    provider.add(template_c);

    let expanded = expand_subgraphs(&template_a, &provider)
        .expect("3-level nested expansion should succeed");

    let node_ids: Vec<&str> = expanded.nodes.iter().map(|n| n.id.as_str()).collect();

    // Expected nodes:
    // - a_start (tool node, unchanged)
    // - sub_b/b_step (from template_b's tool node, prefixed with sub_b/)
    // - sub_b/sub_c/inner_node (from template_c's node, double-prefixed)
    // - a_end (tool node, unchanged)
    assert_eq!(
        expanded.nodes.len(),
        4,
        "Expected 4 nodes after 3-level expansion, got {}: {:?}",
        expanded.nodes.len(),
        node_ids
    );

    assert!(
        node_ids.contains(&"a_start"),
        "Top-level tool node should be present: {:?}",
        node_ids
    );
    assert!(
        node_ids.contains(&"sub_b/b_step"),
        "Level-2 tool node should be prefixed as 'sub_b/b_step': {:?}",
        node_ids
    );
    assert!(
        node_ids.contains(&"sub_b/sub_c/inner_node"),
        "Level-3 node should be double-prefixed as 'sub_b/sub_c/inner_node': {:?}",
        node_ids
    );
    assert!(
        node_ids.contains(&"a_end"),
        "Trailing tool node should be present: {:?}",
        node_ids
    );

    // Verify dependency chain:
    // a_start -> sub_b/b_step -> sub_b/sub_c/inner_node -> a_end
    let b_step = expanded.nodes.iter().find(|n| n.id == "sub_b/b_step").unwrap();
    assert!(
        b_step.depends_on.contains(&"a_start".to_string()),
        "sub_b/b_step should depend on a_start, got: {:?}",
        b_step.depends_on
    );

    let inner = expanded
        .nodes
        .iter()
        .find(|n| n.id == "sub_b/sub_c/inner_node")
        .unwrap();
    assert!(
        inner.depends_on.contains(&"sub_b/b_step".to_string()),
        "sub_b/sub_c/inner_node should depend on sub_b/b_step, got: {:?}",
        inner.depends_on
    );

    // a_end should depend on the terminal node of the subgraph
    let a_end = expanded.nodes.iter().find(|n| n.id == "a_end").unwrap();
    assert!(
        a_end
            .depends_on
            .iter()
            .any(|dep| dep.starts_with("sub_b/")),
        "a_end should depend on a sub_b/ prefixed terminal node, got: {:?}",
        a_end.depends_on
    );
}

// ---------------------------------------------------------------------------
// Test 6: Multiple subgraph nodes (no ID collisions)
// ---------------------------------------------------------------------------

/// Parent template with two different subgraph nodes referencing the SAME
/// inner template. Verify both are expanded correctly without ID collisions.
#[test]
fn test_multiple_subgraph_nodes() {
    let inner = make_template(
        "shared_inner",
        vec![
            make_tool_node("step_a", "echo", vec![]),
            make_tool_node("step_b", "echo", vec!["step_a"]),
        ],
    );

    // Parent has two subgraph nodes both referencing the same inner template
    let parent = make_template(
        "parent",
        vec![
            make_tool_node("start", "echo", vec![]),
            make_subgraph_node("first", "shared_inner", vec!["start"], json!({})),
            make_subgraph_node("second", "shared_inner", vec!["start"], json!({})),
            make_tool_node("join", "echo", vec!["first", "second"]),
        ],
    );

    let mut provider = MapProvider::new();
    provider.add(inner);

    let expanded = expand_subgraphs(&parent, &provider)
        .expect("Multiple subgraph nodes should expand successfully");

    let node_ids: Vec<&str> = expanded.nodes.iter().map(|n| n.id.as_str()).collect();

    // Expected: start + first/step_a + first/step_b + second/step_a + second/step_b + join = 6
    assert_eq!(
        expanded.nodes.len(),
        6,
        "Expected 6 nodes (2 non-subgraph + 2*2 inner nodes), got: {:?}",
        node_ids
    );

    // Verify no ID collisions: all IDs should be unique
    let mut unique_ids: Vec<&str> = node_ids.clone();
    unique_ids.sort();
    unique_ids.dedup();
    assert_eq!(
        unique_ids.len(),
        node_ids.len(),
        "All node IDs should be unique after expansion. Got: {:?}",
        node_ids
    );

    // Verify both expansions are present with correct prefixes
    assert!(node_ids.contains(&"first/step_a"));
    assert!(node_ids.contains(&"first/step_b"));
    assert!(node_ids.contains(&"second/step_a"));
    assert!(node_ids.contains(&"second/step_b"));

    // Neither subgraph placeholder should remain
    assert!(!node_ids.contains(&"first"));
    assert!(!node_ids.contains(&"second"));
}

// ---------------------------------------------------------------------------
// Test 7: Subgraph with diamond dependencies
// ---------------------------------------------------------------------------

/// Parent has A -> S(subgraph) -> B, where the subgraph itself has diamond deps.
/// Verify correct dependency wiring after expansion.
#[test]
fn test_subgraph_with_diamond_deps() {
    // Inner template with diamond pattern:
    //   root -> left
    //   root -> right
    //   left + right -> merge
    let inner = make_template(
        "diamond_inner",
        vec![
            make_tool_node("root", "echo", vec![]),
            make_tool_node("left", "echo", vec!["root"]),
            make_tool_node("right", "echo", vec!["root"]),
            make_tool_node("merge", "echo", vec!["left", "right"]),
        ],
    );

    // Parent: before -> sub(diamond) -> after
    let parent = make_template(
        "parent",
        vec![
            make_tool_node("before", "echo", vec![]),
            make_subgraph_node("sub", "diamond_inner", vec!["before"], json!({})),
            make_tool_node("after", "echo", vec!["sub"]),
        ],
    );

    let mut provider = MapProvider::new();
    provider.add(inner);

    let expanded = expand_subgraphs(&parent, &provider)
        .expect("Diamond subgraph should expand successfully");

    let node_ids: Vec<&str> = expanded.nodes.iter().map(|n| n.id.as_str()).collect();

    // Expected: before + sub/root + sub/left + sub/right + sub/merge + after = 6
    assert_eq!(
        expanded.nodes.len(),
        6,
        "Expected 6 nodes after diamond subgraph expansion, got: {:?}",
        node_ids
    );

    // Verify the diamond structure is preserved within the subgraph
    let sub_root = expanded.nodes.iter().find(|n| n.id == "sub/root").unwrap();
    assert!(
        sub_root.depends_on.contains(&"before".to_string()),
        "sub/root should depend on 'before', got: {:?}",
        sub_root.depends_on
    );

    let sub_left = expanded.nodes.iter().find(|n| n.id == "sub/left").unwrap();
    assert!(
        sub_left.depends_on.contains(&"sub/root".to_string()),
        "sub/left should depend on 'sub/root', got: {:?}",
        sub_left.depends_on
    );

    let sub_right = expanded.nodes.iter().find(|n| n.id == "sub/right").unwrap();
    assert!(
        sub_right.depends_on.contains(&"sub/root".to_string()),
        "sub/right should depend on 'sub/root', got: {:?}",
        sub_right.depends_on
    );

    let sub_merge = expanded.nodes.iter().find(|n| n.id == "sub/merge").unwrap();
    assert!(
        sub_merge.depends_on.contains(&"sub/left".to_string())
            && sub_merge.depends_on.contains(&"sub/right".to_string()),
        "sub/merge should depend on both sub/left and sub/right, got: {:?}",
        sub_merge.depends_on
    );

    // 'after' should depend on the terminal inner node (sub/merge)
    let after_node = expanded.nodes.iter().find(|n| n.id == "after").unwrap();
    assert!(
        after_node.depends_on.contains(&"sub/merge".to_string()),
        "'after' should depend on terminal node 'sub/merge', got: {:?}",
        after_node.depends_on
    );
}

// ---------------------------------------------------------------------------
// Test 8: Backward compatibility YAML parsing
// ---------------------------------------------------------------------------

/// Parse an existing YAML fixture (data_pipeline.yaml) with the new code.
/// Verify it still deserializes correctly (subgraph field defaults to None).
#[test]
fn test_backward_compat_yaml_parsing() {
    let yaml = include_str!("fixtures/data_pipeline.yaml");
    let template: GraphTemplate =
        serde_yaml::from_str(yaml).expect("data_pipeline.yaml should still parse");

    assert_eq!(template.id, "data_pipeline_v1");
    assert_eq!(template.version, "1.0.0");
    assert_eq!(template.nodes.len(), 3);

    // Every node should have subgraph: None (the field didn't exist in the YAML,
    // so serde should default it via #[serde(default)])
    for node in &template.nodes {
        assert!(
            node.subgraph.is_none(),
            "Node '{}' should have subgraph: None when deserialized from legacy YAML without subgraph field",
            node.id
        );
    }

    // All nodes should have valid tool names
    assert_eq!(template.nodes[0].tool, "file_writer");
    assert_eq!(template.nodes[1].tool, "compute_stats");
    assert_eq!(template.nodes[2].tool, "file_writer");

    // Dependencies should be correct
    assert!(template.nodes[0].depends_on.is_empty());
    assert_eq!(template.nodes[1].depends_on, vec!["save_input"]);
    assert_eq!(template.nodes[2].depends_on, vec!["compute_stats"]);
}

// ---------------------------------------------------------------------------
// Test 9: Node count after expansion
// ---------------------------------------------------------------------------

/// Verify that total node count equals:
/// (original non-subgraph nodes) + sum(inner nodes per subgraph).
#[test]
fn test_subgraph_node_count_after_expansion() {
    // Inner template A: 2 nodes
    let inner_a = make_template(
        "inner_a",
        vec![
            make_tool_node("x", "echo", vec![]),
            make_tool_node("y", "echo", vec!["x"]),
        ],
    );

    // Inner template B: 3 nodes
    let inner_b = make_template(
        "inner_b",
        vec![
            make_tool_node("p", "echo", vec![]),
            make_tool_node("q", "echo", vec!["p"]),
            make_tool_node("r", "echo", vec!["q"]),
        ],
    );

    // Parent: 2 tool nodes + 2 subgraph nodes = 4 original nodes
    // After expansion: 2 tool nodes + 2 (from inner_a) + 3 (from inner_b) = 7
    let parent = make_template(
        "parent",
        vec![
            make_tool_node("start", "echo", vec![]),
            make_subgraph_node("sub_a", "inner_a", vec!["start"], json!({})),
            make_subgraph_node("sub_b", "inner_b", vec!["start"], json!({})),
            make_tool_node("end", "echo", vec!["sub_a", "sub_b"]),
        ],
    );

    let mut provider = MapProvider::new();
    provider.add(inner_a.clone());
    provider.add(inner_b.clone());

    let expanded = expand_subgraphs(&parent, &provider)
        .expect("Expansion should succeed");

    let non_subgraph_count = parent
        .nodes
        .iter()
        .filter(|n| n.subgraph.is_none())
        .count();
    let inner_total: usize = parent
        .nodes
        .iter()
        .filter_map(|n| {
            n.subgraph.as_ref().and_then(|sg| {
                provider
                    .get_template(&sg.template_id)
                    .map(|t| t.nodes.len())
            })
        })
        .sum();

    let expected = non_subgraph_count + inner_total;

    assert_eq!(
        expanded.nodes.len(),
        expected,
        "Expected {} nodes (non_subgraph={} + inner_total={}), got {}",
        expected,
        non_subgraph_count,
        inner_total,
        expanded.nodes.len()
    );

    // Specifically: 2 + 2 + 3 = 7
    assert_eq!(expanded.nodes.len(), 7);
}

// ---------------------------------------------------------------------------
// Test 10: Expanded template is valid
// ---------------------------------------------------------------------------

/// After expansion, run validate_template on the expanded template -- it should pass.
#[test]
fn test_expanded_template_is_valid() {
    let inner = make_template(
        "inner_v1",
        vec![
            make_tool_node("step1", "echo", vec![]),
            make_tool_node("step2", "echo", vec!["step1"]),
        ],
    );

    let parent = make_template(
        "parent_v1",
        vec![
            make_tool_node("root", "echo", vec![]),
            make_subgraph_node("sub", "inner_v1", vec!["root"], json!({})),
            make_tool_node("finish", "echo", vec!["sub"]),
        ],
    );

    let mut provider = MapProvider::new();
    provider.add(inner);

    let expanded = expand_subgraphs(&parent, &provider)
        .expect("Expansion should succeed");

    // The expanded template should pass validation
    let validation_result = validate_template(&expanded);
    assert!(
        validation_result.is_ok(),
        "Expanded template should pass validation, but got error: {:?}",
        validation_result.unwrap_err()
    );

    // Also verify structural correctness
    assert_eq!(expanded.nodes.len(), 4); // root + sub/step1 + sub/step2 + finish
    assert!(expanded.nodes.iter().all(|n| n.subgraph.is_none()),
        "All nodes in expanded template should have subgraph: None");
}
