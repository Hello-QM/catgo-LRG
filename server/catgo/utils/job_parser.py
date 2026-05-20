"""Remote job analysis utilities for parsing calculation output files over SSH.

Provides functions to detect calculation software/type, parse convergence data,
track optimization progress, and retrieve structure files from remote HPC jobs.
Each function takes a conn object with an async run(cmd, check=False) method
that returns an object with .exit_status, .stdout, and .stderr attributes.
"""

import asyncio
import json
import logging
import re
import shlex
from typing import Any

from catgo.models.hpc import CalcSoftware, CalcType, ConvergenceData, ConvergencePoint

logger = logging.getLogger(__name__)


async def read_orca_output(conn: Any, file_path: str, max_bytes: int = 2 * 1024 * 1024) -> str:
    """Read the tail of an ORCA output file via SSH.

    ORCA writes convergence markers and final energies near the END of the file.
    This uses tail (not head) to read the last max_bytes of the file, avoiding:
    1. The unnecessary wc -l that reads the entire file on slow HPC filesystems
    2. Truncation of data (head reads beginning where data is missing)

    Also adds a timeout to prevent indefinite hangs on slow/unresponsive HPC systems.

    Args:
        conn: SSH connection with async run() method.
        file_path: Remote ORCA output file path.
        max_bytes: Maximum bytes to read from the tail (default 2 MB).

    Returns:
        File content (last max_bytes), or empty string on timeout/error.
    """
    safe_path = shlex.quote(file_path)
    try:
        result = await asyncio.wait_for(
            conn.run(f"tail -c {max_bytes} {safe_path} 2>/dev/null", check=False),
            timeout=30.0,
        )
        return result.stdout or ""
    except asyncio.TimeoutError:
        logger.warning("Timed out reading ORCA output from %s after 30s", file_path)
        return ""
    except Exception as e:
        logger.warning("Failed to read ORCA output from %s: %s", file_path, e)
        return ""


async def read_orca_convergence(conn: Any, file_path: str) -> str:
    """Grep optimization convergence lines from full ORCA output.

    Uses grep instead of reading the entire file — fast on any file size.
    Extracts GEOMETRY OPTIMIZATION CYCLE markers, Total Energy values, and gradient data.
    For optimization jobs with many cycles, this reads from the beginning of the file
    instead of using tail which would truncate early cycles.

    Args:
        conn: SSH connection with async run() method.
        file_path: Remote ORCA output file path.

    Returns:
        Convergence lines (GEOMETRY OPTIMIZATION CYCLE, Total Energy, gradient data),
        or empty string on timeout/error.
    """
    safe_path = shlex.quote(file_path)
    try:
        result = await asyncio.wait_for(
            conn.run(
                f"grep -E 'GEOMETRY OPTIMIZATION CYCLE|Total Energy.*Eh|MAX gradient|RMS gradient' {safe_path} 2>/dev/null | head -2000",
                check=False
            ),
            timeout=30.0,
        )
        return result.stdout or ""
    except asyncio.TimeoutError:
        logger.warning("Timed out grepping ORCA convergence from %s after 30s", file_path)
        return ""
    except Exception as e:
        logger.warning("Failed to grep ORCA convergence from %s: %s", file_path, e)
        return ""


async def detect_calc_type(
    conn: Any, work_dir: str
) -> tuple[CalcSoftware, CalcType]:
    """Detect calculation software and type from files in work_dir.

    Checks for VASP (INCAR), Quantum ESPRESSO (.pwi/.in), LAMMPS (in.*/*.lmp),
    and CP2K (.inp with &GLOBAL) input files, then parses relevant keywords
    to determine the calculation type.

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote working directory to inspect.

    Returns:
        Tuple of (CalcSoftware, CalcType) detected from job files.
    """
    safe_dir = shlex.quote(work_dir)

    # --- VASP detection ---
    result = await conn.run(
        f"test -f {safe_dir}/INCAR && echo VASP", check=False
    )
    if result.exit_status == 0 and "VASP" in (result.stdout or ""):
        software = CalcSoftware.VASP
        calc_type = CalcType.SCF  # default

        grep_result = await conn.run(
            f"grep -i 'IBRION\\|NSW\\|ISIF\\|ISTART\\|ICHARG' {safe_dir}/INCAR 2>/dev/null",
            check=False,
        )
        incar_text = (grep_result.stdout or "").upper()

        nsw = 0
        ibrion = -1  # VASP default

        # Parse NSW
        nsw_match = re.search(r"NSW\s*=\s*(\d+)", incar_text)
        if nsw_match:
            nsw = int(nsw_match.group(1))

        # Parse IBRION
        ibrion_match = re.search(r"IBRION\s*=\s*(-?\d+)", incar_text)
        if ibrion_match:
            ibrion = int(ibrion_match.group(1))

        if nsw == 0 or ibrion == -1:
            calc_type = CalcType.SCF
        elif ibrion == 0:
            calc_type = CalcType.MD
        elif ibrion in (5, 6, 7, 8):
            calc_type = CalcType.FREQ
        elif nsw > 0 and ibrion in (1, 2, 3, 44):
            calc_type = CalcType.OPT
        elif nsw > 0:
            calc_type = CalcType.OPT

        return software, calc_type

    # --- Quantum ESPRESSO detection ---
    result = await conn.run(
        f"ls {safe_dir}/*.pwi {safe_dir}/*.in 2>/dev/null | head -1",
        check=False,
    )
    qe_file = (result.stdout or "").strip()
    if qe_file:
        software = CalcSoftware.QE
        calc_type = CalcType.SCF  # default

        safe_file = shlex.quote(qe_file)
        grep_result = await conn.run(
            f"grep -i 'calculation' {safe_file} 2>/dev/null", check=False
        )
        calc_line = (grep_result.stdout or "").lower()

        if "vc-relax" in calc_line or "vc-md" in calc_line:
            if "vc-relax" in calc_line:
                calc_type = CalcType.OPT
            else:
                calc_type = CalcType.MD
        elif "relax" in calc_line:
            calc_type = CalcType.OPT
        elif "md" in calc_line:
            calc_type = CalcType.MD
        elif "bands" in calc_line:
            calc_type = CalcType.BAND
        elif "nscf" in calc_line:
            calc_type = CalcType.SCF
        elif "scf" in calc_line:
            calc_type = CalcType.SCF

        return software, calc_type

    # --- LAMMPS detection ---
    result = await conn.run(
        f"ls {safe_dir}/in.* {safe_dir}/*.lmp 2>/dev/null | head -1",
        check=False,
    )
    if (result.stdout or "").strip():
        return CalcSoftware.LAMMPS, CalcType.MD

    # --- CP2K detection ---
    result = await conn.run(
        f"ls {safe_dir}/*.inp 2>/dev/null | head -1", check=False
    )
    inp_file = (result.stdout or "").strip()
    if inp_file:
        safe_file = shlex.quote(inp_file)
        grep_result = await conn.run(
            f"grep -i 'RUN_TYPE\\|&GLOBAL' {safe_file} 2>/dev/null", check=False
        )
        grep_text = (grep_result.stdout or "").upper()
        if "&GLOBAL" in grep_text or "&FORCE_EVAL" in grep_text or "&CELL" in grep_text:
            software = CalcSoftware.CP2K
            calc_type = CalcType.UNKNOWN

            run_match = re.search(r"RUN_TYPE\s+(\S+)", grep_text)
            if run_match:
                rt = run_match.group(1)
                if rt in ("GEO_OPT", "CELL_OPT"):
                    calc_type = CalcType.OPT
                elif rt in ("ENERGY", "ENERGY_FORCE"):
                    calc_type = CalcType.SCF
                elif rt == "MD":
                    calc_type = CalcType.MD
                elif rt in ("VIBRATIONAL_ANALYSIS", "NORMAL_MODES"):
                    calc_type = CalcType.FREQ
                elif rt == "BAND":
                    calc_type = CalcType.NEB

            return software, calc_type

    return CalcSoftware.UNKNOWN, CalcType.UNKNOWN


