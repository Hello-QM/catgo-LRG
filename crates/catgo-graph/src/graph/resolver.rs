use regex::Regex;
use std::sync::LazyLock;

use crate::core::EngineError;
use crate::graph::run::GraphRun;
use crate::graph::template::NodeTemplate;

/// Regex matching `${...}` variable references.
/// Captures the inner expression (without the `${` and `}` delimiters).
static VAR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\$\{([^}]+)\}").expect("Failed to compile variable reference regex")
});

/// Resolve all `${...}` variable references in a node's `input_bindings`.
///
/// Takes the `GraphRun` (for graph-level inputs and completed node outputs)
/// and the `NodeTemplate` (for the `input_bindings` with placeholders).
///
/// Supported patterns:
///   `${inputs.KEY}`                  - graph-level input from `run.inputs`
///   `${nodes.NODE_ID.outputs.KEY}`   - output from a completed upstream node
///
/// **Type preservation**: If the entire JSON string value is a single `${...}`
/// reference, the resolved value preserves its original JSON type (number,
/// object, array, bool, null). If `${...}` is embedded in a larger string,
/// the resolved value is stringified and interpolated.
pub fn resolve_inputs(
    run: &GraphRun,
    node_template: &NodeTemplate,
) -> Result<serde_json::Value, EngineError> {
    resolve_value(&node_template.input_bindings, run)
}

/// Resolve a single expression like `"inputs.surface"` or
/// `"nodes.relax_OH.outputs.energy"`.
///
/// Returns the resolved JSON value, preserving its original type.
fn resolve_expression(
    expr: &str,
    run: &GraphRun,
) -> Result<serde_json::Value, EngineError> {
    let parts: Vec<&str> = expr.splitn(4, '.').collect();

    match parts.as_slice() {
        // ${inputs.KEY}
        ["inputs", key] => {
            run.inputs
                .get(*key)
                .cloned()
                .ok_or_else(|| EngineError::InputResolution {
                    expression: format!("${{{}}}", expr),
                    reason: format!("Input key '{}' not found in run inputs", key),
                })
        }

        // ${nodes.NODE_ID.outputs.KEY}
        ["nodes", node_id, "outputs", key] => {
            let node_run = run.node_run(node_id).ok_or_else(|| {
                EngineError::InputResolution {
                    expression: format!("${{{}}}", expr),
                    reason: format!("Node '{}' not found in run", node_id),
                }
            })?;

            let outputs = node_run.outputs.as_ref().ok_or_else(|| {
                EngineError::InputResolution {
                    expression: format!("${{{}}}", expr),
                    reason: format!(
                        "Node '{}' has no outputs (status: {:?})",
                        node_id, node_run.status
                    ),
                }
            })?;

            outputs.get(*key).cloned().ok_or_else(|| {
                EngineError::InputResolution {
                    expression: format!("${{{}}}", expr),
                    reason: format!(
                        "Output key '{}' not found in node '{}' outputs",
                        key, node_id
                    ),
                }
            })
        }

        _ => Err(EngineError::InputResolution {
            expression: format!("${{{}}}", expr),
            reason: format!(
                "Malformed expression '{}'. Expected 'inputs.KEY' or 'nodes.NODE_ID.outputs.KEY'",
                expr
            ),
        }),
    }
}

/// Recursively walk a JSON value tree, resolving all `${...}` references.
fn resolve_value(
    value: &serde_json::Value,
    run: &GraphRun,
) -> Result<serde_json::Value, EngineError> {
    match value {
        serde_json::Value::String(s) => resolve_string(s, run),
        serde_json::Value::Array(arr) => {
            let resolved: Result<Vec<serde_json::Value>, EngineError> = arr
                .iter()
                .map(|v| resolve_value(v, run))
                .collect();
            Ok(serde_json::Value::Array(resolved?))
        }
        serde_json::Value::Object(obj) => {
            let mut resolved = serde_json::Map::new();
            for (k, v) in obj {
                resolved.insert(k.clone(), resolve_value(v, run)?);
            }
            Ok(serde_json::Value::Object(resolved))
        }
        // Numbers, bools, null pass through unchanged
        other => Ok(other.clone()),
    }
}

