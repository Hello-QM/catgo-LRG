from catgo.workflow.states import TaskState, WorkflowState


class TestStates:
    def test_task_states_exist(self):
        assert TaskState.WAITING.value == "WAITING"
        assert TaskState.READY.value == "READY"
        assert TaskState.COMPLETED.value == "COMPLETED"
        assert TaskState.FAILED.value == "FAILED"

    def test_is_active(self):
        assert TaskState.RUNNING.is_active
        assert TaskState.SUBMITTED.is_active
        assert not TaskState.COMPLETED.is_active
        assert not TaskState.FAILED.is_active
        assert not TaskState.WAITING.is_active

    def test_is_terminal(self):
        assert TaskState.COMPLETED.is_terminal
        assert TaskState.FAILED.is_terminal
        assert TaskState.CANCELLED.is_terminal
        assert not TaskState.RUNNING.is_terminal
        assert not TaskState.WAITING.is_terminal

    def test_is_retryable(self):
        assert TaskState.REMOTE_ERROR.is_retryable
        assert not TaskState.FAILED.is_retryable
        assert not TaskState.COMPLETED.is_retryable

    def test_workflow_states(self):
        assert WorkflowState.DRAFT.value == "draft"
        assert WorkflowState.RUNNING.value == "running"
        assert WorkflowState.COMPLETED.value == "completed"
