use std::collections::{HashSet, VecDeque};

use crate::core::ids::NodeId;
use crate::core::state::{GraphRunStatus, NodeStatus};
use crate::graph::run::GraphRun;
use crate::graph::template::{GraphTemplate, NodeTemplate};

/// Find all nodes in `Pending` state whose dependencies are all `Succeeded`.
pub fn find_ready_nodes(run: &GraphRun, template: &GraphTemplate) -> Vec<NodeId> {
    let mut ready = Vec::new();

    for node_run in &run.node_runs {
        if node_run.status != NodeStatus::Pending {
            continue;
        }

        // Find the corresponding NodeTemplate
        let node_tmpl = match template.nodes.iter().find(|n| n.id == node_run.node_id) {
            Some(t) => t,
            None => continue,
        };

        // Check all dependencies
        let all_deps_succeeded = node_tmpl.depends_on.iter().all(|dep_id| {
            run.node_run(dep_id)
                .map(|nr| nr.status == NodeStatus::Succeeded)
                .unwrap_or(false)
        });

        if all_deps_succeeded {
            ready.push(node_run.node_id.clone());
        }
    }

    ready
}

/// Propagate failure: mark all downstream `Pending`/`Ready` nodes as `Blocked`.
///
/// Uses BFS from `failed_node` through forward dependency edges.
pub fn propagate_failure(run: &mut GraphRun, failed_node: &NodeId, template: &GraphTemplate) {
    // Build forward adjacency: for each node, which nodes depend on it?
    let mut forward: std::collections::HashMap<&str, Vec<&str>> =
        std::collections::HashMap::new();
    for node in &template.nodes {
        for dep in &node.depends_on {
            forward
                .entry(dep.as_str())
                .or_default()
                .push(node.id.as_str());
        }
    }

    // BFS from failed_node
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back(failed_node.clone());
    visited.insert(failed_node.clone());

    while let Some(current) = queue.pop_front() {
        if let Some(downstream) = forward.get(current.as_str()) {
            for &next in downstream {
                if visited.insert(next.to_string()) {
                    queue.push_back(next.to_string());
                }
            }
        }
    }

    // Mark reachable Pending/Ready nodes as Blocked (skip the failed node itself)
    for node_run in &mut run.node_runs {
        if node_run.node_id == *failed_node {
            continue;
        }
        if visited.contains(&node_run.node_id)
            && (node_run.status == NodeStatus::Pending || node_run.status == NodeStatus::Ready)
        {
            node_run.status = NodeStatus::Blocked;
            node_run.finished_at = Some(crate::core::time::now());
        }
    }
}

/// Check if all nodes are in terminal states.
pub fn is_terminal(run: &GraphRun) -> bool {
    run.node_runs.iter().all(|n| n.status.is_terminal())
}

/// Determine the final `GraphRunStatus` from node states.
pub fn determine_run_status(run: &GraphRun) -> GraphRunStatus {
    let all_succeeded = run
        .node_runs
        .iter()
        .all(|n| n.status == NodeStatus::Succeeded);
    let any_succeeded = run
        .node_runs
        .iter()
        .any(|n| n.status == NodeStatus::Succeeded);
    let any_cancelled = run
        .node_runs
        .iter()
        .any(|n| n.status == NodeStatus::Cancelled);

    if all_succeeded {
        GraphRunStatus::Succeeded
    } else if any_cancelled && !any_succeeded {
        GraphRunStatus::Cancelled
    } else if any_succeeded {
        GraphRunStatus::PartiallySucceeded
    } else {
        GraphRunStatus::Failed
    }
}

/// Check if a node should be skipped based on its `skip_condition`.
///
/// Returns `true` if the node has a skip_condition and the resolved expression
/// value equals the condition's `equals` value.
fn should_skip(run: &GraphRun, node_tmpl: &NodeTemplate) -> bool {
    if let Some(condition) = &node_tmpl.skip_condition {
        if let Some(value) = resolve_skip_expression(run, &condition.expression) {
            return value == condition.equals;
        }
    }
    false
}

