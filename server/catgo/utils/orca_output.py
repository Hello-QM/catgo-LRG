"""ORCA output file parsing utilities for NEB-TS and single point calculations."""

import re
from typing import Optional, Dict, Any, List, Tuple


class OrcaNebOutput:
    """Parser for ORCA NEB-TS output files."""

    def __init__(self, output_text: str):
        """Initialize parser with ORCA output text.

        Args:
            output_text: Full content of ORCA .out or .txt file
        """
        self.output_text = output_text
        self._parse()

    def _parse(self):
        """Parse all relevant sections from ORCA output."""
        self.neb_converged = self._check_neb_convergence()
        self.ts_converged = self._check_ts_convergence()
        self.ci_converged = False
        self.path_summary = self._parse_path_summary()
        self.vibrational_data = self._parse_vibrational_frequencies()
        self.convergence_data = self._parse_convergence_criteria()
        self.intermediate_minima = self._check_intermediate_minima()
        # Release the raw output text after parsing completes — frees up to 2 MB of memory
        del self.output_text

    def _check_neb_convergence(self) -> bool:
        """Check if NEB optimization converged."""
        return "THE NEB OPTIMIZATION HAS CONVERGED" in self.output_text

    def _check_ts_convergence(self) -> bool:
        """Check if TS optimization converged."""
        return "THE TS OPTIMIZATION HAS CONVERGED" in self.output_text

    def _parse_convergence_criteria(self) -> Optional[Dict[str, Any]]:
        """Parse CI-NEB or TS convergence criteria.

        Returns:
            Dict with convergence metrics if found, None otherwise
        """
        # Find CI-NEB convergence block by locating the section start first.
        # This avoids catastrophic regex backtracking if the section is absent.
        pos = self.output_text.find("CI-NEB convergence")
        if pos == -1:
            return None

        # Extract a bounded slice (convergence block is ~20 lines, ~2KB max)
        section = self.output_text[pos:pos + 2000]

        # Now search for the convergence metrics within the small section
        ci_pattern = r"CI-NEB convergence.*?RMS\(Fp\)\s+([\d.]+).*?MAX\(\|Fp\|\)\s+([\d.]+).*?RMS\(FCI\)\s+([\d.]+).*?MAX\(\|FCI\|\)\s+([\d.]+)"
        match = re.search(ci_pattern, section, re.DOTALL)

        if match:
            self.ci_converged = True
            return {
                "type": "CI-NEB",
                "rms_fp": float(match.group(1)),
                "max_fp": float(match.group(2)),
                "rms_fci": float(match.group(3)),
                "max_fci": float(match.group(4))
            }

        return None

    def _parse_path_summary(self) -> Optional[Dict[str, Any]]:
        """Parse the PATH SUMMARY FOR NEB-TS section.

        Returns:
            Dict with energy profile and TS data if found
        """
        # Find PATH SUMMARY section by locating the section start first.
        # This avoids catastrophic regex backtracking if the section is absent.
        pos = self.output_text.find("PATH SUMMARY FOR NEB-TS")
        if pos == -1:
            return None

        # Extract a bounded slice (PATH SUMMARY is typically ~100 lines for 8 images, ~10KB max)
        section = self.output_text[pos:pos + 10000]

        # Now search for the table content within the small section
        summary_match = re.search(
            r"PATH SUMMARY FOR NEB-TS.*?(?:Image\s+E\(Eh\).*?\n)(.*?)(?:\n\s*-+|$)",
            section,
            re.DOTALL
        )

        if not summary_match:
            return None

        summary_text = summary_match.group(1)
        images = []
        ts_data = None
        ci_data = None

        # Parse each image line
        for line in summary_text.split('\n'):
            line = line.strip()
            if not line:
                continue

            # Match image number or TS/CI markers
            image_match = re.match(
                r"(\d+|TS)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*(.*)",
                line
            )

            if image_match:
                image_id = image_match.group(1)
                energy_eh = float(image_match.group(2))
                de_kcal = float(image_match.group(3))
                max_force = float(image_match.group(4))
                rms_force = float(image_match.group(5))
                markers = image_match.group(6).strip()

                entry = {
                    "image": image_id,
                    "energy_eh": energy_eh,
                    "de_kcal_mol": de_kcal,
                    "max_force": max_force,
                    "rms_force": rms_force
                }

                # Check for CI and TS markers
                if "<= CI" in markers:
                    entry["is_ci"] = True
                    ci_data = entry
                elif "<= TS" in markers:
                    entry["is_ts"] = True
                    ts_data = entry

                if image_id != "TS":
                    images.append(entry)

        if not ts_data and images:
            # If TS not explicitly marked, find highest energy
            ts_data = max(images, key=lambda x: x["de_kcal_mol"])

        return {
            "images": images,
            "ts": ts_data,
            "ci": ci_data,
            "activation_barrier_kcal_mol": ts_data["de_kcal_mol"] if ts_data else None
        }

    def _parse_vibrational_frequencies(self) -> Optional[Dict[str, Any]]:
        """Parse vibrational frequencies section.

        Returns:
            Dict with frequency data and TS validation
        """
        # Find vibrational frequencies section by locating the section start first.
        # Avoids catastrophic regex backtracking with broken ^[A-Z] terminator.
        pos = self.output_text.find("VIBRATIONAL FREQUENCIES")
        if pos == -1:
            return None

        # Find the end of the section (NORMAL MODES marks the end of VIBRATIONAL FREQUENCIES section)
        end = self.output_text.find("NORMAL MODES", pos)
        if end == -1:
            # No separator found, use a bounded slice (frequencies block is ~10KB max)
            section = self.output_text[pos:pos + 10000]
        else:
            # Use everything up to the separator
            section = self.output_text[pos:end]

        # Extract frequency lines (after the "VIBRATIONAL FREQUENCIES" header)
        header_end = section.find("\n")
        if header_end == -1:
            return None
        freq_text = section[header_end+1:]
        frequencies = []
        imaginary_count = 0
        imaginary_freq = None

        # Parse frequency lines
        for line in freq_text.split('\n'):
            line = line.strip()
            if not line:
                continue

            # Match frequency entries like: "6:   -1192.35 cm**-1 ***imaginary mode***"
            freq_match_line = re.match(
                r"(\d+):\s+([-\d.]+)\s+cm\*\*-1\s*(.*)",
                line
            )

            if freq_match_line:
                freq_num = int(freq_match_line.group(1))
                freq_value = float(freq_match_line.group(2))
                is_imaginary = "imaginary" in freq_match_line.group(3).lower()

                entry = {
                    "number": freq_num,
                    "value": freq_value,
                    "is_imaginary": is_imaginary or freq_value < 0
                }

                frequencies.append(entry)

                if entry["is_imaginary"]:
                    imaginary_count += 1
                    if imaginary_freq is None:  # Store first (usually only) imaginary
                        imaginary_freq = freq_value

        # Filter out translation/rotation (first 6 should be ~0)
        real_frequencies = [f for f in frequencies if abs(f["value"]) > 1.0]

        return {
            "all_frequencies": frequencies,
            "real_frequencies": real_frequencies,
            "imaginary_frequencies": [f for f in real_frequencies if f["is_imaginary"]],
            "num_imaginary": imaginary_count,
            "imaginary_freq_value": imaginary_freq,
            "is_valid_ts": imaginary_count == 1  # Valid TS has exactly 1 imaginary frequency
        }

    def _check_intermediate_minima(self) -> Optional[List[int]]:
        """Check for warnings about possible intermediate minima.

        Returns:
            List of image indices with possible minima, or None
        """
        interp_match = re.search(
            r"Possible intermediate minimum found at image\(s\):\s*([\d\s,]+)",
            self.output_text
        )

        if interp_match:
            # Parse image numbers
            images_str = interp_match.group(1)
            images = [int(x.strip()) for x in images_str.split(',') if x.strip().isdigit()]
            return images

        return None

    def get_activation_barrier(self) -> Optional[float]:
        """Get activation barrier in kcal/mol."""
        if self.path_summary and self.path_summary.get("ts"):
            return self.path_summary["ts"]["de_kcal_mol"]
        return None

    def get_ts_structure_imaginary_freq(self) -> Optional[float]:
        """Get the imaginary frequency of the TS (should be 1 for valid TS)."""
        if self.vibrational_data and self.vibrational_data.get("imaginary_freq_value"):
            return abs(self.vibrational_data["imaginary_freq_value"])
        return None

    def is_valid_ts(self) -> bool:
        """Check if the computed TS is valid (has exactly 1 imaginary frequency)."""
        return (
            self.ts_converged and
            self.vibrational_data and
            self.vibrational_data.get("is_valid_ts", False)
        )

    def get_summary(self) -> Dict[str, Any]:
        """Get complete summary of NEB-TS calculation.

        Returns:
            Dict with all relevant results
        """
        summary = {
            "neb_converged": self.neb_converged,
            "ts_converged": self.ts_converged,
            "ci_converged": self.ci_converged,
            "is_valid_ts": self.is_valid_ts(),
            "activation_barrier_kcal_mol": self.get_activation_barrier(),
            "ts_imaginary_frequency": self.get_ts_structure_imaginary_freq(),
            "path_summary": self.path_summary,
            "vibrational_data": self.vibrational_data,
            "convergence": self.convergence_data,
            "intermediate_minima": self.intermediate_minima,
            "warnings": self._get_warnings()
        }

        # Extract convergence_points from path_summary for visualization (one per image)
        if self.path_summary and self.path_summary.get("images"):
            images = self.path_summary["images"]
            convergence_points = []
            for image in images:
                convergence_points.append({
                    "step": image.get("image"),  # Image number (1=reactant, ..., N=product)
                    "energy": image.get("energy_eh"),  # Use standard "energy" key
                    "dE": image.get("de_kcal_mol", 0.0),
                    "is_ts": image.get("is_ts", False)
                })
            summary["convergence_points"] = convergence_points

        return summary

    def _get_warnings(self) -> List[str]:
        """Extract warnings from output."""
        warnings = []

        if self.intermediate_minima:
            warnings.append(
                f"Possible intermediate minima found at images: {self.intermediate_minima}. "
                "Consider optimizing these intermediates separately."
            )

        if self.neb_converged and not self.ts_converged:
            warnings.append("NEB converged but TS optimization did not converge.")

        if self.vibrational_data and not self.vibrational_data.get("is_valid_ts"):
            num_imag = self.vibrational_data.get("num_imaginary", 0)
            warnings.append(
                f"TS structure has {num_imag} imaginary frequency/frequencies. "
                "Valid TS should have exactly 1."
            )

        return warnings