async def batch_detect_calc_types(
    conn: Any, work_dirs: list[str]
) -> dict[str, tuple["CalcSoftware", "CalcType"]]:
    """Detect calculation software and type for multiple work directories.

    Uses a single SSH command to check characteristic files in all directories,
    then parses INCAR/input files for calculation type where needed.

    Returns a dict mapping work_dir -> (CalcSoftware, CalcType).
    """
    if not work_dirs:
        return {}

    # Build a shell script that checks each directory
    checks = []
    for d in work_dirs:
        sd = shlex.quote(d)
        checks.append(
            f'if [ -f {sd}/INCAR ]; then echo "{d}:vasp"; '
            f'elif ls {sd}/*.pwi {sd}/*.in 2>/dev/null | head -1 | grep -q .; then echo "{d}:qe"; '
            f'elif ls {sd}/in.* {sd}/*.lmp 2>/dev/null | head -1 | grep -q .; then echo "{d}:lammps"; '
            f'elif ls {sd}/*.inp 2>/dev/null | head -1 | grep -q .; then echo "{d}:cp2k"; '
            f'else echo "{d}:unknown"; fi'
        )
    cmd = " && ".join(checks)
    result = await conn.run(cmd, check=False)

    software_map: dict[str, CalcSoftware] = {}
    if result.exit_status == 0 and (result.stdout or "").strip():
        for line in result.stdout.strip().splitlines():
            line = line.strip()
            if ":" not in line:
                continue
            # Split on last colon (work_dir may contain colons)
            idx = line.rfind(":")
            wdir = line[:idx]
            sw = line[idx + 1:].strip().lower()
            sw_map = {
                "vasp": CalcSoftware.VASP,
                "qe": CalcSoftware.QE,
                "lammps": CalcSoftware.LAMMPS,
                "cp2k": CalcSoftware.CP2K,
            }
            software_map[wdir] = sw_map.get(sw, CalcSoftware.UNKNOWN)

    # For VASP directories, batch-parse INCAR to determine calc type
    vasp_dirs = [d for d, sw in software_map.items() if sw == CalcSoftware.VASP]
    type_map: dict[str, CalcType] = {}

    if vasp_dirs:
        # Read IBRION and NSW from INCAR in each VASP directory
        incar_checks = []
        for d in vasp_dirs:
            sd = shlex.quote(d)
            incar_checks.append(
                f'echo "DIR:{d}"; grep -iE "^\\s*(IBRION|NSW|ISIF)" {sd}/INCAR 2>/dev/null'
            )
        incar_cmd = " ; ".join(incar_checks)
        incar_result = await conn.run(incar_cmd, check=False)

        if incar_result.exit_status is not None and (incar_result.stdout or "").strip():
            current_dir = ""
            ibrion = -1
            nsw = 0
            for line in incar_result.stdout.strip().splitlines():
                line = line.strip()
                if line.startswith("DIR:"):
                    # Save previous directory's result
                    if current_dir:
                        type_map[current_dir] = _classify_vasp(ibrion, nsw)
                    current_dir = line[4:]
                    ibrion = -1
                    nsw = 0
                else:
                    m = re.search(r"IBRION\s*=\s*(-?\d+)", line, re.IGNORECASE)
                    if m:
                        ibrion = int(m.group(1))
                    m = re.search(r"NSW\s*=\s*(\d+)", line, re.IGNORECASE)
                    if m:
                        nsw = int(m.group(1))
            # Don't forget last directory
            if current_dir:
                type_map[current_dir] = _classify_vasp(ibrion, nsw)

    # Build final result
    results: dict[str, tuple[CalcSoftware, CalcType]] = {}
    for d in work_dirs:
        sw = software_map.get(d, CalcSoftware.UNKNOWN)
        ct = type_map.get(d, CalcType.UNKNOWN)
        if sw == CalcSoftware.LAMMPS and ct == CalcType.UNKNOWN:
            ct = CalcType.MD
        results[d] = (sw, ct)

    return results


def _classify_vasp(ibrion: int, nsw: int) -> "CalcType":
    """Classify VASP calculation type from IBRION and NSW values."""
    if nsw == 0 or ibrion == -1:
        return CalcType.SCF
    elif ibrion == 0:
        return CalcType.MD
    elif ibrion in (1, 2, 3):
        return CalcType.OPT
    elif ibrion in (5, 6, 7, 8):
        return CalcType.FREQ
    return CalcType.UNKNOWN


async def parse_vasp_convergence(
    conn: Any, work_dir: str
) -> ConvergenceData:
    """Parse VASP OSZICAR and OUTCAR for convergence data.

    Extracts energy per ionic step from OSZICAR (free energy F and energy
    sigma->0 E0) and maximum force per ionic step from OUTCAR.

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote directory containing OSZICAR and OUTCAR.

    Returns:
        ConvergenceData with per-step energy and force information.
    """
    safe_dir = shlex.quote(work_dir)

    # Single SSH command: OSZICAR + OUTCAR forces + convergence check
    # Uses delimiters to separate outputs and avoid multiple round-trips
    awk_forces = (
        "awk '"
        "/TOTAL-FORCE/{dash=0; max=0; sum2=0; n=0; next} "
        "/---/{dash++; if(dash==2){rms=(n>0)?sqrt(sum2/n):0; print max,rms}; next} "
        "dash==1 && NF>=6{f=sqrt($4*$4+$5*$5+$6*$6); if(f>max)max=f; sum2+=f*f; n++}'"
    )
    combined_cmd = (
        f"cat {safe_dir}/OSZICAR 2>/dev/null; "
        f"echo '===FORCES_DELIM==='; "
        f"{awk_forces} {safe_dir}/OUTCAR 2>/dev/null; "
        f"echo '===CONV_DELIM==='; "
        f"grep -c 'reached required accuracy' {safe_dir}/OUTCAR 2>/dev/null"
    )
    result = await conn.run(combined_cmd, check=False)
    raw = result.stdout or ""

    # Split by delimiters
    parts = raw.split("===FORCES_DELIM===")
    oszicar_text = parts[0] if parts else ""
    rest = parts[1] if len(parts) > 1 else ""
    conv_parts = rest.split("===CONV_DELIM===")
    forces_text = conv_parts[0].strip() if conv_parts else ""
    conv_text = conv_parts[1].strip() if len(conv_parts) > 1 else "0"

    # --- Parse OSZICAR for ionic step energies ---
    if not oszicar_text.strip():
        return ConvergenceData(
            success=False, message="OSZICAR not found or empty"
        )

    ionic_pattern = re.compile(
        r"^\s*(\d+)\s+F=\s*([\d.E+-]+)\s+E0=\s*([\d.E+-]+)",
        re.MULTILINE,
    )
    ionic_steps: list[tuple[int, float, float]] = []
    for match in ionic_pattern.finditer(oszicar_text):
        step = int(match.group(1))
        energy_f = float(match.group(2))
        energy_e0 = float(match.group(3))
        ionic_steps.append((step, energy_f, energy_e0))

    if not ionic_steps:
        return ConvergenceData(
            success=False, message="No ionic steps found in OSZICAR"
        )

    # --- Parse forces from combined output ---
    max_forces: list[float] = []
    rms_forces: list[float] = []
    if forces_text:
        for line in forces_text.splitlines():
            line_parts = line.strip().split()
            if len(line_parts) >= 2:
                try:
                    max_forces.append(float(line_parts[0]))
                    rms_forces.append(float(line_parts[1]))
                except ValueError:
                    pass
            elif len(line_parts) == 1:
                try:
                    max_forces.append(float(line_parts[0]))
                    rms_forces.append(0.0)
                except ValueError:
                    pass

    # --- Check convergence ---
    # "reached required accuracy" is VASP's universal ionic convergence marker
    # (works for both force-based and energy-based EDIFFG)
    # NOTE: removed `|| echo 0` — it caused double "0\n0" output when grep
    # found no match, making the string != "0" and falsely setting converged=True.
    # Without `|| echo 0`, grep -c outputs "0" (no match) or "" (no OUTCAR),
    # both handled correctly below. check=False on SSH ignores exit codes.
    converged = conv_text not in ("0", "")

    # --- Build ConvergencePoint list ---
    # OUTCAR may contain more TOTAL-FORCE blocks than OSZICAR ionic steps
    # (e.g. initial geometry evaluation before relaxation starts).
    # Align from the end so the last ionic step gets the last force value.
    force_offset = max(len(max_forces) - len(ionic_steps), 0)
    points: list[ConvergencePoint] = []
    for idx, (step, energy_f, energy_e0) in enumerate(ionic_steps):
        fi = idx + force_offset
        force = max_forces[fi] if fi < len(max_forces) else 0.0
        rms = rms_forces[fi] if fi < len(rms_forces) else 0.0
        points.append(
            ConvergencePoint(
                step=step,
                energy=energy_f,
                energy_sigma0=energy_e0,
                max_force=force,
                rms_force=rms,
            )
        )

    return ConvergenceData(
        success=True,
        points=points,
        converged=converged,
        message=f"{len(points)} ionic steps parsed"
        + (" (converged)" if converged else ""),
    )


# CP2K reports energies in Hartree and gradients in Hartree/Bohr. Convert to
# the VASP-aligned units (eV, eV/Å) so the same Plotly trace config works for
# both engines and the user reads consistent magnitudes across the workflow.
_HARTREE_TO_EV = 27.211386245988
_HARTREE_PER_BOHR_TO_EV_PER_ANG = 51.42220675112


