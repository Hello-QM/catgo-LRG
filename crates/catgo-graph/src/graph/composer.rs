//! Subgraph composition: expand subgraph references into flat node lists.
//!
//! This module provides template-level composition where a node can reference
//! another GraphTemplate as a "subgraph". During expansion, subgraph nodes are
//! replaced with the referenced template's nodes, with proper ID prefixing,
//! dependency wiring, and input/output remapping.
//!
//! The expansion is a pure function that produces a flat GraphTemplate with no
//! remaining subgraph references. The executor, scheduler, and persistence
//! layer operate on the expanded template unchanged.

use std::collections::HashSet;
use regex::Regex;
use std::sync::LazyLock;

use crate::core::EngineError;
use crate::graph::template::*;

/// Maximum nesting depth for recursive subgraph expansion.
const MAX_EXPANSION_DEPTH: usize = 10;

/// Regex matching ${inputs.KEY} references.
static INPUTS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\$\{inputs\.([^}]+)\}").expect("Failed to compile inputs regex")
});

/// Regex matching ${nodes.NODE_ID.outputs.KEY} references.
static NODES_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\$\{nodes\.([^.]+)\.outputs\.([^}]+)\}").expect("Failed to compile nodes regex")
});

/// Trait for resolving template references during subgraph expansion.
pub trait TemplateProvider: Send + Sync {
    /// Get a template by ID (returns the default/latest version).
    fn get_template(&self, id: &str) -> Option<GraphTemplate>;

    /// Get a template by ID and exact version.
    /// Default implementation: gets the template and checks if version matches.
    fn get_template_versioned(&self, id: &str, version: &str) -> Option<GraphTemplate> {
        let t = self.get_template(id)?;
        if t.version == version { Some(t) } else { None }
    }
}

/// Expand all subgraph references in a template, producing a fully flat template.
///
/// Algorithm:
/// 1. For each node with subgraph: Some(ref):
///    a. Resolve the referenced template via provider
///    b. Recursively expand the referenced template (with depth limit)
///    c. Prefix inner node IDs with "{parent_node_id}/"
///    d. Update inner depends_on to use prefixed IDs
///    e. Inner root nodes (no deps in subgraph) inherit parent node's depends_on
///    f. Rewrite inner ${inputs.X} references using subgraph's input_map
///    g. Rewrite inner ${nodes.Y.outputs.Z} to ${nodes.parent_id/Y.outputs.Z}
///    h. Add subgraph_origin metadata to each expanded node
///    i. Identify terminal inner nodes (no other inner node depends on them)
/// 2. Replace the subgraph node with expanded inner nodes
/// 3. For non-subgraph nodes that depend on the subgraph node:
///    a. Replace depends_on entries with terminal inner node IDs
///    b. Rewrite ${nodes.subgraph_id.outputs.X} using subgraph's outputs spec
/// 4. Update template.outputs similarly
///
/// Uses "/" as the node ID separator (e.g., "relax_step/save_input").
/// This is compatible with the existing resolver (which splits on ".").
pub fn expand_subgraphs(
    template: &GraphTemplate,
    provider: &dyn TemplateProvider,
) -> Result<GraphTemplate, EngineError> {
    expand_recursive(template, provider, 0, &mut HashSet::new())
}

