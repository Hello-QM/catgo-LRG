use crate::core::state::NodeStatus;
use crate::core::errors::EngineError;
use crate::graph::run::NodeRun;

/// Transition a node's status, enforcing the state machine.
/// Returns `EngineError::InvalidTransition` if the transition is not allowed.
pub fn transition_node(
    node: &mut NodeRun,
    target: NodeStatus,
) -> Result<(), EngineError> {
    if !node.status.can_transition_to(target) {
        return Err(EngineError::InvalidTransition {
            node_id: node.node_id.clone(),
            from: node.status,
            to: target,
        });
    }
    node.status = target;
    // Set timestamps based on the target state
    match target {
        NodeStatus::Running => {
            node.started_at = Some(crate::core::time::now());
        }
        NodeStatus::Repairing => {
            // Clear finished_at since the node is being actively worked on again
            node.finished_at = None;
        }
        s if s.is_terminal() => {
            node.finished_at = Some(crate::core::time::now());
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::state::NodeStatus;
    use crate::graph::run::NodeRun;

    fn make_node(status: NodeStatus) -> NodeRun {
        let mut nr = NodeRun::new("test_node".to_string());
        nr.status = status;
        nr
    }

    #[test]
    fn test_valid_pending_to_ready() {
        let mut node = make_node(NodeStatus::Pending);
        assert!(transition_node(&mut node, NodeStatus::Ready).is_ok());
        assert_eq!(node.status, NodeStatus::Ready);
    }

    #[test]
    fn test_valid_ready_to_running() {
        let mut node = make_node(NodeStatus::Ready);
        let result = transition_node(&mut node, NodeStatus::Running);
        assert!(result.is_ok());
        assert_eq!(node.status, NodeStatus::Running);
        assert!(node.started_at.is_some());
    }

    #[test]
    fn test_valid_running_to_succeeded() {
        let mut node = make_node(NodeStatus::Running);
        let result = transition_node(&mut node, NodeStatus::Succeeded);
        assert!(result.is_ok());
        assert_eq!(node.status, NodeStatus::Succeeded);
        assert!(node.finished_at.is_some());
    }

    #[test]
    fn test_valid_running_to_failed() {
        let mut node = make_node(NodeStatus::Running);
        let result = transition_node(&mut node, NodeStatus::Failed);
        assert!(result.is_ok());
        assert_eq!(node.status, NodeStatus::Failed);
        assert!(node.finished_at.is_some());
    }

    #[test]
    fn test_valid_pending_to_blocked() {
        let mut node = make_node(NodeStatus::Pending);
        let result = transition_node(&mut node, NodeStatus::Blocked);
        assert!(result.is_ok());
        assert_eq!(node.status, NodeStatus::Blocked);
        assert!(node.finished_at.is_some());
    }

    #[test]
    fn test_invalid_pending_to_running() {
        let mut node = make_node(NodeStatus::Pending);
        let result = transition_node(&mut node, NodeStatus::Running);
        assert!(result.is_err());
        match result.unwrap_err() {
            EngineError::InvalidTransition { node_id, from, to } => {
                assert_eq!(node_id, "test_node");
                assert_eq!(from, NodeStatus::Pending);
                assert_eq!(to, NodeStatus::Running);
            }
            other => panic!("Expected InvalidTransition, got {:?}", other),
        }
    }

    #[test]
    fn test_invalid_succeeded_to_running() {
        let mut node = make_node(NodeStatus::Succeeded);
        let result = transition_node(&mut node, NodeStatus::Running);
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_failed_to_pending() {
        let mut node = make_node(NodeStatus::Failed);
        let result = transition_node(&mut node, NodeStatus::Pending);
        assert!(result.is_err());
    }

    #[test]
    fn test_valid_running_to_repairing() {
        let mut node = make_node(NodeStatus::Running);
        assert!(transition_node(&mut node, NodeStatus::Repairing).is_ok());
        assert_eq!(node.status, NodeStatus::Repairing);
    }

    #[test]
    fn test_valid_repairing_to_ready() {
        let mut node = make_node(NodeStatus::Repairing);
        assert!(transition_node(&mut node, NodeStatus::Ready).is_ok());
        assert_eq!(node.status, NodeStatus::Ready);
    }

    #[test]
    fn test_valid_repairing_to_failed() {
        let mut node = make_node(NodeStatus::Repairing);
        assert!(transition_node(&mut node, NodeStatus::Failed).is_ok());
        assert_eq!(node.status, NodeStatus::Failed);
    }

    #[test]
    fn test_full_lifecycle_pending_to_succeeded() {
        let mut node = make_node(NodeStatus::Pending);
        transition_node(&mut node, NodeStatus::Ready).unwrap();
        transition_node(&mut node, NodeStatus::Running).unwrap();
        transition_node(&mut node, NodeStatus::Succeeded).unwrap();
        assert_eq!(node.status, NodeStatus::Succeeded);
        assert!(node.started_at.is_some());
        assert!(node.finished_at.is_some());
    }

    #[test]
    fn test_blocked_is_final() {
        // Blocked is terminal: no transition should be allowed from it
        let mut node = make_node(NodeStatus::Blocked);
        let all_targets = [
            NodeStatus::Pending,
            NodeStatus::Ready,
            NodeStatus::Running,
            NodeStatus::Repairing,
            NodeStatus::Succeeded,
            NodeStatus::Failed,
            NodeStatus::Blocked,
            NodeStatus::Skipped,
            NodeStatus::Cancelled,
        ];
        for target in &all_targets {
            let result = transition_node(&mut node, *target);
            assert!(
                result.is_err(),
                "Blocked -> {:?} should be rejected",
                target,
            );
            // Status must remain Blocked after each failed attempt
            assert_eq!(node.status, NodeStatus::Blocked);
        }
    }

    #[test]
    fn test_skipped_is_final() {
        // Skipped is terminal: no transition should be allowed from it
        let mut node = make_node(NodeStatus::Skipped);
        let all_targets = [
            NodeStatus::Pending,
            NodeStatus::Ready,
            NodeStatus::Running,
            NodeStatus::Repairing,
            NodeStatus::Succeeded,
            NodeStatus::Failed,
            NodeStatus::Blocked,
            NodeStatus::Skipped,
            NodeStatus::Cancelled,
        ];
        for target in &all_targets {
            let result = transition_node(&mut node, *target);
            assert!(
                result.is_err(),
                "Skipped -> {:?} should be rejected",
                target,
            );
            assert_eq!(node.status, NodeStatus::Skipped);
        }
    }

    #[test]
    fn test_cancelled_is_final() {
        // Cancelled is terminal: no transition should be allowed from it
        let mut node = make_node(NodeStatus::Cancelled);
        let all_targets = [
            NodeStatus::Pending,
            NodeStatus::Ready,
            NodeStatus::Running,
            NodeStatus::Repairing,
            NodeStatus::Succeeded,
            NodeStatus::Failed,
            NodeStatus::Blocked,
            NodeStatus::Skipped,
            NodeStatus::Cancelled,
        ];
        for target in &all_targets {
            let result = transition_node(&mut node, *target);
            assert!(
                result.is_err(),
                "Cancelled -> {:?} should be rejected",
                target,
            );
            assert_eq!(node.status, NodeStatus::Cancelled);
        }
    }

    #[test]
    fn test_succeeded_is_final() {
        // Succeeded is terminal: no transition should be allowed from it
        let mut node = make_node(NodeStatus::Succeeded);
        let all_targets = [
            NodeStatus::Pending,
            NodeStatus::Ready,
            NodeStatus::Running,
            NodeStatus::Repairing,
            NodeStatus::Succeeded,
            NodeStatus::Failed,
            NodeStatus::Blocked,
            NodeStatus::Skipped,
            NodeStatus::Cancelled,
        ];
        for target in &all_targets {
            let result = transition_node(&mut node, *target);
            assert!(
                result.is_err(),
                "Succeeded -> {:?} should be rejected",
                target,
            );
            assert_eq!(node.status, NodeStatus::Succeeded);
        }
    }

    #[test]
    fn test_ready_to_skipped() {
        // Ready -> Skipped is a valid transition (e.g. conditional skip)
        let mut node = make_node(NodeStatus::Ready);
        let result = transition_node(&mut node, NodeStatus::Skipped);
        assert!(result.is_ok(), "Ready -> Skipped should be valid");
        assert_eq!(node.status, NodeStatus::Skipped);
        // Skipped is terminal, so finished_at should be set
        assert!(node.finished_at.is_some());
    }

    #[test]
    fn test_running_to_cancelled() {
        // Running -> Cancelled is a valid transition (e.g. user cancellation)
        let mut node = make_node(NodeStatus::Running);
        let result = transition_node(&mut node, NodeStatus::Cancelled);
        assert!(result.is_ok(), "Running -> Cancelled should be valid");
        assert_eq!(node.status, NodeStatus::Cancelled);
        // Cancelled is terminal, so finished_at should be set
        assert!(node.finished_at.is_some());
    }

    #[test]
    fn test_timestamps_not_set_for_pending_to_ready() {
        // Pending -> Ready should NOT set started_at or finished_at
        let mut node = make_node(NodeStatus::Pending);
        assert!(node.started_at.is_none());
        assert!(node.finished_at.is_none());

        transition_node(&mut node, NodeStatus::Ready).unwrap();

        assert_eq!(node.status, NodeStatus::Ready);
        // started_at is only set when transitioning to Running
        assert!(
            node.started_at.is_none(),
            "started_at should remain None after Pending -> Ready",
        );
        // finished_at is only set when transitioning to a terminal state
        assert!(
            node.finished_at.is_none(),
            "finished_at should remain None after Pending -> Ready",
        );
    }
}