def _parse_cp2k_scf(raw: str) -> ConvergenceData | None:
    """Parse CP2K SCF iteration table — fallback when no MD/OPT steps exist yet.

    During initial SCF (before the first MD step or before the first
    optimization step completes), CP2K writes lines like:

        Step     Update method      Time    Convergence         Total energy    Change
        ------------------------------------------------------------------------------
           1 OT DIIS     0.15E+00    3.2     0.18934141       -65.1644992206 -6.52E+01
           2 OT DIIS     0.15E+00    3.8     0.15555510       -66.6465994918 -1.48E+00

    With nothing else parseable yet, the user sees a blank chart that says
    "Waiting for first MD step…" for ~10 min on a big basis — which is
    indistinguishable from "the parser is broken". Surfacing the SCF
    energy descent gives them real-time feedback that CP2K is actually
    making progress. Each SCF iteration becomes a ConvergencePoint with
    step = iteration index, energy in eV.

    Returns None if no SCF table found, so caller can fall back further.
    """
    # Match SCF lines: leading whitespace, integer step, "OT DIIS" or other
    # method (e.g. "OT CG"), the stepsize, time, convergence, total energy,
    # change. We anchor on `OT ` to avoid matching unrelated tables.
    scf_re = re.compile(
        r"^\s*(\d+)\s+OT\s+\w+\s+\S+\s+\S+\s+\S+\s+(-?\d+\.\d+(?:[eE][+-]?\d+)?)\s+(\S+)\s*$",
        re.MULTILINE,
    )
    matches = list(scf_re.finditer(raw))
    if not matches:
        return None

    points: list[ConvergencePoint] = []
    for m in matches:
        iter_n = int(m.group(1))
        energy_ha = float(m.group(2))
        points.append(ConvergencePoint(
            step=iter_n,
            energy=energy_ha * _HARTREE_TO_EV,
            energy_sigma0=energy_ha * _HARTREE_TO_EV,
        ))

    return ConvergenceData(
        success=True,
        points=points,
        converged=False,
        message=f"SCF iterations ({len(points)}) — waiting for first MD/OPT step",
    )


def _parse_cp2k_md(raw: str) -> ConvergenceData:
    """Parse CP2K MD output for per-step thermodynamic data.

    CP2K MD prints one block per MD step containing STEP NUMBER, TIME,
    CONSERVED QUANTITY, POTENTIAL ENERGY, KINETIC ENERGY, TEMPERATURE.
    These appear at every step (no extra PRINT keyword needed), so the
    chart fills in dense from the very first step — which is what the
    user expects for MD (vs the once-per-cycle pattern of GEO_OPT).

    Format variations handled:
      - Classic block format: `STEP NUMBER = N` (CP2K 2023.x default)
      - Optional unit brackets: `TEMPERATURE [K] = X` or `TEMPERATURE = X`
      - Integer values (no decimal): `TEMPERATURE [K] = 298`
      - Both `POTENTIAL ENERGY[hartree]` (no space) and `KINETIC ENERGY [hartree]` (with space)
    """
    # Try classic block format first, then MD| prefix format.
    step_re = re.compile(r"^\s*STEP NUMBER\s*=\s*(\d+)\s*$", re.MULTILINE)
    step_matches = list(step_re.finditer(raw))
    md_prefix = False
    if not step_matches:
        md_prefix = True
        step_re = re.compile(
            r"^\s*MD\|\s*Step number\s+(\d+)", re.MULTILINE | re.IGNORECASE,
        )
        step_matches = list(step_re.finditer(raw))
    if not step_matches:
        return ConvergenceData(success=False, message="No MD steps found")

    # Helper: pull a `KEY [unit?] = NUMBER` value from one MD-step block.
    # In the classic block format keys look like:
    #   TEMPERATURE [K] = 298.150
    #   TEMPERATURE [K] = 0.298150E+03
    #   TEMPERATURE [K] = 298           (int — Variant 5)
    #   TEMPERATURE     = 298.150       (no brackets — Variant 3)
    # In the MD| prefix format keys look like:
    #   MD| Temperature [K]   298.150
    # (no `=` sign — the value is just whitespace-separated). Try both.
    def _field(block: str, key: str) -> float | None:
        # Pattern 1: classic "KEY [unit?] = VALUE"
        m = re.search(
            rf"{key}\s*(?:\[[^\]]*\])?\s*=\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)",
            block,
            re.IGNORECASE,
        )
        if m:
            return float(m.group(1))
        # Pattern 2: MD| prefix "MD| KEY [unit?] VALUE"
        m = re.search(
            rf"MD\|\s*{key}\s*(?:\[[^\]]*\])?\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)",
            block,
            re.IGNORECASE,
        )
        return float(m.group(1)) if m else None

    points: list[ConvergencePoint] = []
    for i, sm in enumerate(step_matches):
        block_start = sm.start()
        block_end = step_matches[i + 1].start() if i + 1 < len(step_matches) else len(raw)
        block = raw[block_start:block_end]
        step_num = int(sm.group(1))

        pot_ha = _field(block, r"POTENTIAL ENERGY") or 0.0
        kin_ha = _field(block, r"KINETIC ENERGY") or 0.0
        cons_ha = _field(block, r"CONSERVED QUANTITY") or 0.0
        temp_k = _field(block, r"TEMPERATURE") or 0.0
        # CP2K MD doesn't print forces in the step block by default; the
        # chart's force panel will just be flat zero for MD which is fine
        # — it's still useful when MOTION/PRINT/FORCES is enabled.

        # `energy` is what the chart's "Energy" trace reads — for MD show
        # the total (potential + kinetic) so the curve reflects what an
        # MD user would call "the energy" (cons_quantity is also useful
        # and lives on its own field).
        total_ha = pot_ha + kin_ha
        points.append(ConvergencePoint(
            step=step_num,
            energy=total_ha * _HARTREE_TO_EV,
            energy_sigma0=total_ha * _HARTREE_TO_EV,
            potential_energy=pot_ha * _HARTREE_TO_EV,
            kinetic_energy=kin_ha * _HARTREE_TO_EV,
            conserved_energy=cons_ha * _HARTREE_TO_EV,
            temperature=temp_k,
        ))

    return ConvergenceData(
        success=True,
        points=points,
        # MD doesn't "converge" — show running so the UI doesn't flag the
        # task as not-converged when the user has run its full nsteps.
        converged=False,
        message=f"{len(points)} MD steps parsed",
    )


async def parse_cp2k_convergence(
    conn: Any, work_dir: str
) -> ConvergenceData:
    """Parse CP2K output (geo_opt, cell_opt, MD, or single-point) for
    per-step convergence / trajectory data.

    CP2K writes its stdout to whatever file we tee to (our submit.sh pipes
    to `cp2k.out`); some workflows alternatively use `project.out` (CP2K's
    default when `-o` is passed). We try both in one SSH round-trip.

    Routing:
      * If output contains `STEP NUMBER` blocks → MD parser (per-step
        energies + temperature + conserved quantity).
      * If output contains `OPTIMIZATION STEP:` markers → geo_opt /
        cell_opt parser (per-step total energy + max/RMS gradient).
      * If only an `ENERGY|` line exists → single-point fallback (1 pt).

    All energies are returned in eV, forces in eV/Å, temperature in K —
    consistent with the VASP parser so the frontend chart config can be
    shared.

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote directory containing cp2k.out (or project.out).

    Returns:
        ConvergenceData with per-step ConvergencePoint entries.
    """
    safe_dir = shlex.quote(work_dir)
    combined_cmd = (
        f"if [ -s {safe_dir}/cp2k.out ]; then cat {safe_dir}/cp2k.out; "
        f"elif [ -s {safe_dir}/project.out ]; then cat {safe_dir}/project.out; "
        f"fi"
    )
    result = await conn.run(combined_cmd, check=False)
    raw = result.stdout or ""

    if not raw.strip():
        return ConvergenceData(
            success=False, message="cp2k.out / project.out not found or empty"
        )

    # MD takes priority — its per-step blocks have nothing in common
    # with OPTIMIZATION STEP, so the routing is unambiguous.
    # Match either:
    #   - "STEP NUMBER = N"        (CP2K 2023.x classic block format)
    #   - "MD| Step number  N"     (older CP2K MD| line-prefix format)
    if (
        re.search(r"^\s*STEP NUMBER\s*=\s*\d+", raw, re.MULTILINE)
        or re.search(r"^\s*MD\|\s*Step number\s+\d+", raw, re.MULTILINE | re.IGNORECASE)
    ):
        return _parse_cp2k_md(raw)

    converged = (
        "GEOMETRY OPTIMIZATION COMPLETED" in raw
        or "CELL OPTIMIZATION COMPLETED" in raw
    )

    energy_re = re.compile(
        r"ENERGY\|\s+Total FORCE_EVAL\s*\([^)]+\)\s*energy\s*\[(?:a\.u\.|hartree)\]:\s+(-?\d+\.\d+(?:[eE][+-]?\d+)?)"
    )
    # CP2K writes per-step blocks with different markers across versions:
    #   - "--------  Informations at step =     1 ------" (CP2K 2023.x BFGS — most common)
    #   - "OPTIMIZATION STEP:     1"                     (some older or alternative-optimizer variants)
    # Match either. Single regex with alternation keeps the i-th match
    # alignment with the i-th ENERGY| line intact.
    step_re = re.compile(
        r"(?:Informations at step\s*=|OPTIMIZATION STEP:)\s*(\d+)",
        re.IGNORECASE,
    )
    # Gradient values appear in the per-step "Convergence check" block.
    # Accept "Max. gradient", "Max gradient", or the "MAX. ATOMIC FORCE"
    # variant some CP2K versions print in the force-eval summary.
    max_grad_re = re.compile(
        r"(?:Max\.?\s+(?:atomic\s+)?gradient|MAX\.?\s+ATOMIC\s+FORCE)\s*=?\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)",
        re.IGNORECASE,
    )
    rms_grad_re = re.compile(
        r"RMS\s+(?:atomic\s+)?(?:gradient|force)\s*=?\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)",
        re.IGNORECASE,
    )

    energies_ha = [float(m.group(1)) for m in energy_re.finditer(raw)]
    step_matches = list(step_re.finditer(raw))

    if not step_matches and energies_ha:
        # No OPT/MD step markers, but multiple ENERGY| lines exist —
        # almost certainly an MD that's printed several SCF-converged
        # total energies but where CP2K hasn't yet emitted its "STEP
        # NUMBER" block (the per-step thermodynamics block comes after
        # the SCF + force calc). Return one point per ENERGY| so the
        # user sees the trajectory build up live, instead of a frozen
        # single-point readout.
        points = [
            ConvergencePoint(
                step=i + 1,
                energy=e_ha * _HARTREE_TO_EV,
                energy_sigma0=e_ha * _HARTREE_TO_EV,
            )
            for i, e_ha in enumerate(energies_ha)
        ]
        return ConvergenceData(
            success=True,
            points=points,
            converged=len(points) == 1,  # 1 point ≈ single-point calc
            message=(
                "single-point energy parsed" if len(points) == 1
                else f"{len(points)} converged SCFs (pre-MD-step)"
            ),
        )

    if not step_matches:
        # No MD step, no OPT step, no ENERGY| line — CP2K is probably still
        # in initial SCF on a big system. Surface the SCF iteration table
        # so the live chart shows real progress instead of "broken".
        scf_fallback = _parse_cp2k_scf(raw)
        if scf_fallback:
            return scf_fallback
        return ConvergenceData(
            success=False, message="No optimization steps found in CP2K output"
        )

    points: list[ConvergencePoint] = []
    for i, sm in enumerate(step_matches):
        step_num = int(sm.group(1))
        block_start = sm.start()
        block_end = step_matches[i + 1].start() if i + 1 < len(step_matches) else len(raw)
        block = raw[block_start:block_end]

        energy_ha = energies_ha[i] if i < len(energies_ha) else 0.0
        max_g_match = max_grad_re.search(block)
        rms_g_match = rms_grad_re.search(block)
        max_grad_au = float(max_g_match.group(1)) if max_g_match else 0.0
        rms_grad_au = float(rms_g_match.group(1)) if rms_g_match else 0.0

        points.append(ConvergencePoint(
            step=step_num,
            energy=energy_ha * _HARTREE_TO_EV,
            energy_sigma0=energy_ha * _HARTREE_TO_EV,
            max_force=max_grad_au * _HARTREE_PER_BOHR_TO_EV_PER_ANG,
            rms_force=rms_grad_au * _HARTREE_PER_BOHR_TO_EV_PER_ANG,
        ))

    return ConvergenceData(
        success=True,
        points=points,
        converged=converged,
        message=f"{len(points)} optimization steps parsed"
        + (" (converged)" if converged else ""),
    )


