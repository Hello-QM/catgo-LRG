"""OutputReference — lazy pointer to a task's future output."""

from __future__ import annotations


class OutputReference:
    """A lazy reference to a not-yet-computed task output.

    Usage:
        ref = OutputReference("task-123")
        ref.structure   → OutputReference("task-123", key="structure")
        ref.energy      → OutputReference("task-123", key="energy")

    When passed as an argument to Workflow.add_task(), the workflow
    detects it and creates a task_link in the DB.
    """

    __slots__ = ("task_id", "key")

    def __init__(self, task_id: str, key: str | None = None):
        object.__setattr__(self, "task_id", task_id)
        object.__setattr__(self, "key", key)

    def __getattr__(self, name: str) -> OutputReference:
        if name.startswith("_"):
            raise AttributeError(name)
        return OutputReference(self.task_id, name)

    def __repr__(self) -> str:
        if self.key:
            return f"OutputReference({self.task_id!r}, key={self.key!r})"
        return f"OutputReference({self.task_id!r})"

    @staticmethod
    def is_reference(obj: object) -> bool:
        return isinstance(obj, OutputReference)