/// Resolve a `${nodes.X.outputs.Y}` expression against the current run state.
///
/// Returns `None` if the expression doesn't match the expected pattern, or
/// if the referenced node/output doesn't exist.
fn resolve_skip_expression(run: &GraphRun, expression: &str) -> Option<serde_json::Value> {
    let re = regex::Regex::new(r"^\$\{nodes\.([^.]+)\.outputs\.([^}]+)\}$").ok()?;
    let caps = re.captures(expression)?;
    let node_id = caps.get(1)?.as_str();
    let output_key = caps.get(2)?.as_str();

    let node_run = run.node_run(node_id)?;
    let outputs = node_run.outputs.as_ref()?;
    outputs.get(output_key).cloned()
}

/// Evaluate skip conditions for all pending nodes whose dependencies have all succeeded.
///
/// Nodes that match their skip_condition are transitioned from Pending -> Skipped,
/// and failure is propagated to their downstream nodes (marking them as Blocked).
///
/// This must be called before `find_ready_nodes` in the execution loop so that
/// skipped nodes are never returned as ready.
pub fn process_skip_conditions(run: &mut GraphRun, template: &GraphTemplate) {
    // Collect node IDs that should be skipped (immutable pass)
    let to_skip: Vec<NodeId> = run
        .node_runs
        .iter()
        .filter(|nr| nr.status == NodeStatus::Pending)
        .filter_map(|nr| {
            let node_tmpl = template.nodes.iter().find(|n| n.id == nr.node_id)?;
            // Check all deps succeeded
            let all_deps_succeeded = node_tmpl.depends_on.iter().all(|dep_id| {
                run.node_run(dep_id)
                    .map(|dep| dep.status == NodeStatus::Succeeded)
                    .unwrap_or(false)
            });
            if all_deps_succeeded && should_skip(run, node_tmpl) {
                Some(nr.node_id.clone())
            } else {
                None
            }
        })
        .collect();

    // Mark each as Skipped and propagate (mutable pass)
    for node_id in &to_skip {
        if let Some(nr) = run.node_run_mut(node_id) {
            nr.status = NodeStatus::Skipped;
            nr.finished_at = Some(crate::core::time::now());
        }
        propagate_failure(run, node_id, template);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::state::{GraphRunStatus, NodeStatus};
    use crate::graph::run::{GraphRun, NodeRun};
    use crate::graph::template::{GraphTemplate, NodeTemplate};
    use chrono::Utc;

    fn make_template(nodes: Vec<(&str, Vec<&str>)>) -> GraphTemplate {
        GraphTemplate {
            id: "test".to_string(),
            version: "1.0".to_string(),
            description: None,
            inputs_schema: serde_json::json!({}),
            nodes: nodes
                .into_iter()
                .map(|(id, deps)| NodeTemplate {
                    id: id.to_string(),
                    tool: "echo".to_string(),
                    depends_on: deps.into_iter().map(|s| s.to_string()).collect(),
                    input_bindings: serde_json::json!({}),
                    output_spec: None,
                    retry_policy: None,
                    timeout_seconds: None,
                    repair_policy: None,
                    execution_mode: Default::default(),
                    skip_condition: None,
                    subgraph: None,
                    metadata: Default::default(),
                })
                .collect(),
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        }
    }

    fn make_run(nodes: Vec<(&str, NodeStatus)>) -> GraphRun {
        let now = Utc::now();
        GraphRun {
            id: "run-1".to_string(),
            template_id: "test".to_string(),
            template_version: "1.0".to_string(),
            status: GraphRunStatus::Running,
            inputs: serde_json::json!({}),
            node_runs: nodes
                .into_iter()
                .map(|(id, status)| {
                    let mut nr = NodeRun::new(id.to_string());
                    nr.status = status;
                    nr
                })
                .collect(),
            created_at: now,
            updated_at: now,
            run_dir: "/tmp/test".to_string(),
            metadata: Default::default(),
            rewrite_events: vec![],
        }
    }

    #[test]
    fn test_find_ready_no_deps() {
        // All nodes have no deps and are Pending -> all should be ready
        let template = make_template(vec![("a", vec![]), ("b", vec![]), ("c", vec![])]);
        let run = make_run(vec![
            ("a", NodeStatus::Pending),
            ("b", NodeStatus::Pending),
            ("c", NodeStatus::Pending),
        ]);
        let ready = find_ready_nodes(&run, &template);
        assert_eq!(ready.len(), 3);
    }

    #[test]
    fn test_find_ready_with_deps() {
        // a -> b -> c: only a should be ready initially
        let template = make_template(vec![("a", vec![]), ("b", vec!["a"]), ("c", vec!["b"])]);
        let run = make_run(vec![
            ("a", NodeStatus::Pending),
            ("b", NodeStatus::Pending),
            ("c", NodeStatus::Pending),
        ]);
        let ready = find_ready_nodes(&run, &template);
        assert_eq!(ready, vec!["a"]);
    }

    #[test]
    fn test_find_ready_after_a_succeeds() {
        let template = make_template(vec![("a", vec![]), ("b", vec!["a"]), ("c", vec!["b"])]);
        let run = make_run(vec![
            ("a", NodeStatus::Succeeded),
            ("b", NodeStatus::Pending),
            ("c", NodeStatus::Pending),
        ]);
        let ready = find_ready_nodes(&run, &template);
        assert_eq!(ready, vec!["b"]);
    }

    #[test]
    fn test_find_ready_diamond() {
        // a -> b, a -> c, b+c -> d
        let template = make_template(vec![
            ("a", vec![]),
            ("b", vec!["a"]),
            ("c", vec!["a"]),
            ("d", vec!["b", "c"]),
        ]);
        let run = make_run(vec![
            ("a", NodeStatus::Succeeded),
            ("b", NodeStatus::Succeeded),
            ("c", NodeStatus::Pending),
            ("d", NodeStatus::Pending),
        ]);
        let ready = find_ready_nodes(&run, &template);
        // c is ready (a succeeded), d is not ready (c not succeeded)
        assert_eq!(ready, vec!["c"]);
    }

    #[test]
    fn test_propagate_failure_linear() {
        // a -> b -> c: if b fails, c should be blocked
        let template = make_template(vec![("a", vec![]), ("b", vec!["a"]), ("c", vec!["b"])]);
        let mut run = make_run(vec![
            ("a", NodeStatus::Succeeded),
            ("b", NodeStatus::Failed),
            ("c", NodeStatus::Pending),
        ]);
        propagate_failure(&mut run, &"b".to_string(), &template);
        assert_eq!(run.node_run("c").unwrap().status, NodeStatus::Blocked);
    }

    #[test]
    fn test_propagate_failure_diamond() {
        // a -> b, a -> c, b+c -> d: if b fails, d should be blocked but c should not
        let template = make_template(vec![
            ("a", vec![]),
            ("b", vec!["a"]),
            ("c", vec!["a"]),
            ("d", vec!["b", "c"]),
        ]);
        let mut run = make_run(vec![
            ("a", NodeStatus::Succeeded),
            ("b", NodeStatus::Failed),
            ("c", NodeStatus::Pending),
            ("d", NodeStatus::Pending),
        ]);
        propagate_failure(&mut run, &"b".to_string(), &template);
        assert_eq!(run.node_run("c").unwrap().status, NodeStatus::Pending);
        assert_eq!(run.node_run("d").unwrap().status, NodeStatus::Blocked);
    }

    #[test]
    fn test_is_terminal_all_succeeded() {
        let run = make_run(vec![
            ("a", NodeStatus::Succeeded),
            ("b", NodeStatus::Succeeded),
        ]);
        assert!(is_terminal(&run));
    }

    #[test]
    fn test_is_terminal_mixed() {
        let run = make_run(vec![
            ("a", NodeStatus::Succeeded),
            ("b", NodeStatus::Running),
        ]);
        assert!(!is_terminal(&run));
    }

    #[test]
    fn test_is_terminal_all_terminal_mixed() {
        let run = make_run(vec![
            ("a", NodeStatus::Succeeded),
            ("b", NodeStatus::Failed),
            ("c", NodeStatus::Blocked),
        ]);
        assert!(is_terminal(&run));
    }

    #[test]
    fn test_determine_run_status_all_succeeded() {
        let run = make_run(vec![
            ("a", NodeStatus::Succeeded),
            ("b", NodeStatus::Succeeded),
        ]);
        assert_eq!(determine_run_status(&run), GraphRunStatus::Succeeded);
    }

    #[test]
    fn test_determine_run_status_partial() {
        let run = make_run(vec![
            ("a", NodeStatus::Succeeded),
            ("b", NodeStatus::Failed),
        ]);
        assert_eq!(
            determine_run_status(&run),
            GraphRunStatus::PartiallySucceeded
        );
    }

    #[test]
    fn test_determine_run_status_all_failed() {
        let run = make_run(vec![
            ("a", NodeStatus::Failed),
            ("b", NodeStatus::Blocked),
        ]);
        assert_eq!(determine_run_status(&run), GraphRunStatus::Failed);
    }

    #[test]
    fn test_find_ready_blocked_deps() {
        // a -> b: a is Blocked, so b should NOT be ready
        let template = make_template(vec![("a", vec![]), ("b", vec!["a"])]);
        let run = make_run(vec![
            ("a", NodeStatus::Blocked),
            ("b", NodeStatus::Pending),
        ]);
        let ready = find_ready_nodes(&run, &template);
        assert!(
            ready.is_empty(),
            "b should not be ready when its dependency a is Blocked, got: {:?}",
            ready
        );
    }

    #[test]
    fn test_find_ready_skipped_deps() {
        // a -> b: a is Skipped, so b should NOT be ready
        // (only Succeeded deps unlock downstream nodes)
        let template = make_template(vec![("a", vec![]), ("b", vec!["a"])]);
        let run = make_run(vec![
            ("a", NodeStatus::Skipped),
            ("b", NodeStatus::Pending),
        ]);
        let ready = find_ready_nodes(&run, &template);
        assert!(
            ready.is_empty(),
            "b should not be ready when its dependency a is Skipped, got: {:?}",
            ready
        );
    }

    #[test]
    fn test_determine_run_status_all_cancelled() {
        // All nodes are Cancelled, no Succeeded nodes -> Failed
        let run = make_run(vec![
            ("a", NodeStatus::Cancelled),
            ("b", NodeStatus::Cancelled),
            ("c", NodeStatus::Cancelled),
        ]);
        let status = determine_run_status(&run);
        assert_eq!(
            status,
            GraphRunStatus::Cancelled,
            "All Cancelled nodes should produce Cancelled status"
        );
    }

    #[test]
    fn test_determine_run_status_with_skipped() {
        // Mix of Succeeded and Skipped -> PartiallySucceeded
        // (not all_succeeded because Skipped != Succeeded, but any_succeeded is true)
        let run = make_run(vec![
            ("a", NodeStatus::Succeeded),
            ("b", NodeStatus::Skipped),
            ("c", NodeStatus::Succeeded),
        ]);
        let status = determine_run_status(&run);
        assert_eq!(
            status,
            GraphRunStatus::PartiallySucceeded,
            "Mix of Succeeded and Skipped should produce PartiallySucceeded"
        );
    }

    #[test]
    fn test_propagate_failure_deep_chain() {
        // a -> b -> c -> d -> e: a fails, all downstream (b, c, d, e) become Blocked
        let template = make_template(vec![
            ("a", vec![]),
            ("b", vec!["a"]),
            ("c", vec!["b"]),
            ("d", vec!["c"]),
            ("e", vec!["d"]),
        ]);
        let mut run = make_run(vec![
            ("a", NodeStatus::Failed),
            ("b", NodeStatus::Pending),
            ("c", NodeStatus::Pending),
            ("d", NodeStatus::Pending),
            ("e", NodeStatus::Pending),
        ]);
        propagate_failure(&mut run, &"a".to_string(), &template);

        assert_eq!(run.node_run("a").unwrap().status, NodeStatus::Failed);
        assert_eq!(run.node_run("b").unwrap().status, NodeStatus::Blocked);
        assert_eq!(run.node_run("c").unwrap().status, NodeStatus::Blocked);
        assert_eq!(run.node_run("d").unwrap().status, NodeStatus::Blocked);
        assert_eq!(run.node_run("e").unwrap().status, NodeStatus::Blocked);

        // All blocked nodes should have finished_at set
        assert!(run.node_run("b").unwrap().finished_at.is_some());
        assert!(run.node_run("c").unwrap().finished_at.is_some());
        assert!(run.node_run("d").unwrap().finished_at.is_some());
        assert!(run.node_run("e").unwrap().finished_at.is_some());
    }

    #[test]
    fn test_no_duplicate_ready_nodes() {
        // Call find_ready_nodes twice on the same state, should get identical results
        let template = make_template(vec![
            ("a", vec![]),
            ("b", vec![]),
            ("c", vec!["a", "b"]),
        ]);
        let run = make_run(vec![
            ("a", NodeStatus::Pending),
            ("b", NodeStatus::Pending),
            ("c", NodeStatus::Pending),
        ]);

        let ready1 = find_ready_nodes(&run, &template);
        let ready2 = find_ready_nodes(&run, &template);

        assert_eq!(ready1, ready2, "Two calls should produce identical results");

        // Also verify there are no duplicates within a single call
        let mut seen = HashSet::new();
        for node_id in &ready1 {
            assert!(
                seen.insert(node_id.clone()),
                "Duplicate ready node found: {}",
                node_id
            );
        }
    }

    // ========================================================================
    // Skip Condition Tests
    // ========================================================================

    use crate::graph::template::SkipCondition;

    /// Helper: create a template where a specific node has a skip_condition.
    fn make_template_with_skip(
        nodes: Vec<(&str, Vec<&str>)>,
        skip_node: &str,
        skip_condition: SkipCondition,
    ) -> GraphTemplate {
        GraphTemplate {
            id: "test".to_string(),
            version: "1.0".to_string(),
            description: None,
            inputs_schema: serde_json::json!({}),
            nodes: nodes
                .into_iter()
                .map(|(id, deps)| NodeTemplate {
                    id: id.to_string(),
                    tool: "echo".to_string(),
                    depends_on: deps.into_iter().map(|s| s.to_string()).collect(),
                    input_bindings: serde_json::json!({}),
                    output_spec: None,
                    retry_policy: None,
                    timeout_seconds: None,
                    repair_policy: None,
                    execution_mode: Default::default(),
                    skip_condition: if id == skip_node {
                        Some(skip_condition.clone())
                    } else {
                        None
                    },
                    subgraph: None,
                    metadata: Default::default(),
                })
                .collect(),
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        }
    }

    /// Helper: create a run where a specific node has outputs set.
    fn make_run_with_outputs(
        nodes: Vec<(&str, NodeStatus)>,
        output_node: &str,
        outputs: serde_json::Value,
    ) -> GraphRun {
        let now = Utc::now();
        GraphRun {
            id: "run-1".to_string(),
            template_id: "test".to_string(),
            template_version: "1.0".to_string(),
            status: GraphRunStatus::Running,
            inputs: serde_json::json!({}),
            node_runs: nodes
                .into_iter()
                .map(|(id, status)| {
                    let mut nr = NodeRun::new(id.to_string());
                    nr.status = status;
                    if id == output_node {
                        nr.outputs = Some(outputs.clone());
                    }
                    nr
                })
                .collect(),
            created_at: now,
            updated_at: now,
            run_dir: "/tmp/test".to_string(),
            metadata: Default::default(),
            rewrite_events: vec![],
        }
    }

    #[test]
    fn test_skip_condition_matches() {
        // a -> b: a succeeded with converged=false.
        // b has skip_condition: skip when ${nodes.a.outputs.converged} == false
        // After process_skip_conditions, b should be Skipped and NOT in ready list.
        let condition = SkipCondition {
            expression: "${nodes.a.outputs.converged}".to_string(),
            equals: serde_json::json!(false),
        };
        let template = make_template_with_skip(
            vec![("a", vec![]), ("b", vec!["a"])],
            "b",
            condition,
        );
        let mut run = make_run_with_outputs(
            vec![("a", NodeStatus::Succeeded), ("b", NodeStatus::Pending)],
            "a",
            serde_json::json!({"converged": false}),
        );

        // Process skip conditions
        process_skip_conditions(&mut run, &template);

        // b should now be Skipped
        assert_eq!(
            run.node_run("b").unwrap().status,
            NodeStatus::Skipped,
            "Node b should be Skipped when skip_condition matches"
        );
        assert!(
            run.node_run("b").unwrap().finished_at.is_some(),
            "Skipped node should have finished_at set"
        );

        // b should not appear in ready list
        let ready = find_ready_nodes(&run, &template);
        assert!(
            ready.is_empty(),
            "Skipped node should not appear in ready list, got: {:?}",
            ready
        );
    }

    #[test]
    fn test_skip_condition_no_match() {
        // a -> b: a succeeded with converged=true.
        // b has skip_condition: skip when ${nodes.a.outputs.converged} == false
        // Since converged=true != false, b should NOT be skipped and should appear in ready list.
        let condition = SkipCondition {
            expression: "${nodes.a.outputs.converged}".to_string(),
            equals: serde_json::json!(false),
        };
        let template = make_template_with_skip(
            vec![("a", vec![]), ("b", vec!["a"])],
            "b",
            condition,
        );
        let mut run = make_run_with_outputs(
            vec![("a", NodeStatus::Succeeded), ("b", NodeStatus::Pending)],
            "a",
            serde_json::json!({"converged": true}),
        );

        // Process skip conditions — should not skip b
        process_skip_conditions(&mut run, &template);

        // b should still be Pending
        assert_eq!(
            run.node_run("b").unwrap().status,
            NodeStatus::Pending,
            "Node b should remain Pending when skip_condition does not match"
        );

        // b should appear in ready list
        let ready = find_ready_nodes(&run, &template);
        assert_eq!(
            ready,
            vec!["b"],
            "Node b should appear in ready list when skip_condition does not match"
        );
    }

    #[test]
    fn test_skip_condition_propagates() {
        // a -> b -> c: a succeeded with converged=false.
        // b has skip_condition: skip when ${nodes.a.outputs.converged} == false
        // After process_skip_conditions, b is Skipped, c should be Blocked
        // (because c depends on b, and b is Skipped, not Succeeded).
        let condition = SkipCondition {
            expression: "${nodes.a.outputs.converged}".to_string(),
            equals: serde_json::json!(false),
        };
        let template = make_template_with_skip(
            vec![("a", vec![]), ("b", vec!["a"]), ("c", vec!["b"])],
            "b",
            condition,
        );
        let mut run = make_run_with_outputs(
            vec![
                ("a", NodeStatus::Succeeded),
                ("b", NodeStatus::Pending),
                ("c", NodeStatus::Pending),
            ],
            "a",
            serde_json::json!({"converged": false}),
        );

        // Process skip conditions
        process_skip_conditions(&mut run, &template);

        // b should be Skipped
        assert_eq!(
            run.node_run("b").unwrap().status,
            NodeStatus::Skipped,
            "Node b should be Skipped"
        );

        // c should be Blocked (propagated from b's skip)
        assert_eq!(
            run.node_run("c").unwrap().status,
            NodeStatus::Blocked,
            "Node c should be Blocked because its dependency b was Skipped"
        );

        // Neither b nor c should appear in ready list
        let ready = find_ready_nodes(&run, &template);
        assert!(
            ready.is_empty(),
            "No nodes should be ready after skip propagation, got: {:?}",
            ready
        );
    }
}
