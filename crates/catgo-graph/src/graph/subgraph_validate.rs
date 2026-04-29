//! Subgraph reference validation.
//!
//! Validates that subgraph node references are correctly wired:
//! input_map keys match declared inputs, required inputs are provided,
//! output references are resolvable, and expressions are syntactically valid.
//!
//! Call [`validate_subgraph_refs`] **before** `expand_subgraphs()` for early
//! error detection with clear, actionable messages.

use regex::Regex;
use std::sync::LazyLock;

use crate::core::EngineError;
use crate::graph::composer::TemplateProvider;
use crate::graph::template::{GraphTemplate, NodeTemplate};

/// Regex matching `${inputs.KEY}` — a valid input reference expression.
static VALID_INPUTS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\$\{inputs\.[A-Za-z_][A-Za-z0-9_]*\}$").expect("Failed to compile inputs regex")
});

/// Regex matching `${nodes.NODE.outputs.KEY}` — a valid node output reference.
static VALID_NODES_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\$\{nodes\.[A-Za-z_][A-Za-z0-9_]*\.outputs\.[A-Za-z_][A-Za-z0-9_]*\}$")
        .expect("Failed to compile nodes regex")
});

/// Regex matching any `${...}` expression (to detect expression-like strings).
static EXPR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\$\{[^}]*\}").expect("Failed to compile expression regex")
});

/// Regex to extract `${nodes.NODE.outputs.KEY}` components from any string.
static NODE_OUTPUT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\$\{nodes\.([A-Za-z_][A-Za-z0-9_]*)\.outputs\.([A-Za-z_][A-Za-z0-9_]*)\}")
        .expect("Failed to compile node output regex")
});

/// Validate all subgraph references in a template against their referenced templates.
///
/// Checks:
/// 1. Referenced templates exist in the provider
/// 2. input_map keys correspond to declared properties in the subgraph's inputs_schema
/// 3. Required subgraph inputs are provided (or have defaults)
/// 4. `${...}` expressions in input_map values are syntactically valid
/// 5. Parent nodes referencing subgraph outputs use names declared in the subgraph's outputs spec
///
/// This should be called before `expand_subgraphs()` for early error detection.
pub fn validate_subgraph_refs(
    template: &GraphTemplate,
    provider: &dyn TemplateProvider,
) -> Result<(), EngineError> {
    // Collect subgraph node IDs and their resolved templates for output reference validation.
    let mut subgraph_templates: Vec<(&NodeTemplate, GraphTemplate)> = Vec::new();

    for node in &template.nodes {
        if let Some(ref sg_ref) = node.subgraph {
            // 1. Template existence
            let sub_template = provider
                .get_template(&sg_ref.template_id)
                .ok_or_else(|| EngineError::Validation {
                    reason: format!(
                        "Subgraph node '{}': referenced template '{}' not found in provider",
                        node.id, sg_ref.template_id
                    ),
                })?;

            // 2. Input key validation
            let declared_props = extract_schema_properties(&sub_template.inputs_schema);
            if let Some(map) = sg_ref.input_map.as_object() {
                let unknown_keys: Vec<&String> = map
                    .keys()
                    .filter(|k| !declared_props.contains(&k.to_string()))
                    .collect();
                if !unknown_keys.is_empty() {
                    return Err(EngineError::Validation {
                        reason: format!(
                            "Subgraph node '{}': input_map key '{}' is not declared in template '{}' \
                             inputs_schema (available: {})",
                            node.id,
                            unknown_keys
                                .iter()
                                .map(|k| k.as_str())
                                .collect::<Vec<_>>()
                                .join(", "),
                            sg_ref.template_id,
                            declared_props.join(", ")
                        ),
                    });
                }
            }

            // 3. Required input validation
            let required = extract_required_inputs(&sub_template.inputs_schema);
            for req_key in &required {
                let provided = sg_ref
                    .input_map
                    .as_object()
                    .map_or(false, |m| m.contains_key(req_key));
                if !provided && !has_default(&sub_template.inputs_schema, req_key) {
                    return Err(EngineError::Validation {
                        reason: format!(
                            "Subgraph node '{}': required input '{}' is not provided in input_map \
                             and has no default",
                            node.id, req_key
                        ),
                    });
                }
            }

            // 4. Expression syntax validation
            if let Some(map) = sg_ref.input_map.as_object() {
                for (key, value) in map {
                    validate_expression_value(&node.id, key, value)?;
                }
            }

            subgraph_templates.push((node, sub_template));
        }
    }

    // 5. Output reference validation — scan all non-subgraph nodes
    for node in &template.nodes {
        if node.subgraph.is_some() {
            continue;
        }
        // Check input_bindings for references to subgraph outputs
        validate_output_refs_in_value(
            &node.id,
            &node.input_bindings,
            &subgraph_templates,
        )?;
    }

    Ok(())
}

