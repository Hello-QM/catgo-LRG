"""LAMMPS NVT molecular dynamics workflow node — Tool-First format."""

import logging

logger = logging.getLogger(__name__)

TOOL = {
    "name": "lammps_nvt",
    "display_name": "LAMMPS NVT (Plugin)",
    "description": "Run NVT molecular dynamics using LAMMPS with a custom force field",
    "category": "workflow_node",
    "input_schema": {
        "type": "object",
        "properties": {
            "timestep": {
                "type": "number",
                "default": 1.0,
                "minimum": 0.1,
                "maximum": 10.0,
                "description": "Integration timestep in femtoseconds",
            },
            "temperature": {
                "type": "number",
                "default": 300,
                "minimum": 1,
                "maximum": 5000,
                "description": "Target temperature for NVT thermostat (K)",
            },
            "steps": {
                "type": "integer",
                "default": 1000,
                "minimum": 100,
                "maximum": 1000000,
                "description": "Number of MD integration steps",
            },
            "potential": {
                "type": "string",
                "default": "eam",
                "enum": ["eam", "lj", "reaxff"],
                "description": "Interatomic potential type",
            },
        },
    },
    "output_type": "structure",
    "node_definition": {
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
    },
    "version": "1.0.0",
    "author": "CatGo Team",
}


async def execute(context):
    """Execute the LAMMPS NVT simulation.

    This is a placeholder that returns a mock result.
    A real implementation would:
    1. Convert the structure to LAMMPS data format
    2. Generate LAMMPS input script with NVT settings
    3. Run LAMMPS (locally or submit to HPC)
    4. Parse output and return results
    """
    structure_json = context.get("structure")
    params = context.get("params", {})

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
    import json

    structure_str = json.dumps(structure_json) if isinstance(structure_json, dict) else str(structure_json)

    return {
        "structure_json": structure_str,
        "energy": -42.0,  # placeholder
        "status": "completed",
        "metadata": {
            "plugin": "lammps_nvt",
            "timestep": timestep,
            "temperature": temperature,
            "steps": steps,
            "potential": potential,
        },
    }