class OrcaSinglePointOutput:
    """Parser for ORCA single point calculation output."""

    def __init__(self, output_text: str):
        """Initialize parser with ORCA output text."""
        self.output_text = output_text
        self.energy_eh = self._parse_total_energy()
        self.convergence_points = self._parse_convergence_points()
        # Release the raw output text after parsing completes — frees up to 2 MB of memory
        del self.output_text

    def _parse_total_energy(self) -> Optional[float]:
        """Parse total energy from output.

        Returns:
            Energy in Hartree, or None if not found
        """
        # Look for "Total Energy" line
        energy_match = re.search(
            r"Total Energy\s*:\s+([-\d.]+)\s+Eh",
            self.output_text
        )

        if energy_match:
            return float(energy_match.group(1))

        return None

    def _parse_convergence_points(self) -> List[Dict[str, Any]]:
        """Parse convergence points. For SP, just return single point."""
        if self.energy_eh is not None:
            return [{"step": 1, "energy": self.energy_eh, "dE": 0.0, "energy_sigma0": 0.0, "max_force": 0.0, "rms_force": 0.0}]
        return []

    def get_summary(self) -> Dict[str, Any]:
        """Get energy summary."""
        return {
            "energy_eh": self.energy_eh,
            "energy_ev": self.energy_eh * 27.211386 if self.energy_eh else None,
            "convergence_points": self.convergence_points
        }


