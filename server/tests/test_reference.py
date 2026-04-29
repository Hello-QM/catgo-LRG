from catgo.workflow.reference import OutputReference


class TestOutputReference:
    def test_create_bare(self):
        ref = OutputReference("task-123")
        assert ref.task_id == "task-123"
        assert ref.key is None

    def test_attribute_access(self):
        ref = OutputReference("task-123")
        sub = ref.structure
        assert isinstance(sub, OutputReference)
        assert sub.task_id == "task-123"
        assert sub.key == "structure"

    def test_chained_access(self):
        ref = OutputReference("task-123")
        sub = ref.output_data
        assert sub.key == "output_data"

    def test_is_reference(self):
        ref = OutputReference("task-123")
        assert OutputReference.is_reference(ref)
        assert OutputReference.is_reference(ref.structure)
        assert not OutputReference.is_reference("hello")
        assert not OutputReference.is_reference(42)

    def test_repr(self):
        ref = OutputReference("task-123").structure
        assert "task-123" in repr(ref)
        assert "structure" in repr(ref)
