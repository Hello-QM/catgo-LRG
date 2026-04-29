"""OER (Oxygen Evolution Reaction) overpotential calculation via CHE model.

Implements the Computational Hydrogen Electrode (CHE) model for
calculating theoretical OER overpotentials from adsorption free energies.
"""


def compute_oer_overpotential(
    dG_OH: float,
    dG_O: float,
    dG_OOH: float,
    equilibrium_potential: float = 1.23,
) -> dict:
    """Compute OER four-step theoretical overpotential.

    OER mechanism (4-electron process):
    1. H₂O → *OH + H⁺ + e⁻       ΔG₁ = ΔG_OH
    2. *OH → *O + H⁺ + e⁻         ΔG₂ = ΔG_O - ΔG_OH
    3. *O + H₂O → *OOH + H⁺ + e⁻ ΔG₃ = ΔG_OOH - ΔG_O
    4. *OOH → O₂ + H⁺ + e⁻       ΔG₄ = 4.92 - ΔG_OOH

    η_OER = max(ΔG₁..₄) / e - U_eq

    Args:
        dG_OH: Adsorption free energy of *OH in eV.
        dG_O: Adsorption free energy of *O in eV.
        dG_OOH: Adsorption free energy of *OOH in eV.
        equilibrium_potential: Equilibrium potential in V (default 1.23V for OER).

    Returns:
        Dict with overpotential, limiting step, step energies, and inputs.
    """
    step1 = dG_OH
    step2 = dG_O - dG_OH
    step3 = dG_OOH - dG_O
    # 4.92 eV = total free energy change for 2H₂O → O₂ + 4H⁺ + 4e⁻
    step4 = 4.92 - dG_OOH

    steps = [step1, step2, step3, step4]
    limiting_step = max(range(4), key=lambda i: steps[i])
    eta = steps[limiting_step] - equilibrium_potential

    return {
        "overpotential": max(eta, 0),
        "limiting_step": limiting_step + 1,
        "step_energies": steps,
        "dG_OH": dG_OH,
        "dG_O": dG_O,
        "dG_OOH": dG_OOH,
    }


def estimate_dG_OOH_from_scaling(dG_OH: float) -> float:
    """Estimate ΔG_OOH using Nørskov universal scaling relation.

    ΔG_OOH ≈ 0.84 * ΔG_OH + 3.29 eV
    Reference: Man et al., ChemCatChem (2011)
    """
    return 0.84 * dG_OH + 3.29


def compute_adsorption_free_energy(
    e_slab_ads: float,
    e_slab: float,
    e_ref_molecule: float,
    zpe_correction: float = 0.0,
    ts_correction: float = 0.0,
) -> float:
    """Compute adsorption free energy relative to a reference molecule.

    ΔG_ads = E(slab+adsorbate) - E(clean slab) - E(reference) + ΔZPE - TΔS

    Args:
        e_slab_ads: DFT energy of slab with adsorbate (eV).
        e_slab: DFT energy of clean slab (eV).
        e_ref_molecule: DFT energy of reference molecule (eV).
        zpe_correction: Zero-point energy difference (eV).
        ts_correction: Entropy correction TΔS (eV, positive).

    Returns:
        Adsorption free energy in eV.
    """
    return e_slab_ads - e_slab - e_ref_molecule + zpe_correction - ts_correction
