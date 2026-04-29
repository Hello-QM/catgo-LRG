import os
import tempfile
import pytest
from catgo.workflow.config import load_config, get_default, resolve_param, DEFAULT_CONFIG


class TestConfig:
    def test_default_config_has_engine_section(self):
        config = load_config(config_path=None)
        assert "engine" in config
        assert "poll_interval" in config["engine"]
        assert isinstance(config["engine"]["poll_interval"], (int, float))

    def test_default_config_has_software_defaults(self):
        config = load_config(config_path=None)
        assert "defaults" in config
        assert "vasp" in config["defaults"]
        assert config["defaults"]["vasp"]["ENCUT"] == 520

    def test_yaml_override(self, tmp_path):
        yaml_file = tmp_path / "config.yaml"
        yaml_file.write_text("engine:\n  poll_interval: 10\n")
        config = load_config(config_path=str(yaml_file))
        assert config["engine"]["poll_interval"] == 10
        # Non-overridden values still have defaults
        assert config["defaults"]["vasp"]["ENCUT"] == 520

    def test_env_var_override(self, monkeypatch):
        monkeypatch.setenv("CATGO_ENGINE_POLL_INTERVAL", "5")
        config = load_config(config_path=None)
        assert config["engine"]["poll_interval"] == 5

    def test_get_default(self):
        config = load_config(config_path=None)
        assert get_default(config, "vasp", "ENCUT") == 520
        assert get_default(config, "vasp_freq", "IBRION") == 5
        assert get_default(config, "gibbs", "temperature") == 298.15

    def test_resolve_param_task_wins(self):
        config = load_config(config_path=None)
        # Task-level param overrides everything
        val = resolve_param("ENCUT", task_params={"ENCUT": 800},
                           workflow_config={}, global_config=config, software="vasp")
        assert val == 800

    def test_resolve_param_workflow_wins_over_global(self):
        config = load_config(config_path=None)
        wf_config = {"defaults": {"vasp": {"ENCUT": 600}}}
        val = resolve_param("ENCUT", task_params={},
                           workflow_config=wf_config, global_config=config, software="vasp")
        assert val == 600

    def test_resolve_param_falls_to_global(self):
        config = load_config(config_path=None)
        val = resolve_param("ENCUT", task_params={},
                           workflow_config={}, global_config=config, software="vasp")
        assert val == 520
