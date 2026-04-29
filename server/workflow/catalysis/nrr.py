"""NRR (Nitrogen Reduction Reaction) overpotential calculation.

Implements simplified NRR overpotential estimation using the first
protonation step as the primary descriptor (distal pathway).
"""


def compute_nrr_overpotential(
    dG_N2H: float,
    dG_NNH2: float | None = None,
    dG_N: float | None = None,
    dG_NH: float | None = None,
    dG_NH2: float | None = None,
    dG_NH3: float | None = None,
    pathway: str = "distal",
    # -0.16 V vs RHE at 298K: thermodynamic potential for N₂ + 6H⁺ + 6e⁻ → 2NH₃
    equilibrium_potential: float = -0.16,
) -> dict:
    """Compute NRR overpotential.

    NRR distal pathway (6 electron transfer):
    N₂ → *N₂H → *NNH₂ → *N + NH₃ → *NH → *NH₂ → NH₃

    First protonation (N₂ → *N₂H) is typically rate-limiting.

    Args:
        dG_N2H: Free energy of first protonation step (eV).
        dG_NH3: Free energy of final desorption step (eV, optional).
        pathway: "distal", "alternating", or "enzymatic".
        equilibrium_potential: Thermodynamic potential (V vs RHE).

    Returns:
        Dict with overpotential, limiting_step, step_energies, pathway, dG_N2H.
    """
    # Simplified: use first protonation as primary descriptor
    steps = [dG_N2H]
    if dG_NH3 is not None:
        steps.append(-dG_NH3)

    limiting_idx = max(range(len(steps)), key=lambda i: steps[i])
    eta = steps[limiting_idx] + equilibrium_potential

    return {
        "overpotential": max(eta, 0),
        "limiting_step": limiting_idx + 1,
        "step_energies": steps,
        "pathway": pathway,
        "dG_N2H": dG_N2H,
    }
