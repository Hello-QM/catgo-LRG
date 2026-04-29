import pytest
from catgo.workflow.task_decorator import task, get_task_registry, TaskDefinition


class TestTaskDecorator:
    def test_register_task(self):
        @task(software="vasp", task_type="test_geo_opt", outputs=["structure", "energy"])
        def my_geo_opt(structure, ENCUT=520, **params):
            pass

        registry = get_task_registry()
        assert "test_geo_opt" in registry
        defn = registry["test_geo_opt"]
        assert defn.software == "vasp"
        assert defn.outputs == ["structure", "energy"]

    def test_register_local_task(self):
        @task(task_type="test_local", local=True, outputs=["result"])
        def my_local(x, y):
            return x + y

        registry = get_task_registry()
        defn = registry["test_local"]
        assert defn.local is True
        assert defn.func is not None

    def test_task_type_inferred_from_function_name(self):
        @task(software="vasp", outputs=["structure"])
        def my_custom_task(structure, **params):
            pass

        registry = get_task_registry()
        assert "my_custom_task" in registry

    def test_duplicate_registration_raises(self):
        @task(task_type="dup_test", outputs=["x"])
        def dup1():
            pass

        with pytest.raises(ValueError, match="already registered"):
            @task(task_type="dup_test", outputs=["y"])
            def dup2():
                pass
