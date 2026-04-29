use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::core::errors::EngineError;
use crate::core::ids::{GraphRunId, NodeId};
use crate::core::state::{AttemptStatus, GraphRunStatus, NodeStatus};
use crate::graph::composer::TemplateProvider;
use crate::graph::resolver;
use crate::graph::run::{GraphRun, NodeAttempt, ToolExecutionResult};
use crate::graph::rewrite::{self, RewriteLimits};
use crate::graph::template::{BackoffPolicy, GraphTemplate};
use crate::repair::{RepairContext, RepairRegistry};
use crate::runtime::lifecycle;
use crate::runtime::scheduler;
use crate::storage::traits::{ArtifactStore, StateStore};
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::ToolExecutionContext;

/// Events emitted during execution (for monitoring / UI updates).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "event_type", rename_all = "snake_case")]
pub enum ExecutionEvent {
    NodeStateChanged {
        node_id: NodeId,
        old_status: NodeStatus,
        new_status: NodeStatus,
    },
    GraphStateChanged {
        run_id: GraphRunId,
        status: GraphRunStatus,
    },
    NodeLog {
        node_id: NodeId,
        message: String,
    },
    RewriteApplied {
        event_id: String,
        rule_id: String,
        source_node: NodeId,
        injected_node_ids: Vec<NodeId>,
    },
    NodeRetryScheduled {
        node_id: NodeId,
        attempt: u32,
        backoff_seconds: u64,
    },
    NodeRepairStarted {
        node_id: NodeId,
        repair_attempt: u32,
        handler: String,
    },
    NodeRepairCompleted {
        node_id: NodeId,
        success: bool,
    },
}