async def parse_vasp_forces(
    conn: Any, work_dir: str, ionic_step: int = 0
) -> dict:
    """Extract per-atom force vectors from OUTCAR for a specific ionic step.

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote directory containing OUTCAR.
        ionic_step: Which ionic step to extract (0 = last step).

    Returns:
        Dict with forces, positions, step index, and total steps.
    """
    safe_dir = shlex.quote(work_dir)

    # AWK script: extract positions + forces from the TARGET-th TOTAL-FORCE block.
    # If TARGET=0, extract the last block.
    awk_script = (
        "BEGIN{block=0; target=" + str(ionic_step) + "} "
        "/TOTAL-FORCE/{block++; n=0; dash=0; "
        "delete px; delete py; delete pz; "
        "delete fx; delete fy; delete fz; next} "
        "/---/{dash++; "
        "if(dash==2 && (target>0 && block==target || target==0)){ "
        "for(i=0;i<n;i++) printf \"%.8f %.8f %.8f %.8f %.8f %.8f\\n\","
        "px[i],py[i],pz[i],fx[i],fy[i],fz[i]; "
        "if(target>0){printf \"BLOCK %d %d\\n\",block,block; exit}} "
        "next} "
        "dash==1 && NF>=6{"
        "px[n]=$1; py[n]=$2; pz[n]=$3; "
        "fx[n]=$4; fy[n]=$5; fz[n]=$6; n++} "
        "END{if(target==0) printf \"BLOCK %d %d\\n\",block,block}"
    )

    result = await conn.run(
        f"awk '{awk_script}' {safe_dir}/OUTCAR 2>/dev/null",
        check=False,
    )

    if result.exit_status != 0 or not (result.stdout or "").strip():
        return {"success": False, "message": "OUTCAR not found or no force data"}

    positions: list[list[float]] = []
    forces: list[list[float]] = []
    total_steps = 0
    actual_step = 0

    for line in result.stdout.strip().splitlines():
        if line.startswith("BLOCK"):
            parts = line.split()
            actual_step = int(parts[1]) if len(parts) > 1 else 0
            total_steps = int(parts[2]) if len(parts) > 2 else actual_step
            continue
        parts = line.split()
        if len(parts) >= 6:
            try:
                positions.append([float(parts[0]), float(parts[1]), float(parts[2])])
                forces.append([float(parts[3]), float(parts[4]), float(parts[5])])
            except ValueError:
                pass

    # Also read CONTCAR/POSCAR for the full structure
    struct_result = await conn.run(
        f"cat {safe_dir}/CONTCAR 2>/dev/null || cat {safe_dir}/POSCAR 2>/dev/null",
        check=False,
    )
    structure_content = (struct_result.stdout or "").strip() if struct_result.exit_status == 0 else None

    return {
        "success": True,
        "forces": forces,
        "positions": positions,
        "step": actual_step,
        "total_steps": total_steps,
        "structure_content": structure_content,
    }


async def parse_vasp_forces_h5(
    conn: Any, work_dir: str, ionic_step: int = 0
) -> dict | None:
    """Extract per-atom forces from vaspout.h5 via h5py on the remote HPC.

    Falls back to None if vaspout.h5 doesn't exist or h5py isn't available.

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote directory containing vaspout.h5.
        ionic_step: Which ionic step (0 = last step).

    Returns:
        Dict with forces/positions/step/total_steps, or None if H5 unavailable.
    """
    safe_dir = shlex.quote(work_dir)

    # Check if vaspout.h5 exists
    check = await conn.run(
        f"test -f {safe_dir}/vaspout.h5 && echo yes || echo no",
        check=False,
    )
    if (check.stdout or "").strip() != "yes":
        return None

    # Run h5py extraction script on remote HPC.
    # HDF5 paths follow py4vasp convention (https://github.com/vasp-dev/py4vasp):
    #   forces:    intermediate/ion_dynamics/forces           (nsteps, natoms, 3) eV/Å
    #   positions: intermediate/ion_dynamics/position_ions    (nsteps, natoms, 3) fractional
    #   lattice:   intermediate/ion_dynamics/lattice_vectors  (nsteps, 3, 3)
    #   scale:     intermediate/ion_dynamics/scale            scalar
    #   ion_types: results/positions/ion_types                string array
    #   ion_counts: results/positions/number_ion_types        int array
    step_arg = ionic_step
    py_script = f"""
import sys, json, numpy as np
try:
    import h5py
except ImportError:
    print("NO_H5PY"); sys.exit(0)
try:
    f = h5py.File("{work_dir}/vaspout.h5", "r")
    # Forces — trajectory path (VASP 6.4+)
    fpath = "intermediate/ion_dynamics/forces"
    if fpath not in f:
        print("NO_FORCES"); sys.exit(0)
    forces_ds = f[fpath]
    is_traj = forces_ds.ndim == 3
    total = forces_ds.shape[0] if is_traj else 1
    step = ({step_arg} - 1) if {step_arg} > 0 else (total - 1)
    step = max(0, min(step, total - 1))
    frc = (forces_ds[step] if is_traj else forces_ds[:]).tolist()
    # Positions (fractional) → convert to Cartesian
    pos_cart = []
    ppath = "intermediate/ion_dynamics/position_ions"
    lpath = "intermediate/ion_dynamics/lattice_vectors"
    spath = "intermediate/ion_dynamics/scale"
    if ppath in f and lpath in f:
        pos_ds = f[ppath]
        lat_ds = f[lpath]
        pos_frac = pos_ds[step] if pos_ds.ndim == 3 else pos_ds[:]
        lat = lat_ds[step] if lat_ds.ndim == 3 else lat_ds[:]
        scale = float(f[spath][()]) if spath in f else 1.0
        lat = np.array(lat) * scale
        pos_cart = (np.array(pos_frac) @ lat).tolist()
    ion_types = []
    if "results/positions/ion_types" in f:
        raw = f["results/positions/ion_types"][:]
        ion_types = [t.decode() if isinstance(t, bytes) else str(t) for t in raw]
    ion_counts = f["results/positions/number_ion_types"][:].tolist() if "results/positions/number_ion_types" in f else []
    f.close()
    out = {{"forces": frc, "positions": pos_cart, "step": step + 1, "total_steps": total,
           "ion_types": ion_types, "ion_counts": ion_counts}}
    print(json.dumps(out))
except Exception as e:
    print(f"ERROR:{{e}}"); sys.exit(0)
"""

    result = await conn.run(
        f"python3 -c {shlex.quote(py_script)}",
        check=False,
    )
    stdout = (result.stdout or "").strip()
    if not stdout or stdout in ("NO_H5PY", "NO_FORCES") or stdout.startswith("ERROR:"):
        return None

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return None

    # Also read CONTCAR/POSCAR for structure
    struct_result = await conn.run(
        f"cat {safe_dir}/CONTCAR 2>/dev/null || cat {safe_dir}/POSCAR 2>/dev/null",
        check=False,
    )
    structure_content = (struct_result.stdout or "").strip() if struct_result.exit_status == 0 else None

    return {
        "success": True,
        "forces": data.get("forces", []),
        "positions": data.get("positions", []),
        "step": data.get("step", 0),
        "total_steps": data.get("total_steps", 0),
        "structure_content": structure_content,
    }