class OrcaFreqOutput:
    """Parser for ORCA frequency calculation output."""

    def __init__(self, output_text: str):
        """Initialize parser with ORCA output text."""
        self.output_text = output_text
        self.energy_eh = self._parse_total_energy()
        self.frequencies = self._parse_vibrational_frequencies()
        self.zpe_eh, self.zpe_kj_mol = self._parse_zero_point_energy()
        self.thermochemistry = self._parse_thermochemistry()
        self.convergence_points = self._parse_convergence_points()
        # Release the raw output text after parsing completes — frees up to 2 MB of memory
        del self.output_text

    def _parse_total_energy(self) -> Optional[float]:
        """Parse total energy from output in Hartree."""
        energy_match = re.search(
            r"Total Energy\s*:\s+([-\d.]+)\s+Eh",
            self.output_text
        )
        if energy_match:
            return float(energy_match.group(1))
        return None

    def _parse_vibrational_frequencies(self) -> List[Dict[str, Any]]:
        """Parse vibrational frequencies from VIBRATIONAL FREQUENCIES section.

        Returns:
            List of dicts with 'index', 'frequency_cm', and 'imaginary' flag
        """
        frequencies = []

        # Look for VIBRATIONAL FREQUENCIES section by locating the section start first.
        # Avoids catastrophic regex backtracking with $ fallback terminator.
        pos = self.output_text.find("VIBRATIONAL FREQUENCIES")
        if pos == -1:
            return frequencies

        # Find the end of the section (NORMAL MODES marker or 30 KB max)
        # ORCA format has "NORMAL MODES" section after the frequency list
        end = self.output_text.find("NORMAL MODES", pos)
        if end == -1:
            freq_section = self.output_text[pos:pos + 30000]
        else:
            freq_section = self.output_text[pos:end]

        # Parse each frequency line: "   0:      404.72 cm**-1" or "   6:   -1192.35 cm**-1 ***imaginary mode***"
        # ORCA uses negative values to denote imaginary frequencies (not the 'i' prefix)
        freq_pattern = r"(\d+):\s+([-\d.]+)\s+cm\*\*-1"
        for match in re.finditer(freq_pattern, freq_section):
            freq_idx = int(match.group(1))
            freq_value = float(match.group(2))
            # ORCA denotes imaginary frequencies with negative values (e.g., -1192.35 cm**-1)
            is_imaginary = freq_value < 0

            frequencies.append({
                "index": freq_idx,
                "frequency_cm": abs(freq_value),  # Store absolute value; frontend uses is_imaginary flag to mark with 'i'
                "imaginary": is_imaginary
            })

        return frequencies

    def _parse_zero_point_energy(self) -> Tuple[Optional[float], Optional[float]]:
        """Parse zero point energy from output.

        Returns:
            Tuple of (ZPE in Eh, ZPE in kJ/mol) or (None, None)
        """
        # Look for "Zero point energy" line
        zpe_match = re.search(
            r"Zero point energy\s+[=:]\s+([-\d.]+)\s+Eh\s+\(.*?([-\d.]+)\s+kJ/mol",
            self.output_text,
            re.IGNORECASE
        )

        if zpe_match:
            zpe_eh = float(zpe_match.group(1))
            zpe_kj_mol = float(zpe_match.group(2))
            return zpe_eh, zpe_kj_mol

        return None, None

    def _parse_thermochemistry(self) -> Optional[Dict[str, float]]:
        """Parse thermochemistry data (H, S, G) if available.

        Returns:
            Dict with 'enthalpy_eh', 'entropy_j_mol_k', 'gibbs_eh' or None
        """
        thermo_data = {}

        # Look for thermochemical quantities
        enthalpy_match = re.search(
            r"(?:Final enthalpy|Total enthalpy)\s+[=:]\s+([-\d.]+)\s+Eh",
            self.output_text,
            re.IGNORECASE
        )
        if enthalpy_match:
            thermo_data["enthalpy_eh"] = float(enthalpy_match.group(1))

        entropy_match = re.search(
            r"(?:Final entropy|Total entropy)\s+[=:]\s+([-\d.]+)\s+J/\(mol\*K\)",
            self.output_text,
            re.IGNORECASE
        )
        if entropy_match:
            thermo_data["entropy_j_mol_k"] = float(entropy_match.group(1))

        gibbs_match = re.search(
            r"(?:Final free energy|Total free energy|Gibbs free energy)\s+[=:]\s+([-\d.]+)\s+Eh",
            self.output_text,
            re.IGNORECASE
        )
        if gibbs_match:
            thermo_data["gibbs_eh"] = float(gibbs_match.group(1))

        return thermo_data if thermo_data else None

    def _parse_convergence_points(self) -> List[Dict[str, Any]]:
        """Parse convergence points. For freq calculation, return single point with final energy."""
        if self.energy_eh is not None:
            return [{"step": 1, "energy": self.energy_eh, "dE": 0.0, "energy_sigma0": 0.0, "max_force": 0.0, "rms_force": 0.0}]
        return []

    def get_summary(self) -> Dict[str, Any]:
        """Get frequency calculation summary."""
        summary = {
            "energy_eh": self.energy_eh,
            "energy_ev": self.energy_eh * 27.211386 if self.energy_eh else None,
            "frequencies": self.frequencies,
            "zpe_eh": self.zpe_eh,
            "zpe_kj_mol": self.zpe_kj_mol,
            "convergence_points": self.convergence_points,
        }

        if self.thermochemistry:
            summary.update({
                "enthalpy_eh": self.thermochemistry.get("enthalpy_eh"),
                "entropy_j_mol_k": self.thermochemistry.get("entropy_j_mol_k"),
                "gibbs_eh": self.thermochemistry.get("gibbs_eh"),
            })

        # Count imaginary frequencies
        imaginary_freqs = [f for f in self.frequencies if f.get("imaginary", False)]
        summary["num_imaginary"] = len(imaginary_freqs)
        summary["imaginary_frequencies"] = [f["frequency_cm"] for f in imaginary_freqs]

        return summary


