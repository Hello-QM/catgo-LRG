"""Generate comprehensive ORCA calculation results files."""

import json
from datetime import datetime
from typing import Any, Dict, Optional


def generate_neb_results_file(
    output_summary: Dict[str, Any],
    output_format: str = "both"
) -> Dict[str, str]:
    """Generate comprehensive NEB-TS results files.

    Args:
        output_summary: Summary dict from OrcaNebOutput.get_summary()
        output_format: "json", "text", or "both"

    Returns:
        Dict with "json" and/or "text" keys containing file contents
    """
    results = {}

    if output_format in ("json", "both"):
        results["json"] = _generate_neb_json(output_summary)

    if output_format in ("text", "both"):
        results["text"] = _generate_neb_text(output_summary)

    return results


def _generate_neb_json(summary: Dict[str, Any]) -> str:
    """Generate JSON results file."""
    output = {
        "calculation_type": "ORCA NEB-TS",
        "timestamp": datetime.now().isoformat(),
        "convergence": {
            "neb_converged": summary.get("neb_converged"),
            "ts_converged": summary.get("ts_converged"),
            "ci_converged": summary.get("ci_converged"),
        },
        "transition_state": {
            "is_valid": summary.get("is_valid_ts"),
            "activation_barrier_kcal_mol": summary.get("activation_barrier_kcal_mol"),
            "activation_barrier_ev": (
                summary.get("activation_barrier_kcal_mol") * 0.0433641
                if summary.get("activation_barrier_kcal_mol") else None
            ),
            "imaginary_frequency_cm_inv": summary.get("ts_imaginary_frequency"),
        },
        "energy_profile": summary.get("path_summary", {}).get("images", []),
        "convergence_criteria": summary.get("convergence"),
        "vibrational_data": summary.get("vibrational_data"),
        "warnings": summary.get("warnings", []),
        "intermediate_minima": summary.get("intermediate_minima"),
    }

    return json.dumps(output, indent=2)


