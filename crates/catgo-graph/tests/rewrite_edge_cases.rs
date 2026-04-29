//! Edge-case tests for dynamic graph rewriting.

mod helpers;

use catgo_graph::*;
use catgo_graph::graph::rewrite::{
    RewriteRule, RewriteCondition, ConditionOperator,
    evaluate_condition, check_rewrite_rules, validate_rewrite_rules,
    RewriteEvent,
};
use serde_json::json;

// ---------------------------------------------------------------------------
// Helper constructors
// ---------------------------------------------------------------------------

fn make_node(id: &str) -> NodeTemplate {
    NodeTemplate {
        id: id.to_string(),
        tool: "echo".to_string(),
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
    }
}

#[allow(dead_code)]
fn make_template_with_node(id: &str) -> GraphTemplate {
    GraphTemplate {
        id: id.to_string(),
        version: "1.0".to_string(),
        description: None,
        inputs_schema: json!({}),
        nodes: vec![make_node("only_node")],
        outputs: vec![],
        metadata: Default::default(),
        rewrite_rules: vec![],
    }
}

fn make_rule(
    rule_id: &str,
    source_node: &str,
    output_key: &str,
    op: ConditionOperator,
    value: serde_json::Value,
    max_applications: u32,
) -> RewriteRule {
    RewriteRule {
        rule_id: rule_id.to_string(),
        source_node: source_node.to_string(),
        condition: RewriteCondition {
            output_key: output_key.to_string(),
            operator: op,
            value,
        },
        subgraph_template_id: "sub_tmpl".to_string(),
        subgraph_version: None,
        input_map: json!({}),
        max_applications,
    }
}

fn make_event(rule_id: &str, source_node: &str) -> RewriteEvent {
    RewriteEvent {
        event_id: uuid::Uuid::new_v4().to_string(),
        rule_id: rule_id.to_string(),
        source_node: source_node.to_string(),
        trigger_outputs: json!({}),
        injected_template_id: "sub_tmpl".to_string(),
        injected_node_ids: vec![],
        applied_at: "2025-01-01T00:00:00Z".to_string(),
    }
}

// ---------------------------------------------------------------------------
// 1. test_condition_with_nested_json_value
// ---------------------------------------------------------------------------

/// `output_key` only checks top-level keys. A nested key lookup always returns
/// false because `Value::get` only navigates one level for string keys.
#[test]
fn test_condition_with_nested_json_value() {
    // outputs["result"] is an object, not a scalar. The condition checks the
    // top-level key "result", which exists, so Equal comparison is tried.
    let cond = RewriteCondition {
        output_key: "result".to_string(),
        operator: ConditionOperator::Equal,
        value: json!({"inner": 42}),
    };
    let outputs = json!({ "result": {"inner": 42} });
    // Equal comparison on two identical JSON objects — should be true.
    assert!(evaluate_condition(&cond, &outputs));

    // A different nested value should be false.
    let outputs_diff = json!({ "result": {"inner": 99} });
    assert!(!evaluate_condition(&cond, &outputs_diff));

    // Attempting a numeric comparison (LessThan) on a nested object fails
    // gracefully — the object can't be coerced to f64, so returns false.
    let cond_lt = RewriteCondition {
        output_key: "result".to_string(),
        operator: ConditionOperator::LessThan,
        value: json!(100.0),
    };
    assert!(!evaluate_condition(&cond_lt, &outputs));
}

// ---------------------------------------------------------------------------
// 2. test_condition_with_null_output
// ---------------------------------------------------------------------------

/// When the output value is `null`, Equal comparison against `null` returns true.
#[test]
fn test_condition_with_null_output() {
    let cond = RewriteCondition {
        output_key: "status".to_string(),
        operator: ConditionOperator::Equal,
        value: json!(null),
    };
    let outputs_null = json!({ "status": null });
    assert!(evaluate_condition(&cond, &outputs_null));

    // Non-null value should not equal null.
    let outputs_non_null = json!({ "status": "done" });
    assert!(!evaluate_condition(&cond, &outputs_non_null));

    // Missing key entirely also returns false (not equal to null).
    let outputs_missing = json!({ "other_key": "x" });
    assert!(!evaluate_condition(&cond, &outputs_missing));

    // NotEqual: null != "something" should be true.
    let cond_ne = RewriteCondition {
        output_key: "status".to_string(),
        operator: ConditionOperator::NotEqual,
        value: json!(null),
    };
    assert!(evaluate_condition(&cond_ne, &outputs_non_null));
    assert!(!evaluate_condition(&cond_ne, &outputs_null));
}

// ---------------------------------------------------------------------------
// 3. test_condition_with_boolean_output
// ---------------------------------------------------------------------------