class OrcaOptOutput:
    """Parser for ORCA geometry optimization output."""

    def __init__(self, output_text: str):
        """Initialize parser with ORCA output text."""
        self.output_text = output_text
        self.energy_eh = self._parse_total_energy()
        self.converged = self._check_convergence()
        self.n_steps = self._count_opt_cycles()
        self.max_gradient, self.rms_gradient = self._parse_final_gradients()
        self.convergence_points = self._parse_convergence_points()
        # Release the raw output text after parsing completes — frees up to 2 MB of memory
        del self.output_text

    def _parse_total_energy(self) -> Optional[float]:
        """Parse total energy from output in Hartree (includes D4 dispersion correction)."""
        # Use rfind to get the LAST occurrence (final converged energy with D4 correction)
        pos = self.output_text.rfind("FINAL SINGLE POINT ENERGY")
        if pos != -1:
            # Search from that position to extract the energy value
            match = re.search(
                r"FINAL SINGLE POINT ENERGY\s+([-\d.]+)",
                self.output_text[pos:pos+200]
            )
            if match:
                return float(match.group(1))
        return None

    def _check_convergence(self) -> bool:
        """Check if geometry optimization converged."""
        return "GEOMETRY OPTIMIZATION CONVERGED" in self.output_text

    def _count_opt_cycles(self) -> int:
        """Count the number of geometry optimization cycles.

        Returns:
            Number of optimization steps (cycles), or 0 if not found
        """
        # Look for "GEOMETRY OPTIMIZATION CYCLE" headers
        cycle_matches = re.findall(
            r"GEOMETRY OPTIMIZATION CYCLE\s+(\d+)",
            self.output_text
        )

        if cycle_matches:
            # The last cycle number is the total count
            return int(cycle_matches[-1])

        return 0

    def _parse_final_gradients(self) -> Tuple[Optional[float], Optional[float]]:
        """Parse final maximum and RMS gradients from the last convergence criteria.

        Returns:
            Tuple of (max_gradient, rms_gradient) or (None, None)
        """
        # Gradient data appears at the very end of the file (after all optimization cycles).
        # Use rfind to skip the entire optimization history and start from the end.
        # This avoids scanning through potentially hundreds of cycles.
        pos = self.output_text.rfind("FINAL SINGLE POINT ENERGY")
        if pos != -1:
            # Extract from the FINAL SINGLE POINT ENERGY line onward
            end_section = self.output_text[pos:pos + 5000]
            alt_grad = re.search(
                r"FINAL SINGLE POINT ENERGY.*?"
                r"Maximum gradient\s+:\s+([-\d.]+).*?"
                r"RMS gradient\s+:\s+([-\d.]+)",
                end_section,
                re.IGNORECASE | re.DOTALL
            )

            if alt_grad:
                try:
                    max_grad = float(alt_grad.group(1))
                    rms_grad = float(alt_grad.group(2))
                    return max_grad, rms_grad
                except (ValueError, IndexError):
                    pass

        # Fallback: Look for convergence criteria table (usually near end of optimization)
        # But only search the last 10 KB to avoid scanning all optimization cycles
        tail_section = self.output_text[-10000:] if len(self.output_text) > 10000 else self.output_text
        grad_section = re.search(
            r"(?:Geometry|OPTIMIZATION CONVERGED|Convergence criteria:).*?"
            r"Max\. gradient.*?([-\d.]+)\s+"
            r"RMS gradient\s+([-\d.]+)",
            tail_section,
            re.IGNORECASE | re.DOTALL
        )

        if grad_section:
            try:
                max_grad = float(grad_section.group(1))
                rms_grad = float(grad_section.group(2))
                return max_grad, rms_grad
            except (ValueError, IndexError):
                pass

        return None, None

    def _parse_convergence_points(self) -> List[Dict[str, Any]]:
        """Parse per-cycle convergence data from geometry optimization cycles.

        Extracts FINAL SINGLE POINT ENERGY (D4-corrected) for each cycle, along with
        gradient information from the GEOMETRY RELAXATION STEP section.

        Returns:
            List of dicts with step, energy, dE, max_force, rms_force for each cycle
        """
        points = []
        lines = self.output_text.split("\n")
        current_cycle = 0

        for line in lines:
            # Check for cycle header
            cycle_match = re.search(r"GEOMETRY OPTIMIZATION CYCLE\s+(\d+)", line)
            if cycle_match:
                current_cycle = int(cycle_match.group(1))

            # Check for FINAL SINGLE POINT ENERGY (D4-corrected energy, appears once per cycle)
            energy_match = re.search(r"FINAL SINGLE POINT ENERGY\s+([-\d.]+)", line)
            if energy_match and current_cycle > 0:
                energy = float(energy_match.group(1))
                # Only add if we don't already have this cycle
                if not points or points[-1]["step"] != current_cycle:
                    dE = energy - points[-1]["energy"] if points else 0.0
                    points.append({
                        "step": current_cycle,
                        "energy": energy,
                        "dE": dE,
                        "energy_sigma0": 0.0,
                        "max_force": 0.0,
                        "rms_force": 0.0
                    })

            # Extract gradients for the current cycle
            # Handles both formats: "MAX gradient ... 0.123" and "MAX gradient        0.123"
            max_match = re.search(r"MAX\s+gradient\s+(?:\.\.\.)?\s+([-\d.]+)", line, re.IGNORECASE)
            rms_match = re.search(r"RMS\s+gradient\s+(?:\.\.\.)?\s+([-\d.]+)", line, re.IGNORECASE)
            if max_match and points:
                points[-1]["max_force"] = float(max_match.group(1))
            if rms_match and points:
                points[-1]["rms_force"] = float(rms_match.group(1))

        return points

    def get_summary(self) -> Dict[str, Any]:
        """Get optimization summary."""
        return {
            "energy_eh": self.energy_eh,
            "energy_ev": self.energy_eh * 27.211386 if self.energy_eh else None,
            "converged": self.converged,
            "n_steps": self.n_steps,
            "max_gradient": self.max_gradient,
            "rms_gradient": self.rms_gradient,
            "convergence_points": self.convergence_points,
        }


