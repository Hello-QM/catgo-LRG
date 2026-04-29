"""Volcano plot data generation for catalyst screening.

Generates scatter plot data and ideal volcano lines for comparing
catalyst activity across a descriptor space (e.g., ΔG_OH vs overpotential).
"""


def generate_volcano_data(
    catalyst_results: list[dict],
    reaction: str = "OER",
    descriptor_x: str = "dG_OH",
    descriptor_y: str | None = None,
) -> dict:
    """Generate volcano plot data from catalyst screening results.

    Args:
        catalyst_results: List of dicts, each with at minimum:
            - "name": catalyst identifier
            - descriptor_x key: x-axis value
            - "overpotential" or descriptor_y key: y-axis value
        reaction: Reaction type for ideal line ("OER", "HER", "CO2RR", "NRR").
        descriptor_x: Key for x-axis descriptor (default "dG_OH").
        descriptor_y: Key for y-axis. If None, uses -overpotential.

    Returns:
        Dict with points (scatter data), ideal_line, descriptor_x, reaction.
    """
    points = []
    for r in catalyst_results:
        x = r.get(descriptor_x)
        if x is None:
            continue
        y = r.get(descriptor_y) if descriptor_y else -r.get("overpotential", 0)
        points.append({
            "name": r.get("name", ""),
            "x": x,
            "y": y,
            **{k: v for k, v in r.items() if k not in ("name",)},
        })

    # Theoretical volcano line using Nørskov scaling relations
    ideal_line = None
    if reaction == "OER":
        import numpy as np
        x_range = np.linspace(0.5, 2.5, 100)
        # Left branch: η limited by step 1 (OH adsorption), η = ΔG_OH - 1.23
        left = x_range - 1.23
        # Right branch: η limited by step 4, using scaling ΔG_OOH ≈ 0.84*ΔG_OH + 3.29
        # η = (4.92 - ΔG_OOH) - 1.23 = (4.92 - 0.84*ΔG_OH - 3.29) - 1.23
        right = (4.92 - (0.84 * x_range + 3.29)) - 1.23
        # Volcano: -η so peak is at top (lower overpotential = better catalyst)
        y_ideal = -np.maximum(left, right)
        ideal_line = {"x": x_range.tolist(), "y": y_ideal.tolist()}

    return {
        "points": points,
        "ideal_line": ideal_line,
        "descriptor_x": descriptor_x,
        "reaction": reaction,
    }