def _generate_neb_text(summary: Dict[str, Any]) -> str:
    """Generate human-readable text results file."""
    lines = []

    lines.append("=" * 80)
    lines.append("ORCA NEB-TS CALCULATION RESULTS")
    lines.append("=" * 80)
    lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")

    # Convergence status
    lines.append("CONVERGENCE STATUS")
    lines.append("-" * 80)
    lines.append(f"NEB Optimization:        {'✓ CONVERGED' if summary.get('neb_converged') else '✗ NOT CONVERGED'}")
    lines.append(f"TS Optimization:         {'✓ CONVERGED' if summary.get('ts_converged') else '✗ NOT CONVERGED'}")
    lines.append(f"Climbing Image:          {'✓ CONVERGED' if summary.get('ci_converged') else '✗ NOT CONVERGED'}")
    lines.append("")

    # Transition state results
    lines.append("TRANSITION STATE RESULTS")
    lines.append("-" * 80)
    barrier = summary.get("activation_barrier_kcal_mol")
    if barrier is not None:
        barrier_ev = barrier * 0.0433641
        lines.append(f"Activation Barrier:      {barrier:>10.2f} kcal/mol ({barrier_ev:>10.4f} eV)")
    else:
        lines.append("Activation Barrier:      NOT AVAILABLE")

    imag_freq = summary.get("ts_imaginary_frequency")
    if imag_freq is not None:
        lines.append(f"TS Imaginary Frequency:  {imag_freq:>10.2f} cm⁻¹")
    else:
        lines.append("TS Imaginary Frequency:  NOT AVAILABLE")

    is_valid = summary.get("is_valid_ts")
    lines.append(f"Valid TS Structure:      {'✓ YES (1 imaginary frequency)' if is_valid else '✗ NO'}")
    lines.append("")

    # Energy profile
    path_summary = summary.get("path_summary", {})
    images = path_summary.get("images", [])

    if images:
        lines.append("ENERGY PROFILE (Minimum Energy Path)")
        lines.append("-" * 80)
        lines.append(f"{'Image':>6} {'Energy (Eh)':>18} {'ΔE (kcal/mol)':>16} {'Max Force':>12} {'RMS Force':>12}")
        lines.append("-" * 80)

        for img in images:
            img_id = img.get("image", "?")
            energy = img.get("energy_eh", float("nan"))
            de = img.get("de_kcal_mol", float("nan"))
            max_f = img.get("max_force", float("nan"))
            rms_f = img.get("rms_force", float("nan"))

            ci_marker = " [CI]" if img.get("is_ci") else ""
            ts_marker = " [TS]" if img.get("is_ts") else ""
            marker = ci_marker + ts_marker

            lines.append(
                f"{img_id:>6} {energy:>18.8f} {de:>16.2f} {max_f:>12.6f} {rms_f:>12.6f}{marker}"
            )

        lines.append("")

    # Vibrational frequencies
    vib_data = summary.get("vibrational_data", {})
    if vib_data:
        lines.append("VIBRATIONAL FREQUENCIES")
        lines.append("-" * 80)
        lines.append(f"Total Frequencies:       {len(vib_data.get('all_frequencies', []))} modes")
        lines.append(f"Real Frequencies:        {len(vib_data.get('real_frequencies', []))} modes")
        lines.append(f"Imaginary Frequencies:   {vib_data.get('num_imaginary', 0)} mode(s)")

        imag_freqs = vib_data.get("imaginary_frequencies", [])
        if imag_freqs:
            lines.append("  Imaginary modes:")
            for freq in imag_freqs:
                lines.append(f"    - {freq.get('value', 0):>10.2f} cm⁻¹")

        lines.append("")

    # Warnings
    warnings = summary.get("warnings", [])
    if warnings:
        lines.append("⚠️  WARNINGS")
        lines.append("-" * 80)
        for i, warning in enumerate(warnings, 1):
            lines.append(f"{i}. {warning}")
        lines.append("")

    # Summary
    lines.append("SUMMARY")
    lines.append("-" * 80)
    if summary.get("is_valid_ts") and summary.get("neb_converged") and summary.get("ts_converged"):
        lines.append("✓ High-quality transition state found!")
        lines.append(f"  Barrier: {barrier:.2f} kcal/mol")
        lines.append(f"  Structure is valid (1 imaginary frequency)")
    else:
        lines.append("⚠️  Check calculation for issues:")
        if not summary.get("neb_converged"):
            lines.append("  - NEB did not converge")
        if not summary.get("ts_converged"):
            lines.append("  - TS optimization did not converge")
        if not summary.get("is_valid_ts"):
            lines.append("  - TS structure invalid (wrong number of imaginary frequencies)")

    lines.append("")
    lines.append("=" * 80)
    lines.append("End of Results")
    lines.append("=" * 80)

    return "\n".join(lines)


def generate_orca_opt_results_file(
    energy_eh: Optional[float],
    energy_ev: Optional[float] = None,
) -> str:
    """Generate results file for ORCA geometry optimization.

    Args:
        energy_eh: Final energy in Hartree
        energy_ev: Final energy in eV (computed if not provided)

    Returns:
        Text results content
    """
    if energy_ev is None and energy_eh is not None:
        energy_ev = energy_eh * 27.211386

    lines = []
    lines.append("=" * 80)
    lines.append("ORCA GEOMETRY OPTIMIZATION RESULTS")
    lines.append("=" * 80)
    lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")

    lines.append("FINAL ENERGY")
    lines.append("-" * 80)
    if energy_eh is not None:
        lines.append(f"Energy: {energy_eh:>20.8f} Eh  ({energy_ev:>15.8f} eV)")
    else:
        lines.append("Energy: NOT AVAILABLE")

    lines.append("")
    lines.append("=" * 80)

    return "\n".join(lines)


def save_results_files(
    work_dir: str,
    results_dict: Dict[str, str],
    base_filename: str = "RESULTS"
) -> Dict[str, str]:
    """Save results files to disk.

    Args:
        work_dir: Directory to save files in
        results_dict: Dict with "json" and/or "text" keys
        base_filename: Base name for output files (without extension)

    Returns:
        Dict mapping format -> file path
    """
    import os

    saved_files = {}

    if "json" in results_dict:
        json_path = os.path.join(work_dir, f"{base_filename}.json")
        with open(json_path, "w") as f:
            f.write(results_dict["json"])
        saved_files["json"] = json_path

    if "text" in results_dict:
        text_path = os.path.join(work_dir, f"{base_filename}.txt")
        with open(text_path, "w") as f:
            f.write(results_dict["text"])
        saved_files["text"] = text_path

    return saved_files
