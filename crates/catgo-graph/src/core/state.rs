use serde::{Deserialize, Serialize};

/// Node lifecycle states (9 states)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Pending,
    Ready,
    Running,
    Repairing,
    Succeeded,
    Failed,
    Blocked,
    Skipped,
    Cancelled,
}

impl NodeStatus {
    /// Check if this is a terminal state
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Blocked | Self::Skipped | Self::Cancelled)
    }

    /// Check if transition to `target` is allowed per the state machine
    pub fn can_transition_to(&self, target: NodeStatus) -> bool {
        matches!(
            (self, target),
            (NodeStatus::Pending, NodeStatus::Ready)
                | (NodeStatus::Pending, NodeStatus::Blocked)
                | (NodeStatus::Ready, NodeStatus::Running)
                | (NodeStatus::Ready, NodeStatus::Skipped)
                | (NodeStatus::Running, NodeStatus::Succeeded)
                | (NodeStatus::Running, NodeStatus::Failed)
                | (NodeStatus::Running, NodeStatus::Repairing)
                | (NodeStatus::Running, NodeStatus::Cancelled)
                | (NodeStatus::Repairing, NodeStatus::Ready)
                | (NodeStatus::Repairing, NodeStatus::Failed)
                | (NodeStatus::Failed, NodeStatus::Repairing)
        )
    }
}

/// Graph-level run status (8 states)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphRunStatus {
    Created,
    Validated,
    Running,
    Paused,
    Succeeded,
    Failed,
    Cancelled,
    PartiallySucceeded,
}

impl GraphRunStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled | Self::PartiallySucceeded)
    }
}

