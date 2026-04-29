"""
Example WorkflowNodePlugin: LAMMPS NVT simulation.

This plugin demonstrates how to create a custom workflow node
that can be dragged into the visual workflow editor.

To install:
    cp -r examples/plugins/lammps-workflow plugins/
    # Restart the CatGo backend
"""

import json
import logging

from plugins.base import WorkflowNodePlugin

logger = logging.getLogger(__name__)


class LammpsNVTPlugin(WorkflowNodePlugin):
    """Custom LAMMPS NVT molecular dynamics workflow node."""

    name = "lammps-nvt-plugin"
    display_name = "LAMMPS NVT (Plugin)"
    description = "Run NVT molecular dynamics using LAMMPS with a custom force field"
    version = "1.0.0"
    author = "CatGo Team"

    # Workflow node attributes
    node_type = "lammps_nvt_plugin"
    execution_mode = "local"

    node_definition = {
        "type": "lammps_nvt_plugin",
        "label": "LAMMPS NVT (Plugin)",
        "color": "#22c55e",
        "icon": "\U0001f3c3",
        "category": "Plugin",
        "description": "Run NVT MD using LAMMPS with a custom force field",
        "inputs": ["structure"],
        "outputs": ["structure", "trajectory"],
        "default_params": {
            "timestep": 1.0,
            "temperature": 300,
            "steps": 1000,
            "potential": "eam",
        },
        "param_schema": [
            {
                "key": "timestep",
                "label": "Timestep (fs)",
                "type": "number",
                "default": 1.0,
                "min": 0.1,
                "max": 10.0,
                "step": 0.1,
                "help": "Integration timestep in femtoseconds",
            },
            {
                "key": "temperature",
                "label": "Temperature (K)",
                "type": "number",
                "default": 300,
                "min": 1,
                "max": 5000,
                "step": 10,
                "help": "Target temperature for NVT thermostat",
            },
            {
                "key": "steps",
                "label": "MD Steps",
                "type": "number",
                "default": 1000,
                "min": 100,
                "max": 1000000,
                "step": 100,
                "help": "Number of MD integration steps",
            },
            {
                "key": "potential",
                "label": "Potential",
                "type": "select",
                "default": "eam",
                "options": [
                    {"label": "EAM", "value": "eam"},
                    {"label": "Lennard-Jones", "value": "lj"},
                    {"label": "ReaxFF", "value": "reaxff"},
                ],
                "help": "Interatomic potential type",
            },
        ],
    }

    async def execute(
        self,
        structure_json: str,
        params: dict,
        config: dict,
    ) -> dict:
        """
        Execute the LAMMPS NVT simulation.

        This is a placeholder that returns a mock result.
        A real implementation would:
        1. Convert structure_json to LAMMPS data format
        2. Generate LAMMPS input script with NVT settings
        3. Run LAMMPS (locally or submit to HPC)
        4. Parse output and return results
        """
        timestep = params.get("timestep", 1.0)
        temperature = params.get("temperature", 300)
        steps = params.get("steps", 1000)
        potential = params.get("potential", "eam")

        logger.info(
            "LAMMPS NVT plugin: timestep=%.1f fs, T=%d K, steps=%d, potential=%s",
            timestep, temperature, steps, potential,
        )

        # In a real plugin, you would run the actual LAMMPS simulation here.
        # For this example, we just pass the structure through unchanged.
        result = {
            "structure_json": structure_json,
            "energy": -42.0,  # placeholder
            "status": "completed",
            "metadata": {
                "plugin": self.name,
                "timestep": timestep,
                "temperature": temperature,
                "steps": steps,
                "potential": potential,
            },
        }

        return result