class OrcaIrcOutput:
    """Parser for ORCA IRC output files."""

    def __init__(self, output_text: str):
        """Initialize parser with ORCA output text.

        Args:
            output_text: Full content of ORCA IRC output file
        """
        self.output_text = output_text
        self._parse()

    def _parse(self):
        """Parse all relevant sections from ORCA IRC output."""
        self.irc_converged = self._check_irc_convergence()
        self.path_summary = self._parse_path_summary()
        self.forward_endpoint = self._extract_endpoint_energy("forward")
        self.backward_endpoint = self._extract_endpoint_energy("backward")
        self.warnings = self._collect_warnings()
        # Release the raw output text after parsing completes — frees up to 2 MB of memory
        del self.output_text

    def _check_irc_convergence(self) -> bool:
        """Check if IRC optimization converged."""
        return "IRC OPTIMIZATION HAS CONVERGED" in self.output_text

    def _parse_path_summary(self) -> Optional[Dict[str, Any]]:
        """Parse the IRC PATH SUMMARY section.

        Returns:
            Dict with energy profile data if found
        """
        # Find IRC PATH SUMMARY section by locating the section start first.
        # Avoids catastrophic regex backtracking with ^[A-Z] and $ fallback.
        pos = self.output_text.find("IRC PATH SUMMARY")
        if pos == -1:
            return None

        # Extract a bounded slice (IRC PATH SUMMARY is typically ~50-100 lines, ~10KB max)
        section = self.output_text[pos:pos + 10000]

        # Extract the table content (lines between header and separator)
        header_end = section.find("\n")
        if header_end == -1:
            return None
        summary_text = section[header_end+1:]
        steps = []
        ts_index = None
        ts_energy = None

        # Parse each step line: Step E(Eh) dE(kcal/mol) max(|G|) RMS(G) [TS marker]
        for line in summary_text.split('\n'):
            line = line.strip()
            if not line:
                continue

            # Match step entries
            step_match = re.match(
                r"(\d+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*(.*)",
                line
            )

            if step_match:
                step_num = int(step_match.group(1))
                energy_eh = float(step_match.group(2))
                de_kcal = float(step_match.group(3))
                max_grad = float(step_match.group(4))
                rms_grad = float(step_match.group(5))
                markers = step_match.group(6).strip()

                entry = {
                    "step": step_num,
                    "energy_eh": energy_eh,
                    "de_kcal_mol": de_kcal,
                    "max_gradient": max_grad,
                    "rms_gradient": rms_grad
                }

                # Check for TS marker
                if "<= TS" in markers:
                    entry["is_ts"] = True
                    ts_index = step_num
                    ts_energy = energy_eh

                steps.append(entry)

        return {
            "steps": steps,
            "ts_step": ts_index,
            "ts_energy": ts_energy,
            "num_steps": len(steps)
        }

    def _extract_endpoint_energy(self, direction: str) -> Optional[Dict[str, Any]]:
        """Extract endpoint structure information.

        Args:
            direction: Either "forward" or "backward"

        Returns:
            Dict with endpoint data if found
        """
        if direction == "forward":
            # Look for "FORWARD IRC" section
            forward_match = re.search(
                r"\*+\s*FORWARD IRC\s*\*+.*?(?:Iteration.*?\n\s*)(\d+)\s+([-\d.]+).*?$",
                self.output_text,
                re.MULTILINE | re.DOTALL
            )
            if forward_match:
                return {
                    "direction": "forward",
                    "final_iteration": int(forward_match.group(1)),
                    "final_energy": float(forward_match.group(2))
                }
        else:
            # Look for "BACKWARD IRC" section
            backward_match = re.search(
                r"\*+\s*BACKWARD IRC\s*\*+.*?(?:Iteration.*?\n\s*)(\d+)\s+([-\d.]+).*?$",
                self.output_text,
                re.MULTILINE | re.DOTALL
            )
            if backward_match:
                return {
                    "direction": "backward",
                    "final_iteration": int(backward_match.group(1)),
                    "final_energy": float(backward_match.group(2))
                }

        return None

    def _collect_warnings(self) -> List[str]:
        """Collect any warnings from IRC output.

        Returns:
            List of warning messages
        """
        warnings = []

        if "PROBLEM" in self.output_text or "ERROR" in self.output_text:
            warnings.append("IRC calculation may have encountered issues - check output file")

        if "does not have" in self.output_text and "imaginary" in self.output_text:
            warnings.append("Input structure may not be a true transition state")

        return warnings

    def get_summary(self) -> Dict[str, Any]:
        """Get complete IRC summary.

        Returns:
            Dictionary with all IRC results
        """
        summary = {
            "irc_converged": self.irc_converged,
            "path_summary": self.path_summary,
            "forward_endpoint": self.forward_endpoint,
            "backward_endpoint": self.backward_endpoint,
            "warnings": self.warnings
        }

        # Extract convergence_points from path_summary for visualization
        if self.path_summary and self.path_summary.get("steps"):
            steps = self.path_summary["steps"]
            convergence_points = []
            for step in steps:
                convergence_points.append({
                    "step": step.get("step"),
                    "energy": step.get("energy_eh"),  # Use standard "energy" key
                    "dE": step.get("de_kcal_mol", 0.0),
                    "max_gradient": step.get("max_gradient", 0.0),
                    "rms_gradient": step.get("rms_gradient", 0.0),
                    "is_ts": step.get("is_ts", False)
                })
            summary["convergence_points"] = convergence_points

            if len(steps) > 0:
                reactant_energy = min(s["energy_eh"] for s in steps)
                product_energy = max(s["energy_eh"] for s in steps)
                summary["reaction_coordinate_data"] = {
                    "min_energy": reactant_energy,
                    "max_energy": product_energy,
                    "energy_range_kcal_mol": (product_energy - reactant_energy) * 627.51  # Eh to kcal/mol
                }

        return summary


