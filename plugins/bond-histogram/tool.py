"""Bond length distribution histogram — Tool-First format."""

TOOL = {
    "name": "bond_histogram",
    "display_name": "Bond Length Histogram",
    "description": "Compute distribution of interatomic distances in the structure",
    "category": "general",
    "input_schema": {
        "type": "object",
        "properties": {
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
    },
    "output_type": "bar_plot",
    "version": "1.0.0",
    "author": "CatGo Team",
}


async def execute(context):
    """Compute bond length histogram for the current structure."""
    import numpy as np
    from pymatgen.core import Structure

    structure = context["structure"]
    params = context.get("params", {})
    n_bins = params.get("n_bins", 30)
    max_dist = params.get("max_distance", 4.0)

    struct = Structure.from_dict(structure) if isinstance(structure, dict) else structure

    # Collect all pairwise distances within cutoff
    distances = []
    for i in range(len(struct)):
        neighbors = struct.get_neighbors(struct[i], max_dist)
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
