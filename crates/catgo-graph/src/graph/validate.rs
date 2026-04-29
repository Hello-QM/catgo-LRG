use std::collections::{HashMap, HashSet};

use crate::core::EngineError;
use crate::graph::template::{GraphTemplate, NodeTemplate};

/// Validate a graph template for structural correctness.
///
/// Checks performed:
/// 1. Template ID is non-empty
/// 2. All node IDs are unique
/// 3. All `depends_on` references point to existing node IDs
/// 4. No self-dependencies
/// 5. No cycles (DFS-based detection with white/gray/black coloring)
/// 6. All graph output `from_node` references are valid
pub fn validate_template(template: &GraphTemplate) -> Result<(), EngineError> {
    // 1. Template ID must be non-empty
    if template.id.trim().is_empty() {
        return Err(EngineError::Validation {
            reason: "Template ID must not be empty".into(),
        });
    }

    // Build a set of all node IDs for lookup
    let mut node_ids: HashSet<&str> = HashSet::new();

    // 2. All node IDs must be unique
    for node in &template.nodes {
        if !node_ids.insert(&node.id) {
            return Err(EngineError::Validation {
                reason: format!("Duplicate node ID: '{}'", node.id),
            });
        }
    }

    for node in &template.nodes {
        for dep in &node.depends_on {
            // 4. No self-dependencies
            if dep == &node.id {
                return Err(EngineError::Validation {
                    reason: format!(
                        "Node '{}' has a self-dependency",
                        node.id
                    ),
                });
            }

            // 3. All depends_on references must point to existing nodes
            if !node_ids.contains(dep.as_str()) {
                return Err(EngineError::Validation {
                    reason: format!(
                        "Node '{}' depends on '{}', which does not exist",
                        node.id, dep
                    ),
                });
            }
        }
    }

    // 4.5. Each node must have exactly one of: non-empty tool name, or subgraph reference
    for node in &template.nodes {
        let has_tool = !node.tool.is_empty();
        let has_subgraph = node.subgraph.is_some();

        match (has_tool, has_subgraph) {
            (true, true) => {
                return Err(EngineError::Validation {
                    reason: format!(
                        "Node '{}' has both a tool ('{}') and a subgraph reference — only one is allowed",
                        node.id, node.tool
                    ),
                });
            }
            (false, false) => {
                return Err(EngineError::Validation {
                    reason: format!(
                        "Node '{}' has neither a tool nor a subgraph reference — one must be set",
                        node.id
                    ),
                });
            }
            _ => {} // Valid: exactly one is set
        }
    }

    // 5. Cycle detection
    if let Some(cycle_nodes) = detect_cycle(&template.nodes) {
        return Err(EngineError::CycleDetected { nodes: cycle_nodes });
    }

    // 6. Validate graph output source references
    for output in &template.outputs {
        // Extract node ID from source expression like "${nodes.evaluate_oer.outputs.overpotential}"
        if let Some(node_ref) = extract_node_ref(&output.source) {
            if !node_ids.contains(node_ref.as_str()) {
                return Err(EngineError::Validation {
                    reason: format!(
                        "Graph output '{}' references non-existent node '{}'",
                        output.name, node_ref
                    ),
                });
            }
        }
    }

    Ok(())
}

/// Extract node ID from a source expression like "${nodes.some_node.outputs.key}"
fn extract_node_ref(source: &str) -> Option<String> {
    let trimmed = source.trim();
    let inner = trimmed.strip_prefix("${")?.strip_suffix('}')?;
    let parts: Vec<&str> = inner.splitn(4, '.').collect();
    if parts.len() >= 2 && parts[0] == "nodes" {
        Some(parts[1].to_string())
    } else {
        None
    }
}

