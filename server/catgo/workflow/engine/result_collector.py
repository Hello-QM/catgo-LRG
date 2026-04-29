"""Result extraction from completed HPC jobs.

Reads output structures, energies, frequencies, and engine-specific results
from HPC work directories after job completion.
"""

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def _try_read_output_structure(
    hpc: Any,
    work_dir: str,
    node_type: str,
) -> Optional[str]:
    """Try to read output structure from HPC for downstream nodes.

    For VASP: reads CONTCAR. For other engines: reads appropriate output.
    """
    from workflow.node_sets import get_engine_for_node

    engine_key = get_engine_for_node(node_type)

    # VASP: read CONTCAR
    if engine_key == "vasp":
        try:
            result = await hpc.conn.run(f"cat {work_dir}/CONTCAR", check=False)
            if result.exit_status == 0 and result.stdout and len(result.stdout.strip()) > 10:
                return result.stdout
        except Exception:
            logger.debug("Failed to read CONTCAR from %s", work_dir, exc_info=True)

    # CP2K: read output structure
    if engine_key == "cp2k":
        try:
            result = await hpc.conn.run(
                f"ls -t {work_dir}/*-pos-*.xyz 2>/dev/null | head -1",
                check=False,
            )
            if result.exit_status == 0 and result.stdout.strip():
                xyz_file = result.stdout.strip()
                result2 = await hpc.conn.run(f"cat {xyz_file}", check=False)
                if result2.exit_status == 0:
                    return result2.stdout
        except Exception:
            logger.debug("Failed to read CP2K output structure from %s", work_dir, exc_info=True)

    # Sella: read structure.xyz (preferred) or CONTCAR
    if engine_key == "sella":
        for fname in ("structure.xyz", "CONTCAR"):
            try:
                result = await hpc.conn.run(f"cat {work_dir}/{fname}", check=False)
                if result.exit_status == 0 and result.stdout and len(result.stdout.strip()) > 5:
                    logger.info("Read Sella output structure from %s/%s", work_dir, fname)
                    return result.stdout
            except Exception:
                continue
        logger.debug("No Sella output structure found in %s", work_dir)

    # ORCA standalone nodes: read output structure
    if engine_key == "orca":
        for fname in ("CONTCAR", "structure.xyz"):
            try:
                result = await hpc.conn.run(f"cat {work_dir}/{fname}", check=False)
                if result.exit_status == 0 and result.stdout and len(result.stdout.strip()) > 5:
                    return result.stdout
            except Exception:
                continue

    # MLP (MACE/CHGNet/M3GNet): read CONTCAR
    if engine_key == "mlp":
        try:
            result = await hpc.conn.run(f"cat {work_dir}/CONTCAR", check=False)
            if result.exit_status == 0 and result.stdout and len(result.stdout.strip()) > 10:
                return result.stdout
        except Exception:
            logger.debug("Failed to read MLP CONTCAR from %s", work_dir, exc_info=True)

    return None


async def _try_read_sella_results(
    hpc: Any,
    work_dir: str,
) -> dict:
    """Read Sella-specific results: energy, convergence, forces from stdout/log.

    Returns a dict with keys: energy, converged, max_force, n_steps.
    """
    results: dict = {}

    # Try reading ts.log for step count
    try:
        result = await hpc.conn.run(f"wc -l {work_dir}/ts.log 2>/dev/null", check=False)
        if result.exit_status == 0 and result.stdout.strip():
            n_lines = int(result.stdout.strip().split()[0])
            results["n_steps"] = max(0, n_lines - 1)  # subtract header line
    except Exception:
        pass

    # Try reading stdout for energy and convergence (from SLURM output or direct run)
    try:
        # Check for SLURM output first, then stdout capture
        result = await hpc.conn.run(
            f"grep -h 'Final energy\\|Max force\\|Converged' {work_dir}/*.out {work_dir}/*.log 2>/dev/null | tail -5",
            check=False,
        )
        if result.exit_status == 0 and result.stdout:
            for line in result.stdout.splitlines():
                if "Final energy:" in line:
                    try:
                        results["energy"] = float(line.split(":")[-1].strip().split()[0])
                    except (ValueError, IndexError):
                        pass
                elif "Max force:" in line:
                    try:
                        results["max_force"] = float(line.split(":")[-1].strip().split()[0])
                    except (ValueError, IndexError):
                        pass
                elif "Converged:" in line:
                    results["converged"] = "True" in line
    except Exception:
        logger.debug("Failed to parse Sella results from %s", work_dir, exc_info=True)

    return results


