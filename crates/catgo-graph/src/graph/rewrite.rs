//! Dynamic graph rewriting: append-only injection of predefined subgraph templates.
//!
//! Rewrite rules are explicit, deterministic conditions attached to a GraphTemplate.
//! When a node succeeds and its outputs satisfy a rule's condition, a predefined
//! subgraph template is injected into the running graph. The injection is:
//! - Append-only (no deletion of existing nodes)
//! - Persisted as a first-class RewriteEvent
//! - Idempotent across resume/restart
//! - Bounded by safety limits

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use regex::Regex;
use std::sync::LazyLock;

use crate::core::EngineError;
use crate::core::ids::NodeId;
use crate::graph::template::*;
use crate::graph::run::{GraphRun, NodeRun};
use crate::graph::composer::{TemplateProvider, expand_subgraphs};

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

/// Regex matching ${inputs.KEY} references.
static INPUTS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\$\{inputs\.([^}]+)\}").expect("Failed to compile inputs regex")
});

/// Regex matching ${nodes.NODE_ID.outputs.KEY} references.
static NODES_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\$\{nodes\.([^.]+)\.outputs\.([^}]+)\}").expect("Failed to compile nodes regex")
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Comparison operator for a rewrite condition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConditionOperator {
    Equal,
    NotEqual,
    LessThan,
    LessThanOrEqual,
    GreaterThan,
    GreaterThanOrEqual,
}

/// A single condition that, when satisfied, triggers a rewrite rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewriteCondition {
    /// Which output key of the source node to evaluate (e.g. "energy").
    pub output_key: String,
    /// The comparison operator.
    pub operator: ConditionOperator,
    /// The threshold value to compare against.
    pub value: serde_json::Value,
}

fn default_max_applications() -> u32 { 1 }

/// A rule that governs when and how a subgraph template is injected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewriteRule {
    /// Unique identifier for this rule within the template.
    pub rule_id: String,
    /// The node whose successful completion triggers evaluation of this rule.
    pub source_node: String,
    /// The condition that must be satisfied.
    pub condition: RewriteCondition,
    /// The ID of the subgraph template to inject when the condition fires.
    pub subgraph_template_id: String,
    /// Optional exact version pin for the subgraph template.
    #[serde(default)]
    pub subgraph_version: Option<String>,
    /// Maps subgraph input parameter names to values or expressions from the
    /// parent context. Keys are the subgraph's input names; values are literal
    /// JSON values or `${...}` expressions.
    #[serde(default)]
    pub input_map: serde_json::Value,
    /// Maximum number of times this rule may fire in a single run.
    #[serde(default = "default_max_applications")]
    pub max_applications: u32,
}

/// An immutable record of a rewrite that was applied during a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewriteEvent {
    /// UUID identifying this event.
    pub event_id: String,
    /// The rule that triggered this event.
    pub rule_id: String,
    /// The source node whose outputs triggered the rule.
    pub source_node: String,
    /// The outputs of the source node at the time of the trigger.
    pub trigger_outputs: serde_json::Value,
    /// The template that was injected.
    pub injected_template_id: String,
    /// All node IDs that were created during this injection.
    pub injected_node_ids: Vec<String>,
    /// ISO 8601 timestamp when the rewrite was applied.
    pub applied_at: String,
}

/// Safety limits for graph rewriting.
#[derive(Debug, Clone)]
pub struct RewriteLimits {
    /// Maximum number of rewrite events allowed in a single run.
    pub max_events_per_run: usize,
    /// Maximum number of nodes that a single rewrite may inject.
    pub max_nodes_per_rewrite: usize,
}