/// Recursive expansion with depth tracking and cycle detection.
fn expand_recursive(
    template: &GraphTemplate,
    provider: &dyn TemplateProvider,
    depth: usize,
    visited: &mut HashSet<String>,
) -> Result<GraphTemplate, EngineError> {
    if depth > MAX_EXPANSION_DEPTH {
        return Err(EngineError::Validation {
            reason: format!(
                "Subgraph expansion exceeded maximum nesting depth of {}",
                MAX_EXPANSION_DEPTH
            ),
        });
    }

    // Collect information about which nodes are subgraph nodes, and what their
    // terminal inner nodes are. We'll need this to rewrite dependencies.
    // Maps: subgraph_node_id -> Vec<terminal_inner_node_id>
    let mut subgraph_terminals: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    // Maps: subgraph_node_id -> Vec<GraphOutputSpec> (from the referenced template)
    let mut subgraph_outputs: std::collections::HashMap<String, Vec<GraphOutputSpec>> =
        std::collections::HashMap::new();

    let mut expanded_nodes: Vec<NodeTemplate> = Vec::new();

    for node in &template.nodes {
        if let Some(ref sg_ref) = node.subgraph {
            // Cycle detection
            if visited.contains(&sg_ref.template_id) {
                return Err(EngineError::Validation {
                    reason: format!(
                        "Cycle detected in subgraph expansion: template '{}' references itself \
                         (chain: {:?})",
                        sg_ref.template_id, visited
                    ),
                });
            }

            // Look up the referenced template (version-aware if pinned)
            let sub_template = if let Some(ref ver) = sg_ref.version {
                provider.get_template_versioned(&sg_ref.template_id, ver)
                    .ok_or_else(|| EngineError::Validation {
                        reason: format!(
                            "Subgraph node '{}': referenced template '{}' version '{}' not found",
                            node.id, sg_ref.template_id, ver
                        ),
                    })?
            } else {
                provider.get_template(&sg_ref.template_id)
                    .ok_or_else(|| EngineError::Validation {
                        reason: format!(
                            "Subgraph node '{}': referenced template '{}' not found",
                            node.id, sg_ref.template_id
                        ),
                    })?
            };

            // Recursively expand the sub-template
            visited.insert(sg_ref.template_id.clone());
            let expanded_sub = expand_recursive(&sub_template, provider, depth + 1, visited)?;
            visited.remove(&sg_ref.template_id);

            // Store the sub-template's output specs for later remapping
            subgraph_outputs.insert(node.id.clone(), expanded_sub.outputs.clone());

            // Collect all inner node IDs (before prefixing) for dependency analysis
            let inner_ids: HashSet<String> = expanded_sub
                .nodes
                .iter()
                .map(|n| n.id.clone())
                .collect();

            // Find root nodes (no deps within the subgraph)
            let root_ids: HashSet<&str> = expanded_sub
                .nodes
                .iter()
                .filter(|n| {
                    n.depends_on
                        .iter()
                        .all(|dep| !inner_ids.contains(dep))
                })
                .map(|n| n.id.as_str())
                .collect();

            // Find terminal nodes (no other inner node depends on them)
            let depended_on: HashSet<&str> = expanded_sub
                .nodes
                .iter()
                .flat_map(|n| n.depends_on.iter())
                .filter(|dep| inner_ids.contains(*dep))
                .map(|s| s.as_str())
                .collect();
            let terminal_ids: Vec<String> = expanded_sub
                .nodes
                .iter()
                .filter(|n| !depended_on.contains(n.id.as_str()))
                .map(|n| format!("{}/{}", node.id, n.id))
                .collect();

            subgraph_terminals.insert(node.id.clone(), terminal_ids);

            // Expand each inner node with prefixing and rewriting
            for inner_node in &expanded_sub.nodes {
                let prefixed_id = format!("{}/{}", node.id, inner_node.id);

                // Prefix depends_on
                let new_deps: Vec<String> = if root_ids.contains(inner_node.id.as_str()) {
                    // Root nodes inherit parent's depends_on
                    let mut deps = node.depends_on.clone();
                    // Also include any non-inner deps the root node already had (shouldn't
                    // normally happen after recursive expansion, but be safe)
                    for dep in &inner_node.depends_on {
                        if !inner_ids.contains(dep) {
                            deps.push(dep.clone());
                        }
                    }
                    deps
                } else {
                    inner_node
                        .depends_on
                        .iter()
                        .map(|dep| {
                            if inner_ids.contains(dep) {
                                format!("{}/{}", node.id, dep)
                            } else {
                                dep.clone()
                            }
                        })
                        .collect()
                };

                // Rewrite input_bindings:
                // 1. Replace ${inputs.X} with values from input_map
                // 2. Prefix ${nodes.Y.outputs.Z} → ${nodes.parent_id/Y.outputs.Z}
                let new_bindings = rewrite_inputs(
                    &inner_node.input_bindings,
                    &sg_ref.input_map,
                    &node.id,
                    &inner_ids,
                );

                // Build metadata with subgraph_origin
                let mut new_metadata = inner_node.metadata.clone();
                new_metadata.insert(
                    "subgraph_origin".to_string(),
                    serde_json::json!({
                        "parent_node_id": node.id,
                        "subgraph_template_id": sg_ref.template_id,
                        "original_node_id": inner_node.id,
                    }),
                );

                expanded_nodes.push(NodeTemplate {
                    id: prefixed_id,
                    tool: inner_node.tool.clone(),
                    depends_on: new_deps,
                    input_bindings: new_bindings,
                    output_spec: inner_node.output_spec.clone(),
                    retry_policy: inner_node.retry_policy.clone(),
                    timeout_seconds: inner_node.timeout_seconds,
                    repair_policy: inner_node.repair_policy.clone(),
                    execution_mode: inner_node.execution_mode.clone(),
                    skip_condition: inner_node.skip_condition.clone(),
                    subgraph: None,
                    metadata: new_metadata,
                });
            }
        } else {
            // Non-subgraph node: keep as-is (dependencies will be rewritten below)
            expanded_nodes.push(node.clone());
        }
    }

    // Second pass: rewrite dependencies and node references for non-subgraph nodes
    // that depend on subgraph nodes.
    let expanded_nodes = expanded_nodes
        .into_iter()
        .map(|mut node| {
            // Rewrite depends_on: replace subgraph node IDs with their terminal nodes
            let mut new_deps: Vec<String> = Vec::new();
            for dep in &node.depends_on {
                if let Some(terminals) = subgraph_terminals.get(dep) {
                    new_deps.extend(terminals.clone());
                } else {
                    new_deps.push(dep.clone());
                }
            }
            node.depends_on = new_deps;

            // Rewrite ${nodes.SUBGRAPH_ID.outputs.X} references in input_bindings
            node.input_bindings =
                rewrite_subgraph_output_refs(&node.input_bindings, &subgraph_outputs, &subgraph_terminals);

            node
        })
        .collect();

    // Rewrite template-level outputs
    let new_outputs: Vec<GraphOutputSpec> = template
        .outputs
        .iter()
        .map(|out| {
            let new_source =
                rewrite_subgraph_output_ref_str(&out.source, &subgraph_outputs, &subgraph_terminals);
            GraphOutputSpec {
                name: out.name.clone(),
                source: new_source,
            }
        })
        .collect();

    Ok(GraphTemplate {
        id: template.id.clone(),
        version: template.version.clone(),
        description: template.description.clone(),
        inputs_schema: template.inputs_schema.clone(),
        nodes: expanded_nodes,
        outputs: new_outputs,
        metadata: template.metadata.clone(),
        rewrite_rules: template.rewrite_rules.clone(),
    })
}