/// Resolve `${...}` references within a single string value.
///
/// If the entire string is exactly one `${...}` reference (no surrounding text),
/// the resolved value preserves its original JSON type. Otherwise, all references
/// are stringified and interpolated into the result string.
fn resolve_string(
    s: &str,
    run: &GraphRun,
) -> Result<serde_json::Value, EngineError> {
    // Fast path: check if the string contains any references at all
    if !s.contains("${") {
        return Ok(serde_json::Value::String(s.to_string()));
    }

    // Check if the entire string is a single ${...} reference for type preservation
    let captures: Vec<_> = VAR_RE.captures_iter(s).collect();
    if captures.len() == 1 {
        let m = captures[0].get(0).unwrap();
        if m.start() == 0 && m.end() == s.len() {
            // Entire string is one reference: preserve the resolved type
            let expr = captures[0].get(1).unwrap().as_str();
            return resolve_expression(expr, run);
        }
    }

    // Multiple references or embedded in a larger string: stringify all
    let mut result = s.to_string();
    // Process replacements from right to left to preserve indices
    let matches: Vec<_> = VAR_RE.captures_iter(s).collect();
    for cap in matches.iter().rev() {
        let full_match = cap.get(0).unwrap();
        let expr = cap.get(1).unwrap().as_str();
        let resolved = resolve_expression(expr, run)?;
        let stringified = json_to_string(&resolved);
        result.replace_range(full_match.start()..full_match.end(), &stringified);
    }

    Ok(serde_json::Value::String(result))
}