/// Boolean equality checks: `true == true`, `false != true`.
#[test]
fn test_condition_with_boolean_output() {
    let cond_true = RewriteCondition {
        output_key: "converged".to_string(),
        operator: ConditionOperator::Equal,
        value: json!(true),
    };
    let outputs_true = json!({ "converged": true });
    let outputs_false = json!({ "converged": false });

    assert!(evaluate_condition(&cond_true, &outputs_true));
    assert!(!evaluate_condition(&cond_true, &outputs_false));

    // NotEqual: converged != false should be true when converged is true.
    let cond_ne = RewriteCondition {
        output_key: "converged".to_string(),
        operator: ConditionOperator::NotEqual,
        value: json!(false),
    };
    assert!(evaluate_condition(&cond_ne, &outputs_true));
    assert!(!evaluate_condition(&cond_ne, &outputs_false));

    // LessThan on a boolean fails gracefully (booleans don't coerce to f64).
    let cond_lt = RewriteCondition {
        output_key: "converged".to_string(),
        operator: ConditionOperator::LessThan,
        value: json!(1.0),
    };
    assert!(!evaluate_condition(&cond_lt, &outputs_true));
}

// ---------------------------------------------------------------------------
// 4. test_condition_numeric_edge_cases
// ---------------------------------------------------------------------------

/// Numeric edge cases: integer vs float, LessThan/GreaterThan boundary values.
///
/// Note: The `Equal` operator uses serde_json Value equality, which distinguishes
/// between integer `5` and float `5.0` — they are different JSON types and will
/// NOT compare equal. Only `LessThan`, `LessThanOrEqual`, `GreaterThan`, and
/// `GreaterThanOrEqual` perform numeric (f64) coercion.
#[test]
fn test_condition_numeric_edge_cases() {
    // Equal: integer 5 vs float 5.0 — these are DIFFERENT JSON values in serde_json.
    // serde_json distinguishes Number::PosInt(5) from Number::Float(5.0).
    let cond_eq_float = RewriteCondition {
        output_key: "count".to_string(),
        operator: ConditionOperator::Equal,
        value: json!(5.0),
    };
    let outputs_int = json!({ "count": 5 });
    // Integer 5 and float 5.0 are NOT equal under serde_json Value comparison.
    assert!(!evaluate_condition(&cond_eq_float, &outputs_int),
        "serde_json integer 5 != float 5.0 under Value equality");

    // Equal: integer vs integer — same type, same value, should be true.
    let cond_eq_int = RewriteCondition {
        output_key: "count".to_string(),
        operator: ConditionOperator::Equal,
        value: json!(5),
    };
    assert!(evaluate_condition(&cond_eq_int, &outputs_int),
        "Integer 5 should equal integer 5");

    // Float output vs integer threshold.
    let cond_int_thresh = RewriteCondition {
        output_key: "score".to_string(),
        operator: ConditionOperator::GreaterThanOrEqual,
        value: json!(5),
    };
    let outputs_float = json!({ "score": 5.0 });
    assert!(evaluate_condition(&cond_int_thresh, &outputs_float));

    // LessThanOrEqual: 4.9999 < 5 is true.
    let cond_lte = RewriteCondition {
        output_key: "val".to_string(),
        operator: ConditionOperator::LessThanOrEqual,
        value: json!(5),
    };
    let outputs_below = json!({ "val": 4.9999 });
    assert!(evaluate_condition(&cond_lte, &outputs_below));

    // GreaterThan: 5.0001 > 5 is true.
    let cond_gt = RewriteCondition {
        output_key: "val".to_string(),
        operator: ConditionOperator::GreaterThan,
        value: json!(5),
    };
    let outputs_above = json!({ "val": 5.0001 });
    assert!(evaluate_condition(&cond_gt, &outputs_above));

    // GreaterThan: exact equality (5 > 5) is false.
    let outputs_exact = json!({ "val": 5 });
    assert!(!evaluate_condition(&cond_gt, &outputs_exact));
}

// ---------------------------------------------------------------------------
// 5. test_max_applications_limit
// ---------------------------------------------------------------------------

/// A rule with `max_applications=2` should fire on the first two completions
/// but not the third.
#[test]
fn test_max_applications_limit() {
    let rule = make_rule(
        "rule_fire_twice",
        "source_node",
        "energy",
        ConditionOperator::LessThan,
        json!(-1.0),
        2,
    );
    let outputs = json!({ "energy": -2.0 });

    // No existing events — rule fires (first application).
    let rules_1 = [rule.clone()];
    let fired = check_rewrite_rules(&rules_1, "source_node", &outputs, &[]);
    assert_eq!(fired.len(), 1, "Rule should fire on first application");

    // One existing event — rule fires again (second application).
    let one_event = vec![make_event("rule_fire_twice", "source_node")];
    let rules_2 = [rule.clone()];
    let fired2 = check_rewrite_rules(&rules_2, "source_node", &outputs, &one_event);
    assert_eq!(fired2.len(), 1, "Rule should fire on second application");

    // Two existing events — rule does NOT fire (max_applications reached).
    let two_events = vec![
        make_event("rule_fire_twice", "source_node"),
        make_event("rule_fire_twice", "source_node"),
    ];
    let rules_3 = [rule];
    let fired3 = check_rewrite_rules(&rules_3, "source_node", &outputs, &two_events);
    assert_eq!(fired3.len(), 0, "Rule should not fire after max_applications=2 reached");
}