async def parse_vasp_progress(
    conn: Any, work_dir: str
) -> tuple[int, int]:
    """Get current and total ionic steps for a VASP calculation.

    Counts completed ionic step lines in OSZICAR and reads NSW from INCAR
    to determine total expected steps.

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote directory containing OSZICAR and INCAR.

    Returns:
        Tuple of (current_step, total_steps). Returns (0, 0) on failure.
    """
    safe_dir = shlex.quote(work_dir)

    # Count ionic steps in OSZICAR
    current = 0
    result = await conn.run(
        f"grep -c 'F=' {safe_dir}/OSZICAR 2>/dev/null", check=False
    )
    if result.exit_status == 0 and (result.stdout or "").strip():
        try:
            current = int(result.stdout.strip())
        except ValueError:
            current = 0

    # Parse NSW from INCAR
    total = 0
    result = await conn.run(
        f"grep -i 'NSW' {safe_dir}/INCAR 2>/dev/null", check=False
    )
    if result.exit_status == 0 and (result.stdout or "").strip():
        nsw_match = re.search(r"NSW\s*=\s*(\d+)", result.stdout, re.IGNORECASE)
        if nsw_match:
            total = int(nsw_match.group(1))

    if current == 0 and total == 0:
        return 0, 0

    return current, total


async def get_structure_content(
    conn: Any, work_dir: str, software: CalcSoftware
) -> str:
    """Retrieve the current structure file content from a remote job.

    For VASP, reads CONTCAR if available, otherwise falls back to POSCAR.
    Other software types are not yet supported.

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote working directory of the calculation.
        software: Detected calculation software.

    Returns:
        Raw file content as a string, or empty string on failure.
    """
    if software == CalcSoftware.VASP:
        safe_dir = shlex.quote(work_dir)
        result = await conn.run(
            f"test -f {safe_dir}/CONTCAR && cat {safe_dir}/CONTCAR "
            f"|| cat {safe_dir}/POSCAR 2>/dev/null",
            check=False,
        )
        if result.exit_status == 0 and (result.stdout or "").strip():
            return result.stdout
        return ""

    if software == CalcSoftware.CP2K:
        safe_dir = shlex.quote(work_dir)
        # Try .restart files first (contain optimized geometry)
        result = await conn.run(
            f"ls -1t {safe_dir}/*.restart 2>/dev/null | head -1",
            check=False,
        )
        restart_file = (result.stdout or "").strip()
        if restart_file:
            safe_file = shlex.quote(restart_file)
            result = await conn.run(f"cat {safe_file} 2>/dev/null", check=False)
            if result.exit_status == 0 and (result.stdout or "").strip():
                return result.stdout

        # Fall back to .inp files
        result = await conn.run(
            f"ls -1t {safe_dir}/*.inp 2>/dev/null | head -1",
            check=False,
        )
        inp_file = (result.stdout or "").strip()
        if inp_file:
            safe_file = shlex.quote(inp_file)
            result = await conn.run(f"cat {safe_file} 2>/dev/null", check=False)
            if result.exit_status == 0 and (result.stdout or "").strip():
                return result.stdout

        return ""

    # Other software not yet supported
    return ""


async def tail_remote_file(
    conn: Any, file_path: str, n_lines: int = 100
) -> tuple[str, int]:
    """Read the last N lines of a remote file and its total line count.

    Args:
        conn: SSH connection with async run() method.
        file_path: Absolute path to the remote file.
        n_lines: Number of lines to read from the end of the file.

    Returns:
        Tuple of (content, total_lines). Returns ("", 0) on failure.
    """
    safe_path = shlex.quote(file_path)

    # Get total line count
    total_lines = 0
    result = await conn.run(
        f"wc -l < {safe_path} 2>/dev/null", check=False
    )
    if result.exit_status == 0 and (result.stdout or "").strip():
        try:
            total_lines = int(result.stdout.strip())
        except ValueError:
            total_lines = 0

    # Get tail content
    content = ""
    result = await conn.run(
        f"tail -n {n_lines} {safe_path} 2>/dev/null", check=False
    )
    if result.exit_status == 0 and result.stdout:
        content = result.stdout

    if not content and total_lines == 0:
        return "", 0

    return content, total_lines

async def read_remote_file(
    conn: Any, file_path: str, max_bytes: int = 2 * 1024 * 1024
) -> tuple[str, int]:
    """Read full content of a remote file (up to max_bytes, 0 = unlimited).

    Returns (content, total_lines).
    """
    safe_path = shlex.quote(file_path)

    # Get total line count
    total_lines = 0
    wc_result = await conn.run(f"wc -l < {safe_path} 2>/dev/null", check=False)
    if wc_result.exit_status == 0 and (wc_result.stdout or "").strip():
        try:
            total_lines = int(wc_result.stdout.strip())
        except ValueError:
            pass

    # Read content (max_bytes=0 means unlimited)
    if max_bytes > 0:
        cmd = f"head -c {max_bytes} {safe_path} 2>/dev/null"
    else:
        cmd = f"cat {safe_path} 2>/dev/null"
    result = await conn.run(cmd, check=False)
    content = ""
    if result.exit_status == 0:
        content = result.stdout or ""

    return content, total_lines


async def write_remote_file(conn: Any, file_path: str, content: str) -> bool:
    """Write content to a remote file using heredoc.

    Returns True on success.
    """
    if "~" in file_path:
        from catgo.utils.hpc_client import resolve_tilde
        file_path = await resolve_tilde(conn, file_path)
    safe_path = shlex.quote(file_path)
    # Use a heredoc with a unique delimiter to write content
    cmd = f"cat > {safe_path} << 'CATGO_WRITE_EOF'\n{content}\nCATGO_WRITE_EOF"
    result = await conn.run(cmd, check=False)
    return result.exit_status == 0


async def write_remote_files(conn: Any, files: dict[str, str]) -> bool:
    """Write multiple files in a single SSH command.

    Each heredoc uses a unique delimiter (CATGO_EOF_0, CATGO_EOF_1, ...)
    to avoid collisions with file content. One SSH channel for all files,
    eliminating channel exhaustion under concurrent HPC node execution.

    Returns True if all files were written successfully.
    """
    if not files:
        return True
    from catgo.utils.hpc_client import resolve_tilde
    parts = []
    for i, (path, content) in enumerate(files.items()):
        if "~" in path:
            path = await resolve_tilde(conn, path)
        safe = shlex.quote(path)
        delim = f"CATGO_EOF_{i}"
        parts.append(f"cat > {safe} << '{delim}'\n{content}\n{delim}")
    cmd = "\n".join(parts)
    result = await conn.run(cmd, check=False)
    return result.exit_status == 0


async def get_xdatcar_content(conn: Any, work_dir: str) -> str:
    """Read XDATCAR file from a VASP work directory.

    Returns file content or empty string if not found.
    """
    safe_dir = shlex.quote(work_dir)
    # Check if XDATCAR exists
    check = await conn.run(f"test -f {safe_dir}/XDATCAR", check=False)
    if check.exit_status != 0:
        return ""
    result = await conn.run(f"cat {safe_dir}/XDATCAR 2>/dev/null", check=False)
    if result.exit_status == 0:
        return result.stdout or ""
    return ""