/// Execute a graph run to completion.
///
/// This is the main execution loop. It:
/// 1. Finds ready nodes (all deps succeeded)
/// 2. Transitions them through Pending -> Ready -> Running
/// 3. Spawns tool execution as async tasks via `JoinSet`
/// 4. Collects results, handles retries, and propagates failures
/// 5. Determines the final graph status when all nodes are terminal
pub async fn execute_run(
    run: &mut GraphRun,
    template: &GraphTemplate,
    registry: &ToolRegistry,
    state_store: &dyn StateStore,
    _artifact_store: &dyn ArtifactStore,
    repair_registry: &RepairRegistry,
    max_concurrent: usize,
    event_tx: Option<mpsc::UnboundedSender<ExecutionEvent>>,
    template_provider: Option<&dyn TemplateProvider>,
    cancel_token: Option<CancellationToken>,
) -> Result<(), EngineError> {
    let mut live_template = template.clone();

    // Clone the run ID once upfront to avoid borrow conflicts
    let run_id = run.id.clone();

    run.status = GraphRunStatus::Running;
    state_store.save_graph_run(run)?;
    emit(
        &event_tx,
        ExecutionEvent::GraphStateChanged {
            run_id: run_id.clone(),
            status: run.status,
        },
    );

    let mut join_set: JoinSet<(NodeId, Result<ToolExecutionResult, crate::core::StructuredError>)> =
        JoinSet::new();
    let mut in_flight = 0usize;

    loop {
        // Check cancellation before scheduling new work
        if cancel_token.as_ref().is_some_and(|t| t.is_cancelled()) {
            // Drain in-flight tasks (let them finish with a timeout)
            while in_flight > 0 {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    join_set.join_next(),
                )
                .await
                {
                    Ok(Some(Ok((node_id, result)))) => {
                        in_flight -= 1;
                        // Record result for completed tasks
                        if let Some(nr) = run.node_run_mut(&node_id) {
                            match result {
                                Ok(res) => {
                                    if let Some(attempt) = nr.attempts.last_mut() {
                                        attempt.status = AttemptStatus::Succeeded;
                                        attempt.finished_at = Some(crate::core::time::now());
                                    }
                                    nr.outputs = Some(res.outputs);
                                    nr.artifacts = res.artifacts;
                                    let _ = lifecycle::transition_node(nr, NodeStatus::Succeeded);
                                }
                                Err(_) => {
                                    // Reset to Pending for re-execution on resume
                                    nr.status = NodeStatus::Pending;
                                    nr.started_at = None;
                                    nr.finished_at = None;
                                }
                            }
                        }
                    }
                    Ok(Some(Err(_))) | Ok(None) => {
                        in_flight = in_flight.saturating_sub(1);
                    }
                    Err(_timeout) => {
                        // Timeout waiting for tasks; reset remaining running nodes
                        for nr in &mut run.node_runs {
                            if nr.status == NodeStatus::Running {
                                nr.status = NodeStatus::Pending;
                                nr.started_at = None;
                                nr.finished_at = None;
                            }
                        }
                        break;
                    }
                }
            }

            run.status = GraphRunStatus::Paused;
            run.updated_at = crate::core::time::now();
            state_store.save_graph_run(run)?;
            emit(
                &event_tx,
                ExecutionEvent::GraphStateChanged {
                    run_id: run_id.clone(),
                    status: GraphRunStatus::Paused,
                },
            );
            return Ok(());
        }

        // 1a. Evaluate skip conditions before finding ready nodes
        scheduler::process_skip_conditions(run, &live_template);

        // 1b. Find ready nodes, promote Pending -> Ready -> Running
        let ready = scheduler::find_ready_nodes(run, &live_template);
        let slots = max_concurrent.saturating_sub(in_flight);

        for node_id in ready.into_iter().take(slots) {
            // Find NodeTemplate
            let node_tmpl = live_template
                .nodes
                .iter()
                .find(|n| n.id == node_id)
                .expect("scheduler returned a node_id that doesn't exist in template");

            // Transition: Pending -> Ready -> Running
            if let Some(nr) = run.node_run_mut(&node_id) {
                lifecycle::transition_node(nr, NodeStatus::Ready)?;
                lifecycle::transition_node(nr, NodeStatus::Running)?;
                nr.current_attempt += 1;
            }

            // Resolve inputs
            let resolved = resolver::resolve_inputs(run, node_tmpl)?;
            if let Some(nr) = run.node_run_mut(&node_id) {
                nr.resolved_inputs = Some(resolved.clone());
            }

            // Build context
            let attempt_index = run
                .node_run(&node_id)
                .map(|n| n.current_attempt)
                .unwrap_or(1);
            let ctx = ToolExecutionContext {
                run_id: run_id.clone(),
                node_id: node_id.clone(),
                attempt_index,
                work_dir: format!("{}/{}", run.run_dir, node_id),
            };

            // Look up tool
            let tool = registry.get(&node_tmpl.tool).ok_or_else(|| {
                EngineError::ToolNotFound {
                    tool_name: node_tmpl.tool.clone(),
                }
            })?;

            // Create attempt record
            let attempt = NodeAttempt {
                attempt_index: ctx.attempt_index,
                status: AttemptStatus::Running,
                started_at: crate::core::time::now(),
                finished_at: None,
                tool_request: resolved.clone(),
                tool_result: None,
                logs_path: None,
                error: None,
            };
            if let Some(nr) = run.node_run_mut(&node_id) {
                nr.attempts.push(attempt);
            }
            // Persist after releasing the mutable borrow
            if let Some(nr) = run.node_run(&node_id) {
                state_store.update_node_run(&run_id, nr)?;
            }

            emit(
                &event_tx,
                ExecutionEvent::NodeStateChanged {
                    node_id: node_id.clone(),
                    old_status: NodeStatus::Pending,
                    new_status: NodeStatus::Running,
                },
            );

            // Spawn tool execution
            let nid = node_id.clone();
            let tool = Arc::clone(&tool);
            join_set.spawn(async move {
                let result = tool.execute(ctx, resolved).await;
                (nid, result)
            });
            in_flight += 1;
        }

        // If nothing in flight, check terminal condition
        if in_flight == 0 {
            if scheduler::is_terminal(run) {
                break;
            }
            // Check if there are pending nodes that can never run (blocked by failures)
            let has_pending = run
                .node_runs
                .iter()
                .any(|n| n.status == NodeStatus::Pending);
            if has_pending {
                // Propagate failure from all failed and skipped nodes
                let terminal_blockers: Vec<NodeId> = run
                    .node_runs
                    .iter()
                    .filter(|n| n.status == NodeStatus::Failed || n.status == NodeStatus::Skipped)
                    .map(|n| n.node_id.clone())
                    .collect();
                for id in &terminal_blockers {
                    scheduler::propagate_failure(run, id, &live_template);
                }
                state_store.save_graph_run(run)?;
                if scheduler::is_terminal(run) {
                    break;
                }
            }
            break; // Safety: avoid infinite loop
        }

        // Wait for one task to complete
        if let Some(join_result) = join_set.join_next().await {
            in_flight -= 1;
            let (node_id, tool_result) = match join_result {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!("Task panicked: {e}");
                    continue;
                }
            };

            let node_tmpl = live_template
                .nodes
                .iter()
                .find(|n| n.id == node_id)
                .expect("completed node_id doesn't exist in template");
            let retry_policy = node_tmpl.retry_policy.clone().unwrap_or_default();

            match tool_result {
                Ok(result) => {
                    // Record success: mutate the node run, then persist with immutable borrow
                    if let Some(nr) = run.node_run_mut(&node_id) {
                        if let Some(attempt) = nr.attempts.last_mut() {
                            attempt.status = AttemptStatus::Succeeded;
                            attempt.finished_at = Some(crate::core::time::now());
                            attempt.tool_result = Some(result.clone());
                        }
                        nr.outputs = Some(result.outputs);
                        nr.artifacts = result.artifacts;
                        lifecycle::transition_node(nr, NodeStatus::Succeeded)?;
                    }
                    // Persist after releasing mutable borrow
                    if let Some(nr) = run.node_run(&node_id) {
                        state_store.update_node_run(&run_id, nr)?;
                    }
                    emit(
                        &event_tx,
                        ExecutionEvent::NodeStateChanged {
                            node_id: node_id.clone(),
                            old_status: NodeStatus::Running,
                            new_status: NodeStatus::Succeeded,
                        },
                    );

                    // === Dynamic rewrite evaluation ===
                    if let Some(provider) = template_provider {
                        if !live_template.rewrite_rules.is_empty() {
                            let outputs = run.node_run(&node_id)
                                .and_then(|nr| nr.outputs.as_ref())
                                .cloned()
                                .unwrap_or(serde_json::Value::Null);

                            let triggered: Vec<crate::graph::rewrite::RewriteRule> = rewrite::check_rewrite_rules(
                                &live_template.rewrite_rules,
                                &node_id,
                                &outputs,
                                &run.rewrite_events,
                            ).into_iter().cloned().collect();

                            let limits = RewriteLimits::default();
                            for rule in &triggered {
                                match rewrite::apply_rewrite(
                                    rule, &outputs, run, &mut live_template, provider, &limits,
                                ) {
                                    Ok(event) => {
                                        state_store.save_graph_run(run)?;
                                        emit(
                                            &event_tx,
                                            ExecutionEvent::RewriteApplied {
                                                event_id: event.event_id.clone(),
                                                rule_id: event.rule_id.clone(),
                                                source_node: node_id.clone(),
                                                injected_node_ids: event.injected_node_ids.clone(),
                                            },
                                        );
                                        tracing::info!(
                                            "Rewrite rule '{}' fired on node '{}': injected {} nodes",
                                            event.rule_id,
                                            node_id,
                                            event.injected_node_ids.len(),
                                        );
                                    }
                                    Err(e) => {
                                        tracing::warn!(
                                            "Rewrite rule '{}' failed on node '{}': {}",
                                            rule.rule_id,
                                            node_id,
                                            e,
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                Err(err) => {
                    // Determine retry eligibility before mutating
                    let can_retry = err.retryable
                        && run
                            .node_run(&node_id)
                            .map(|n| n.current_attempt)
                            .unwrap_or(0)
                            < retry_policy.max_attempts;

                    // Track backoff info we may need after releasing the borrow
                    let mut backoff_secs = 0u64;

                    // Record failure in the attempt
                    if let Some(nr) = run.node_run_mut(&node_id) {
                        if let Some(attempt) = nr.attempts.last_mut() {
                            attempt.status = AttemptStatus::Failed;
                            attempt.finished_at = Some(crate::core::time::now());
                            attempt.error = Some(err.clone());
                        }
                        nr.last_error = Some(err.clone());

                        if can_retry {
                            // Intentional bypass: Running → Pending to re-enter scheduler
                            // for retry. The state machine has no Running → Pending path
                            // because this is a reset operation, not a normal transition.
                            nr.status = NodeStatus::Pending;
                            nr.started_at = None;
                            nr.finished_at = None;

                            backoff_secs = match &retry_policy.backoff {
                                BackoffPolicy::None => 0,
                                BackoffPolicy::Fixed { seconds } => *seconds,
                                BackoffPolicy::Exponential {
                                    base_seconds,
                                    max_seconds,
                                } => {
                                    let exp = base_seconds.saturating_mul(
                                        2u64.saturating_pow(nr.current_attempt.saturating_sub(1)),
                                    );
                                    exp.min(*max_seconds)
                                }
                            };
                        } else {
                            lifecycle::transition_node(nr, NodeStatus::Failed)?;
                        }
                    }

                    // Persist after releasing mutable borrow
                    if let Some(nr) = run.node_run(&node_id) {
                        state_store.update_node_run(&run_id, nr)?;
                    }

                    if can_retry {
                        let attempt_num = run.node_run(&node_id)
                            .map(|n| n.current_attempt)
                            .unwrap_or(1);
                        emit(
                            &event_tx,
                            ExecutionEvent::NodeRetryScheduled {
                                node_id: node_id.clone(),
                                attempt: attempt_num + 1,
                                backoff_seconds: backoff_secs,
                            },
                        );

                        if backoff_secs > 0 {
                            tokio::time::sleep(std::time::Duration::from_secs(backoff_secs))
                                .await;
                        }
                    } else {
                        // Try repair if a repair_policy is configured and within attempt limit
                        let mut repaired = false;
                        if let Some(repair_ref) = &node_tmpl.repair_policy {
                            let repair_count = run.node_run(&node_id)
                                .map(|n| n.repair_count)
                                .unwrap_or(0);
                            if repair_count >= repair_ref.max_repair_attempts {
                                tracing::warn!(
                                    "Node '{}' exceeded max repair attempts ({}/{})",
                                    node_id, repair_count, repair_ref.max_repair_attempts,
                                );
                            } else if let Some(handler) = repair_registry.get(&repair_ref.handler) {
                                // Transition to Repairing via lifecycle (Failed → Repairing)
                                if let Some(nr) = run.node_run_mut(&node_id) {
                                    nr.repair_count += 1;
                                    lifecycle::transition_node(nr, NodeStatus::Repairing)?;
                                }
                                state_store.save_graph_run(run)?;
                                emit(
                                    &event_tx,
                                    ExecutionEvent::NodeStateChanged {
                                        node_id: node_id.clone(),
                                        old_status: NodeStatus::Failed,
                                        new_status: NodeStatus::Repairing,
                                    },
                                );
                                let current_repair_count = run.node_run(&node_id)
                                    .map(|n| n.repair_count)
                                    .unwrap_or(1);
                                emit(
                                    &event_tx,
                                    ExecutionEvent::NodeRepairStarted {
                                        node_id: node_id.clone(),
                                        repair_attempt: current_repair_count,
                                        handler: repair_ref.handler.clone(),
                                    },
                                );

                                let ctx = RepairContext {
                                    run_id: run_id.clone(),
                                    node_id: node_id.clone(),
                                    work_dir: format!("{}/{}", run.run_dir, node_id),
                                };
                                let nr_snapshot = run.node_run(&node_id).unwrap().clone();

                                match handler.repair(ctx, &nr_snapshot).await {
                                    Ok(outcome) => {
                                        if let Some(nr) = run.node_run_mut(&node_id) {
                                            // Intentional bypass: Repairing → Pending to re-enter
                                            // scheduler after successful repair. The state machine
                                            // has no Repairing → Pending path because this is a
                                            // reset operation, not a normal transition.
                                            nr.status = NodeStatus::Pending;
                                            nr.started_at = None;
                                            nr.finished_at = None;
                                            if let Some(inputs) = outcome.repaired_inputs {
                                                nr.resolved_inputs = Some(inputs);
                                            }
                                            nr.artifacts.extend(outcome.artifacts);
                                        }
                                        state_store.save_graph_run(run)?;
                                        repaired = true;
                                        emit(
                                            &event_tx,
                                            ExecutionEvent::NodeRepairCompleted {
                                                node_id: node_id.clone(),
                                                success: true,
                                            },
                                        );
                                    }
                                    Err(repair_err) => {
                                        // Repair failed — transition to Failed via lifecycle
                                        // (Repairing → Failed sets finished_at)
                                        if let Some(nr) = run.node_run_mut(&node_id) {
                                            lifecycle::transition_node(nr, NodeStatus::Failed)?;
                                            nr.last_error = Some(repair_err);
                                        }
                                        emit(
                                            &event_tx,
                                            ExecutionEvent::NodeRepairCompleted {
                                                node_id: node_id.clone(),
                                                success: false,
                                            },
                                        );
                                    }
                                }
                            }
                        }

                        if !repaired {
                            // Propagate failure to downstream nodes
                            scheduler::propagate_failure(run, &node_id, &live_template);
                            state_store.save_graph_run(run)?;
                            emit(
                                &event_tx,
                                ExecutionEvent::NodeStateChanged {
                                    node_id: node_id.clone(),
                                    old_status: NodeStatus::Running,
                                    new_status: NodeStatus::Failed,
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    // Determine final status
    let final_status = scheduler::determine_run_status(run);
    run.status = final_status;
    run.updated_at = crate::core::time::now();
    state_store.save_graph_run(run)?;
    emit(
        &event_tx,
        ExecutionEvent::GraphStateChanged {
            run_id: run_id.clone(),
            status: final_status,
        },
    );
    Ok(())
}

fn emit(tx: &Option<mpsc::UnboundedSender<ExecutionEvent>>, event: ExecutionEvent) {
    if let Some(tx) = tx {
        let _ = tx.send(event);
    }
}