impl Default for RewriteLimits {
    fn default() -> Self {
        Self {
            max_events_per_run: 10,
            max_nodes_per_rewrite: 50,
        }
    }
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/// Evaluate a single rewrite condition against the outputs of a node.
///
/// Returns `false` if:
/// - The output key is missing.
/// - A numeric comparison is attempted against a non-numeric value.
pub fn evaluate_condition(condition: &RewriteCondition, outputs: &serde_json::Value) -> bool {
    let actual = match outputs.get(&condition.output_key) {
        Some(v) => v,
        None => return false,
    };

    match &condition.operator {
        ConditionOperator::Equal => actual == &condition.value,
        ConditionOperator::NotEqual => actual != &condition.value,
        op => {
            // Numeric comparison
            let lhs = match actual.as_f64() {
                Some(v) => v,
                None => return false,
            };
            let rhs = match condition.value.as_f64() {
                Some(v) => v,
                None => return false,
            };
            match op {
                ConditionOperator::LessThan => lhs < rhs,
                ConditionOperator::LessThanOrEqual => lhs <= rhs,
                ConditionOperator::GreaterThan => lhs > rhs,
                ConditionOperator::GreaterThanOrEqual => lhs >= rhs,
                // Equal / NotEqual already handled above
                _ => unreachable!(),
            }
        }
    }
}

/// Determine which rewrite rules should fire given a completed node and its outputs.
///
/// A rule fires when:
/// 1. Its `source_node` matches the completed node.
/// 2. It has not yet been applied `max_applications` times.
/// 3. Its condition is satisfied by the node's outputs.
pub fn check_rewrite_rules<'a>(
    rules: &'a [RewriteRule],
    source_node: &str,
    outputs: &serde_json::Value,
    existing_events: &[RewriteEvent],
) -> Vec<&'a RewriteRule> {
    rules
        .iter()
        .filter(|rule| {
            if rule.source_node != source_node {
                return false;
            }
            let applied_count = existing_events
                .iter()
                .filter(|ev| ev.rule_id == rule.rule_id && ev.source_node == rule.source_node)
                .count() as u32;
            if applied_count >= rule.max_applications {
                return false;
            }
            evaluate_condition(&rule.condition, outputs)
        })
        .collect()
}

/// Recursively rewrite `${inputs.X}` and `${nodes.Y.outputs.Z}` references
/// within a JSON value during a rewrite injection.
///
/// - `${inputs.X}` is replaced by `input_map["X"]` if present.
/// - `${nodes.Y.outputs.Z}` where Y is an *inner* node is rewritten to
///   `${nodes.prefix/Y.outputs.Z}`.
fn rewrite_rewrite_inputs(
    value: &serde_json::Value,
    input_map: &serde_json::Value,
    prefix: &str,
    inner_ids: &HashSet<String>,
) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => {
            let mut result = s.clone();

            // Replace ${inputs.X} with input_map["X"] when possible.
            // We do string-level replacement for simple cases; if the whole
            // string is exactly one reference, we return the mapped value
            // directly (preserving non-string types).
            if let Some(caps) = INPUTS_RE.captures(&result) {
                let full_match = caps.get(0).unwrap().as_str();
                let key = caps.get(1).unwrap().as_str();
                if result == full_match {
                    // The entire string is this one reference — return the
                    // mapped value verbatim (preserving number/bool types).
                    if let Some(mapped) = input_map.get(key) {
                        return mapped.clone();
                    }
                }
            }
            // General case: replace all ${inputs.X} occurrences in the string.
            result = INPUTS_RE
                .replace_all(&result, |caps: &regex::Captures| {
                    let key = caps.get(1).unwrap().as_str();
                    match input_map.get(key) {
                        Some(v) => match v.as_str() {
                            Some(s) => s.to_string(),
                            None => v.to_string(),
                        },
                        None => caps.get(0).unwrap().as_str().to_string(),
                    }
                })
                .into_owned();

            // Rewrite ${nodes.Y.outputs.Z} where Y is an inner node.
            result = NODES_RE
                .replace_all(&result, |caps: &regex::Captures| {
                    let node_id = caps.get(1).unwrap().as_str();
                    let output_key = caps.get(2).unwrap().as_str();
                    if inner_ids.contains(node_id) {
                        format!("${{nodes.{}/{}.outputs.{}}}", prefix, node_id, output_key)
                    } else {
                        caps.get(0).unwrap().as_str().to_string()
                    }
                })
                .into_owned();

            serde_json::Value::String(result)
        }
        serde_json::Value::Object(map) => {
            let new_map = map
                .iter()
                .map(|(k, v)| (k.clone(), rewrite_rewrite_inputs(v, input_map, prefix, inner_ids)))
                .collect();
            serde_json::Value::Object(new_map)
        }
        serde_json::Value::Array(arr) => {
            let new_arr = arr
                .iter()
                .map(|v| rewrite_rewrite_inputs(v, input_map, prefix, inner_ids))
                .collect();
            serde_json::Value::Array(new_arr)
        }
        other => other.clone(),
    }
}