async def list_job_files(
    conn: Any, work_dir: str, software: "CalcSoftware"
) -> list[str]:
    """List editable input files in a job's work directory.

    Returns list of filenames that exist.
    """
    safe_dir = shlex.quote(work_dir)

    # Define candidate files based on software
    if software == CalcSoftware.VASP:
        candidates = ["INCAR", "KPOINTS", "POSCAR", "CONTCAR", "POTCAR"]
    elif software == CalcSoftware.QE:
        candidates = []  # QE input files have varied names
    elif software == CalcSoftware.CP2K:
        candidates = []  # CP2K files use glob patterns below
    else:
        candidates = []

    # Check which candidates exist
    found: list[str] = []
    if candidates:
        names = " ".join(candidates)
        result = await conn.run(
            f"cd {safe_dir} && ls -1 {names} 2>/dev/null", check=False
        )
        if result.exit_status == 0 and (result.stdout or "").strip():
            found = [f.strip() for f in result.stdout.strip().splitlines() if f.strip()]

    # CP2K: find .inp, .restart, .out files
    if software == CalcSoftware.CP2K:
        cp2k_result = await conn.run(
            f"cd {safe_dir} && ls -1t *.inp *.restart *.out 2>/dev/null", check=False
        )
        if cp2k_result.exit_status == 0 and (cp2k_result.stdout or "").strip():
            cp2k_files = [f.strip() for f in cp2k_result.stdout.strip().splitlines() if f.strip()]
            found.extend(cp2k_files)

    # Also find job scripts (.sh, .slurm)
    script_result = await conn.run(
        f"cd {safe_dir} && ls -1t *.sh *.slurm 2>/dev/null", check=False
    )
    if script_result.exit_status == 0 and (script_result.stdout or "").strip():
        scripts = [f.strip() for f in script_result.stdout.strip().splitlines() if f.strip()]
        found.extend(scripts)

    return found


async def find_job_script(conn: Any, work_dir: str) -> str:
    """Find the most recent job script (.sh or .slurm) in work_dir.

    Returns the script filename (not full path), or empty string if none found.
    """
    safe_dir = shlex.quote(work_dir)
    result = await conn.run(
        f"cd {safe_dir} && ls -1t *.sh *.slurm 2>/dev/null | head -1",
        check=False,
    )
    if result.exit_status == 0 and (result.stdout or "").strip():
        return result.stdout.strip()
    return ""


async def merge_structures_from_dir(
    conn: Any, dir_path: str, pattern: str = "CONTCAR"
) -> tuple[bool, str, list[str]]:
    """Merge CONTCAR/POSCAR files from subdirectories into multi-frame extended XYZ.

    Searches for files matching `pattern` in immediate subdirectories
    (sorted naturally), reads each via SSH, parses them with pymatgen,
    and returns a proper multi-frame extended XYZ string.

    Args:
        conn: SSH connection.
        dir_path: Parent directory to search.
        pattern: Filename to look for in each subdirectory (e.g., "CONTCAR", "POSCAR").

    Returns:
        (success, merged_xyz_content, file_paths_found)
    """
    safe_dir = shlex.quote(dir_path)
    # Find all matching files in sorted subdirectories
    cmd = (
        f"cd {safe_dir} && "
        f"find . -mindepth 2 -maxdepth 2 -name {shlex.quote(pattern)} -type f "
        f"| sort -V"
    )
    result = await conn.run(cmd, check=False)
    if result.exit_status != 0 or not (result.stdout or "").strip():
        return False, "", []

    paths = [p.strip() for p in result.stdout.strip().split("\n") if p.strip()]
    if not paths:
        return False, "", []

    # Read all files with separators so we can split them
    cat_parts = []
    for p in paths:
        safe_p = shlex.quote(f"{dir_path}/{p.lstrip('./')}")
        cat_parts.append(f"cat {safe_p}")
    separator = "===FRAME_SEPARATOR==="
    cat_cmd = f" && echo '{separator}' && ".join(cat_parts)
    result = await conn.run(cat_cmd, check=False)
    if result.exit_status != 0:
        return False, "", paths

    raw = result.stdout or ""
    if not raw.strip():
        return False, "", paths

    # Split into individual POSCAR/CONTCAR chunks and convert to extended XYZ
    chunks = raw.split(separator)
    xyz_frames: list[str] = []
    try:
        from pymatgen.core import Structure as PmgStructure
    except ImportError:
        logger.error("pymatgen not available for POSCAR→XYZ conversion")
        return False, "", paths

    for i, chunk in enumerate(chunks):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            struct = PmgStructure.from_str(chunk, fmt="poscar")
        except Exception as e:
            logger.warning("Failed to parse frame %d as POSCAR: %s", i, e)
            continue

        # Build extended XYZ frame
        n = len(struct)
        lattice = struct.lattice
        # Lattice as row-major: a1 a2 a3 b1 b2 b3 c1 c2 c3
        lv = lattice.matrix
        lat_str = " ".join(f"{v:.8f}" for row in lv for v in row)
        label = paths[i].lstrip("./") if i < len(paths) else f"frame_{i}"
        comment = f'Lattice="{lat_str}" Properties=species:S:1:pos:R:3 comment="{label}"'

        lines = [str(n), comment]
        for site in struct:
            sym = site.specie.symbol
            x, y, z = site.coords
            lines.append(f"{sym}  {x:.8f}  {y:.8f}  {z:.8f}")
        xyz_frames.append("\n".join(lines))

    if not xyz_frames:
        return False, "", paths

    return True, "\n".join(xyz_frames) + "\n", paths

async def parse_orca_irc_progress(
    conn: Any, work_dir: str
) -> ConvergenceData:
    """Parse ORCA.out for live IRC progress — extracts per-step energy and gradient.

    Reads the FORWARD IRC and BACKWARD IRC step tables as they are written and
    returns a ConvergencePoint per step so the frontend can render a live chart.

    Step indexing matches OrcaIrcOutput.get_summary():
      - Forward steps: 0 (TS), 1, 2, ...
      - Backward steps: -1, -2, ... (backward iter 0 is skipped — duplicate TS)

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote directory containing ORCA.out.

    Returns:
        ConvergenceData with one ConvergencePoint per IRC step written so far.
    """
    from catgo.models.hpc import ConvergencePoint as CP

    safe_dir = shlex.quote(work_dir)
    orca_out = f"{safe_dir}/ORCA.out"

    # IRC writes a FORWARD section then a BACKWARD section sequentially into a
    # single output file. A fixed tail window drops the FORWARD header once the
    # file grows past that window, so we anchor the read at the FORWARD header
    # and stream to EOF (capped) when present. Falls back to a tail read while
    # the header has not yet been written.
    IRC_MAX_BYTES = 5 * 1024 * 1024
    anchored_cmd = (
        f"if grep -q 'FORWARD IRC' {orca_out} 2>/dev/null; then "
        f"sed -n '/FORWARD IRC/,$p' {orca_out} | head -c {IRC_MAX_BYTES}; "
        f"else tail -c 100000 {orca_out} 2>/dev/null; fi"
    )
    try:
        result = await asyncio.wait_for(
            conn.run(anchored_cmd, check=False),
            timeout=30.0,
        )
        content = result.stdout or ""
    except asyncio.TimeoutError:
        logger.warning("Timed out reading IRC output from %s after 30s", orca_out)
        content = await read_orca_output(conn, orca_out, max_bytes=100_000)
    except Exception as e:
        logger.warning("Failed anchored IRC read from %s: %s", orca_out, e)
        content = await read_orca_output(conn, orca_out, max_bytes=100_000)
    if not content:
        return ConvergenceData(success=False, message="ORCA.out not found or empty")

    # Regex matching a step data row:
    #   "    0      -344.666731   -1.330235    0.012276  0.005536"
    # Groups: (iter, E_Eh, dE_kcal, max_grad, rms_grad)
    STEP_RE = re.compile(
        r"^\s{1,6}(\d+)\s{2,8}([-\d.]+)\s{2,8}([-\d.]+)\s{2,8}([\d.]+)\s{2,8}([\d.]+)",
        re.MULTILINE,
    )
    THRESH_RE = re.compile(r"Convergence thresholds\s+([\d.]+)\s+([\d.]+)")

    # Parse convergence thresholds (same line appears in both arms)
    thresh_match = THRESH_RE.search(content)
    thresholds = (
        {"max_grad": float(thresh_match.group(1)), "rms_grad": float(thresh_match.group(2))}
        if thresh_match
        else {"max_grad": 0.002, "rms_grad": 0.0005}
    )

    # Locate arm boundaries
    fwd_pos = content.find("FORWARD IRC")
    bwd_pos = content.find("BACKWARD IRC")
    converged = "IRC OPTIMIZATION HAS CONVERGED" in content

    points: list[CP] = []

    # --- Forward arm ---
    if fwd_pos != -1:
        fwd_end = bwd_pos if bwd_pos > fwd_pos else len(content)
        fwd_section = content[fwd_pos:fwd_end]
        fwd_converged = "MAXIMUM NUMBER OF ITERATIONS REACHED" not in fwd_section
        for m in STEP_RE.finditer(fwd_section):
            iter_n = int(m.group(1))
            points.append(CP(
                step=iter_n,
                energy=float(m.group(2)),
                dE=float(m.group(3)),
                max_gradient=float(m.group(4)),
                rms_gradient=float(m.group(5)),
                is_ts=(iter_n == 0),
            ))
        n_fwd = len(points)
    else:
        n_fwd = 0
        fwd_converged = False

    # --- Backward arm ---
    n_bwd = 0
    if bwd_pos != -1:
        bwd_section = content[bwd_pos:]
        for m in STEP_RE.finditer(bwd_section):
            iter_n = int(m.group(1))
            if iter_n == 0:
                continue  # skip duplicate TS
            points.append(CP(
                step=-iter_n,
                energy=float(m.group(2)),
                dE=float(m.group(3)),
                max_gradient=float(m.group(4)),
                rms_gradient=float(m.group(5)),
            ))
            n_bwd += 1

    # Sort so chart reads: backward (negative) → TS (0) → forward (positive)
    points.sort(key=lambda p: p.step)

    phase = "backward" if bwd_pos != -1 else ("forward" if fwd_pos != -1 else "initializing")
    message = f"IRC {phase}: {n_fwd} forward / {n_bwd} backward steps"

    return ConvergenceData(
        success=True,
        points=points,
        converged=converged,
        message=message,
        convergence_thresholds=thresholds,
    )