/// Extract declared property names from an inputs_schema JSON value.
fn extract_schema_properties(inputs_schema: &serde_json::Value) -> Vec<String> {
    inputs_schema
        .get("properties")
        .and_then(|p| p.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default()
}

/// Extract required input names from an inputs_schema JSON value.
fn extract_required_inputs(inputs_schema: &serde_json::Value) -> Vec<String> {
    inputs_schema
        .get("required")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Check if a property in inputs_schema has a default value.
fn has_default(inputs_schema: &serde_json::Value, key: &str) -> bool {
    inputs_schema
        .get("properties")
        .and_then(|p| p.get(key))
        .and_then(|prop| prop.get("default"))
        .is_some()
}

/// Validate that `${...}` expressions in input_map values are syntactically correct.
///
/// Valid forms:
/// - `${inputs.KEY}` — reference to a parent input
/// - `${nodes.NODE.outputs.KEY}` — reference to a parent node output
///
/// Non-string values and strings without `${...}` are allowed (they are literals).
fn validate_expression_value(
    node_id: &str,
    _key: &str,
    value: &serde_json::Value,
) -> Result<(), EngineError> {
    match value {
        serde_json::Value::String(s) => {
            // Find all ${...} expressions in the string
            for m in EXPR_RE.find_iter(s) {
                let expr = m.as_str();
                if !VALID_INPUTS_RE.is_match(expr) && !VALID_NODES_RE.is_match(expr) {
                    return Err(EngineError::Validation {
                        reason: format!(
                            "Subgraph node '{}': input_map expression '{}' is malformed \
                             (expected ${{inputs.KEY}} or ${{nodes.NODE.outputs.KEY}})",
                            node_id, expr
                        ),
                    });
                }
            }
            Ok(())
        }
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                validate_expression_value(node_id, k, v)?;
            }
            Ok(())
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                validate_expression_value(node_id, _key, v)?;
            }
            Ok(())
        }
        // Literal non-string values (numbers, booleans, null) are always valid
        _ => Ok(()),
    }
}