async def collect_completed_results(
    hpc, work_dir: str, node_id: str, node_type: str, params: dict,
    session_id: str, job_id: str,
) -> dict:
    """Build the result dict for a completed HPC job.

    Reads output files (CONTCAR, OUTCAR energy, CP2K energy, MLP energy,
    VASP frequencies, Sella results) and returns a dict suitable for
    ``step_results[node_id]``.

    This is a pure extraction helper -- it does **not** modify any external
    state.  Callers are responsible for storing the returned dict.
    """
    from workflow.node_sets import get_engine_for_node

    engine_key = get_engine_for_node(node_type)

    result: dict = {
        "status": "completed",
        "work_dir": work_dir,
        "job_id": job_id,
        "session_id": session_id,
        "node_type": node_type,
    }

    # Propagate system_name for downstream gibbs_energy / free_energy nodes
    if params.get("system_name"):
        result["system_name"] = params["system_name"]

    # Try to read CONTCAR/output structure for downstream nodes
    output_structure = await _try_read_output_structure(
        hpc, work_dir, node_type,
    )
    if output_structure:
        result["structure"] = output_structure

    # Extract Sella-specific results (energy, convergence, forces)
    if engine_key == "sella":
        try:
            sella_results = await _try_read_sella_results(hpc, work_dir)
            if sella_results:
                result.update(sella_results)
                logger.info("Sella results for %s: %s", node_id, sella_results)
        except Exception as exc:
            logger.warning("Failed to read Sella results for %s: %s", node_id, exc)

    # Extract MLP results (energy from stdout)
    if engine_key == "mlp":
        try:
            # Read the SLURM stdout file for "Final energy: X eV"
            grep_result = await hpc.conn.run(
                f"cat {work_dir}/*.out 2>/dev/null || cat {work_dir}/slurm-*.out 2>/dev/null",
                check=False,
            )
            if grep_result.exit_status == 0 and grep_result.stdout:
                for line in grep_result.stdout.splitlines():
                    if "Final energy:" in line:
                        try:
                            energy = float(line.split("Final energy:")[1].strip().split()[0])
                            result["energy"] = energy
                            logger.info("MLP energy for %s: %.6f eV", node_id, energy)
                        except (ValueError, IndexError):
                            pass
        except Exception as exc:
            logger.warning("Failed to read MLP energy for %s: %s", node_id, exc)

    # Extract VASP final energy from OUTCAR for downstream nodes (gibbs_energy etc.)
    if engine_key == "vasp" and "energy" not in result:
        try:
            grep_result = await hpc.conn.run(
                f"grep 'free  energy   TOTEN' {work_dir}/OUTCAR | tail -1",
                check=False,
            )
            if grep_result.exit_status == 0 and grep_result.stdout.strip():
                # Format: "  free  energy   TOTEN  =      -123.45678901 eV"
                energy_str = grep_result.stdout.strip().split("=")[-1].strip().split()[0]
                energy = float(energy_str)
                result["energy"] = energy
                logger.info("VASP energy for %s: %.6f eV", node_id, energy)
        except Exception as exc:
            logger.warning("Failed to extract VASP energy for %s: %s", node_id, exc)

    # Extract CP2K final energy for downstream nodes
    # CP2K output file may be named project.out, cp2k.out, or other names
    # depending on PROJECT name in &GLOBAL section
    if engine_key == "cp2k" and "energy" not in result:
        try:
            grep_result = await hpc.conn.run(
                f"grep 'ENERGY| Total' {work_dir}/*.out 2>/dev/null | tail -1",
                check=False,
            )
            if grep_result.exit_status == 0 and grep_result.stdout.strip():
                # Format: " ENERGY| Total FORCE_EVAL ( QS ) energy [a.u.]:          -123.456789"
                # or with filename prefix: "project.out: ENERGY| Total ..."
                line = grep_result.stdout.strip()
                energy_ha = float(line.split()[-1])
                energy_ev = energy_ha * 27.211386245988  # Hartree to eV
                result["energy"] = energy_ev
                logger.info("CP2K energy for %s: %.6f eV (%.6f Ha)", node_id, energy_ev, energy_ha)
        except Exception as exc:
            logger.warning("Failed to extract CP2K energy for %s: %s", node_id, exc)

    # Extract frequency data for VASP freq nodes
    # node_type can be "freq" (task_type) or "frequency" (resolved via calc_type_mapping)
    if node_type in ("freq", "frequency") and engine_key == "vasp":
        try:
            from catgo.utils.vasp_freq_parser import parse_vasp_frequencies
            logger.info("[FREQ] Parsing frequencies for %s (node_type=%s, engine=%s, work_dir=%s)",
                       node_id, node_type, engine_key, work_dir)
            freq_data = await parse_vasp_frequencies(hpc.conn, work_dir)
            logger.info("[FREQ] Parser returned: success=%s, n_real=%d, n_imag=%d, msg=%s",
                       freq_data.get("success"), len(freq_data.get("real_freqs", [])),
                       len(freq_data.get("imag_freqs", [])), freq_data.get("message", ""))
            if freq_data.get("success"):
                result.update(freq_data)
            else:
                logger.warning("[FREQ] Parser failed for %s: %s", node_id, freq_data.get("message"))
        except Exception as exc:
            logger.warning(
                "Failed to parse VASP frequencies for %s: %s", node_id, exc, exc_info=True
            )

    return result