/// Detect cycles using DFS with white/gray/black coloring.
///
/// Node coloring:
/// - White (0): unvisited
/// - Gray  (1): currently on the DFS stack (in progress)
/// - Black (2): fully explored, no cycles through this node
///
/// Returns `Some(cycle_nodes)` with the node IDs forming the cycle if one is
/// found, or `None` if the graph is acyclic.
fn detect_cycle(nodes: &[NodeTemplate]) -> Option<Vec<String>> {
    const WHITE: u8 = 0;

    // Build adjacency list: node_id -> list of dependencies
    let adj: HashMap<&str, Vec<&str>> = nodes
        .iter()
        .map(|n| (n.id.as_str(), n.depends_on.iter().map(|d| d.as_str()).collect()))
        .collect();

    let mut color: HashMap<&str, u8> = nodes.iter().map(|n| (n.id.as_str(), WHITE)).collect();
    // Track the DFS path for cycle reporting
    let mut path: Vec<&str> = Vec::new();

    for node in nodes {
        if color[node.id.as_str()] == WHITE {
            if let Some(cycle) = dfs_visit(node.id.as_str(), &adj, &mut color, &mut path) {
                return Some(cycle);
            }
        }
    }

    None
}

/// Recursive DFS visit. Returns Some(cycle) if a back edge is found.
fn dfs_visit<'a>(
    node: &'a str,
    adj: &HashMap<&'a str, Vec<&'a str>>,
    color: &mut HashMap<&'a str, u8>,
    path: &mut Vec<&'a str>,
) -> Option<Vec<String>> {
    const GRAY: u8 = 1;
    const BLACK: u8 = 2;

    color.insert(node, GRAY);
    path.push(node);

    if let Some(neighbors) = adj.get(node) {
        for &neighbor in neighbors {
            match color.get(neighbor).copied() {
                Some(GRAY) => {
                    // Back edge found: extract the cycle from the path
                    // The cycle starts at `neighbor` and goes through to `node`
                    let cycle_start = path.iter().position(|&n| n == neighbor).unwrap();
                    let cycle: Vec<String> = path[cycle_start..]
                        .iter()
                        .map(|&s| s.to_string())
                        .collect();
                    return Some(cycle);
                }
                Some(BLACK) => {
                    // Already fully explored, skip
                    continue;
                }
                _ => {
                    // White: recurse
                    if let Some(cycle) = dfs_visit(neighbor, adj, color, path) {
                        return Some(cycle);
                    }
                }
            }
        }
    }

    color.insert(node, BLACK);
    path.pop();
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::template::{GraphOutputSpec, GraphTemplate, NodeTemplate};
    use serde_json::json;

    /// Helper: create a minimal NodeTemplate
    fn node(id: &str, deps: Vec<&str>) -> NodeTemplate {
        NodeTemplate {
            id: id.into(),
            tool: "test_tool".into(),
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

    /// Helper: create a minimal valid GraphTemplate
    fn template(id: &str, nodes: Vec<NodeTemplate>) -> GraphTemplate {
        GraphTemplate {
            id: id.into(),
            version: "1.0".into(),
            description: None,
            inputs_schema: json!({}),
            nodes,
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        }
    }

    #[test]
    fn valid_linear_chain() {
        // A -> B -> C (linear chain, no cycles)
        let tpl = template("linear", vec![
            node("A", vec![]),
            node("B", vec!["A"]),
            node("C", vec!["B"]),
        ]);
        assert!(validate_template(&tpl).is_ok());
    }

    #[test]
    fn valid_diamond_dag() {
        //     A
        //    / \
        //   B   C
        //    \ /
        //     D
        let tpl = template("diamond", vec![
            node("A", vec![]),
            node("B", vec!["A"]),
            node("C", vec!["A"]),
            node("D", vec!["B", "C"]),
        ]);
        assert!(validate_template(&tpl).is_ok());
    }

    #[test]
    fn empty_template_id() {
        let tpl = template("", vec![node("A", vec![])]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::Validation { reason } => {
                assert!(reason.contains("empty"), "Expected 'empty' in: {}", reason);
            }
            other => panic!("Expected Validation error, got: {:?}", other),
        }
    }

    #[test]
    fn whitespace_only_template_id() {
        let tpl = template("   ", vec![node("A", vec![])]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::Validation { reason } => {
                assert!(reason.contains("empty"), "Expected 'empty' in: {}", reason);
            }
            other => panic!("Expected Validation error, got: {:?}", other),
        }
    }

    #[test]
    fn duplicate_node_ids() {
        let tpl = template("dup", vec![
            node("A", vec![]),
            node("A", vec![]),
        ]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::Validation { reason } => {
                assert!(reason.contains("Duplicate"), "Expected 'Duplicate' in: {}", reason);
                assert!(reason.contains("A"), "Expected 'A' in: {}", reason);
            }
            other => panic!("Expected Validation error, got: {:?}", other),
        }
    }

    #[test]
    fn missing_dependency_reference() {
        let tpl = template("missing_dep", vec![
            node("A", vec!["nonexistent"]),
        ]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::Validation { reason } => {
                assert!(reason.contains("nonexistent"), "Expected 'nonexistent' in: {}", reason);
                assert!(reason.contains("does not exist"), "Expected 'does not exist' in: {}", reason);
            }
            other => panic!("Expected Validation error, got: {:?}", other),
        }
    }

    #[test]
    fn self_dependency() {
        let tpl = template("self_dep", vec![
            node("A", vec!["A"]),
        ]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::Validation { reason } => {
                assert!(reason.contains("self-dependency"), "Expected 'self-dependency' in: {}", reason);
            }
            other => panic!("Expected Validation error, got: {:?}", other),
        }
    }

    #[test]
    fn two_node_cycle() {
        // A -> B -> A
        let tpl = template("cycle2", vec![
            node("A", vec!["B"]),
            node("B", vec!["A"]),
        ]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::CycleDetected { nodes } => {
                assert!(nodes.len() >= 2, "Cycle should have at least 2 nodes: {:?}", nodes);
                assert!(nodes.contains(&"A".to_string()));
                assert!(nodes.contains(&"B".to_string()));
            }
            other => panic!("Expected CycleDetected error, got: {:?}", other),
        }
    }

    #[test]
    fn three_node_cycle() {
        // A -> B -> C -> A
        let tpl = template("cycle3", vec![
            node("A", vec!["C"]),
            node("B", vec!["A"]),
            node("C", vec!["B"]),
        ]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::CycleDetected { nodes } => {
                assert!(nodes.len() >= 3, "Cycle should have at least 3 nodes: {:?}", nodes);
                assert!(nodes.contains(&"A".to_string()));
                assert!(nodes.contains(&"B".to_string()));
                assert!(nodes.contains(&"C".to_string()));
            }
            other => panic!("Expected CycleDetected error, got: {:?}", other),
        }
    }

    #[test]
    fn valid_complex_oer_like_graph() {
        // Simulates a 10-node OER catalyst screening workflow:
        //
        //   relax_slab
        //       |
        //   +---+---+---+---+
        //   |   |   |   |   |
        //  OH  O   OOH  H2O O2
        //   |   |   |   |   |
        //   +---+---+---+---+
        //       |
        //   calc_overpotential
        //       |
        //   gen_report
        //       |
        //   archive
        let tpl = template("oer_screen", vec![
            node("relax_slab", vec![]),
            node("adsorb_OH",  vec!["relax_slab"]),
            node("adsorb_O",   vec!["relax_slab"]),
            node("adsorb_OOH", vec!["relax_slab"]),
            node("ref_H2O",    vec!["relax_slab"]),
            node("ref_O2",     vec!["relax_slab"]),
            node("calc_overpotential", vec!["adsorb_OH", "adsorb_O", "adsorb_OOH", "ref_H2O", "ref_O2"]),
            node("gen_report", vec!["calc_overpotential"]),
            node("archive",    vec!["gen_report"]),
            node("notify",     vec!["archive"]),
        ]);
        assert!(validate_template(&tpl).is_ok());
    }

    #[test]
    fn invalid_graph_output_reference() {
        let mut tpl = template("bad_output", vec![
            node("A", vec![]),
        ]);
        tpl.outputs = vec![GraphOutputSpec {
            name: "final_energy".into(),
            source: "${nodes.nonexistent_node.outputs.energy}".into(),
        }];
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::Validation { reason } => {
                assert!(reason.contains("nonexistent_node"), "Expected 'nonexistent_node' in: {}", reason);
                assert!(reason.contains("final_energy"), "Expected 'final_energy' in: {}", reason);
            }
            other => panic!("Expected Validation error, got: {:?}", other),
        }
    }

    #[test]
    fn valid_graph_output_reference() {
        let mut tpl = template("good_output", vec![
            node("A", vec![]),
            node("B", vec!["A"]),
        ]);
        tpl.outputs = vec![GraphOutputSpec {
            name: "result".into(),
            source: "${nodes.B.outputs.energy}".into(),
        }];
        assert!(validate_template(&tpl).is_ok());
    }

    #[test]
    fn empty_graph_is_valid() {
        // A template with no nodes is structurally valid (nothing to execute)
        let tpl = template("empty", vec![]);
        assert!(validate_template(&tpl).is_ok());
    }

    #[test]
    fn single_node_no_deps() {
        let tpl = template("single", vec![node("A", vec![])]);
        assert!(validate_template(&tpl).is_ok());
    }

    #[test]
    fn test_four_node_cycle() {
        // A → B → C → D → A
        let tpl = template("cycle4", vec![
            node("A", vec!["D"]),
            node("B", vec!["A"]),
            node("C", vec!["B"]),
            node("D", vec!["C"]),
        ]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::CycleDetected { nodes } => {
                assert!(nodes.len() >= 4, "Cycle should have at least 4 nodes: {:?}", nodes);
                assert!(nodes.contains(&"A".to_string()));
                assert!(nodes.contains(&"B".to_string()));
                assert!(nodes.contains(&"C".to_string()));
                assert!(nodes.contains(&"D".to_string()));
            }
            other => panic!("Expected CycleDetected error, got: {:?}", other),
        }
    }

    #[test]
    fn test_partial_cycle_with_valid_branch() {
        // Valid branch: E → F (no cycle)
        // Cycle: A → B → C → A
        // Even though E→F is fine, the cycle in A→B→C→A should reject the graph.
        let tpl = template("partial_cycle", vec![
            node("A", vec!["C"]),
            node("B", vec!["A"]),
            node("C", vec!["B"]),
            node("E", vec![]),
            node("F", vec!["E"]),
        ]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::CycleDetected { nodes } => {
                assert!(nodes.contains(&"A".to_string()));
                assert!(nodes.contains(&"B".to_string()));
                assert!(nodes.contains(&"C".to_string()));
                // E and F should NOT be part of the cycle
                assert!(!nodes.contains(&"E".to_string()), "E should not be in cycle: {:?}", nodes);
                assert!(!nodes.contains(&"F".to_string()), "F should not be in cycle: {:?}", nodes);
            }
            other => panic!("Expected CycleDetected error, got: {:?}", other),
        }
    }

    #[test]
    fn test_multiple_missing_deps_reports_first() {
        // Node A depends on both X and Y, neither of which exists.
        // The validator iterates depends_on in order, so the error should mention
        // at least one of them (the first encountered).
        let tpl = template("multi_missing", vec![
            node("A", vec!["X", "Y"]),
        ]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::Validation { reason } => {
                assert!(
                    reason.contains("does not exist"),
                    "Expected 'does not exist' in: {}",
                    reason
                );
                // Should mention at least one of the missing deps
                let mentions_x = reason.contains("X");
                let mentions_y = reason.contains("Y");
                assert!(
                    mentions_x || mentions_y,
                    "Expected error to mention 'X' or 'Y', got: {}",
                    reason
                );
            }
            other => panic!("Expected Validation error, got: {:?}", other),
        }
    }

    #[test]
    fn test_graph_output_malformed_source() {
        // Source that doesn't match "${nodes.X.outputs.Y}" pattern.
        // extract_node_ref returns None for non-matching patterns, so
        // validation should pass (the source is not checked further).
        let mut tpl = template("malformed_output", vec![
            node("A", vec![]),
        ]);
        tpl.outputs = vec![GraphOutputSpec {
            name: "result".into(),
            source: "${some.weird.pattern.that.does.not.match}".into(),
        }];
        assert!(
            validate_template(&tpl).is_ok(),
            "Malformed source patterns (non nodes.X...) should pass validation"
        );
    }

    #[test]
    fn test_graph_output_literal_source() {
        // A source with no ${...} variable reference at all should pass validation.
        let mut tpl = template("literal_output", vec![
            node("A", vec![]),
        ]);
        tpl.outputs = vec![GraphOutputSpec {
            name: "version".into(),
            source: "1.0.0".into(),
        }];
        assert!(
            validate_template(&tpl).is_ok(),
            "Literal source with no variable reference should pass validation"
        );
    }

    #[test]
    fn test_disconnected_components() {
        // Two independent subgraphs, both valid (no cycles, no missing deps).
        // Subgraph 1: A → B
        // Subgraph 2: C → D
        let tpl = template("disconnected", vec![
            node("A", vec![]),
            node("B", vec!["A"]),
            node("C", vec![]),
            node("D", vec!["C"]),
        ]);
        assert!(
            validate_template(&tpl).is_ok(),
            "Disconnected but valid subgraphs should pass validation"
        );
    }

    #[test]
    fn test_wide_fan_out() {
        // One root node with 20 children, all valid.
        let mut nodes = vec![node("root", vec![])];
        for i in 0..20 {
            nodes.push(node(
                Box::leak(format!("child_{}", i).into_boxed_str()),
                vec!["root"],
            ));
        }
        let tpl = template("wide_fan_out", nodes);
        assert!(
            validate_template(&tpl).is_ok(),
            "Wide fan-out graph with 20 children should pass validation"
        );
    }

    #[test]
    fn test_node_with_both_tool_and_subgraph_is_invalid() {
        use crate::graph::template::SubgraphRef;

        let tpl = template("both", vec![NodeTemplate {
            id: "bad_node".into(),
            tool: "some_tool".into(),
            depends_on: vec![],
            input_bindings: json!({}),
            output_spec: None,
            retry_policy: None,
            timeout_seconds: None,
            repair_policy: None,
            execution_mode: Default::default(),
            skip_condition: None,
            subgraph: Some(SubgraphRef {
                template_id: "some_template".into(),
                version: None,
                input_map: json!({}),
            }),
            metadata: Default::default(),
        }]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::Validation { reason } => {
                assert!(reason.contains("both"), "Expected 'both' in: {}", reason);
                assert!(reason.contains("bad_node"), "Expected 'bad_node' in: {}", reason);
            }
            other => panic!("Expected Validation error, got: {:?}", other),
        }
    }

    #[test]
    fn test_node_with_neither_tool_nor_subgraph_is_invalid() {
        let tpl = template("neither", vec![NodeTemplate {
            id: "empty_node".into(),
            tool: "".into(),  // empty tool
            depends_on: vec![],
            input_bindings: json!({}),
            output_spec: None,
            retry_policy: None,
            timeout_seconds: None,
            repair_policy: None,
            execution_mode: Default::default(),
            skip_condition: None,
            subgraph: None,  // no subgraph either
            metadata: Default::default(),
        }]);
        let err = validate_template(&tpl).unwrap_err();
        match err {
            EngineError::Validation { reason } => {
                assert!(reason.contains("neither"), "Expected 'neither' in: {}", reason);
                assert!(reason.contains("empty_node"), "Expected 'empty_node' in: {}", reason);
            }
            other => panic!("Expected Validation error, got: {:?}", other),
        }
    }

    #[test]
    fn test_subgraph_node_without_tool_is_valid() {
        use crate::graph::template::SubgraphRef;

        let tpl = template("subgraph_only", vec![NodeTemplate {
            id: "sub_node".into(),
            tool: "".into(),  // no tool
            depends_on: vec![],
            input_bindings: json!({}),
            output_spec: None,
            retry_policy: None,
            timeout_seconds: None,
            repair_policy: None,
            execution_mode: Default::default(),
            skip_condition: None,
            subgraph: Some(SubgraphRef {
                template_id: "child_template".into(),
                version: None,
                input_map: json!({}),
            }),
            metadata: Default::default(),
        }]);
        // Note: This validates the TEMPLATE structure, not whether child_template exists.
        // Template existence is checked during subgraph expansion, not validation.
        assert!(validate_template(&tpl).is_ok());
    }

    #[test]
    fn test_tool_node_without_subgraph_is_valid() {
        // Existing behavior: tool nodes work as before
        let tpl = template("tool_only", vec![node("A", vec![])]);
        assert!(validate_template(&tpl).is_ok());
    }
}
