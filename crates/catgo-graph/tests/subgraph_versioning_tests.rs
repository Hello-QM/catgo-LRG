//! Integration tests for subgraph versioning.
//!
//! Tests that version-pinned SubgraphRef fields select the correct template
//! version during expansion, and that the TemplateRegistry properly stores
//! and retrieves multiple versions.

mod helpers;

use catgo_graph::*;
use catgo_graph::api::graph_api::TemplateRegistry;
use catgo_graph::graph::composer::expand_subgraphs;
use catgo_graph::graph::template::SubgraphRef;
use serde_json::json;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/// Create a simple template with the given id, version, and a single tool node.
/// The tool node's ID encodes the version for easy verification after expansion.
fn versioned_template(id: &str, version: &str, node_tool: &str) -> GraphTemplate {
    GraphTemplate {
        id: id.to_string(),
        version: version.to_string(),
        description: Some(format!("{} v{}", id, version)),
        inputs_schema: json!({}),
        nodes: vec![NodeTemplate {
            id: format!("step_{}", version.replace('.', "_")),
            tool: node_tool.to_string(),
            depends_on: vec![],
            input_bindings: json!({}),
            output_spec: None,
            retry_policy: None,
            timeout_seconds: None,
            repair_policy: None,
            execution_mode: Default::default(),
            skip_condition: None,
            subgraph: None,
            metadata: Default::default(),
        }],
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    }
}

/// Create a parent template that references a subgraph with an optional version pin.
fn parent_with_subgraph(
    parent_id: &str,
    subgraph_template_id: &str,
    version_pin: Option<&str>,
) -> GraphTemplate {
    GraphTemplate {
        id: parent_id.to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes: vec![NodeTemplate {
            id: "sg_node".to_string(),
            tool: "".to_string(),
            depends_on: vec![],
            input_bindings: json!({}),
            output_spec: None,
            retry_policy: None,
            timeout_seconds: None,
            repair_policy: None,
            execution_mode: Default::default(),
            skip_condition: None,
            subgraph: Some(SubgraphRef {
                template_id: subgraph_template_id.to_string(),
                version: version_pin.map(|v| v.to_string()),
                input_map: json!({}),
            }),
            metadata: Default::default(),
        }],
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    }
}

// ---------------------------------------------------------------------------
// Test 1: Version pin selects correct template
// ---------------------------------------------------------------------------

#[test]
fn test_version_pin_selects_correct_template() {
    let registry = TemplateRegistry::new();

    // Register v1 and v2 of the same template
    let v1 = versioned_template("calc_wf", "1.0", "echo");
    let v2 = versioned_template("calc_wf", "2.0", "echo");

    registry.register(v1.clone());
    registry.register(v2.clone());

    // Parent pins to v1
    let parent = parent_with_subgraph("parent", "calc_wf", Some("1.0"));

    let expanded = expand_subgraphs(&parent, &registry).unwrap();

    // Should use v1's node structure (step_1_0), not v2's (step_2_0)
    assert_eq!(expanded.nodes.len(), 1);
    assert_eq!(
        expanded.nodes[0].id, "sg_node/step_1_0",
        "Version pin to 1.0 should use v1 template with node 'step_1_0'"
    );
}

// ---------------------------------------------------------------------------
// Test 2: No version uses latest (whatever registry returns for get_template)
// ---------------------------------------------------------------------------

#[test]
fn test_no_version_uses_latest() {
    let registry = TemplateRegistry::new();

    // Register v1, then v2. v2 should be "latest" (last registered).
    let v1 = versioned_template("calc_wf", "1.0", "echo");
    let v2 = versioned_template("calc_wf", "2.0", "echo");

    registry.register(v1);
    registry.register(v2);

    // Parent has version: None
    let parent = parent_with_subgraph("parent", "calc_wf", None);

    let expanded = expand_subgraphs(&parent, &registry).unwrap();

    // Should use v2's node structure (step_2_0) since it was registered last
    assert_eq!(expanded.nodes.len(), 1);
    assert_eq!(
        expanded.nodes[0].id, "sg_node/step_2_0",
        "No version pin should use latest template (v2) with node 'step_2_0'"
    );
}

// ---------------------------------------------------------------------------
// Test 3: Version not found produces clear error
// ---------------------------------------------------------------------------

#[test]
fn test_version_not_found_error() {
    let registry = TemplateRegistry::new();

    // Only register v1
    let v1 = versioned_template("calc_wf", "1.0", "echo");
    registry.register(v1);

    // Parent pins to nonexistent version
    let parent = parent_with_subgraph("parent", "calc_wf", Some("99.0"));

    let result = expand_subgraphs(&parent, &registry);

    assert!(
        result.is_err(),
        "Should fail when pinned version does not exist"
    );

    let err_msg = format!("{}", result.unwrap_err());
    assert!(
        err_msg.contains("not found") || err_msg.contains("99.0") || err_msg.contains("calc_wf"),
        "Error should mention the missing version or template, got: {}",
        err_msg
    );
}

// ---------------------------------------------------------------------------
// Test 4: Nested versions — chain of version pins
// ---------------------------------------------------------------------------