/// Scan a JSON value for `${nodes.SUBGRAPH_NODE.outputs.KEY}` references
/// and verify that KEY exists in the subgraph template's declared outputs.
fn validate_output_refs_in_value(
    consumer_node_id: &str,
    value: &serde_json::Value,
    subgraph_templates: &[(&NodeTemplate, GraphTemplate)],
) -> Result<(), EngineError> {
    match value {
        serde_json::Value::String(s) => {
            for caps in NODE_OUTPUT_RE.captures_iter(s) {
                let referenced_node = &caps[1];
                let output_key = &caps[2];

                // Check if this references a subgraph node
                for (sg_node, sg_template) in subgraph_templates {
                    if sg_node.id == referenced_node {
                        let available_outputs: Vec<&str> = sg_template
                            .outputs
                            .iter()
                            .map(|o| o.name.as_str())
                            .collect();

                        if !available_outputs.contains(&output_key) {
                            return Err(EngineError::Validation {
                                reason: format!(
                                    "Node '{}': references subgraph output \
                                     '${{nodes.{}.outputs.{}}}' but template '{}' has no output \
                                     named '{}' (available: {})",
                                    consumer_node_id,
                                    referenced_node,
                                    output_key,
                                    sg_template.id,
                                    output_key,
                                    available_outputs.join(", ")
                                ),
                            });
                        }
                    }
                }
            }
            Ok(())
        }
        serde_json::Value::Object(map) => {
            for (_k, v) in map {
                validate_output_refs_in_value(consumer_node_id, v, subgraph_templates)?;
            }
            Ok(())
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                validate_output_refs_in_value(consumer_node_id, v, subgraph_templates)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::template::{GraphOutputSpec, GraphTemplate, NodeTemplate, SubgraphRef};
    use serde_json::json;
    use std::collections::HashMap;

    /// Simple map-based template provider for tests.
    struct MapProvider {
        templates: HashMap<String, GraphTemplate>,
    }

    impl MapProvider {
        fn new() -> Self {
            Self {
                templates: HashMap::new(),
            }
        }

        fn add(&mut self, t: GraphTemplate) {
            self.templates.insert(t.id.clone(), t);
        }
    }

    impl TemplateProvider for MapProvider {
        fn get_template(&self, id: &str) -> Option<GraphTemplate> {
            self.templates.get(id).cloned()
        }
    }

    /// Create a minimal tool node.
    fn tool_node(id: &str, tool: &str, deps: Vec<&str>) -> NodeTemplate {
        NodeTemplate {
            id: id.into(),
            tool: tool.into(),
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

    /// Create a subgraph node (no tool, with subgraph ref).
    fn subgraph_node(
        id: &str,
        template_id: &str,
        input_map: serde_json::Value,
        deps: Vec<&str>,
    ) -> NodeTemplate {
        NodeTemplate {
            id: id.into(),
            tool: String::new(),
            depends_on: deps.into_iter().map(String::from).collect(),
            input_bindings: json!({}),
            output_spec: None,
            retry_policy: None,
            timeout_seconds: None,
            repair_policy: None,
            execution_mode: Default::default(),
            skip_condition: None,
            subgraph: Some(SubgraphRef {
                template_id: template_id.into(),
                version: None,
                input_map,
            }),
            metadata: Default::default(),
        }
    }

    /// Create a GraphTemplate with configurable inputs_schema and outputs.
    fn make_template(
        id: &str,
        nodes: Vec<NodeTemplate>,
        inputs_schema: serde_json::Value,
        outputs: Vec<GraphOutputSpec>,
    ) -> GraphTemplate {
        GraphTemplate {
            id: id.into(),
            version: "1.0".into(),
            description: None,
            inputs_schema,
            nodes,
            outputs,
            metadata: Default::default(),
            rewrite_rules: vec![],
        }
    }

    /// Build a stats sub-template with `values` (required) and `label` (optional, has default).
    fn stats_template() -> GraphTemplate {
        make_template(
            "stats_v1",
            vec![
                tool_node("compute", "compute_stats", vec![]),
                tool_node("save", "file_writer", vec!["compute"]),
            ],
            json!({
                "type": "object",
                "required": ["values"],
                "properties": {
                    "values": { "type": "array" },
                    "label": { "type": "string", "default": "stats" }
                }
            }),
            vec![
                GraphOutputSpec {
                    name: "mean".into(),
                    source: "${nodes.compute.outputs.mean}".into(),
                },
                GraphOutputSpec {
                    name: "count".into(),
                    source: "${nodes.compute.outputs.count}".into(),
                },
            ],
        )
    }

    // ──────────────────────────────────────────────────────────────────────
    // 1. Well-formed subgraph refs pass validation
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_valid_subgraph_refs_pass() {
        let mut provider = MapProvider::new();
        provider.add(stats_template());

        let parent = make_template(
            "parent",
            vec![
                tool_node("prep", "file_writer", vec![]),
                subgraph_node(
                    "analyze",
                    "stats_v1",
                    json!({
                        "values": "${inputs.data}",
                        "label": "${inputs.tag}"
                    }),
                    vec!["prep"],
                ),
                {
                    let mut n = tool_node("report", "file_writer", vec!["analyze"]);
                    n.input_bindings = json!({
                        "m": "${nodes.analyze.outputs.mean}",
                        "c": "${nodes.analyze.outputs.count}"
                    });
                    n
                },
            ],
            json!({}),
            vec![],
        );

        assert!(validate_subgraph_refs(&parent, &provider).is_ok());
    }

    // ──────────────────────────────────────────────────────────────────────
    // 2. Referenced template not found
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_missing_template_error() {
        let provider = MapProvider::new(); // empty

        let parent = make_template(
            "parent",
            vec![subgraph_node(
                "analyze",
                "nonexistent_v1",
                json!({}),
                vec![],
            )],
            json!({}),
            vec![],
        );

        let err = validate_subgraph_refs(&parent, &provider).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("nonexistent_v1") && msg.contains("not found"),
            "Expected error about missing template, got: {}",
            msg
        );
    }

    // ──────────────────────────────────────────────────────────────────────
    // 3. input_map has key not in inputs_schema
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_unknown_input_key_error() {
        let mut provider = MapProvider::new();
        provider.add(stats_template());

        let parent = make_template(
            "parent",
            vec![subgraph_node(
                "analyze",
                "stats_v1",
                json!({
                    "values": "${inputs.data}",
                    "unknown_param": 42
                }),
                vec![],
            )],
            json!({}),
            vec![],
        );

        let err = validate_subgraph_refs(&parent, &provider).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("unknown_param") && msg.contains("not declared"),
            "Expected error about unknown key, got: {}",
            msg
        );
    }

    // ──────────────────────────────────────────────────────────────────────
    // 4. Required input not in input_map, no default
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_missing_required_input_error() {
        let mut provider = MapProvider::new();
        provider.add(stats_template());

        // `values` is required and has no default — omit it
        let parent = make_template(
            "parent",
            vec![subgraph_node(
                "analyze",
                "stats_v1",
                json!({
                    "label": "test"
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
            "Expected error about missing required input 'values', got: {}",
            msg
        );
    }

    // ──────────────────────────────────────────────────────────────────────
    // 5. Required input missing but has default -> OK
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_required_input_with_default_ok() {
        let mut provider = MapProvider::new();
        // Create a template where ALL required inputs have defaults
        let tpl = make_template(
            "all_defaults_v1",
            vec![tool_node("step", "echo", vec![])],
            json!({
                "type": "object",
                "required": ["values", "label"],
                "properties": {
                    "values": { "type": "array", "default": [1, 2, 3] },
                    "label": { "type": "string", "default": "default_label" }
                }
            }),
            vec![],
        );
        provider.add(tpl);

        // Provide NO inputs — both have defaults, so should pass
        let parent = make_template(
            "parent",
            vec![subgraph_node(
                "analyze",
                "all_defaults_v1",
                json!({}),
                vec![],
            )],
            json!({}),
            vec![],
        );

        assert!(validate_subgraph_refs(&parent, &provider).is_ok());
    }

    // ──────────────────────────────────────────────────────────────────────
    // 6. Non-required input missing from input_map -> OK
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_optional_input_not_required() {
        let mut provider = MapProvider::new();
        provider.add(stats_template());

        // `label` is not in the required array — omitting it is fine
        let parent = make_template(
            "parent",
            vec![subgraph_node(
                "analyze",
                "stats_v1",
                json!({
                    "values": "${inputs.data}"
                }),
                vec![],
            )],
            json!({}),
            vec![],
        );

        assert!(validate_subgraph_refs(&parent, &provider).is_ok());
    }

    // ──────────────────────────────────────────────────────────────────────
    // 7. Malformed expression in input_map value
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_malformed_expression_error() {
        let mut provider = MapProvider::new();
        provider.add(stats_template());

        let parent = make_template(
            "parent",
            vec![subgraph_node(
                "analyze",
                "stats_v1",
                json!({
                    "values": "${invalid}"
                }),
                vec![],
            )],
            json!({}),
            vec![],
        );

        let err = validate_subgraph_refs(&parent, &provider).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("${invalid}") && msg.contains("malformed"),
            "Expected error about malformed expression, got: {}",
            msg
        );
    }

    // ──────────────────────────────────────────────────────────────────────
    // 8. Valid expressions pass: ${inputs.X} and ${nodes.Y.outputs.Z}
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_valid_expressions_pass() {
        let mut provider = MapProvider::new();
        provider.add(stats_template());

        let parent = make_template(
            "parent",
            vec![
                tool_node("source", "echo", vec![]),
                subgraph_node(
                    "analyze",
                    "stats_v1",
                    json!({
                        "values": "${nodes.source.outputs.data}",
                        "label": "${inputs.tag}"
                    }),
                    vec!["source"],
                ),
            ],
            json!({}),
            vec![],
        );

        assert!(validate_subgraph_refs(&parent, &provider).is_ok());
    }

    // ──────────────────────────────────────────────────────────────────────
    // 9. Parent references nonexistent subgraph output
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_invalid_output_reference_error() {
        let mut provider = MapProvider::new();
        provider.add(stats_template()); // has outputs: mean, count

        let parent = make_template(
            "parent",
            vec![
                subgraph_node(
                    "analyze",
                    "stats_v1",
                    json!({
                        "values": "${inputs.data}"
                    }),
                    vec![],
                ),
                {
                    let mut n = tool_node("report", "file_writer", vec!["analyze"]);
                    n.input_bindings = json!({
                        "result": "${nodes.analyze.outputs.unknown_output}"
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
            msg.contains("unknown_output") && msg.contains("report"),
            "Expected error about unknown subgraph output, got: {}",
            msg
        );
    }

    // ──────────────────────────────────────────────────────────────────────
    // 10. Parent references valid subgraph output
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_valid_output_reference_passes() {
        let mut provider = MapProvider::new();
        provider.add(stats_template()); // has outputs: mean, count

        let parent = make_template(
            "parent",
            vec![
                subgraph_node(
                    "analyze",
                    "stats_v1",
                    json!({
                        "values": "${inputs.data}"
                    }),
                    vec![],
                ),
                {
                    let mut n = tool_node("report", "file_writer", vec!["analyze"]);
                    n.input_bindings = json!({
                        "m": "${nodes.analyze.outputs.mean}",
                        "c": "${nodes.analyze.outputs.count}"
                    });
                    n
                },
            ],
            json!({}),
            vec![],
        );

        assert!(validate_subgraph_refs(&parent, &provider).is_ok());
    }

    // ──────────────────────────────────────────────────────────────────────
    // 11. Template with no subgraph nodes passes trivially
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_no_subgraph_nodes_passes() {
        let provider = MapProvider::new();

        let parent = make_template(
            "simple_pipeline",
            vec![
                tool_node("a", "echo", vec![]),
                tool_node("b", "echo", vec!["a"]),
                tool_node("c", "echo", vec!["b"]),
            ],
            json!({}),
            vec![],
        );

        assert!(validate_subgraph_refs(&parent, &provider).is_ok());
    }

    // ──────────────────────────────────────────────────────────────────────
    // 12. Nested subgraph refs — subgraph-within-subgraph validated
    // ──────────────────────────────────────────────────────────────────────
    #[test]
    fn test_nested_subgraph_refs_validated() {
        let mut provider = MapProvider::new();

        // Inner template: a single tool node with an inputs_schema
        let inner = make_template(
            "inner_v1",
            vec![tool_node("leaf", "echo", vec![])],
            json!({
                "type": "object",
                "required": ["x"],
                "properties": {
                    "x": { "type": "number" }
                }
            }),
            vec![],
        );
        provider.add(inner);

        // Middle template: contains a subgraph reference to inner_v1
        // This template itself declares inputs_schema and has an inner subgraph node
        let middle = make_template(
            "middle_v1",
            vec![subgraph_node(
                "inner_sg",
                "inner_v1",
                json!({ "x": "${inputs.value}" }),
                vec![],
            )],
            json!({
                "type": "object",
                "required": ["value"],
                "properties": {
                    "value": { "type": "number" }
                }
            }),
            vec![],
        );
        provider.add(middle.clone());

        // Top-level template: references middle_v1
        let top = make_template(
            "top",
            vec![subgraph_node(
                "outer_sg",
                "middle_v1",
                json!({ "value": "${inputs.num}" }),
                vec![],
            )],
            json!({}),
            vec![],
        );

        // Validate the top template: should check that middle_v1 exists and
        // input_map keys are valid. The nested inner_v1 validation happens
        // when validating middle_v1 separately.
        assert!(validate_subgraph_refs(&top, &provider).is_ok());

        // Also validate the middle template directly to cover nested validation
        assert!(validate_subgraph_refs(&middle, &provider).is_ok());
    }

    // ──────────────────────────────────────────────────────────────────────
    // Additional edge-case tests
    // ──────────────────────────────────────────────────────────────────────

    #[test]
    fn test_empty_inputs_schema_passes() {
        let mut provider = MapProvider::new();
        // Template with no inputs_schema properties
        let tpl = make_template(
            "no_inputs_v1",
            vec![tool_node("step", "echo", vec![])],
            json!({}),
            vec![],
        );
        provider.add(tpl);

        let parent = make_template(
            "parent",
            vec![subgraph_node("sg", "no_inputs_v1", json!({}), vec![])],
            json!({}),
            vec![],
        );

        assert!(validate_subgraph_refs(&parent, &provider).is_ok());
    }

    #[test]
    fn test_literal_values_in_input_map_pass() {
        let mut provider = MapProvider::new();
        provider.add(stats_template());

        // Using literal number and string values (no ${...}) is fine
        let parent = make_template(
            "parent",
            vec![subgraph_node(
                "analyze",
                "stats_v1",
                json!({
                    "values": [1, 2, 3],
                    "label": "literal_label"
                }),
                vec![],
            )],
            json!({}),
            vec![],
        );

        assert!(validate_subgraph_refs(&parent, &provider).is_ok());
    }

    #[test]
    fn test_multiple_malformed_expressions() {
        let mut provider = MapProvider::new();
        provider.add(stats_template());

        // ${broken.ref} is malformed
        let parent = make_template(
            "parent",
            vec![subgraph_node(
                "analyze",
                "stats_v1",
                json!({
                    "values": "${broken.ref}"
                }),
                vec![],
            )],
            json!({}),
            vec![],
        );

        let err = validate_subgraph_refs(&parent, &provider).unwrap_err();
        let msg = format!("{}", err);
        assert!(msg.contains("malformed"), "Got: {}", msg);
    }

    #[test]
    fn test_subgraph_with_no_outputs_rejects_output_ref() {
        let mut provider = MapProvider::new();
        // Template with no declared outputs
        let tpl = make_template(
            "no_outputs_v1",
            vec![tool_node("step", "echo", vec![])],
            json!({
                "type": "object",
                "properties": {
                    "x": { "type": "number" }
                }
            }),
            vec![], // no outputs
        );
        provider.add(tpl);

        let parent = make_template(
            "parent",
            vec![
                subgraph_node("sg", "no_outputs_v1", json!({"x": 1}), vec![]),
                {
                    let mut n = tool_node("consumer", "echo", vec!["sg"]);
                    n.input_bindings = json!({
                        "val": "${nodes.sg.outputs.result}"
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
            msg.contains("result") && msg.contains("consumer"),
            "Expected error about nonexistent output 'result', got: {}",
            msg
        );
    }
}