/// Apply a single rewrite rule, injecting the referenced subgraph template
/// into the live template and run state.
///
/// This function is the core mutation point for dynamic graph extension.
/// It is append-only: existing nodes and events are never modified or removed.
pub fn apply_rewrite(
    rule: &RewriteRule,
    source_node_outputs: &serde_json::Value,
    run: &mut GraphRun,
    live_template: &mut GraphTemplate,
    provider: &dyn TemplateProvider,
    limits: &RewriteLimits,
) -> Result<RewriteEvent, EngineError> {
    // Safety: enforce maximum event count.
    if run.rewrite_events.len() >= limits.max_events_per_run {
        return Err(EngineError::Validation {
            reason: format!(
                "Rewrite limit exceeded: max_events_per_run={} already reached",
                limits.max_events_per_run
            ),
        });
    }

    // Look up the subgraph template.
    let sub_template = match &rule.subgraph_version {
        Some(version) => provider.get_template_versioned(&rule.subgraph_template_id, version),
        None => provider.get_template(&rule.subgraph_template_id),
    }
    .ok_or_else(|| EngineError::Validation {
        reason: format!(
            "Rewrite rule '{}': subgraph template '{}' not found",
            rule.rule_id, rule.subgraph_template_id
        ),
    })?;

    // Recursively expand any nested subgraph refs in the fetched template.
    let expanded = expand_subgraphs(&sub_template, provider)?;

    // Safety: enforce maximum nodes per rewrite.
    if expanded.nodes.len() > limits.max_nodes_per_rewrite {
        return Err(EngineError::Validation {
            reason: format!(
                "Rewrite rule '{}': expanded template has {} nodes, exceeds max_nodes_per_rewrite={}",
                rule.rule_id,
                expanded.nodes.len(),
                limits.max_nodes_per_rewrite
            ),
        });
    }

    // Generate a stable event ID.
    let event_id = uuid::Uuid::new_v4().to_string();

    // Determine the application count for prefix generation.
    let prior_count = run
        .rewrite_events
        .iter()
        .filter(|ev| ev.rule_id == rule.rule_id)
        .count();

    let prefix = if prior_count == 0 {
        rule.rule_id.clone()
    } else {
        format!("{}_{}", rule.rule_id, prior_count + 1)
    };

    // Build the set of inner node IDs (original, before prefixing).
    let inner_ids: HashSet<String> = expanded.nodes.iter().map(|n| n.id.clone()).collect();

    // Identify root nodes — those with no depends_on in this subgraph.
    let root_nodes: HashSet<String> = expanded
        .nodes
        .iter()
        .filter(|n| n.depends_on.is_empty())
        .map(|n| n.id.clone())
        .collect();

    let mut injected_node_ids: Vec<String> = Vec::new();

    for mut node in expanded.nodes {
        let original_id = node.id.clone();
        let new_id = format!("{}/{}", prefix, original_id);

        // Rewrite depends_on: prefix inner deps, keep external deps as-is.
        let mut new_depends_on: Vec<NodeId> = node
            .depends_on
            .iter()
            .map(|dep| {
                if inner_ids.contains(dep.as_str()) {
                    format!("{}/{}", prefix, dep)
                } else {
                    dep.clone()
                }
            })
            .collect();

        // Root nodes (no dependencies inside the subgraph) depend on the source node.
        if root_nodes.contains(&original_id) {
            new_depends_on.push(rule.source_node.clone());
        }

        // Rewrite input_bindings references.
        node.input_bindings = rewrite_rewrite_inputs(
            &node.input_bindings,
            &rule.input_map,
            &prefix,
            &inner_ids,
        );

        // Attach rewrite provenance metadata.
        node.metadata.insert(
            "rewrite_event_id".to_string(),
            serde_json::Value::String(event_id.clone()),
        );
        node.metadata.insert(
            "rewrite_rule_id".to_string(),
            serde_json::Value::String(rule.rule_id.clone()),
        );
        node.metadata.insert(
            "rewrite_source_node".to_string(),
            serde_json::Value::String(rule.source_node.clone()),
        );

        node.id = new_id.clone();
        node.depends_on = new_depends_on;

        live_template.nodes.push(node);
        run.node_runs.push(NodeRun::new(new_id.clone()));
        injected_node_ids.push(new_id);
    }

    let event = RewriteEvent {
        event_id,
        rule_id: rule.rule_id.clone(),
        source_node: rule.source_node.clone(),
        trigger_outputs: source_node_outputs.clone(),
        injected_template_id: rule.subgraph_template_id.clone(),
        injected_node_ids,
        applied_at: chrono::Utc::now().to_rfc3339(),
    };

    run.rewrite_events.push(event.clone());
    Ok(event)
}

