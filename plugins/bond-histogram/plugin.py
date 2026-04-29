"""Bond length histogram analyzer plugin for CatGo."""

import sys
from pathlib import Path

# Ensure server directory is on sys.path for plugin base class import
server_dir = Path(__file__).resolve().parent.parent.parent / "server"
if server_dir.exists() and str(server_dir) not in sys.path:
    sys.path.insert(0, str(server_dir))

from plugins.base import AnalyzerPlugin


class BondHistogramPlugin(AnalyzerPlugin):
    name = "bond-histogram"
    analyzer_id = "bond_histogram"
    display_name = "Bond Length Histogram"
    description = "Compute distribution of interatomic distances in the structure"
    version = "1.0.0"
    author = "CatGo Team"

    output_type = "bar_plot"
    input_schema = {
        "type": "object",
        "properties": {
            "structure": {
                "type": "object",
                "description": "Pymatgen structure dict with lattice and sites",
            },
            "n_bins": {
                "type": "integer",
                "default": 30,
                "minimum": 5,
                "maximum": 200,
                "description": "Number of histogram bins",
            },
            "max_distance": {
                "type": "number",
                "default": 4.0,
                "minimum": 1.0,
                "maximum": 20.0,
                "description": "Neighbor search cutoff in Angstrom",
            },
        },
        "required": ["structure"],
    }

    async def analyze(self, input_data: dict) -> dict:
        import numpy as np
        from pymatgen.core import Structure

        struct_dict = input_data["structure"]
        n_bins = input_data.get("n_bins", 30)
        max_dist = input_data.get("max_distance", 4.0)

        structure = Structure.from_dict(struct_dict)

        # Collect all pairwise distances within cutoff
        distances = []
        for i in range(len(structure)):
            neighbors = structure.get_neighbors(structure[i], max_dist)
            for neighbor in neighbors:
                distances.append(neighbor.nn_distance)

        if not distances:
            return {
                "series": [],
                "x_axis": {"label": "Distance (Angstrom)"},
                "y_axis": {"label": "Count"},
            }

        counts, bin_edges = np.histogram(distances, bins=n_bins, range=(0, max_dist))
        bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2

        return {
            "series": [
                {
                    "x": [round(v, 4) for v in bin_centers.tolist()],
                    "y": counts.tolist(),
                    "label": f"Bond lengths (N={len(distances)})",
                }
            ],
            "x_axis": {"label": "Distance (Angstrom)"},
            "y_axis": {"label": "Count"},
        }