// ---------------------------------------------------------------------------
// 6. test_validate_rules_empty_list
// ---------------------------------------------------------------------------

/// An empty rules list is always valid (no rules to check).
#[test]
fn test_validate_rules_empty_list() {
    let nodes = vec![make_node("node_a")];
    let result = validate_rewrite_rules(&[], &nodes);
    assert!(result.is_ok(), "Empty rules list should be valid");
}

// ---------------------------------------------------------------------------
// 7. test_validate_rules_nonexistent_source_node
// ---------------------------------------------------------------------------

/// A rule that references a source_node not present in template_nodes is invalid.
#[test]
fn test_validate_rules_nonexistent_source_node() {
    let nodes = vec![make_node("node_a"), make_node("node_b")];
    let rule = make_rule(
        "rule_bad",
        "node_that_does_not_exist",
        "energy",
        ConditionOperator::LessThan,
        json!(-1.0),
        1,
    );
    let result = validate_rewrite_rules(&[rule], &nodes);
    assert!(result.is_err(), "Rule with nonexistent source_node should fail validation");
    let err_msg = format!("{:?}", result.unwrap_err());
    assert!(
        err_msg.contains("node_that_does_not_exist"),
        "Error should mention the missing node ID, got: {}",
        err_msg
    );
}

// ---------------------------------------------------------------------------
// 8. test_backward_compat_yaml_without_rewrite_rules
// ---------------------------------------------------------------------------

/// A YAML template that omits the `rewrite_rules` field should deserialize
/// successfully and yield an empty `rewrite_rules` vec (serde default).
#[test]
fn test_backward_compat_yaml_without_rewrite_rules() {
    let yaml = r#"
id: compat_template
version: "1.0"
nodes:
  - id: step_a
    tool: echo
outputs: []
"#;
    let template: GraphTemplate = serde_yaml::from_str(yaml)
        .expect("YAML without rewrite_rules should deserialize successfully");

    assert_eq!(template.id, "compat_template");
    assert_eq!(template.version, "1.0");
    assert_eq!(template.nodes.len(), 1);
    assert!(
        template.rewrite_rules.is_empty(),
        "rewrite_rules should default to empty vec, got: {:?}",
        template.rewrite_rules
    );
}

// ---------------------------------------------------------------------------
// 9. test_backward_compat_graphrun_without_rewrite_events
// ---------------------------------------------------------------------------

/// A JSON GraphRun that omits the `rewrite_events` field should deserialize
/// successfully and yield an empty `rewrite_events` vec (serde default).
#[test]
fn test_backward_compat_graphrun_without_rewrite_events() {
    let json_str = r#"{
        "id": "run-compat",
        "template_id": "tmpl-1",
        "template_version": "1.0",
        "status": "created",
        "inputs": {},
        "node_runs": [],
        "created_at": "2025-01-01T00:00:00Z",
        "updated_at": "2025-01-01T00:00:00Z",
        "run_dir": "/tmp/test",
        "metadata": {}
    }"#;

    let run: GraphRun = serde_json::from_str(json_str)
        .expect("JSON without rewrite_events should deserialize successfully");

    assert_eq!(run.id, "run-compat");
    assert!(
        run.rewrite_events.is_empty(),
        "rewrite_events should default to empty vec, got: {:?}",
        run.rewrite_events
    );
}

// ---------------------------------------------------------------------------
// 10. test_rewrite_event_serialization_roundtrip
// ---------------------------------------------------------------------------

/// A `RewriteEvent` should serialize to JSON and deserialize back with the
/// same field values.
#[test]
fn test_rewrite_event_serialization_roundtrip() {
    let original = RewriteEvent {
        event_id: "evt-abc-123".to_string(),
        rule_id: "rule_refine".to_string(),
        source_node: "initial_relax".to_string(),
        trigger_outputs: json!({ "energy": -4.5, "converged": true }),
        injected_template_id: "refine_workflow".to_string(),
        injected_node_ids: vec![
            "rule_refine/step_a".to_string(),
            "rule_refine/step_b".to_string(),
        ],
        applied_at: "2025-06-01T12:00:00Z".to_string(),
    };

    let json_str = serde_json::to_string(&original)
        .expect("RewriteEvent should serialize to JSON without error");

    let roundtripped: RewriteEvent = serde_json::from_str(&json_str)
        .expect("Serialized RewriteEvent should deserialize back without error");

    // Verify field-by-field equality since PartialEq is not derived on RewriteEvent.
    assert_eq!(roundtripped.event_id, original.event_id);
    assert_eq!(roundtripped.rule_id, original.rule_id);
    assert_eq!(roundtripped.source_node, original.source_node);
    assert_eq!(roundtripped.trigger_outputs, original.trigger_outputs);
    assert_eq!(roundtripped.injected_template_id, original.injected_template_id);
    assert_eq!(roundtripped.injected_node_ids, original.injected_node_ids);
    assert_eq!(roundtripped.applied_at, original.applied_at);
}