/// Status of a single attempt
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatus {
    Running,
    Succeeded,
    Failed,
    Repaired,
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_status_terminal_states() {
        // Terminal states
        assert!(NodeStatus::Succeeded.is_terminal());
        assert!(NodeStatus::Failed.is_terminal());
        assert!(NodeStatus::Blocked.is_terminal());
        assert!(NodeStatus::Skipped.is_terminal());
        assert!(NodeStatus::Cancelled.is_terminal());

        // Non-terminal states
        assert!(!NodeStatus::Pending.is_terminal());
        assert!(!NodeStatus::Ready.is_terminal());
        assert!(!NodeStatus::Running.is_terminal());
        assert!(!NodeStatus::Repairing.is_terminal());
    }

    #[test]
    fn test_valid_transitions_from_pending() {
        assert!(NodeStatus::Pending.can_transition_to(NodeStatus::Ready));
        assert!(NodeStatus::Pending.can_transition_to(NodeStatus::Blocked));
    }

    #[test]
    fn test_valid_transitions_from_ready() {
        assert!(NodeStatus::Ready.can_transition_to(NodeStatus::Running));
        assert!(NodeStatus::Ready.can_transition_to(NodeStatus::Skipped));
    }

    #[test]
    fn test_valid_transitions_from_running() {
        assert!(NodeStatus::Running.can_transition_to(NodeStatus::Succeeded));
        assert!(NodeStatus::Running.can_transition_to(NodeStatus::Failed));
        assert!(NodeStatus::Running.can_transition_to(NodeStatus::Repairing));
        assert!(NodeStatus::Running.can_transition_to(NodeStatus::Cancelled));
    }

    #[test]
    fn test_valid_transitions_from_repairing() {
        assert!(NodeStatus::Repairing.can_transition_to(NodeStatus::Ready));
        assert!(NodeStatus::Repairing.can_transition_to(NodeStatus::Failed));
    }

    #[test]
    fn test_valid_failed_to_repairing() {
        assert!(NodeStatus::Failed.can_transition_to(NodeStatus::Repairing));
    }

    #[test]
    fn test_invalid_transitions() {
        // Cannot go backwards from terminal states (except Failed → Repairing for repair flow)
        assert!(!NodeStatus::Succeeded.can_transition_to(NodeStatus::Running));
        assert!(!NodeStatus::Failed.can_transition_to(NodeStatus::Running));
        assert!(!NodeStatus::Cancelled.can_transition_to(NodeStatus::Pending));
        assert!(!NodeStatus::Blocked.can_transition_to(NodeStatus::Ready));
        assert!(!NodeStatus::Skipped.can_transition_to(NodeStatus::Ready));

        // Cannot skip states
        assert!(!NodeStatus::Pending.can_transition_to(NodeStatus::Running));
        assert!(!NodeStatus::Pending.can_transition_to(NodeStatus::Succeeded));
        assert!(!NodeStatus::Ready.can_transition_to(NodeStatus::Succeeded));
        assert!(!NodeStatus::Ready.can_transition_to(NodeStatus::Failed));

        // Self-transitions are not allowed
        assert!(!NodeStatus::Pending.can_transition_to(NodeStatus::Pending));
        assert!(!NodeStatus::Running.can_transition_to(NodeStatus::Running));

        // Invalid cross-state transitions
        assert!(!NodeStatus::Running.can_transition_to(NodeStatus::Ready));
        assert!(!NodeStatus::Running.can_transition_to(NodeStatus::Blocked));
        assert!(!NodeStatus::Repairing.can_transition_to(NodeStatus::Succeeded));
        assert!(!NodeStatus::Repairing.can_transition_to(NodeStatus::Cancelled));
    }

    #[test]
    fn test_graph_run_status_terminal() {
        assert!(GraphRunStatus::Succeeded.is_terminal());
        assert!(GraphRunStatus::Failed.is_terminal());
        assert!(GraphRunStatus::Cancelled.is_terminal());
        assert!(GraphRunStatus::PartiallySucceeded.is_terminal());

        assert!(!GraphRunStatus::Created.is_terminal());
        assert!(!GraphRunStatus::Validated.is_terminal());
        assert!(!GraphRunStatus::Running.is_terminal());
        assert!(!GraphRunStatus::Paused.is_terminal());
    }

    #[test]
    fn test_terminal_states_from_blocked() {
        // Blocked is terminal: no transition should be allowed from it
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
            assert!(
                !NodeStatus::Blocked.can_transition_to(*target),
                "Blocked should not transition to {:?}",
                target,
            );
        }
    }

    #[test]
    fn test_terminal_states_from_skipped() {
        // Skipped is terminal: no transition should be allowed from it
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
            assert!(
                !NodeStatus::Skipped.can_transition_to(*target),
                "Skipped should not transition to {:?}",
                target,
            );
        }
    }

    #[test]
    fn test_terminal_states_from_cancelled() {
        // Cancelled is terminal: no transition should be allowed from it
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
            assert!(
                !NodeStatus::Cancelled.can_transition_to(*target),
                "Cancelled should not transition to {:?}",
                target,
            );
        }
    }

    #[test]
    fn test_all_non_terminal_states() {
        // Pending, Ready, Running, Repairing are NOT terminal
        let non_terminal = [
            NodeStatus::Pending,
            NodeStatus::Ready,
            NodeStatus::Running,
            NodeStatus::Repairing,
        ];
        for status in &non_terminal {
            assert!(
                !status.is_terminal(),
                "{:?} should NOT be terminal",
                status,
            );
        }

        // Also verify they each have at least one valid outgoing transition
        assert!(NodeStatus::Pending.can_transition_to(NodeStatus::Ready));
        assert!(NodeStatus::Ready.can_transition_to(NodeStatus::Running));
        assert!(NodeStatus::Running.can_transition_to(NodeStatus::Succeeded));
        assert!(NodeStatus::Repairing.can_transition_to(NodeStatus::Ready));
    }

    #[test]
    fn test_graph_run_status_non_terminal() {
        // Created, Validated, Running, Paused are NOT terminal
        let non_terminal = [
            GraphRunStatus::Created,
            GraphRunStatus::Validated,
            GraphRunStatus::Running,
            GraphRunStatus::Paused,
        ];
        for status in &non_terminal {
            assert!(
                !status.is_terminal(),
                "GraphRunStatus::{:?} should NOT be terminal",
                status,
            );
        }

        // Verify the terminal ones are indeed terminal
        let terminal = [
            GraphRunStatus::Succeeded,
            GraphRunStatus::Failed,
            GraphRunStatus::Cancelled,
            GraphRunStatus::PartiallySucceeded,
        ];
        for status in &terminal {
            assert!(
                status.is_terminal(),
                "GraphRunStatus::{:?} should be terminal",
                status,
            );
        }
    }
}
