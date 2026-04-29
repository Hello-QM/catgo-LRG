"""Gibbs free energy correction: G = E_DFT + ZPE - T*S

Implements thermodynamic corrections for DFT energies using the
harmonic oscillator approximation for vibrational contributions.
"""

import math

# Physical constants
KB = 8.617333262e-5      # eV/K — Boltzmann constant
H_EV_S = 4.135667696e-15  # eV·s — Planck constant

# Standard reference free energies (eV, 298.15K, 1 atm)
# These are typical DFT-calculated values; users should override
# with their own values from consistent DFT calculations.
REFERENCE_ENERGIES = {
    "H2_gas": -6.77,
    "H2O_liquid": -14.22,
    "N2_gas": -16.64,
    "CO2_gas": -22.96,
}


def compute_zpe(frequencies_cm: list[float]) -> float:
    """Compute zero-point energy from vibrational frequencies.

    Args:
        frequencies_cm: Vibrational frequencies in cm⁻¹.
            Imaginary (negative) frequencies are ignored.

    Returns:
        Zero-point energy in eV.
    """
    zpe = 0.0
    for freq in frequencies_cm:
        if freq > 0:  # Imaginary frequencies (negative) contribute no ZPE
            # E = 0.5 * h * ν, convert cm⁻¹ → Hz via speed of light (cm/s)
            nu_hz = freq * 2.998e10
            zpe += 0.5 * H_EV_S * nu_hz
    return zpe


def compute_entropy_correction(
    frequencies_cm: list[float], temperature: float = 298.15
) -> float:
    """Compute -T*S vibrational entropy correction from frequencies.

    Uses the quantum harmonic oscillator partition function:
    S_vib = k * [x/(e^x - 1) - ln(1 - e^{-x})]
    where x = hν/(kT)

    Args:
        frequencies_cm: Vibrational frequencies in cm⁻¹.
        temperature: Temperature in Kelvin.

    Returns:
        -T*S correction in eV (negative value reduces G).
    """
    ts = 0.0
    for freq in frequencies_cm:
        if freq <= 0:
            continue
        nu_hz = freq * 2.998e10
        x = H_EV_S * nu_hz / (KB * temperature)
        if x > 100:
            continue  # Avoid overflow; contribution negligible at high x
        # Quantum harmonic oscillator vibrational entropy
        s_vib = KB * (x / (math.exp(x) - 1) - math.log(1 - math.exp(-x)))
        ts += temperature * s_vib
    return -ts


def gibbs_free_energy(
    e_dft: float,
    frequencies_cm: list[float] | None = None,
    temperature: float = 298.15,
    zpe: float | None = None,
) -> dict:
    """Compute Gibbs free energy with thermodynamic corrections.

    G = E_DFT + ZPE - T*S

    Args:
        e_dft: DFT total energy in eV.
        frequencies_cm: Vibrational frequencies in cm⁻¹ (for ZPE and entropy).
        temperature: Temperature in Kelvin.
        zpe: Pre-computed ZPE in eV. If None, computed from frequencies.

    Returns:
        Dict with G, E_DFT, ZPE, TS, and temperature values.
    """
    if zpe is None:
        zpe = compute_zpe(frequencies_cm or [])
    ts = compute_entropy_correction(frequencies_cm or [], temperature)
    g = e_dft + zpe + ts  # ts is already negative (-T*S)
    return {
        "G": g,
        "E_DFT": e_dft,
        "ZPE": zpe,
        "TS": -ts,  # Report positive T*S for clarity
        "temperature": temperature,
    }