#[test]
fn test_nested_versions() {
    let registry = TemplateRegistry::new();

    // Inner template: B v1.0 and B v2.0
    let b_v1 = versioned_template("tpl_b", "1.0", "echo");
    let b_v2 = versioned_template("tpl_b", "2.0", "echo");
    registry.register(b_v1);
    registry.register(b_v2);

    // Middle template: A v1.0 — pins subgraph B@2.0
    let a_v1 = GraphTemplate {
        id: "tpl_a".to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes: vec![
            NodeTemplate {
                id: "use_b".to_string(),
                tool: "".to_string(),
                depends_on: vec![],
                input_bindings: json!({}),
                output_spec: None,
                retry_policy: None,
                timeout_seconds: None,
                repair_policy: None,
                execution_mode: Default::default(),
                skip_condition: None,
                subgraph: Some(SubgraphRef {
                    template_id: "tpl_b".to_string(),
                    version: Some("2.0".to_string()),
                    input_map: json!({}),
                }),
                metadata: Default::default(),
            },
        ],
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    };
    registry.register(a_v1);

    // Top-level template: pins A@1.0
    let top = parent_with_subgraph("top", "tpl_a", Some("1.0"));

    let expanded = expand_subgraphs(&top, &registry).unwrap();

    // Should have: sg_node/use_b/step_2_0
    // (top -> A@1.0 -> B@2.0, which has node "step_2_0")
    assert_eq!(expanded.nodes.len(), 1);
    assert_eq!(
        expanded.nodes[0].id, "sg_node/use_b/step_2_0",
        "Nested version resolution: A@1.0 should resolve B@2.0 with node 'step_2_0'"
    );
}

// ---------------------------------------------------------------------------
// Test 5: Registry stores multiple versions independently
// ---------------------------------------------------------------------------

#[test]
fn test_registry_stores_multiple_versions() {
    let registry = TemplateRegistry::new();

    let v1 = versioned_template("my_wf", "1.0", "echo");
    let v2 = versioned_template("my_wf", "2.0", "echo");
    let v3 = versioned_template("my_wf", "3.0", "echo");

    registry.register(v1.clone());
    registry.register(v2.clone());
    registry.register(v3.clone());

    // get_versioned returns each version correctly
    let got_v1 = registry.get_versioned("my_wf", "1.0");
    assert!(got_v1.is_some(), "v1 should be retrievable");
    assert_eq!(got_v1.unwrap().version, "1.0");

    let got_v2 = registry.get_versioned("my_wf", "2.0");
    assert!(got_v2.is_some(), "v2 should be retrievable");
    assert_eq!(got_v2.unwrap().version, "2.0");

    let got_v3 = registry.get_versioned("my_wf", "3.0");
    assert!(got_v3.is_some(), "v3 should be retrievable");
    assert_eq!(got_v3.unwrap().version, "3.0");

    // Nonexistent version returns None
    assert!(
        registry.get_versioned("my_wf", "4.0").is_none(),
        "v4 should not exist"
    );

    // get() returns the latest (v3, since it was registered last)
    let latest = registry.get("my_wf");
    assert!(latest.is_some());
    assert_eq!(latest.unwrap().version, "3.0");

    // Verify each version has its own node structure
    let v1_nodes = registry.get_versioned("my_wf", "1.0").unwrap();
    assert_eq!(v1_nodes.nodes[0].id, "step_1_0");

    let v2_nodes = registry.get_versioned("my_wf", "2.0").unwrap();
    assert_eq!(v2_nodes.nodes[0].id, "step_2_0");

    let v3_nodes = registry.get_versioned("my_wf", "3.0").unwrap();
    assert_eq!(v3_nodes.nodes[0].id, "step_3_0");
}

// ---------------------------------------------------------------------------
// Test 6: SubgraphRef with version field parses from YAML
// ---------------------------------------------------------------------------

#[test]
fn test_version_in_yaml_parsing() {
    // Test SubgraphRef deserialization from YAML with version field
    let yaml_with_version = r#"
template_id: "calc_workflow"
version: "2.1"
input_map:
  structure: "${inputs.structure}"
"#;

    let sg_ref: SubgraphRef = serde_yaml::from_str(yaml_with_version)
        .expect("SubgraphRef with version should parse from YAML");

    assert_eq!(sg_ref.template_id, "calc_workflow");
    assert_eq!(sg_ref.version, Some("2.1".to_string()));
    assert_eq!(sg_ref.input_map["structure"], "${inputs.structure}");

    // Test SubgraphRef without version (should default to None)
    let yaml_no_version = r#"
template_id: "calc_workflow"
input_map:
  kpoints: 4
"#;

    let sg_ref_no_ver: SubgraphRef = serde_yaml::from_str(yaml_no_version)
        .expect("SubgraphRef without version should parse from YAML");

    assert_eq!(sg_ref_no_ver.template_id, "calc_workflow");
    assert_eq!(sg_ref_no_ver.version, None);
    assert_eq!(sg_ref_no_ver.input_map["kpoints"], 4);

    // Test full NodeTemplate with subgraph version from YAML
    let yaml_node = r#"
id: "relax_step"
tool: ""
depends_on: ["setup"]
subgraph:
  template_id: "vasp_relax"
  version: "3.0.1"
  input_map:
    structure: "${nodes.setup.outputs.structure}"
"#;

    let node: NodeTemplate = serde_yaml::from_str(yaml_node)
        .expect("NodeTemplate with versioned subgraph should parse from YAML");

    assert_eq!(node.id, "relax_step");
    assert!(node.subgraph.is_some());
    let sg = node.subgraph.unwrap();
    assert_eq!(sg.template_id, "vasp_relax");
    assert_eq!(sg.version, Some("3.0.1".to_string()));
}