/// Rewrite a JSON value's string contents:
/// - Replace `${inputs.X}` with the corresponding value from `input_map`
/// - Prefix `${nodes.Y.outputs.Z}` → `${nodes.prefix/Y.outputs.Z}` for inner node refs
fn rewrite_inputs(
    value: &serde_json::Value,
    input_map: &serde_json::Value,
    parent_id: &str,
    inner_ids: &HashSet<String>,
) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => {
            rewrite_string_value(s, input_map, parent_id, inner_ids)
        }
        serde_json::Value::Object(map) => {
            let new_map: serde_json::Map<String, serde_json::Value> = map
                .iter()
                .map(|(k, v)| (k.clone(), rewrite_inputs(v, input_map, parent_id, inner_ids)))
                .collect();
            serde_json::Value::Object(new_map)
        }
        serde_json::Value::Array(arr) => {
            let new_arr: Vec<serde_json::Value> = arr
                .iter()
                .map(|v| rewrite_inputs(v, input_map, parent_id, inner_ids))
                .collect();
            serde_json::Value::Array(new_arr)
        }
        other => other.clone(),
    }
}

/// Rewrite a single string value, handling input references and node references.
fn rewrite_string_value(
    s: &str,
    input_map: &serde_json::Value,
    parent_id: &str,
    inner_ids: &HashSet<String>,
) -> serde_json::Value {
    // Check if the entire string is a single ${inputs.X} reference
    if let Some(caps) = INPUTS_RE.captures(s) {
        if caps.get(0).map_or(false, |m| m.as_str() == s) {
            // Entire string is a single ${inputs.KEY} reference
            let key = &caps[1];
            if let Some(mapped) = input_map.get(key) {
                return mapped.clone();
            }
            // Key not in input_map, leave as-is
            return serde_json::Value::String(s.to_string());
        }
    }

    // For partial references or mixed content, do string replacement
    let mut result = s.to_string();

    // Replace ${inputs.X} with input_map values (stringified for non-string types)
    result = INPUTS_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let key = &caps[1];
            if let Some(mapped) = input_map.get(key) {
                match mapped {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                }
            } else {
                caps[0].to_string()
            }
        })
        .to_string();

    // Prefix ${nodes.Y.outputs.Z} where Y is an inner node
    result = NODES_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let node_ref = &caps[1];
            let output_key = &caps[2];
            if inner_ids.contains(node_ref) {
                format!("${{nodes.{}/{}.outputs.{}}}", parent_id, node_ref, output_key)
            } else {
                caps[0].to_string()
            }
        })
        .to_string();

    serde_json::Value::String(result)
}

/// Rewrite `${nodes.SUBGRAPH_ID.outputs.X}` references in a JSON value.
/// Uses the subgraph's output specs to find the actual inner node that provides the output.
fn rewrite_subgraph_output_refs(
    value: &serde_json::Value,
    subgraph_outputs: &std::collections::HashMap<String, Vec<GraphOutputSpec>>,
    _subgraph_terminals: &std::collections::HashMap<String, Vec<String>>,
) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => {
            let new_s = rewrite_subgraph_output_ref_str(s, subgraph_outputs, _subgraph_terminals);
            serde_json::Value::String(new_s)
        }
        serde_json::Value::Object(map) => {
            let new_map: serde_json::Map<String, serde_json::Value> = map
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        rewrite_subgraph_output_refs(v, subgraph_outputs, _subgraph_terminals),
                    )
                })
                .collect();
            serde_json::Value::Object(new_map)
        }
        serde_json::Value::Array(arr) => {
            let new_arr: Vec<serde_json::Value> = arr
                .iter()
                .map(|v| rewrite_subgraph_output_refs(v, subgraph_outputs, _subgraph_terminals))
                .collect();
            serde_json::Value::Array(new_arr)
        }
        other => other.clone(),
    }
}