def parse_orca_neb_output(output_file_path: str) -> OrcaNebOutput:
    """Parse ORCA NEB output file.

    Args:
        output_file_path: Path to ORCA output file

    Returns:
        OrcaNebOutput parser object
    """
    with open(output_file_path, 'r') as f:
        content = f.read()

    return OrcaNebOutput(content)


def parse_orca_single_point_output(output_file_path: str) -> OrcaSinglePointOutput:
    """Parse ORCA single point output file.

    Args:
        output_file_path: Path to ORCA output file

    Returns:
        OrcaSinglePointOutput parser object
    """
    with open(output_file_path, 'r') as f:
        content = f.read()

    return OrcaSinglePointOutput(content)


def parse_orca_freq_output(output_file_path: str) -> OrcaFreqOutput:
    """Parse ORCA frequency calculation output file.

    Args:
        output_file_path: Path to ORCA output file

    Returns:
        OrcaFreqOutput parser object
    """
    with open(output_file_path, 'r') as f:
        content = f.read()

    return OrcaFreqOutput(content)


def parse_orca_opt_output(output_file_path: str) -> OrcaOptOutput:
    """Parse ORCA geometry optimization output file.

    Args:
        output_file_path: Path to ORCA output file

    Returns:
        OrcaOptOutput parser object
    """
    with open(output_file_path, 'r') as f:
        content = f.read()

    return OrcaOptOutput(content)