/// Validate that all rewrite rules in a template are internally consistent.
///
/// Checks:
/// - Each `source_node` exists among `template_nodes`.
/// - `rule_id` and `subgraph_template_id` are non-empty.
/// - No duplicate `rule_id`s.
pub fn validate_rewrite_rules(
    rules: &[RewriteRule],
    template_nodes: &[NodeTemplate],
) -> Result<(), EngineError> {
    let node_ids: HashSet<&str> = template_nodes.iter().map(|n| n.id.as_str()).collect();
    let mut seen_rule_ids: HashSet<&str> = HashSet::new();

    for rule in rules {
        if rule.rule_id.is_empty() {
            return Err(EngineError::Validation {
                reason: "RewriteRule has an empty rule_id".to_string(),
            });
        }
        if rule.subgraph_template_id.is_empty() {
            return Err(EngineError::Validation {
                reason: format!(
                    "RewriteRule '{}' has an empty subgraph_template_id",
                    rule.rule_id
                ),
            });
        }
        if !node_ids.contains(rule.source_node.as_str()) {
            return Err(EngineError::Validation {
                reason: format!(
                    "RewriteRule '{}' references source_node '{}' which does not exist in the template",
                    rule.rule_id, rule.source_node
                ),
            });
        }
        if !seen_rule_ids.insert(rule.rule_id.as_str()) {
            return Err(EngineError::Validation {
                reason: format!("Duplicate rule_id '{}'", rule.rule_id),
            });
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::state::GraphRunStatus;
    use crate::core::types::ExecutionMode;
    use std::collections::HashMap;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    fn make_condition(key: &str, op: ConditionOperator, val: serde_json::Value) -> RewriteCondition {
        RewriteCondition {
            output_key: key.to_string(),
            operator: op,
            value: val,
        }
    }

    fn make_rule(
        rule_id: &str,
        source_node: &str,
        condition: RewriteCondition,
        subgraph_template_id: &str,
    ) -> RewriteRule {
        RewriteRule {
            rule_id: rule_id.to_string(),
            source_node: source_node.to_string(),
            condition,
            subgraph_template_id: subgraph_template_id.to_string(),
            subgraph_version: None,
            input_map: serde_json::json!({}),
            max_applications: 1,
        }
    }

    fn make_node_template(id: &str) -> NodeTemplate {
        NodeTemplate {
            id: id.to_string(),
            tool: "echo".to_string(),
            depends_on: vec![],
            input_bindings: serde_json::json!({}),
            output_spec: None,
            retry_policy: None,
            timeout_seconds: None,
            repair_policy: None,
            execution_mode: ExecutionMode::default(),
            skip_condition: None,
            subgraph: None,
            metadata: Default::default(),
        }
    }

    fn make_graph_template(id: &str, nodes: Vec<NodeTemplate>) -> GraphTemplate {
        GraphTemplate {
            id: id.to_string(),
            version: "1.0".to_string(),
            description: None,
            inputs_schema: serde_json::json!({}),
            nodes,
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        }
    }

    fn make_graph_run(template_id: &str) -> GraphRun {
        GraphRun {
            id: "run-1".to_string(),
            template_id: template_id.to_string(),
            template_version: "1.0".to_string(),
            status: GraphRunStatus::Running,
            inputs: serde_json::json!({}),
            node_runs: vec![],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            run_dir: "/tmp/test".to_string(),
            metadata: Default::default(),
            rewrite_events: vec![],
        }
    }

    struct TestProvider {
        templates: HashMap<String, GraphTemplate>,
    }

    impl TemplateProvider for TestProvider {
        fn get_template(&self, id: &str) -> Option<GraphTemplate> {
            self.templates.get(id).cloned()
        }
    }

    // ------------------------------------------------------------------
    // evaluate_condition
    // ------------------------------------------------------------------

    #[test]
    fn test_evaluate_condition_equal() {
        let cond = make_condition("status", ConditionOperator::Equal, serde_json::json!("done"));
        let outputs = serde_json::json!({ "status": "done" });
        assert!(evaluate_condition(&cond, &outputs));

        let outputs_wrong = serde_json::json!({ "status": "pending" });
        assert!(!evaluate_condition(&cond, &outputs_wrong));

        // Numeric equality
        let cond_num = make_condition("count", ConditionOperator::Equal, serde_json::json!(42));
        let outputs_num = serde_json::json!({ "count": 42 });
        assert!(evaluate_condition(&cond_num, &outputs_num));
    }

    #[test]
    fn test_evaluate_condition_not_equal() {
        let cond = make_condition("state", ConditionOperator::NotEqual, serde_json::json!("failed"));
        let outputs_ok = serde_json::json!({ "state": "success" });
        assert!(evaluate_condition(&cond, &outputs_ok));

        let outputs_fail = serde_json::json!({ "state": "failed" });
        assert!(!evaluate_condition(&cond, &outputs_fail));
    }

    #[test]
    fn test_evaluate_condition_less_than() {
        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let outputs_below = serde_json::json!({ "energy": -2.5 });
        assert!(evaluate_condition(&cond, &outputs_below));

        let outputs_above = serde_json::json!({ "energy": 0.0 });
        assert!(!evaluate_condition(&cond, &outputs_above));

        // Equal to threshold — should be false for strict less-than
        let outputs_equal = serde_json::json!({ "energy": -1.0 });
        assert!(!evaluate_condition(&cond, &outputs_equal));
    }

    #[test]
    fn test_evaluate_condition_greater_than_or_equal() {
        let cond = make_condition("score", ConditionOperator::GreaterThanOrEqual, serde_json::json!(0.9));
        let outputs_high = serde_json::json!({ "score": 0.95 });
        assert!(evaluate_condition(&cond, &outputs_high));

        let outputs_equal = serde_json::json!({ "score": 0.9 });
        assert!(evaluate_condition(&cond, &outputs_equal));

        let outputs_low = serde_json::json!({ "score": 0.5 });
        assert!(!evaluate_condition(&cond, &outputs_low));
    }

    #[test]
    fn test_evaluate_condition_missing_key() {
        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let outputs = serde_json::json!({ "other_key": 42 });
        assert!(!evaluate_condition(&cond, &outputs));
    }

    #[test]
    fn test_evaluate_condition_non_numeric_comparison() {
        // LessThan with string values should return false.
        let cond = make_condition("label", ConditionOperator::LessThan, serde_json::json!("z"));
        let outputs = serde_json::json!({ "label": "a" });
        assert!(!evaluate_condition(&cond, &outputs));
    }

    // ------------------------------------------------------------------
    // check_rewrite_rules
    // ------------------------------------------------------------------

    #[test]
    fn test_check_rewrite_rules_matching() {
        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let rules = vec![make_rule("rule_a", "node_1", cond, "sub_template")];
        let outputs = serde_json::json!({ "energy": -2.0 });
        let fired = check_rewrite_rules(&rules, "node_1", &outputs, &[]);
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].rule_id, "rule_a");
    }

    #[test]
    fn test_check_rewrite_rules_no_match() {
        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let rules = vec![make_rule("rule_a", "node_1", cond, "sub_template")];
        let outputs = serde_json::json!({ "energy": 0.5 });
        let fired = check_rewrite_rules(&rules, "node_1", &outputs, &[]);
        assert_eq!(fired.len(), 0);
    }

    #[test]
    fn test_check_rewrite_rules_already_applied() {
        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let rules = vec![make_rule("rule_a", "node_1", cond, "sub_template")];
        let existing = vec![RewriteEvent {
            event_id: "ev-1".to_string(),
            rule_id: "rule_a".to_string(),
            source_node: "node_1".to_string(),
            trigger_outputs: serde_json::json!({}),
            injected_template_id: "sub_template".to_string(),
            injected_node_ids: vec![],
            applied_at: "2024-01-01T00:00:00Z".to_string(),
        }];
        let outputs = serde_json::json!({ "energy": -2.0 });
        let fired = check_rewrite_rules(&rules, "node_1", &outputs, &existing);
        // max_applications=1 and it has been applied once — should NOT fire
        assert_eq!(fired.len(), 0);
    }

    #[test]
    fn test_check_rewrite_rules_wrong_source_node() {
        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let rules = vec![make_rule("rule_a", "node_1", cond, "sub_template")];
        let outputs = serde_json::json!({ "energy": -2.0 });
        // Different source node — rule must not fire.
        let fired = check_rewrite_rules(&rules, "node_2", &outputs, &[]);
        assert_eq!(fired.len(), 0);
    }

    // ------------------------------------------------------------------
    // validate_rewrite_rules
    // ------------------------------------------------------------------

    #[test]
    fn test_validate_rewrite_rules_valid() {
        let nodes = vec![make_node_template("node_a")];
        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let rule = make_rule("rule_1", "node_a", cond, "tmpl");
        assert!(validate_rewrite_rules(&[rule], &nodes).is_ok());
    }

    #[test]
    fn test_validate_rewrite_rules_missing_source_node() {
        let nodes = vec![make_node_template("node_a")];
        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let rule = make_rule("rule_1", "node_missing", cond, "tmpl");
        let result = validate_rewrite_rules(&[rule], &nodes);
        assert!(result.is_err());
        let msg = format!("{:?}", result.unwrap_err());
        assert!(msg.contains("node_missing"));
    }

    #[test]
    fn test_validate_rewrite_rules_empty_rule_id() {
        let nodes = vec![make_node_template("node_a")];
        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let rule = make_rule("", "node_a", cond, "tmpl");
        let result = validate_rewrite_rules(&[rule], &nodes);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_rewrite_rules_duplicate_rule_id() {
        let nodes = vec![make_node_template("node_a")];
        let cond1 = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let cond2 = make_condition("score", ConditionOperator::GreaterThan, serde_json::json!(0.9));
        let rule1 = make_rule("rule_dup", "node_a", cond1, "tmpl_a");
        let rule2 = make_rule("rule_dup", "node_a", cond2, "tmpl_b");
        let result = validate_rewrite_rules(&[rule1, rule2], &nodes);
        assert!(result.is_err());
        let msg = format!("{:?}", result.unwrap_err());
        assert!(msg.contains("rule_dup"));
    }

    // ------------------------------------------------------------------
    // apply_rewrite
    // ------------------------------------------------------------------

    fn make_test_provider(id: &str, nodes: Vec<NodeTemplate>) -> TestProvider {
        let tmpl = make_graph_template(id, nodes);
        let mut templates = HashMap::new();
        templates.insert(id.to_string(), tmpl);
        TestProvider { templates }
    }

    #[test]
    fn test_apply_rewrite_basic() {
        let sub_node_a = make_node_template("step_a");
        let mut sub_node_b = make_node_template("step_b");
        sub_node_b.depends_on = vec!["step_a".to_string()];

        let provider = make_test_provider("sub_tmpl", vec![sub_node_a, sub_node_b]);

        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let rule = make_rule("rule_x", "source_node", cond, "sub_tmpl");

        let mut live_template = make_graph_template("main", vec![make_node_template("source_node")]);
        let mut run = make_graph_run("main");
        let limits = RewriteLimits::default();

        let outputs = serde_json::json!({ "energy": -2.0 });
        let event = apply_rewrite(&rule, &outputs, &mut run, &mut live_template, &provider, &limits)
            .expect("apply_rewrite should succeed");

        // The event should record the two injected nodes.
        assert_eq!(event.rule_id, "rule_x");
        assert_eq!(event.source_node, "source_node");
        assert_eq!(event.injected_node_ids.len(), 2);

        // Node IDs should be prefixed with the rule_id.
        let ids: HashSet<&str> = event.injected_node_ids.iter().map(|s| s.as_str()).collect();
        assert!(ids.contains("rule_x/step_a"));
        assert!(ids.contains("rule_x/step_b"));

        // live_template should now have 3 nodes total (source + 2 injected).
        assert_eq!(live_template.nodes.len(), 3);

        // The root node (step_a) must depend on source_node.
        let injected_a = live_template.nodes.iter().find(|n| n.id == "rule_x/step_a").unwrap();
        assert!(injected_a.depends_on.contains(&"source_node".to_string()));

        // step_b must depend on the prefixed step_a.
        let injected_b = live_template.nodes.iter().find(|n| n.id == "rule_x/step_b").unwrap();
        assert!(injected_b.depends_on.contains(&"rule_x/step_a".to_string()));

        // Metadata must be set on both injected nodes.
        for node in live_template.nodes.iter().filter(|n| n.id.starts_with("rule_x/")) {
            assert_eq!(
                node.metadata.get("rewrite_rule_id"),
                Some(&serde_json::Value::String("rule_x".to_string()))
            );
            assert_eq!(
                node.metadata.get("rewrite_source_node"),
                Some(&serde_json::Value::String("source_node".to_string()))
            );
        }

        // The event must have been appended to the run.
        assert_eq!(run.rewrite_events.len(), 1);
        // Two new NodeRuns must have been appended.
        assert_eq!(run.node_runs.len(), 2);
    }

    #[test]
    fn test_apply_rewrite_idempotent_prefix() {
        let sub_node = make_node_template("step_a");
        let provider = make_test_provider("sub_tmpl", vec![sub_node]);

        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let mut rule = make_rule("rule_x", "source_node", cond, "sub_tmpl");
        rule.max_applications = 3;

        let mut live_template = make_graph_template("main", vec![make_node_template("source_node")]);
        let mut run = make_graph_run("main");
        let limits = RewriteLimits::default();

        let outputs = serde_json::json!({ "energy": -2.0 });

        // First application — prefix should be "rule_x"
        let ev1 = apply_rewrite(&rule, &outputs, &mut run, &mut live_template, &provider, &limits)
            .expect("first apply should succeed");
        assert!(ev1.injected_node_ids.iter().any(|id| id == "rule_x/step_a"));

        // Second application — prefix should be "rule_x_2"
        let ev2 = apply_rewrite(&rule, &outputs, &mut run, &mut live_template, &provider, &limits)
            .expect("second apply should succeed");
        assert!(ev2.injected_node_ids.iter().any(|id| id == "rule_x_2/step_a"));

        assert_eq!(run.rewrite_events.len(), 2);
    }

    #[test]
    fn test_apply_rewrite_limits_exceeded() {
        let sub_node = make_node_template("step_a");
        let provider = make_test_provider("sub_tmpl", vec![sub_node]);

        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let mut rule = make_rule("rule_x", "source_node", cond, "sub_tmpl");
        rule.max_applications = 99;

        let mut live_template = make_graph_template("main", vec![make_node_template("source_node")]);
        let mut run = make_graph_run("main");
        let limits = RewriteLimits { max_events_per_run: 2, max_nodes_per_rewrite: 50 };

        let outputs = serde_json::json!({ "energy": -2.0 });

        apply_rewrite(&rule, &outputs, &mut run, &mut live_template, &provider, &limits)
            .expect("first apply should succeed");
        apply_rewrite(&rule, &outputs, &mut run, &mut live_template, &provider, &limits)
            .expect("second apply should succeed");

        // Third application should fail — limit is 2.
        let result = apply_rewrite(&rule, &outputs, &mut run, &mut live_template, &provider, &limits);
        assert!(result.is_err());
        let msg = format!("{:?}", result.unwrap_err());
        assert!(msg.contains("max_events_per_run"));
    }

    #[test]
    fn test_apply_rewrite_input_rewriting() {
        let mut sub_node = make_node_template("step_a");
        sub_node.input_bindings = serde_json::json!({
            "threshold": "${inputs.threshold}",
            "ref_energy": "${inputs.ref_energy}"
        });

        let provider = make_test_provider("sub_tmpl", vec![sub_node]);

        let cond = make_condition("energy", ConditionOperator::LessThan, serde_json::json!(-1.0));
        let mut rule = make_rule("rule_x", "source_node", cond, "sub_tmpl");
        rule.input_map = serde_json::json!({
            "threshold": -0.5,
            "ref_energy": "${nodes.source_node.outputs.energy}"
        });

        let mut live_template = make_graph_template("main", vec![make_node_template("source_node")]);
        let mut run = make_graph_run("main");
        let limits = RewriteLimits::default();

        let outputs = serde_json::json!({ "energy": -2.0 });
        apply_rewrite(&rule, &outputs, &mut run, &mut live_template, &provider, &limits)
            .expect("apply_rewrite should succeed");

        let injected = live_template.nodes.iter().find(|n| n.id == "rule_x/step_a").unwrap();
        // ${inputs.threshold} should be replaced by the numeric value -0.5
        assert_eq!(injected.input_bindings["threshold"], serde_json::json!(-0.5));
        // ${inputs.ref_energy} is mapped to a string expression (external node — not rewritten)
        assert_eq!(
            injected.input_bindings["ref_energy"],
            serde_json::json!("${nodes.source_node.outputs.energy}")
        );
    }
}