/// Rewrite a single string, replacing `${nodes.SUBGRAPH_ID.outputs.X}` with the
/// remapped reference from the subgraph's output spec.
///
/// If the subgraph has an explicit output spec for key X, uses that spec's source
/// (with inner node IDs prefixed). Otherwise, falls back to the subgraph's single
/// terminal node: `${nodes.SUBGRAPH_ID/TERMINAL.outputs.X}`.
fn rewrite_subgraph_output_ref_str(
    s: &str,
    subgraph_outputs: &std::collections::HashMap<String, Vec<GraphOutputSpec>>,
    subgraph_terminals: &std::collections::HashMap<String, Vec<String>>,
) -> String {
    NODES_RE
        .replace_all(s, |caps: &regex::Captures| {
            let node_ref = &caps[1];
            let output_key = &caps[2];

            // Check if node_ref is a subgraph node (it will be in subgraph_outputs
            // or subgraph_terminals if it was expanded)
            let is_subgraph = subgraph_outputs.contains_key(node_ref)
                || subgraph_terminals.contains_key(node_ref);

            if !is_subgraph {
                // Not a subgraph node, leave as-is
                return caps[0].to_string();
            }

            // Try explicit output spec first
            if let Some(outputs) = subgraph_outputs.get(node_ref) {
                if let Some(out_spec) = outputs.iter().find(|o| o.name == *output_key) {
                    // The source is e.g. "${nodes.vasp_relax.outputs.energy}"
                    // We need to prefix the node ref: "${nodes.SUBGRAPH_ID/vasp_relax.outputs.energy}"
                    return NODES_RE
                        .replace_all(&out_spec.source, |inner_caps: &regex::Captures| {
                            let inner_node = &inner_caps[1];
                            let inner_key = &inner_caps[2];
                            format!(
                                "${{nodes.{}/{}.outputs.{}}}",
                                node_ref, inner_node, inner_key
                            )
                        })
                        .to_string();
                }
            }

            // Fallback: if the subgraph has exactly one terminal node, remap to it
            if let Some(terminals) = subgraph_terminals.get(node_ref) {
                if terminals.len() == 1 {
                    return format!(
                        "${{nodes.{}.outputs.{}}}",
                        terminals[0], output_key
                    );
                }
            }

            // Cannot disambiguate; leave as-is
            caps[0].to_string()
        })
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    /// Simple map-based template provider for tests.
    /// Stores templates by ID (last-registered wins for unversioned lookup)
    /// and by (ID, version) for versioned lookup.
    struct MapProvider {
        templates: HashMap<String, GraphTemplate>,
        versioned: HashMap<(String, String), GraphTemplate>,
    }

    impl MapProvider {
        fn new() -> Self {
            Self {
                templates: HashMap::new(),
                versioned: HashMap::new(),
            }
        }

        fn add(&mut self, t: GraphTemplate) {
            let id = t.id.clone();
            let ver = t.version.clone();
            self.templates.insert(id.clone(), t.clone());
            self.versioned.insert((id, ver), t);
        }
    }

    impl TemplateProvider for MapProvider {
        fn get_template(&self, id: &str) -> Option<GraphTemplate> {
            self.templates.get(id).cloned()
        }

        fn get_template_versioned(&self, id: &str, version: &str) -> Option<GraphTemplate> {
            self.versioned.get(&(id.to_string(), version.to_string())).cloned()
        }
    }

    /// Helper to build a minimal NodeTemplate for testing.
    fn make_node(id: &str, tool: &str, deps: Vec<&str>) -> NodeTemplate {
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

    /// Helper to build a subgraph node (no tool, with subgraph ref).
    fn make_subgraph_node(
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

    /// Helper to build a minimal GraphTemplate.
    fn make_template(
        id: &str,
        nodes: Vec<NodeTemplate>,
        outputs: Vec<GraphOutputSpec>,
    ) -> GraphTemplate {
        GraphTemplate {
            id: id.into(),
            version: "1.0".into(),
            description: None,
            inputs_schema: json!({}),
            nodes,
            outputs,
            metadata: Default::default(),
            rewrite_rules: vec![],
        }
    }

    // ──────────────────────────────────────────────────────
    // 1. No subgraphs → passthrough
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_no_subgraphs() {
        let template = make_template(
            "simple",
            vec![
                make_node("a", "tool_a", vec![]),
                make_node("b", "tool_b", vec!["a"]),
            ],
            vec![],
        );
        let provider = MapProvider::new();

        let result = expand_subgraphs(&template, &provider).unwrap();
        assert_eq!(result.nodes.len(), 2);
        assert_eq!(result.nodes[0].id, "a");
        assert_eq!(result.nodes[1].id, "b");
        assert_eq!(result.nodes[1].depends_on, vec!["a".to_string()]);
    }

    // ──────────────────────────────────────────────────────
    // 2. Simple subgraph expansion
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_simple_subgraph() {
        // Sub-template with 2 nodes: inner_a → inner_b
        let sub = make_template(
            "sub_tpl",
            vec![
                make_node("inner_a", "tool_ia", vec![]),
                make_node("inner_b", "tool_ib", vec!["inner_a"]),
            ],
            vec![],
        );

        let mut provider = MapProvider::new();
        provider.add(sub);

        // Parent template: prep → sg_node(subgraph) → final
        let template = make_template(
            "parent",
            vec![
                make_node("prep", "tool_prep", vec![]),
                make_subgraph_node("sg_node", "sub_tpl", json!({}), vec!["prep"]),
                make_node("final", "tool_final", vec!["sg_node"]),
            ],
            vec![],
        );

        let result = expand_subgraphs(&template, &provider).unwrap();

        // Should have 4 nodes: prep, sg_node/inner_a, sg_node/inner_b, final
        assert_eq!(result.nodes.len(), 4);

        let ids: Vec<&str> = result.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"prep"));
        assert!(ids.contains(&"sg_node/inner_a"));
        assert!(ids.contains(&"sg_node/inner_b"));
        assert!(ids.contains(&"final"));

        // sg_node/inner_a (root of subgraph) should depend on "prep" (parent's deps)
        let inner_a = result.nodes.iter().find(|n| n.id == "sg_node/inner_a").unwrap();
        assert_eq!(inner_a.depends_on, vec!["prep".to_string()]);

        // sg_node/inner_b depends on sg_node/inner_a
        let inner_b = result.nodes.iter().find(|n| n.id == "sg_node/inner_b").unwrap();
        assert_eq!(inner_b.depends_on, vec!["sg_node/inner_a".to_string()]);

        // "final" should now depend on terminal nodes of the subgraph (sg_node/inner_b)
        let final_node = result.nodes.iter().find(|n| n.id == "final").unwrap();
        assert_eq!(final_node.depends_on, vec!["sg_node/inner_b".to_string()]);
    }

    // ──────────────────────────────────────────────────────
    // 3. ID prefixing with "/" separator
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_preserves_id_prefixing() {
        let sub = make_template(
            "sub_tpl",
            vec![make_node("step1", "tool_s1", vec![])],
            vec![],
        );

        let mut provider = MapProvider::new();
        provider.add(sub);

        let template = make_template(
            "parent",
            vec![make_subgraph_node("my_sub", "sub_tpl", json!({}), vec![])],
            vec![],
        );

        let result = expand_subgraphs(&template, &provider).unwrap();
        assert_eq!(result.nodes.len(), 1);
        assert_eq!(result.nodes[0].id, "my_sub/step1");
        assert!(result.nodes[0].id.contains('/'));
    }

    // ──────────────────────────────────────────────────────
    // 4. Input rewriting: ${inputs.X} → input_map values
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_input_rewriting() {
        // Sub-template with a node that uses ${inputs.structure} and ${inputs.kpoints}
        let mut inner_node = make_node("calc", "vasp", vec![]);
        inner_node.input_bindings = json!({
            "structure": "${inputs.structure}",
            "kpoints": "${inputs.kpoints}",
            "label": "calc on ${inputs.structure}"
        });

        let sub = make_template("sub_tpl", vec![inner_node], vec![]);

        let mut provider = MapProvider::new();
        provider.add(sub);

        // Parent provides literal values and expression passthrough
        let template = make_template(
            "parent",
            vec![make_subgraph_node(
                "relax",
                "sub_tpl",
                json!({
                    "structure": "${nodes.build.outputs.structure}",
                    "kpoints": 4
                }),
                vec![],
            )],
            vec![],
        );

        let result = expand_subgraphs(&template, &provider).unwrap();
        let calc = result.nodes.iter().find(|n| n.id == "relax/calc").unwrap();

        // "${inputs.structure}" → passthrough expression "${nodes.build.outputs.structure}"
        assert_eq!(
            calc.input_bindings["structure"],
            json!("${nodes.build.outputs.structure}")
        );
        // "${inputs.kpoints}" → literal 4
        assert_eq!(calc.input_bindings["kpoints"], json!(4));
        // Partial string: "calc on ${inputs.structure}" → "calc on ${nodes.build.outputs.structure}"
        assert_eq!(
            calc.input_bindings["label"],
            json!("calc on ${nodes.build.outputs.structure}")
        );
    }

    // ──────────────────────────────────────────────────────
    // 5. Node reference rewriting: ${nodes.Y.outputs.Z} prefix
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_node_ref_rewriting() {
        // Sub-template: step1 → step2, where step2 references step1's output
        let mut step2 = make_node("step2", "tool_s2", vec!["step1"]);
        step2.input_bindings = json!({
            "data": "${nodes.step1.outputs.result}"
        });

        let sub = make_template(
            "sub_tpl",
            vec![make_node("step1", "tool_s1", vec![]), step2],
            vec![],
        );

        let mut provider = MapProvider::new();
        provider.add(sub);

        let template = make_template(
            "parent",
            vec![make_subgraph_node("sg", "sub_tpl", json!({}), vec![])],
            vec![],
        );

        let result = expand_subgraphs(&template, &provider).unwrap();
        let expanded_step2 = result.nodes.iter().find(|n| n.id == "sg/step2").unwrap();

        // ${nodes.step1.outputs.result} → ${nodes.sg/step1.outputs.result}
        assert_eq!(
            expanded_step2.input_bindings["data"],
            json!("${nodes.sg/step1.outputs.result}")
        );
    }

    // ──────────────────────────────────────────────────────
    // 6. Dependency wiring
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_dependency_wiring() {
        // Sub-template: a → b (so a is root, b is terminal)
        let sub = make_template(
            "sub_tpl",
            vec![
                make_node("a", "tool_a", vec![]),
                make_node("b", "tool_b", vec!["a"]),
            ],
            vec![],
        );

        let mut provider = MapProvider::new();
        provider.add(sub);

        // Parent: pre → subgraph → post
        let template = make_template(
            "parent",
            vec![
                make_node("pre", "tool_pre", vec![]),
                make_subgraph_node("sg", "sub_tpl", json!({}), vec!["pre"]),
                make_node("post", "tool_post", vec!["sg"]),
            ],
            vec![],
        );

        let result = expand_subgraphs(&template, &provider).unwrap();

        // Root inner node (sg/a) inherits parent's deps ["pre"]
        let sg_a = result.nodes.iter().find(|n| n.id == "sg/a").unwrap();
        assert_eq!(sg_a.depends_on, vec!["pre".to_string()]);

        // Non-root inner node (sg/b) depends on sg/a
        let sg_b = result.nodes.iter().find(|n| n.id == "sg/b").unwrap();
        assert_eq!(sg_b.depends_on, vec!["sg/a".to_string()]);

        // Post depends on terminal nodes of sg → sg/b
        let post = result.nodes.iter().find(|n| n.id == "post").unwrap();
        assert_eq!(post.depends_on, vec!["sg/b".to_string()]);
    }

    // ──────────────────────────────────────────────────────
    // 7. Output remapping
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_output_remapping() {
        // Sub-template with an output spec
        let sub = make_template(
            "sub_tpl",
            vec![
                make_node("calc", "vasp", vec![]),
                make_node("parse", "parser", vec!["calc"]),
            ],
            vec![GraphOutputSpec {
                name: "energy".into(),
                source: "${nodes.parse.outputs.energy}".into(),
            }],
        );

        let mut provider = MapProvider::new();
        provider.add(sub);

        // Parent references subgraph output
        let mut post = make_node("post", "tool_post", vec!["relax"]);
        post.input_bindings = json!({
            "e": "${nodes.relax.outputs.energy}"
        });

        let template = make_template(
            "parent",
            vec![
                make_subgraph_node("relax", "sub_tpl", json!({}), vec![]),
                post,
            ],
            vec![GraphOutputSpec {
                name: "final_energy".into(),
                source: "${nodes.relax.outputs.energy}".into(),
            }],
        );

        let result = expand_subgraphs(&template, &provider).unwrap();

        // post's input_bindings should remap relax → relax/parse
        let post_node = result.nodes.iter().find(|n| n.id == "post").unwrap();
        assert_eq!(
            post_node.input_bindings["e"],
            json!("${nodes.relax/parse.outputs.energy}")
        );

        // Template output should also be remapped
        assert_eq!(result.outputs.len(), 1);
        assert_eq!(
            result.outputs[0].source,
            "${nodes.relax/parse.outputs.energy}"
        );
    }

    // ──────────────────────────────────────────────────────
    // 8. Nested subgraphs (2 levels deep)
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_nested_subgraphs() {
        // Inner template: single node
        let inner = make_template(
            "inner_tpl",
            vec![make_node("leaf", "tool_leaf", vec![])],
            vec![],
        );

        // Middle template: contains a subgraph reference to inner_tpl
        let middle = make_template(
            "middle_tpl",
            vec![
                make_subgraph_node("inner_sg", "inner_tpl", json!({}), vec![]),
                make_node("mid_step", "tool_mid", vec!["inner_sg"]),
            ],
            vec![],
        );

        let mut provider = MapProvider::new();
        provider.add(inner);
        provider.add(middle);

        // Top template: contains subgraph reference to middle_tpl
        let template = make_template(
            "top",
            vec![make_subgraph_node(
                "outer_sg",
                "middle_tpl",
                json!({}),
                vec![],
            )],
            vec![],
        );

        let result = expand_subgraphs(&template, &provider).unwrap();

        // Should be fully flattened:
        // outer_sg/inner_sg/leaf, outer_sg/mid_step
        let ids: Vec<&str> = result.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"outer_sg/inner_sg/leaf"));
        assert!(ids.contains(&"outer_sg/mid_step"));

        // mid_step should depend on inner_sg's terminal (outer_sg/inner_sg/leaf)
        let mid_step = result.nodes.iter().find(|n| n.id == "outer_sg/mid_step").unwrap();
        assert_eq!(
            mid_step.depends_on,
            vec!["outer_sg/inner_sg/leaf".to_string()]
        );
    }

    // ──────────────────────────────────────────────────────
    // 9. Cycle detection (A → B → A)
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_cycle_detection() {
        // Template A references B
        let tpl_a = make_template(
            "tpl_a",
            vec![make_subgraph_node("ref_b", "tpl_b", json!({}), vec![])],
            vec![],
        );
        // Template B references A
        let tpl_b = make_template(
            "tpl_b",
            vec![make_subgraph_node("ref_a", "tpl_a", json!({}), vec![])],
            vec![],
        );

        let mut provider = MapProvider::new();
        provider.add(tpl_a.clone());
        provider.add(tpl_b);

        let err = expand_subgraphs(&tpl_a, &provider).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("Cycle") || msg.contains("cycle"),
            "Expected cycle error, got: {}",
            msg
        );
    }

    // ──────────────────────────────────────────────────────
    // 10. Depth limit exceeded
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_depth_limit() {
        // Create a chain of templates that exceeds MAX_EXPANSION_DEPTH
        let mut provider = MapProvider::new();
        let mut root_tpl = None;
        for i in 0..=MAX_EXPANSION_DEPTH + 1 {
            let next_id = format!("tpl_{}", i + 1);
            let tpl = make_template(
                &format!("tpl_{}", i),
                vec![make_subgraph_node(
                    &format!("sg_{}", i),
                    &next_id,
                    json!({}),
                    vec![],
                )],
                vec![],
            );
            if i == 0 {
                root_tpl = Some(tpl.clone());
            }
            provider.add(tpl);
        }
        // Add a leaf template at the end
        provider.add(make_template(
            &format!("tpl_{}", MAX_EXPANSION_DEPTH + 2),
            vec![make_node("leaf", "tool_leaf", vec![])],
            vec![],
        ));

        let root = root_tpl.unwrap();

        let err = expand_subgraphs(&root, &provider).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("depth") || msg.contains("Depth"),
            "Expected depth limit error, got: {}",
            msg
        );
    }

    // ──────────────────────────────────────────────────────
    // 11. Missing template
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_missing_template() {
        let provider = MapProvider::new();
        let template = make_template(
            "parent",
            vec![make_subgraph_node(
                "sg",
                "nonexistent",
                json!({}),
                vec![],
            )],
            vec![],
        );

        let err = expand_subgraphs(&template, &provider).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("not found") || msg.contains("nonexistent"),
            "Expected not found error, got: {}",
            msg
        );
    }

    // ──────────────────────────────────────────────────────
    // 12. Metadata: subgraph_origin
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_metadata() {
        let sub = make_template(
            "sub_tpl",
            vec![
                make_node("inner_a", "tool_ia", vec![]),
                make_node("inner_b", "tool_ib", vec!["inner_a"]),
            ],
            vec![],
        );

        let mut provider = MapProvider::new();
        provider.add(sub);

        let template = make_template(
            "parent",
            vec![make_subgraph_node("my_sg", "sub_tpl", json!({}), vec![])],
            vec![],
        );

        let result = expand_subgraphs(&template, &provider).unwrap();

        for node in &result.nodes {
            let origin = node
                .metadata
                .get("subgraph_origin")
                .expect("expanded node should have subgraph_origin metadata");
            assert_eq!(origin["parent_node_id"], json!("my_sg"));
            assert_eq!(origin["subgraph_template_id"], json!("sub_tpl"));
            // original_node_id should be the unprefixed ID
            let original_id = origin["original_node_id"].as_str().unwrap();
            assert!(
                original_id == "inner_a" || original_id == "inner_b",
                "unexpected original_node_id: {}",
                original_id
            );
        }

        // Verify specific nodes
        let inner_a = result.nodes.iter().find(|n| n.id == "my_sg/inner_a").unwrap();
        assert_eq!(
            inner_a.metadata["subgraph_origin"]["original_node_id"],
            json!("inner_a")
        );
        let inner_b = result.nodes.iter().find(|n| n.id == "my_sg/inner_b").unwrap();
        assert_eq!(
            inner_b.metadata["subgraph_origin"]["original_node_id"],
            json!("inner_b")
        );
    }

    // ──────────────────────────────────────────────────────
    // 13. Version pin: expand with exact version
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_with_version_pin() {
        // Register two versions of the same template
        let v1 = GraphTemplate {
            id: "sub".into(),
            version: "1.0".into(),
            description: Some("Version 1".into()),
            inputs_schema: json!({}),
            nodes: vec![make_node("only_v1", "echo", vec![])],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        let v2 = GraphTemplate {
            id: "sub".into(),
            version: "2.0".into(),
            description: Some("Version 2".into()),
            inputs_schema: json!({}),
            nodes: vec![
                make_node("first_v2", "echo", vec![]),
                make_node("second_v2", "echo", vec!["first_v2"]),
            ],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        // Register v1 first, then v2 (v2 becomes the "latest" in unversioned lookup)
        let mut provider = MapProvider::new();
        provider.add(v1);
        provider.add(v2);

        // Parent pinning to version "1.0"
        let parent = GraphTemplate {
            id: "parent".into(),
            version: "1.0".into(),
            description: None,
            inputs_schema: json!({}),
            nodes: vec![NodeTemplate {
                id: "s".into(),
                tool: String::new(),
                depends_on: vec![],
                input_bindings: json!({}),
                output_spec: None,
                retry_policy: None,
                timeout_seconds: None,
                repair_policy: None,
                execution_mode: Default::default(),
                skip_condition: None,
                subgraph: Some(SubgraphRef {
                    template_id: "sub".into(),
                    version: Some("1.0".into()),
                    input_map: json!({}),
                }),
                metadata: Default::default(),
            }],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        let result = expand_subgraphs(&parent, &provider).unwrap();

        // v1 has 1 node ("only_v1"), v2 has 2 nodes.
        // Since we pinned to v1, we should get exactly 1 expanded node.
        assert_eq!(result.nodes.len(), 1);
        assert_eq!(result.nodes[0].id, "s/only_v1");
    }

    // ──────────────────────────────────────────────────────
    // 14. No version pin: uses latest (whatever get_template returns)
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_without_version_uses_latest() {
        let v1 = GraphTemplate {
            id: "sub".into(),
            version: "1.0".into(),
            description: None,
            inputs_schema: json!({}),
            nodes: vec![make_node("only_v1", "echo", vec![])],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        let v2 = GraphTemplate {
            id: "sub".into(),
            version: "2.0".into(),
            description: None,
            inputs_schema: json!({}),
            nodes: vec![
                make_node("first_v2", "echo", vec![]),
                make_node("second_v2", "echo", vec!["first_v2"]),
            ],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        let mut provider = MapProvider::new();
        provider.add(v1);
        provider.add(v2); // v2 overwrites "sub" in the unversioned map

        // Parent with no version pin
        let parent = make_template(
            "parent",
            vec![make_subgraph_node("s", "sub", json!({}), vec![])],
            vec![],
        );

        let result = expand_subgraphs(&parent, &provider).unwrap();

        // Unversioned lookup returns v2 (last registered), which has 2 nodes
        assert_eq!(result.nodes.len(), 2);
        let ids: Vec<&str> = result.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"s/first_v2"));
        assert!(ids.contains(&"s/second_v2"));
    }

    // ──────────────────────────────────────────────────────
    // 15. Version not found → clear error
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_version_not_found_error() {
        let v1 = GraphTemplate {
            id: "sub".into(),
            version: "1.0".into(),
            description: None,
            inputs_schema: json!({}),
            nodes: vec![make_node("leaf", "echo", vec![])],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        let mut provider = MapProvider::new();
        provider.add(v1);

        // Parent pins to version "3.0" which doesn't exist
        let parent = GraphTemplate {
            id: "parent".into(),
            version: "1.0".into(),
            description: None,
            inputs_schema: json!({}),
            nodes: vec![NodeTemplate {
                id: "s".into(),
                tool: String::new(),
                depends_on: vec![],
                input_bindings: json!({}),
                output_spec: None,
                retry_policy: None,
                timeout_seconds: None,
                repair_policy: None,
                execution_mode: Default::default(),
                skip_condition: None,
                subgraph: Some(SubgraphRef {
                    template_id: "sub".into(),
                    version: Some("3.0".into()),
                    input_map: json!({}),
                }),
                metadata: Default::default(),
            }],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        let err = expand_subgraphs(&parent, &provider).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("version") && msg.contains("3.0") && msg.contains("not found"),
            "Expected version not found error, got: {}",
            msg
        );
    }

    // ──────────────────────────────────────────────────────
    // 16. Nested subgraphs with version pins
    // ──────────────────────────────────────────────────────
    #[test]
    fn test_expand_nested_with_versions() {
        // Inner template "B" v2.0
        let b_v2 = GraphTemplate {
            id: "B".into(),
            version: "2.0".into(),
            description: None,
            inputs_schema: json!({}),
            nodes: vec![make_node("b_leaf", "echo", vec![])],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        // Middle template "A" v1.0 — pins subgraph B@2.0
        let a_v1 = GraphTemplate {
            id: "A".into(),
            version: "1.0".into(),
            description: None,
            inputs_schema: json!({}),
            nodes: vec![NodeTemplate {
                id: "ref_b".into(),
                tool: String::new(),
                depends_on: vec![],
                input_bindings: json!({}),
                output_spec: None,
                retry_policy: None,
                timeout_seconds: None,
                repair_policy: None,
                execution_mode: Default::default(),
                skip_condition: None,
                subgraph: Some(SubgraphRef {
                    template_id: "B".into(),
                    version: Some("2.0".into()),
                    input_map: json!({}),
                }),
                metadata: Default::default(),
            }],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        let mut provider = MapProvider::new();
        provider.add(b_v2);
        provider.add(a_v1);

        // Parent pins subgraph A@1.0
        let parent = GraphTemplate {
            id: "parent".into(),
            version: "1.0".into(),
            description: None,
            inputs_schema: json!({}),
            nodes: vec![NodeTemplate {
                id: "ref_a".into(),
                tool: String::new(),
                depends_on: vec![],
                input_bindings: json!({}),
                output_spec: None,
                retry_policy: None,
                timeout_seconds: None,
                repair_policy: None,
                execution_mode: Default::default(),
                skip_condition: None,
                subgraph: Some(SubgraphRef {
                    template_id: "A".into(),
                    version: Some("1.0".into()),
                    input_map: json!({}),
                }),
                metadata: Default::default(),
            }],
            outputs: vec![],
            metadata: Default::default(),
            rewrite_rules: vec![],
        };

        let result = expand_subgraphs(&parent, &provider).unwrap();

        // Parent → A@1.0 → B@2.0 → b_leaf
        // Fully flattened: ref_a/ref_b/b_leaf
        assert_eq!(result.nodes.len(), 1);
        assert_eq!(result.nodes[0].id, "ref_a/ref_b/b_leaf");
    }
}