class OrcaUvVisOutput:
    """Parser for ORCA UV/Vis spectroscopy output (TD-DFT or STEOM-DLPNO-CCSD)."""

    def __init__(self, output_text: str):
        """Initialize parser with ORCA output text.

        Args:
            output_text: Full content of ORCA .out or .txt file
        """
        self.output_text = output_text
        self._parse()

    def _parse(self):
        """Parse all relevant sections from ORCA UV/Vis output."""
        self.transitions = self._parse_absorption_spectrum()
        self.method = self._detect_method()
        # Release the raw output text after parsing completes — frees up to 2 MB of memory
        del self.output_text

    def _detect_method(self) -> str:
        """Detect if calculation was TD-DFT or STEOM.

        Returns:
            "tddft" or "steom"
        """
        # Look for method indicators near the beginning of output
        if "STEOM-DLPNO-CCSD" in self.output_text:
            return "steom"
        return "tddft"

    def _parse_absorption_spectrum(self) -> List[Dict[str, Any]]:
        """Parse the absorption spectrum table from ORCA output.

        Supports both STEOM and TD-DFT formats. For STEOM, the output contains three
        "ABSORPTION SPECTRUM" blocks (right, left, averaged). We use rfind to grab
        the LAST one (averaged spectrum), which is the correct one to report.

        Returns:
            List of dicts with transition data: state, energy_ev, energy_cm, wavelength_nm, oscillator_strength, transition_dipole_au2
        """
        marker = "ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS"

        # Use rfind to find the LAST occurrence (important for STEOM which has 3 blocks)
        pos = self.output_text.rfind(marker)
        if pos == -1:
            return []

        # Slice a bounded region: header (3 lines) + data lines (~100 chars each) = ~26 KB max for 200 roots
        section = self.output_text[pos : pos + 26000]

        # Truncate at the next table header to avoid matching velocity dipole / CD spectrum data
        table_end_markers = [
            "ABSORPTION SPECTRUM VIA TRANSITION VELOCITY",
            "CD SPECTRUM",
        ]
        end_pos = len(section)
        for m in table_end_markers:
            idx = section.find(m, len(marker) + 1)  # skip past our own header
            if 0 < idx < end_pos:
                end_pos = idx
        section = section[:end_pos]

        transitions = []

        # Format 1: STEOM style — "0-1A  ->  1-1A    2.544515   20522.9   487.3   0.034..."
        # Transition labels with state symbols (A, B, etc.)
        steom_pattern = re.compile(
            r"[\d]+-[\d]+\S*\s+->\s+[\d]+-[\d]+\S*\s+"  # transition labels (e.g., "0-1A  ->  1-1A  ")
            r"([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)"
        )
        steom_matches = list(steom_pattern.finditer(section))

        if steom_matches:
            # STEOM format matched
            for i, match in enumerate(steom_matches):
                transitions.append({
                    "state": i + 1,
                    "energy_ev": float(match.group(1)),
                    "energy_cm": float(match.group(2)),
                    "wavelength_nm": float(match.group(3)),
                    "oscillator_strength": float(match.group(4)),
                    "transition_dipole_au2": float(match.group(5)),
                })
        else:
            # Format 2: TD-DFT style — "   1   20522.9   487.3   0.034716965   0.55690 ..."
            # State number followed by 5+ numeric fields (energy_cm, wavelength_nm, fosc, dipole, ...)
            tddft_pattern = re.compile(
                r"^\s+(\d+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)",
                re.MULTILINE
            )
            for i, m in enumerate(tddft_pattern.finditer(section)):
                try:
                    state = int(m.group(1))
                    energy_cm = float(m.group(2))
                    wavelength = float(m.group(3))
                    fosc = float(m.group(4))
                    d2 = float(m.group(5))
                    # Skip header lines: energy_cm must be > 100 (cm-1), wavelength < 10000 (nm)
                    if energy_cm < 100 or wavelength > 10000:
                        continue
                    transitions.append({
                        "state": state,
                        "energy_ev": energy_cm * 0.000123984,  # cm-1 to eV conversion
                        "energy_cm": energy_cm,
                        "wavelength_nm": wavelength,
                        "oscillator_strength": fosc,
                        "transition_dipole_au2": d2,
                    })
                except (ValueError, IndexError):
                    continue

        return transitions

    def get_summary(self) -> Dict[str, Any]:
        """Return a summary of the UV/Vis calculation results.

        Returns:
            Dict with transitions list and spectral properties
        """
        summary = {
            "transitions": self.transitions,
            "n_transitions": len(self.transitions),
            "method": self.method,
        }

        if self.transitions:
            # Extract convergence_points from transitions for results plot visualization
            # User can plot as absorbance spectrum: X=wavelength_nm, Y=oscillator_strength
            convergence_points = []
            for trans in self.transitions:
                convergence_points.append({
                    "step": trans.get("state"),  # State number
                    "energy": trans.get("energy_ev"),  # Excitation energy in eV
                    "wavelength_nm": trans.get("wavelength_nm"),  # Wavelength (X-axis for spectrum)
                    "oscillator_strength": trans.get("oscillator_strength"),  # Intensity (Y-axis for spectrum)
                    "transition_dipole": trans.get("transition_dipole_au2")
                })
            summary["convergence_points"] = convergence_points

            # Find lowest excitation
            lowest = self.transitions[0]
            summary["lowest_excitation_ev"] = lowest["energy_ev"]
            summary["lowest_excitation_nm"] = lowest["wavelength_nm"]

            # Find brightest transition (highest oscillator strength)
            brightest = max(self.transitions, key=lambda t: t["oscillator_strength"])
            summary["brightest_wavelength_nm"] = brightest["wavelength_nm"]
            summary["brightest_oscillator_strength"] = brightest["oscillator_strength"]

        return summary


def parse_orca_uvvis_output(output_file_path: str) -> OrcaUvVisOutput:
    """Parse ORCA UV/Vis spectroscopy output file.

    Args:
        output_file_path: Path to ORCA output file

    Returns:
        OrcaUvVisOutput parser object
    """
    with open(output_file_path, 'r') as f:
        content = f.read()

    return OrcaUvVisOutput(content)