/// Convert a JSON value to a string for embedding in a larger string.
/// Strings are unquoted; other types use their JSON representation.
fn json_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{GraphRunStatus, NodeStatus};
    use crate::graph::run::{GraphRun, NodeRun};
    use crate::graph::template::NodeTemplate;
    use serde_json::json;

    /// Build a mock GraphRun with graph inputs and one completed node.
    fn mock_graph_run() -> GraphRun {
        GraphRun {
            id: "run_1".into(),
            template_id: "tpl_1".into(),
            template_version: "1.0".into(),
            status: GraphRunStatus::Running,
            inputs: json!({
                "surface": "Pt(111)",
                "kpoints": 4,
                "config": {"key": "val"}
            }),
            node_runs: vec![NodeRun {
                node_id: "node_a".into(),
                status: NodeStatus::Succeeded,
                outputs: Some(json!({
                    "energy": -123.45,
                    "structure": {"atoms": 12}
                })),
                ..NodeRun::new("node_a".into())
            }],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            run_dir: "/tmp/test".into(),
            metadata: Default::default(),
            rewrite_events: vec![],
        }
    }

    /// Helper: create a NodeTemplate with the given input_bindings.
    fn node_with_bindings(bindings: serde_json::Value) -> NodeTemplate {
        NodeTemplate {
            id: "test_node".into(),
            tool: "test_tool".into(),
            depends_on: vec![],
            input_bindings: bindings,
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

    #[test]
    fn resolve_input_string() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "surface": "${inputs.surface}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["surface"], json!("Pt(111)"));
    }

    #[test]
    fn resolve_input_preserves_number() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "kpts": "${inputs.kpoints}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["kpts"], json!(4));
        assert!(resolved["kpts"].is_number(), "Should preserve number type");
    }

    #[test]
    fn resolve_input_preserves_object() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "cfg": "${inputs.config}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["cfg"], json!({"key": "val"}));
        assert!(resolved["cfg"].is_object(), "Should preserve object type");
    }

    #[test]
    fn resolve_node_output() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "prev_energy": "${nodes.node_a.outputs.energy}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["prev_energy"], json!(-123.45));
        assert!(
            resolved["prev_energy"].is_f64(),
            "Should preserve float type"
        );
    }

    #[test]
    fn resolve_node_output_object() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "struct": "${nodes.node_a.outputs.structure}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["struct"], json!({"atoms": 12}));
    }

    #[test]
    fn embedded_reference_in_string() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "filename": "file_${inputs.surface}.txt"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["filename"], json!("file_Pt(111).txt"));
    }

    #[test]
    fn multiple_references_in_one_string() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "label": "${inputs.surface}_k${inputs.kpoints}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["label"], json!("Pt(111)_k4"));
    }

    #[test]
    fn nested_json_object_resolution() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "outer": {
                "inner": {
                    "surface": "${inputs.surface}",
                    "energy": "${nodes.node_a.outputs.energy}"
                },
                "plain": "no_refs_here"
            }
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["outer"]["inner"]["surface"], json!("Pt(111)"));
        assert_eq!(resolved["outer"]["inner"]["energy"], json!(-123.45));
        assert_eq!(resolved["outer"]["plain"], json!("no_refs_here"));
    }

    #[test]
    fn array_resolution() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "items": [
                "${inputs.surface}",
                "${inputs.kpoints}",
                "literal",
                42
            ]
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        let items = resolved["items"].as_array().unwrap();
        assert_eq!(items[0], json!("Pt(111)"));
        assert_eq!(items[1], json!(4));
        assert_eq!(items[2], json!("literal"));
        assert_eq!(items[3], json!(42));
    }

    #[test]
    fn missing_input_error() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "x": "${inputs.nonexistent}"
        }));
        let err = resolve_inputs(&run, &node).unwrap_err();
        match err {
            EngineError::InputResolution { expression, reason } => {
                assert!(expression.contains("inputs.nonexistent"));
                assert!(reason.contains("not found"));
            }
            other => panic!("Expected InputResolution, got: {:?}", other),
        }
    }

    #[test]
    fn missing_node_error() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "x": "${nodes.no_such_node.outputs.energy}"
        }));
        let err = resolve_inputs(&run, &node).unwrap_err();
        match err {
            EngineError::InputResolution { expression, reason } => {
                assert!(expression.contains("no_such_node"));
                assert!(reason.contains("not found"));
            }
            other => panic!("Expected InputResolution, got: {:?}", other),
        }
    }

    #[test]
    fn missing_node_output_error() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "x": "${nodes.node_a.outputs.nonexistent_key}"
        }));
        let err = resolve_inputs(&run, &node).unwrap_err();
        match err {
            EngineError::InputResolution { expression, reason } => {
                assert!(expression.contains("nonexistent_key"));
                assert!(reason.contains("not found"));
            }
            other => panic!("Expected InputResolution, got: {:?}", other),
        }
    }

    #[test]
    fn malformed_expression_error() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "x": "${garbage}"
        }));
        let err = resolve_inputs(&run, &node).unwrap_err();
        match err {
            EngineError::InputResolution { expression, reason } => {
                assert!(expression.contains("garbage"));
                assert!(reason.contains("Malformed"));
            }
            other => panic!("Expected InputResolution, got: {:?}", other),
        }
    }

    #[test]
    fn no_references_passthrough() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "plain_string": "hello",
            "plain_number": 42,
            "plain_bool": true,
            "plain_null": null,
            "nested": {"a": 1}
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["plain_string"], json!("hello"));
        assert_eq!(resolved["plain_number"], json!(42));
        assert_eq!(resolved["plain_bool"], json!(true));
        assert!(resolved["plain_null"].is_null());
        assert_eq!(resolved["nested"], json!({"a": 1}));
    }

    #[test]
    fn node_with_no_outputs_yet() {
        let mut run = mock_graph_run();
        // Add a node that is still running (no outputs yet)
        run.node_runs.push(NodeRun {
            node_id: "node_b".into(),
            status: NodeStatus::Running,
            outputs: None,
            ..NodeRun::new("node_b".into())
        });
        let node = node_with_bindings(json!({
            "x": "${nodes.node_b.outputs.energy}"
        }));
        let err = resolve_inputs(&run, &node).unwrap_err();
        match err {
            EngineError::InputResolution { reason, .. } => {
                assert!(reason.contains("no outputs"), "Expected 'no outputs' in: {}", reason);
            }
            other => panic!("Expected InputResolution, got: {:?}", other),
        }
    }

    #[test]
    fn embedded_number_is_stringified() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "label": "kpoints=${inputs.kpoints}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["label"], json!("kpoints=4"));
    }

    #[test]
    fn embedded_object_is_stringified() {
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "info": "config=${inputs.config}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        let s = resolved["info"].as_str().unwrap();
        assert!(s.starts_with("config="), "Should start with 'config=': {}", s);
        // The JSON object will be serialized
        assert!(s.contains("key"), "Should contain 'key': {}", s);
    }

    #[test]
    fn test_resolve_boolean_input() {
        let mut run = mock_graph_run();
        run.inputs = json!({
            "flag": true
        });
        let node = node_with_bindings(json!({
            "enabled": "${inputs.flag}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["enabled"], json!(true));
        assert!(resolved["enabled"].is_boolean(), "Should preserve boolean type");
    }

    #[test]
    fn test_resolve_null_input() {
        let mut run = mock_graph_run();
        run.inputs = json!({
            "empty": null
        });
        let node = node_with_bindings(json!({
            "value": "${inputs.empty}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert!(resolved["value"].is_null(), "Should preserve null type");
    }

    #[test]
    fn test_resolve_array_input() {
        let mut run = mock_graph_run();
        run.inputs = json!({
            "list": [1, 2, 3]
        });
        let node = node_with_bindings(json!({
            "data": "${inputs.list}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["data"], json!([1, 2, 3]));
        assert!(resolved["data"].is_array(), "Should preserve array type");
    }

    #[test]
    fn test_deeply_nested_resolution() {
        // 3 levels deep nested objects with references
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "level1": {
                "level2": {
                    "level3": {
                        "surface": "${inputs.surface}",
                        "energy": "${nodes.node_a.outputs.energy}"
                    }
                }
            }
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["level1"]["level2"]["level3"]["surface"], json!("Pt(111)"));
        assert_eq!(resolved["level1"]["level2"]["level3"]["energy"], json!(-123.45));
    }

    #[test]
    fn test_mixed_literal_and_ref_in_object() {
        // Object with some literal fields and some ${} reference fields
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "literal_string": "hello",
            "literal_number": 42,
            "literal_bool": false,
            "ref_surface": "${inputs.surface}",
            "ref_energy": "${nodes.node_a.outputs.energy}",
            "nested_literal": {"a": 1, "b": 2}
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        // Literals pass through unchanged
        assert_eq!(resolved["literal_string"], json!("hello"));
        assert_eq!(resolved["literal_number"], json!(42));
        assert_eq!(resolved["literal_bool"], json!(false));
        assert_eq!(resolved["nested_literal"], json!({"a": 1, "b": 2}));
        // References resolve correctly
        assert_eq!(resolved["ref_surface"], json!("Pt(111)"));
        assert_eq!(resolved["ref_energy"], json!(-123.45));
    }

    #[test]
    fn test_empty_string_passthrough() {
        // Empty string "" with no references should pass through unchanged
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "empty": ""
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["empty"], json!(""));
        assert!(resolved["empty"].is_string(), "Should remain a string");
    }

    #[test]
    fn test_reference_to_numeric_output() {
        // ${nodes.A.outputs.energy} returns -123.45 as a number (not a string)
        let run = mock_graph_run();
        let node = node_with_bindings(json!({
            "energy_val": "${nodes.node_a.outputs.energy}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        assert_eq!(resolved["energy_val"], json!(-123.45));
        assert!(resolved["energy_val"].is_f64(), "Should be a float number, not a string");
        let val = resolved["energy_val"].as_f64().unwrap();
        assert!((val - (-123.45)).abs() < 1e-10, "Value should be -123.45, got {}", val);
    }

    #[test]
    fn test_multiple_nodes_outputs() {
        // Resolve from two different upstream nodes in the same input_bindings
        let mut run = mock_graph_run();
        // Add a second completed node
        run.node_runs.push(NodeRun {
            node_id: "node_b".into(),
            status: NodeStatus::Succeeded,
            outputs: Some(json!({
                "bandgap": 1.42,
                "is_metal": false
            })),
            ..NodeRun::new("node_b".into())
        });
        let node = node_with_bindings(json!({
            "energy_from_a": "${nodes.node_a.outputs.energy}",
            "structure_from_a": "${nodes.node_a.outputs.structure}",
            "bandgap_from_b": "${nodes.node_b.outputs.bandgap}",
            "is_metal_from_b": "${nodes.node_b.outputs.is_metal}"
        }));
        let resolved = resolve_inputs(&run, &node).unwrap();
        // From node_a
        assert_eq!(resolved["energy_from_a"], json!(-123.45));
        assert_eq!(resolved["structure_from_a"], json!({"atoms": 12}));
        // From node_b
        assert_eq!(resolved["bandgap_from_b"], json!(1.42));
        assert_eq!(resolved["is_metal_from_b"], json!(false));
    }
}