async def parse_orca_uvvis_progress(
    conn: Any, work_dir: str
) -> ConvergenceData:
    """Parse ORCA.out for live UV-Vis (TD-DFT) progress.

    UV-Vis calculations don't have geometry optimization cycles.
    This parser looks for the number of excited states computed.

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote directory containing ORCA.out.

    Returns:
        ConvergenceData with UV-Vis progress (number of roots computed).
    """
    safe_dir = shlex.quote(work_dir)
    orca_out = f"{safe_dir}/ORCA.out"

    # Read last 2 MB using the existing timeout-protected function
    content = await read_orca_output(conn, orca_out)

    if not content:
        return ConvergenceData(success=False, message="ORCA.out not found or empty")

    # Check if TD-DFT calculation is complete
    converged = "ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS" in content

    # Count ROOT states computed: look for "ROOT N:" markers
    root_matches = re.findall(r"ROOT\s+(\d+):", content)
    roots_computed = max([int(m) for m in root_matches]) if root_matches else 0

    # Try to find expected number of roots from input
    # %tddft NRoots 10 means we expect 10 roots
    nroots_match = re.search(r"%tddft.*?NRoots\s+(\d+)", content, re.IGNORECASE | re.DOTALL)
    expected_roots = int(nroots_match.group(1)) if nroots_match else roots_computed

    return ConvergenceData(
        success=True,
        points=[],  # UV-Vis doesn't have per-cycle optimization points
        converged=converged,
        message=f"TD-DFT: computed {roots_computed} / {expected_roots} excited states"
    )


async def parse_neb_image_energies(
    conn: Any, file_path: str
) -> dict[int, list[tuple[int, float]]]:
    """Parse per-image energies from ORCA.interp file.

    Extracts energy data for each image at each NEB iteration from the .interp file.
    Gracefully handles missing files or incomplete iterations.

    Args:
        conn: SSH connection with async run() method.
        file_path: Path to ORCA.interp file.

    Returns:
        Dict mapping iteration number to list of (image_idx, energy_eh) tuples.
        Empty dict if file not found or parsing fails.
    """
    safe_path = shlex.quote(file_path)
    try:
        # Check if file exists first
        check_result = await asyncio.wait_for(
            conn.run(f"test -f {safe_path} && echo OK", check=False),
            timeout=5.0,
        )
        if check_result.exit_status != 0:
            logger.debug(f".interp file not yet available at {file_path}")
            return {}

        # Read the entire .interp file (usually < 100 KB)
        result = await asyncio.wait_for(
            conn.run(f"cat {safe_path}", check=False),
            timeout=30.0,
        )
        if result.exit_status != 0 or not result.stdout:
            logger.debug(f"Could not read .interp file: {file_path}")
            return {}

        return _parse_interp_content(result.stdout)

    except asyncio.TimeoutError:
        logger.warning("Timed out reading .interp file %s after 30s", file_path)
        return {}
    except Exception as e:
        logger.debug(f"Error parsing .interp file {file_path}: {e}")
        return {}


def _parse_interp_content(text: str) -> dict[int, list[tuple[int, float]]]:
    """Parse .interp file content into structured energy data.

    Format of .interp file:
        Iteration: 0
        Images: Distance  (Bohr), Energy (Eh)
        0.0000   0.00000000      0.00000000       ← actual image points
        0.1111   1.47329742      0.04025458
        ...

        Interp.: Distance  (Bohr), Energy (Eh)    ← interpolated (skip)
        0.0000   0.00000000       0.00000000
        ...

    Only the "Images:" section lines are returned; the "Interp.:" section
    (cubic polynomial interpolation between images) is skipped.

    Args:
        text: Full .interp file content.

    Returns:
        Dict of {iteration: [(image_idx, energy_eh), ...]}
    """
    result = {}
    current_iteration = None
    current_images: list[tuple[int, float]] = []
    image_count = 0
    in_images = False  # True while inside "Images:" block, False in "Interp.:" block

    for line in text.split('\n'):
        line = line.strip()

        # Match "Iteration: N"
        if line.startswith('Iteration:'):
            # Save previous iteration if we have data
            if current_iteration is not None and current_images:
                result[current_iteration] = current_images
            match = re.match(r'Iteration:\s+(-?\d+)', line)
            if match:
                current_iteration = int(match.group(1))
                current_images = []
                image_count = 0
                in_images = False

        # "Images:" header — start collecting image data
        elif line.startswith('Images:'):
            in_images = True

        # "Interp.:" header — stop collecting (interpolated points)
        elif line.startswith('Interp.'):
            in_images = False

        # Parse data lines only from the Images section
        elif in_images and current_iteration is not None and line:
            parts = line.split()
            # Each line: fractional_distance  distance_bohr  energy_eh
            if len(parts) >= 3:
                try:
                    energy_eh = float(parts[2])
                    current_images.append((image_count, energy_eh))
                    image_count += 1
                except (ValueError, IndexError):
                    pass

    # Save final iteration
    if current_iteration is not None and current_images:
        result[current_iteration] = current_images

    return result


async def parse_orca_neb_progress(
    conn: Any, work_dir: str
) -> ConvergenceData:
    """Parse ORCA.out for live NEB (Nudged Elastic Band) progress.

    NEB calculations progress by iteration, with PATH SUMMARY blocks showing
    the current energy profile across all images on the reaction path.

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote directory containing ORCA.out.

    Returns:
        ConvergenceData with NEB iteration progress.
    """
    safe_dir = shlex.quote(work_dir)
    orca_out = f"{safe_dir}/ORCA.out"
    orca_interp = f"{safe_dir}/ORCA.interp"

    # Read last 2 MB to check for convergence marker and count iterations
    content = await read_orca_output(conn, orca_out)

    if not content:
        return ConvergenceData(success=False, message="ORCA.out not found or empty")

    # Parse .interp file for per-image energy data (optional, may not exist yet)
    image_energies = await parse_neb_image_energies(conn, orca_interp)

    # NEB-TS only reports true convergence after the TS optimization stage.
    # The earlier "THE NEB OPTIMIZATION HAS CONVERGED" marker fires when the
    # CI-NEB stage finishes but before the TS opt — don't treat that as done.
    #
    # The marker can sit several MB from EOF when ORCA appends a Hessian /
    # frequency block after the TS opt, so the 2 MB tail in `content` may
    # not contain it. grep -q short-circuits at the first match, so it
    # only reads up through the marker (not the trailing Hessian output).
    marker_result = await conn.run(
        f"grep -q 'THE TS OPTIMIZATION HAS CONVERGED' {orca_out}",
        check=False,
    )
    converged = marker_result.exit_status == 0

    # Count how many PATH SUMMARY table headers appear.
    # Each NEB iteration produces one PATH SUMMARY block in the output.
    # Search for "Image Dist.(Ang.)" which is the table header.
    iteration_matches = re.findall(r"Image Dist\.\(Ang\.\)", content)
    current_iter = len(iteration_matches)

    # Extract LBFGS iteration lines for live monitoring
    # Format:    LBFGS     0      5    0.266161    0.125230   0.024160  13.2627
    # Columns:   LBFGS  iter   HEI   E(HEI)-E0   max(|Fp|)  RMS(Fp)    dS
    points = []
    lbfgs_pattern = r"^\s+LBFGS\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)"
    for match in re.finditer(lbfgs_pattern, content, re.MULTILINE):
        iteration = int(match.group(1))
        max_force = float(match.group(4))  # max(|Fp|)
        rms_force = float(match.group(5))  # RMS(Fp)
        energy_delta = float(match.group(3))  # E(HEI)-E(0)

        # Create proper ConvergencePoint object with all required fields
        points.append(
            ConvergencePoint(
                step=iteration + 1,
                energy=energy_delta,
                energy_sigma0=0.0,
                dE=0.0,
                max_force=max_force,
                rms_force=rms_force,
                max_step=0.0,
                rms_step=0.0
            )
        )

    current_iter = len(points)

    # Extract final PATH SUMMARY if available (energy profile of all images)
    barrier_text = ""
    if converged:
        path_pattern = r"Image Dist\.\(Ang\.\).*?\n((?:\s+\d+\s+[\d.]+\s+[-\d.]+\s+[-\d.]+\s+[\d.e-]+\s+[\d.e-]+.*?\n)*)"
        path_match = re.search(path_pattern, content, re.DOTALL)

        if path_match:
            ci_image = None
            barrier_kcal = 0.0
            image_count = 0
            for line in path_match.group(1).strip().split('\n'):
                parts = line.split()
                if len(parts) >= 4 and parts[0].isdigit():
                    image_count += 1
                    if '<= CI' in line:
                        ci_image = int(parts[0])
                    try:
                        energy_delta_kcal = float(parts[3])
                        barrier_kcal = max(barrier_kcal, energy_delta_kcal)
                    except (ValueError, IndexError):
                        pass

            if ci_image is not None:
                barrier_text = f" | Path: {image_count} images, CI={ci_image}, Barrier={barrier_kcal:.2f} kcal/mol"

    return ConvergenceData(
        success=True,
        points=points,
        converged=converged,
        message=f"NEB: {current_iter} iterations completed{barrier_text}",
        image_energies=image_energies if image_energies else None
    )


