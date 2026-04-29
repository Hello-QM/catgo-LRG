"""CO2RR (CO2 Reduction Reaction) limiting potential calculation.

Implements the Computational Hydrogen Electrode model for CO2 reduction
pathways, primarily the CO pathway (most common on transition metals).
"""


def compute_co2rr_limiting_potential(
    dG_COOH: float,
    dG_CO: float,
    pathway: str = "CO",
) -> dict:
    """Compute CO2RR limiting potential for a given pathway.

    CO pathway (most common):
    1. CO₂ + H⁺ + e⁻ → *COOH     ΔG₁ = ΔG_COOH
    2. *COOH + H⁺ + e⁻ → *CO + H₂O  ΔG₂ = ΔG_CO - ΔG_COOH
    3. *CO → CO(g) + *             ΔG₃ = -ΔG_CO

    U_L = -max(ΔG₁, ΔG₂, ΔG₃) / e

    Args:
        dG_COOH: Adsorption free energy of *COOH (eV).
        dG_CO: Adsorption free energy of *CO (eV).
        pathway: Reaction pathway ("CO" or "HCOOH").

    Returns:
        Dict with limiting_potential, limiting_step, step_energies, step_labels, pathway.
    """
    if pathway == "CO":
        steps = [dG_COOH, dG_CO - dG_COOH, -dG_CO]
        step_labels = ["CO₂→*COOH", "*COOH→*CO", "*CO→CO(g)"]
    elif pathway == "HCOOH":
        steps = [dG_COOH, -dG_COOH]
        step_labels = ["CO₂→*COOH", "*COOH→HCOOH"]
    else:
        raise ValueError(f"Unsupported CO2RR pathway: {pathway}")

    limiting_idx = max(range(len(steps)), key=lambda i: steps[i])
    limiting_potential = -steps[limiting_idx]

    return {
        "limiting_potential": limiting_potential,
        "limiting_step": limiting_idx + 1,
        "step_energies": steps,
        "step_labels": step_labels,
        "pathway": pathway,
    }