async def parse_orca_progress(
    conn: Any, work_dir: str, node_type: str = "orca_opt"
) -> ConvergenceData:
    """Parse ORCA.out for live calculation progress.

    Dispatches to node-type-specific parsers:
    - orca_opt, orca_sp, orca_freq: geometry optimization progress
    - orca_irc: IRC reaction coordinate progress
    - orca_uvvis: UV-Vis (TD-DFT) progress
    - orca_neb_ts: NEB transition state path progress

    Uses tail to read only the last 2000 lines instead of grepping the entire file.
    This prevents timeouts on long-running jobs with large ORCA.out files.

    Args:
        conn: SSH connection with async run() method.
        work_dir: Remote directory containing ORCA.out.
        node_type: Type of ORCA node to determine parsing strategy.

    Returns:
        ConvergenceData with progress information.
    """
    # Dispatch to node-type-specific parsers
    if node_type == "orca_irc":
        return await parse_orca_irc_progress(conn, work_dir)
    elif node_type == "orca_uvvis":
        return await parse_orca_uvvis_progress(conn, work_dir)
    elif node_type == "orca_neb_ts":
        return await parse_orca_neb_progress(conn, work_dir)

    # Default to geometry optimization parser for opt/sp/freq
    safe_dir = shlex.quote(work_dir)
    orca_out = f"{safe_dir}/ORCA.out"

    # Check if ORCA.out exists
    result = await conn.run(
        f"test -f {orca_out} && echo OK", check=False
    )
    if result.exit_status != 0 or "OK" not in (result.stdout or ""):
        return ConvergenceData(
            success=False, message="ORCA.out not found"
        )

    # Read last 2000 lines to avoid timeout on large files
    tail_result = await conn.run(
        f"tail -2000 {orca_out} 2>/dev/null", check=False
    )
    if tail_result.exit_status != 0 or not (tail_result.stdout or "").strip():
        return ConvergenceData(
            success=False, message="Cannot read ORCA.out"
        )

    content = tail_result.stdout or ""

    # Check convergence status in the tail content
    converged = "GEOMETRY OPTIMIZATION CONVERGED" in content

    # Get max iterations from header (search in first 100 lines of full file if needed)
    max_iter = 1  # default
    if "Max. no of cycles" not in content:
        # Max iterations not in tail, get from beginning of file
        header_result = await conn.run(
            f"head -200 {orca_out} 2>/dev/null | grep -m1 'Max. no of cycles'",
            check=False,
        )
        if header_result.exit_status == 0 and (header_result.stdout or "").strip():
            match = re.search(r"MaxIter\s+\.\.\.\.\s+(\d+)", header_result.stdout or "")
            if match:
                max_iter = int(match.group(1))
    else:
        # Found in tail, parse it
        match = re.search(r"Max. no of cycles.*?MaxIter\s+\.\.\.\.\s+(\d+)", content)
        if match:
            max_iter = int(match.group(1))

    # Parse cycles and energies from tail content
    lines = content.split("\n")
    current_cycle = 0
    points: list[ConvergencePoint] = []

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
            if not points or points[-1].step != current_cycle:
                dE = energy - points[-1].energy if points else 0.0
                points.append(ConvergencePoint(step=current_cycle, energy=energy, dE=dE))

        # Extract gradients for the current cycle
        # Handles both formats: "MAX gradient ... 0.123" and "MAX gradient        0.123"
        max_match = re.search(r"MAX gradient\s+(?:\.\.\.)?\s+([-\d.]+)", line)
        rms_match = re.search(r"RMS gradient\s+(?:\.\.\.)?\s+([-\d.]+)", line)
        if max_match and points:
            points[-1].max_force = float(max_match.group(1))
        if rms_match and points:
            points[-1].rms_force = float(rms_match.group(1))

        # Extract displacements for the current cycle
        max_step_match = re.search(r"MAX\s+step\s+(?:\.\.\.)?\s+([-\d.]+)", line, re.IGNORECASE)
        rms_step_match = re.search(r"RMS\s+step\s+(?:\.\.\.)?\s+([-\d.]+)", line, re.IGNORECASE)
        if max_step_match and points:
            points[-1].max_step = float(max_step_match.group(1))
        if rms_step_match and points:
            points[-1].rms_step = float(rms_step_match.group(1))

    # If no optimization cycles found, try single point energy
    if not points:
        energy_match = re.search(
            r"Total Energy\s+:\s+([-\d.]+)\s+Eh",
            content
        )
        if energy_match:
            return ConvergenceData(
                success=True,
                points=[ConvergencePoint(step=1, energy=float(energy_match.group(1)))],
                converged=True,
                message="Single point calculation"
            )
        return ConvergenceData(
            success=False, message="No energy data found"
        )

    not_converged_explicit = "THE OPTIMIZATION DID NOT CONVERGE" in content
    return ConvergenceData(
        success=True,
        points=points,
        converged=converged,
        message=(
            f"Optimization did not converge after {len(points)} cycles"
            if not_converged_explicit and not converged
            else f"{len(points)} optimization cycles parsed (max {max_iter})"
        )
    )


# ---------------------------------------------------------------------------
# ASE optimizer / NEB log parser (for MLP nodes running locally)
# ---------------------------------------------------------------------------
#
# ASE writes one line per iteration to `opt.log` (relax) or `neb.log` (NEB)
# in the format below. Both FIRE and BFGS use the same four-column layout.
#
#       Step     Time          Energy          fmax
# FIRE:    0 13:58:02     -204.230117        4.12345
# FIRE:    1 13:58:03     -204.234567        3.98760
# ...
#
# Unlike the VASP/ORCA parsers above, this one runs on a LOCAL filesystem
# path (MLP execution writes into a temp dir on the machine hosting the
# backend). HPC-remote tailing can be added later by switching to an
# `hpc.conn.run("tail ...")` pattern — see parse_vasp_convergence.

# Match decimals AND scientific notation. ASE emits fmax in scientific form
# (`1.23e-03`) once a run is near convergence; the plain `\d+\.\d+` pattern
# silently dropped those lines, causing the `converged` check to read stale
# data and flag a cleanly-converged run as not-converged.
_NUM = r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?"
_ASE_LOG_LINE = re.compile(
    r"^(?P<optimizer>[A-Za-z]+):\s+"
    r"(?P<step>\d+)\s+"
    r"\d+:\d+:\d+\s+"
    rf"(?P<energy>{_NUM})\s+"
    rf"(?P<fmax>{_NUM})"
)


def parse_ase_opt_log(log_path: str, fmax_target: float = 0.05) -> ConvergenceData:
    """Parse an ASE optimizer / NEB log file from a local filesystem path.

    Returns a `ConvergenceData` with one `ConvergencePoint` per iteration.
    `max_force` holds the fmax value from the last column; `rms_force`
    stays at its 0.0 default since ASE's opt.log doesn't report it.

    `converged` is True iff the last parsed line's fmax is at or below
    `fmax_target`. Callers should pass the step's actual fmax param from
    its config rather than relying on the default 0.05.
    """
    import os

    if not log_path or not os.path.isfile(log_path):
        return ConvergenceData(
            success=False,
            message=f"Log file not found: {log_path}",
        )

    points: list[ConvergencePoint] = []
    try:
        with open(log_path, "r", errors="replace") as fh:
            for raw_line in fh:
                m = _ASE_LOG_LINE.match(raw_line)
                if not m:
                    continue
                try:
                    points.append(ConvergencePoint(
                        step=int(m.group("step")),
                        energy=float(m.group("energy")),
                        energy_sigma0=float(m.group("energy")),
                        max_force=float(m.group("fmax")),
                    ))
                except (ValueError, TypeError):
                    continue
    except OSError as exc:
        return ConvergenceData(
            success=False,
            message=f"Could not read log: {exc}",
        )

    if not points:
        return ConvergenceData(
            success=True,
            points=[],
            converged=False,
            message="No iterations logged yet",
        )

    converged = points[-1].max_force <= fmax_target
    return ConvergenceData(
        success=True,
        points=points,
        converged=converged,
        message=(
            f"step {points[-1].step} · fmax={points[-1].max_force:.3f} eV/Å"
            f"{' (converged)' if converged else ''}"
        ),
    )
