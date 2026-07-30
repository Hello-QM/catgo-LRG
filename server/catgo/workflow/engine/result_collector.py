"""Result extraction from completed HPC jobs.

Reads output structures, energies, frequencies, and engine-specific results
from HPC work directories after job completion.
"""

import hashlib
import hmac
import json
import logging
import math
import re
import shlex
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _extract_xyz_from_orca_output(output_text: str, node_type: str) -> str | None:
    """Extract the last optimized XYZ geometry from ORCA.out.

    ORCA writes coordinates in blocks starting with:
        CARTESIAN COORDINATES (ANGSTROEM)
        ---------------------------------
        C      0.000000    0.000000    0.000000
        ...

    For opt/neb_ts: extracts the LAST such block (final optimized geometry).
    For sp/freq/irc/uvvis: extracts the first (input geometry echoed back).
    Returns an XYZ-format string, or None if not found.
    """
    marker = "CARTESIAN COORDINATES (ANGSTROEM)"
    positions = []
    start = 0
    while True:
        idx = output_text.find(marker, start)
        if idx == -1:
            break
        positions.append(idx)
        start = idx + len(marker)

    if not positions:
        return None

    # For optimization types, take the last block; otherwise first
    if node_type in ("orca_opt", "orca_neb_ts"):
        block_start = positions[-1]
    else:
        block_start = positions[-1]  # last is safest for all types

    # Skip marker line and the dashes line
    lines = output_text[block_start:].split("\n")
    atoms = []
    for line in lines[2:]:  # skip marker + dashes
        stripped = line.strip()
        if not stripped:
            break
        parts = stripped.split()
        if len(parts) >= 4:
            try:
                float(parts[1])
                float(parts[2])
                float(parts[3])
                atoms.append(f"{parts[0]:>2s}  {parts[1]:>14s}  {parts[2]:>14s}  {parts[3]:>14s}")
            except ValueError:
                break
        else:
            break

    if not atoms:
        return None

    n = len(atoms)
    xyz_lines = [str(n), f"ORCA {node_type} output geometry"]
    xyz_lines.extend(atoms)
    return "\n".join(xyz_lines) + "\n"


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
            result = await hpc.run_on_owner(lambda: hpc.conn.run(f"cat {work_dir}/CONTCAR", check=False))
            if result.exit_status == 0 and result.stdout and len(result.stdout.strip()) > 10:
                return result.stdout
        except Exception:
            logger.debug("Failed to read CONTCAR from %s", work_dir, exc_info=True)

    # CP2K: read output structure
    if engine_key == "cp2k":
        try:
            result = await hpc.run_on_owner(lambda: hpc.conn.run(
                f"ls -t {work_dir}/*-pos-*.xyz 2>/dev/null | head -1",
                check=False,
            ))
            if result.exit_status == 0 and result.stdout.strip():
                xyz_file = result.stdout.strip()
                result2 = await hpc.run_on_owner(lambda: hpc.conn.run(f"cat {xyz_file}", check=False))
                if result2.exit_status == 0:
                    return result2.stdout
        except Exception:
            logger.debug("Failed to read CP2K output structure from %s", work_dir, exc_info=True)

    # Sella: read structure.xyz (preferred) or CONTCAR
    if engine_key == "sella":
        for fname in ("structure.xyz", "CONTCAR"):
            try:
                result = await hpc.run_on_owner(lambda fname=fname: hpc.conn.run(f"cat {work_dir}/{fname}", check=False))
                if result.exit_status == 0 and result.stdout and len(result.stdout.strip()) > 5:
                    logger.info("Read Sella output structure from %s/%s", work_dir, fname)
                    return result.stdout
            except Exception:
                continue
        logger.debug("No Sella output structure found in %s", work_dir)

    # ORCA standalone nodes
    if engine_key == "orca":
        # NEB-TS: read the dedicated converged TS XYZ file (small, authoritative)
        # rather than parsing the last coordinate block from the ~5MB ORCA.out
        if node_type in ("orca_neb_ts", "ts_search"):
            for suffix in ("_NEB-TS_converged.xyz", "_NEB-CI_converged.xyz"):
                try:
                    ts_file = f"{work_dir}/ORCA{suffix}"
                    result = await hpc.run_on_owner(lambda ts_file=ts_file: hpc.conn.run(f"cat {ts_file}", check=False))
                    if result.exit_status == 0 and result.stdout and len(result.stdout.strip()) > 5:
                        logger.info("Read NEB-TS converged structure from %s", ts_file)
                        return result.stdout
                except Exception:
                    continue

        # Fallback: extract optimized geometry from ORCA.out
        # (handles orca_opt, orca_sp, orca_freq, etc. and NEB-TS when converged files missing)
        try:
            result = await hpc.run_on_owner(lambda: hpc.conn.run(f"cat {work_dir}/ORCA.out", check=False))
            if result.exit_status == 0 and result.stdout:
                xyz_str = _extract_xyz_from_orca_output(result.stdout, node_type)
                if xyz_str:
                    return xyz_str
        except Exception:
            logger.debug("Failed to extract ORCA output structure from %s", work_dir, exc_info=True)

    # MLP (MACE/CHGNet/M3GNet): read CONTCAR
    if engine_key == "mlp":
        try:
            result = await hpc.run_on_owner(lambda: hpc.conn.run(f"cat {work_dir}/CONTCAR", check=False))
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
        result = await hpc.run_on_owner(lambda: hpc.conn.run(f"wc -l {work_dir}/ts.log 2>/dev/null", check=False))
        if result.exit_status == 0 and result.stdout.strip():
            n_lines = int(result.stdout.strip().split()[0])
            results["n_steps"] = max(0, n_lines - 1)  # subtract header line
    except Exception:
        pass

    # Try reading stdout for energy and convergence (from SLURM output or direct run)
    try:
        # Check for SLURM output first, then stdout capture
        result = await hpc.run_on_owner(lambda: hpc.conn.run(
            f"grep -h 'Final energy\\|Max force\\|Converged' {work_dir}/*.out {work_dir}/*.log 2>/dev/null | tail -5",
            check=False,
        ))
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


_VASP_META_MARKERS = {
    "__CATGO_INCAR__": "incar",
    "__CATGO_POSCAR__": "poscar",
    "__CATGO_KPOINTS__": "kpoints",
    "__CATGO_INPUT_MANIFEST__": "input_manifest",
    "__CATGO_INPUT_HASHES__": "input_hashes",
    "__CATGO_OUTCAR_META__": "outcar",
    "__CATGO_FORCES__": "forces",
    "__CATGO_FMAX__": "fmax",
}
_VASP_NUMBER = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?"


def _positive_incar_float(text: str, tag: str) -> float | None:
    """Return the final active, finite, positive scalar assignment."""
    matches: list[str] = []
    pattern = re.compile(
        rf"(?:^|[;\s]){re.escape(tag)}\s*=\s*([^;\s]+)",
        re.I,
    )
    for raw in (text or "").splitlines():
        line = raw.split("#", 1)[0].split("!", 1)[0]
        matches.extend(match.group(1) for match in pattern.finditer(line))
    if not matches:
        return None
    try:
        value = float(matches[-1].replace("D", "E").replace("d", "e"))
    except ValueError:
        return None
    return value if math.isfinite(value) and value > 0 else None


def _quote_remote_dir(work_dir: str) -> str:
    """Quote a remote path WITHOUT killing a leading `~`.

    `shlex.quote("~/calculations")` yields `'~/calculations'`, and a quoted tilde
    is a literal directory name — the default work root then resolves to nothing
    and no TOTEN/manifest metadata comes back. Quote only the part after the
    tilde so expansion still happens on the remote shell.
    """
    if work_dir == "~" or work_dir.startswith("~/"):
        rest = work_dir[2:]
        return "~/" + shlex.quote(rest) if rest else "~"
    return shlex.quote(work_dir)


def _vasp_metadata_command(work_dir: str) -> str:
    """Read realized VASP metadata in two OUTCAR passes and one SSH call."""
    safe_dir = _quote_remote_dir(work_dir)
    fields = (
        "free  energy|NIONS|ions per type|NELECT|EDIFFG|IBRION|NSW|POTCAR:|TITEL|"
        "LEXCH|GGA|LHFCALC|AEXX|HFSCREEN|LSOL|EB_K|TAU|LAMBDA_D_K|NC_K|"
        "generate[[:space:]]+k-points[[:space:]]+for:"
    )
    # OUTCAR is commonly appended across restarts. Keep only the final VASP
    # invocation's compact metadata so an old run cannot supply current provenance.
    metadata = (
        "awk '"
        "BEGIN{buf=\"\"} "
        "/^[[:space:]]*vasp\\.[0-9]/{buf=\"\"} "
        f"$0 ~ /{fields}/{{buf=buf $0 ORS}} "
        "END{printf \"%s\",buf}' "
        f"{safe_dir}/OUTCAR 2>/dev/null"
    )
    # Emit forces only for the latest complete TOTAL-FORCE block, with exactly
    # NIONS rows, and only when the final invocation has one force block per TOTEN.
    # A partial appended ionic step must not pair a stale force with a newer energy.
    forces = (
        "awk '"
        "/^[[:space:]]*vasp\\.[0-9]/{inside=0;nions=0;ntoten=0;nforce=0;"
        "latest_complete=0;next} "
        "/NIONS[[:space:]]*=/{for(i=1;i<=NF;i++)if($i==\"NIONS\"){j=i+1;"
        "if($(j)==\"=\")j++;nions=$(j)+0}} "
        "/free[[:space:]]+energy[[:space:]]+TOTEN/{ntoten++} "
        "/TOTAL-FORCE/{inside=1;dash=0;max=0;n=0;nforce++;block_valid=1;"
        "latest_complete=0;next} "
        "inside && /^ *-+/{dash++;if(dash==2){latest_complete="
        "(block_valid && nions>0 && n==nions);"
        "if(latest_complete){last_n=n;for(k=1;k<=n;k++){"
        "last_x[k]=cur_x[k];last_y[k]=cur_y[k];last_z[k]=cur_z[k]}};"
        "inside=0};next} "
        "inside && dash==1 && NF>=6{num=\"^[-+]?([0-9]+(\\\\.[0-9]*)?|"
        "\\\\.[0-9]+)([EeDd][-+]?[0-9]+)?$\";"
        "if($4!~num || $5!~num || $6!~num){block_valid=0}else{"
        "n++;x=$4;y=$5;z=$6;gsub(/[Dd]/,\"E\",x);gsub(/[Dd]/,\"E\",y);"
        "gsub(/[Dd]/,\"E\",z);cur_x[n]=x;cur_y[n]=y;cur_z[n]=z}} "
        "END{if(latest_complete && ntoten==nforce){printf \"N %d\\n\",last_n;"
        "for(k=1;k<=last_n;k++)printf \"%s %s %s\\n\","
        "last_x[k],last_y[k],last_z[k]}}' "
        f"{safe_dir}/OUTCAR 2>/dev/null"
    )
    live_hashes = (
        "for catgo_file in INCAR POSCAR POTCAR KPOINTS; do "
        f"catgo_path={safe_dir}/\"$catgo_file\"; catgo_hash=''; "
        "if [ -f \"$catgo_path\" ]; then "
        "if command -v sha256sum >/dev/null 2>&1; then "
        "catgo_hash=$(sha256sum \"$catgo_path\" | awk '{print $1}'); "
        "elif command -v shasum >/dev/null 2>&1; then "
        "catgo_hash=$(shasum -a 256 \"$catgo_path\" | awk '{print $1}'); "
        "elif command -v openssl >/dev/null 2>&1; then "
        "catgo_hash=$(openssl dgst -sha256 \"$catgo_path\" | sed 's/^.*= //'); "
        "fi; "
        "printf '%s %s\\n' \"$catgo_file\" \"${catgo_hash:-UNAVAILABLE}\"; "
        "else "
        "printf '%s %s\\n' \"$catgo_file\" 'ABSENT'; "
        "fi; "
        "done"
    )
    return (
        "printf '%s\\n' '__CATGO_INCAR__'; "
        f"cat {safe_dir}/INCAR 2>/dev/null; "
        "printf '\\n%s\\n' '__CATGO_POSCAR__'; "
        f"cat {safe_dir}/POSCAR 2>/dev/null; "
        "printf '\\n%s\\n' '__CATGO_KPOINTS__'; "
        f"cat {safe_dir}/KPOINTS 2>/dev/null; "
        "printf '\\n%s\\n' '__CATGO_INPUT_MANIFEST__'; "
        f"cat {safe_dir}/catgo_vasp_input_manifest.json 2>/dev/null; "
        "printf '\\n%s\\n' '__CATGO_INPUT_HASHES__'; "
        f"{live_hashes}; "
        "printf '\\n%s\\n' '__CATGO_OUTCAR_META__'; "
        f"{metadata}; "
        "printf '\\n%s\\n' '__CATGO_FORCES__'; "
        f"{forces}; "
        "printf '\\n%s\\n' '__CATGO_FMAX__'; "
        "true"
    )


def _vasp_selective_mask(poscar: str, n_atoms: int):
    """Return whole-atom mobility, or None for unsafe mixed-coordinate masks.

    VASP interprets T/F flags along direct lattice vectors even when positions
    are written in Cartesian mode.  OUTCAR forces are Cartesian, so component-
    wise zipping is wrong for a rotated/non-orthogonal cell.  Whole-atom TTT/FFF
    masks are basis independent; mixed masks fail closed until we carry a
    lattice-aware force projection.
    """
    lines = [line.strip() for line in (poscar or "").splitlines() if line.strip()]
    try:
        if len(lines) < 8 or n_atoms <= 0:
            return None
        first = lines[5].split()
        if first and all(token.isdigit() for token in first):
            counts_index = 5
        else:
            counts_index = 6
        counts = [int(token) for token in lines[counts_index].split()]
        if not counts or sum(counts) != n_atoms:
            return None
        mode_index = counts_index + 1
        selective = lines[mode_index].lower().startswith("s")
        if selective:
            mode_index += 1
        if not lines[mode_index].lower().startswith(("d", "c", "k")):
            return None
        if not selective:
            return [(True, True, True)] * n_atoms
        mask = []
        for line in lines[mode_index + 1:mode_index + 1 + n_atoms]:
            tokens = line.split()
            if len(tokens) < 6:
                return None
            flags = tuple(token.upper() == "T" for token in tokens[3:6])
            if any(token.upper() not in {"T", "F"} for token in tokens[3:6]):
                return None
            if any(flags) and not all(flags):
                return None
            mask.append(flags)
        return mask if len(mask) == n_atoms else None
    except (IndexError, ValueError):
        return None


def _parse_vasp_metadata(raw: str) -> dict:
    """Parse only fields explicitly present in realized VASP files."""
    sections = {name: [] for name in _VASP_META_MARKERS.values()}
    current = None
    for line in (raw or "").splitlines():
        marker = _VASP_META_MARKERS.get(line.strip())
        if marker:
            current = marker
        elif current:
            sections[current].append(line)

    incar = "\n".join(sections["incar"])
    poscar = "\n".join(sections["poscar"])
    kpoints = "\n".join(sections["kpoints"])
    manifest_text = "\n".join(sections["input_manifest"]).strip()
    outcar = "\n".join(sections["outcar"])
    result: dict = {}
    field_sources: dict[str, str] = {}
    kspacing = _positive_incar_float(incar, "KSPACING")

    manifest_errors = []
    manifest = None
    try:
        manifest = json.loads(manifest_text) if manifest_text else None
    except (ValueError, TypeError):
        manifest_errors.append("manifest_json_invalid")
    if not isinstance(manifest, dict):
        if not manifest_errors:
            manifest_errors.append("manifest_missing")
    else:
        if manifest.get("schema_version") != 1:
            manifest_errors.append("schema_version")
        if manifest.get("engine") != "vasp":
            manifest_errors.append("engine")
        if manifest.get("ready") is not True:
            manifest_errors.append("ready")
        if manifest.get("binary_declared") is not True:
            manifest_errors.append("binary_declared")
        if manifest.get("hash_algorithm") != "sha256":
            manifest_errors.append("hash_algorithm")
        if manifest.get("hash_available") is not True:
            manifest_errors.append("hash_available")
        if type(manifest.get("use_custodian")) is not bool:
            manifest_errors.append("use_custodian")
        if manifest.get("missing_mandatory_inputs") != []:
            manifest_errors.append("missing_mandatory_inputs")
        command = manifest.get("resolved_run_command")
        binary = manifest.get("binary_token")
        if not isinstance(command, str) or not command.strip():
            manifest_errors.append("resolved_run_command")
        if not isinstance(binary, str) or not binary.strip():
            manifest_errors.append("binary_token")
        if manifest.get("binary") != binary:
            manifest_errors.append("binary_alias")
        if (
            isinstance(command, str)
            and command.strip()
            and isinstance(binary, str)
            and binary.strip()
        ):
            from .vasp_submission import _extract_vasp_binary_token

            if _extract_vasp_binary_token(command) != binary:
                manifest_errors.append("binary_command_mismatch")
        if not isinstance(manifest.get("command_source"), str) or not manifest[
            "command_source"
        ].strip():
            manifest_errors.append("command_source")

        live_hashes = {}
        for line in sections["input_hashes"]:
            parts = line.split()
            if len(parts) == 2 and parts[0] in {
                "INCAR", "POSCAR", "POTCAR", "KPOINTS"
            }:
                live_hashes[parts[0]] = (
                    None if parts[1] == "ABSENT" else parts[1]
                )
        manifest_inputs = manifest.get("inputs")
        if not isinstance(manifest_inputs, dict):
            manifest_errors.append("inputs")
        else:
            # The remote manifest is evidence, not an independent trust anchor.
            # Record a custodian-mode divergence for diagnosis, but fail closed:
            # a future submission ledger must bind the mode and correction before
            # rewritten inputs can be certified. POTCAR is never rewritable.
            under_custodian = manifest.get("use_custodian") is True
            rewritable = {"INCAR", "KPOINTS", "POSCAR"} if under_custodian else set()
            rewritten: dict[str, dict[str, str | None]] = {}
            for name in ("INCAR", "POSCAR", "POTCAR", "KPOINTS"):
                entry = manifest_inputs.get(name)
                if not isinstance(entry, dict):
                    manifest_errors.append(f"inputs.{name}")
                    continue
                recorded_hash = entry.get("sha256")
                live_hash = live_hashes.get(name)
                declared_mandatory = entry.get("mandatory")
                exists = entry.get("exists")
                if type(declared_mandatory) is not bool:
                    manifest_errors.append(f"inputs.{name}.mandatory")
                    declared_mandatory = True
                if type(exists) is not bool:
                    manifest_errors.append(f"inputs.{name}.exists")
                    exists = False
                if name != "KPOINTS" and declared_mandatory is not True:
                    manifest_errors.append(f"inputs.{name}.mandatory")
                if (
                    name == "KPOINTS"
                    and declared_mandatory is False
                    and kspacing is None
                ):
                    manifest_errors.append(
                        "inputs.KPOINTS.optional_without_kspacing"
                    )
                if declared_mandatory and exists is not True:
                    manifest_errors.append(f"inputs.{name}.exists")
                if name not in live_hashes:
                    manifest_errors.append(f"inputs.{name}.live_status")
                if exists is False:
                    if recorded_hash is not None:
                        manifest_errors.append(f"inputs.{name}.sha256")
                    if live_hash is None:
                        continue
                    if not isinstance(live_hash, str) or not re.fullmatch(
                        r"[0-9a-f]{64}", live_hash
                    ):
                        manifest_errors.append(f"inputs.{name}.live_hash")
                    elif name in rewritable:
                        rewritten[name] = {"submitted": None, "ran": live_hash}
                        manifest_errors.append(
                            f"inputs.{name}.unanchored_rewrite"
                        )
                    else:
                        manifest_errors.append(
                            f"inputs.{name}.unexpected_live_file"
                        )
                    continue
                if not isinstance(recorded_hash, str) or not re.fullmatch(
                    r"[0-9a-f]{64}", recorded_hash
                ):
                    manifest_errors.append(f"inputs.{name}.sha256")
                elif (
                    not isinstance(live_hash, str)
                    or not re.fullmatch(r"[0-9a-f]{64}", live_hash)
                ):
                    manifest_errors.append(f"inputs.{name}.live_hash")
                elif not hmac.compare_digest(recorded_hash, live_hash):
                    if name in rewritable:
                        rewritten[name] = {"submitted": recorded_hash, "ran": live_hash}
                        manifest_errors.append(
                            f"inputs.{name}.unanchored_rewrite"
                        )
                    else:
                        manifest_errors.append(f"inputs.{name}.live_hash")
            if rewritten:
                result["custodian_rewritten_inputs"] = rewritten

        if not manifest_errors:
            canonical = json.dumps(
                manifest,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode("utf-8")
            result["submission_manifest_digest"] = (
                f"sha256:{hashlib.sha256(canonical).hexdigest()}"
            )
            result["input_hashes"] = {
                name: manifest["inputs"][name]["sha256"]
                for name in ("INCAR", "POSCAR", "POTCAR", "KPOINTS")
            }
            result["vasp_binary"] = manifest["binary_token"]
            result["resolved_run_command"] = manifest["resolved_run_command"]
            result["command_source"] = manifest["command_source"]
            result["input_manifest_schema_version"] = manifest["schema_version"]
            result["input_manifest_validated"] = True
            field_sources.update({
                "submission_manifest_digest": (
                    "catgo_vasp_input_manifest.json:canonical_sha256"
                ),
                "input_hashes": (
                    "catgo_vasp_input_manifest.json+live_files:"
                    "sha256_match_or_declared_absent"
                ),
                "vasp_binary": "catgo_vasp_input_manifest.json:binary_token",
                "resolved_run_command": (
                    "catgo_vasp_input_manifest.json:resolved_run_command"
                ),
            })
    if manifest_errors:
        result["input_manifest_validated"] = False
        result["input_manifest_errors"] = sorted(set(manifest_errors))

    def floats(pattern: str) -> list[float]:
        matches = re.findall(pattern + rf"\s*({_VASP_NUMBER})", outcar, re.I)
        return [
            float(value.replace("D", "E").replace("d", "e"))
            for value in matches
        ]

    def last_float(pattern: str):
        values = floats(pattern)
        return values[-1] if values else None

    energy = last_float(r"free\s+energy\s+TOTEN\s*=")
    if energy is not None:
        result["energy"] = energy
        result["energy_source"] = "OUTCAR:TOTEN"
        field_sources["energy"] = "OUTCAR:last_TOTEN"

    nions = re.findall(r"\bNIONS\s*=\s*(\d+)", outcar)
    if nions:
        result["n_atoms"] = int(nions[-1])
        field_sources["n_atoms"] = "OUTCAR:NIONS"
    else:
        ion_rows = re.findall(r"ions per type\s*=\s*([0-9 ]+)", outcar, re.I)
        if ion_rows:
            result["n_atoms"] = sum(int(x) for x in ion_rows[-1].split())
            field_sources["n_atoms"] = "OUTCAR:ions_per_type"

    ediffg = last_float(r"\bEDIFFG\s*=")
    if ediffg is not None:
        result["ediffg"] = ediffg
        field_sources["ediffg"] = "OUTCAR:EDIFFG"
    for tag in ("IBRION", "NSW"):
        values = re.findall(rf"\b{tag}\s*=\s*(-?\d+)", outcar, re.I)
        if values:
            key = tag.lower()
            result[key] = int(values[-1])
            field_sources[key] = f"OUTCAR:{tag}"
    nelect_values = floats(r"\bNELECT\s*=")
    if nelect_values:
        result["nelect"] = nelect_values[-1]
        field_sources["nelect"] = "OUTCAR:last_NELECT"
        if nelect_values[0] != nelect_values[-1]:
            result["nelect_initial"] = nelect_values[0]
            result["nelect_final"] = nelect_values[-1]
            field_sources["nelect_initial"] = "OUTCAR:first_NELECT"
            field_sources["nelect_final"] = "OUTCAR:last_NELECT"

    titles = []
    for line in outcar.splitlines():
        match = re.search(r"\bPOTCAR:\s*(.+?)\s*$", line)
        if not match:
            match = re.search(r"\bTITEL\s*=\s*(.+?)\s*$", line)
        if match and match.group(1) not in titles:
            titles.append(match.group(1))
    if titles:
        result["potcar_titels"] = titles
        field_sources["potcar_titels"] = "OUTCAR:POTCAR_or_TITEL"

    xc = {}
    for tag in ("GGA", "METAGGA", "LEXCH", "LHFCALC", "AEXX", "HFSCREEN"):
        values = re.findall(
            rf"(?<![A-Za-z0-9_]){tag}\s*=\s*([^\s;]+)", outcar, re.I
        )
        if values:
            xc[tag] = values[-1]
    if xc:
        result["xc_tags"] = xc
        field_sources["xc_tags"] = "OUTCAR:raw_tags"
        # Exact realized fingerprint, not a guessed marketing name ("PBE",
        # "HSE06", etc.). This lets provenance compare XC identity without
        # normalizing an incomplete set of raw VASP tags.
        result["xc_functional"] = ";".join(
            f"{tag}={value}" for tag, value in xc.items()
        )
        field_sources["xc_functional"] = "OUTCAR:raw_xc_fingerprint"

    solvation = {}
    for tag in ("LSOL", "EB_K", "TAU", "LAMBDA_D_K", "NC_K"):
        values = re.findall(
            rf"(?<![A-Za-z0-9_]){tag}\s*=\s*([^\s;]+)", outcar, re.I
        )
        if values:
            solvation[tag] = values[-1]
    if solvation:
        result["solvation"] = solvation
        field_sources["solvation"] = "OUTCAR:raw_tags"

    # An explicit KPOINTS file takes precedence over KSPACING in INCAR.
    lines = [line.strip() for line in kpoints.splitlines() if line.strip()]
    if lines:
        result["kpoint_source"] = "KPOINTS"
        field_sources["kpoint_source"] = "KPOINTS:present"
    if len(lines) >= 4:
        try:
            automatic = int(lines[1].split()[0]) == 0
            mesh = [int(x) for x in lines[3].split()[:3]]
        except (ValueError, IndexError):
            automatic, mesh = False, []
        if automatic and len(mesh) == 3 and all(x > 0 for x in mesh):
            result["kgrid"] = mesh
            field_sources["kgrid"] = "KPOINTS:automatic_mesh"
    elif not lines and kspacing is not None:
        result["kpoint_source"] = "INCAR:KSPACING"
        result["kspacing"] = kspacing
        field_sources["kpoint_source"] = "INCAR:KSPACING"
        field_sources["kspacing"] = "INCAR:KSPACING"
        generated = re.findall(
            r"(?im)^\s*generate\s+k-points\s+for\s*:\s*"
            r"(\d+)\s+(\d+)\s+(\d+)\s*$",
            outcar,
        )
        if generated:
            mesh = [int(value) for value in generated[-1]]
            if all(value > 0 for value in mesh):
                result["kgrid"] = mesh
                field_sources["kgrid"] = "OUTCAR:last_generate_k-points_for"

    force_lines = [line.strip() for line in sections["forces"] if line.strip()]
    if force_lines and re.fullmatch(r"N\s+\d+", force_lines[0]):
        declared_count = int(force_lines[0].split()[1])
        vectors = []
        for line in force_lines[1:]:
            tokens = line.split()
            if len(tokens) != 3 or not all(
                re.fullmatch(_VASP_NUMBER, token) for token in tokens
            ):
                vectors = []
                break
            vectors.append(tuple(
                float(token.replace("D", "E").replace("d", "e"))
                for token in tokens
            ))
        mask = _vasp_selective_mask(poscar, declared_count)
        if (
            result.get("n_atoms") == declared_count
            and len(vectors) == declared_count
            and mask is not None
        ):
            free_norms = [
                sum(
                    component * component
                    for component, is_free in zip(vector, flags)
                    if is_free
                ) ** 0.5
                for vector, flags in zip(vectors, mask)
                if any(flags)
            ]
            if free_norms:
                result["fmax"] = max(free_norms)
                field_sources["fmax"] = (
                    "OUTCAR:last_complete_ionic_step"
                    "+POSCAR:selective_dynamics"
                )
    else:
        # Backward-compatible parser path for stored compact fixtures produced
        # before @3. New remote collection always emits full force vectors.
        fmax_lines = [line.strip() for line in sections["fmax"] if line.strip()]
        fmax_parts = fmax_lines[-1].split() if fmax_lines else []
        if (
            len(fmax_parts) == 2
            and re.fullmatch(_VASP_NUMBER, fmax_parts[0])
            and fmax_parts[1].isdigit()
            and result.get("n_atoms") == int(fmax_parts[1])
        ):
            result["fmax"] = float(
                fmax_parts[0].replace("D", "E").replace("d", "e")
            )
            field_sources["fmax"] = "OUTCAR:last_complete_ionic_step:legacy"

    units = {}
    if "energy" in result:
        units["energy"] = "eV"
    if "fmax" in result:
        units["fmax"] = "eV/Angstrom"
    if "ediffg" in result:
        units["ediffg"] = "eV/Angstrom" if result["ediffg"] < 0 else "eV"
    if units:
        result["units"] = units
    if field_sources:
        result["field_sources"] = field_sources
        result["metadata_parser"] = (
            "catgo.workflow.engine.result_collector._parse_vasp_metadata@5"
        )
    return result


async def _try_read_vasp_metadata(hpc: Any, work_dir: str) -> dict:
    response = await hpc.run_on_owner(
        lambda: hpc.conn.run(_vasp_metadata_command(work_dir), check=False)
    )
    return _parse_vasp_metadata(response.stdout or "")


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
            grep_result = await hpc.run_on_owner(lambda: hpc.conn.run(
                f"cat {work_dir}/*.out 2>/dev/null || cat {work_dir}/slurm-*.out 2>/dev/null",
                check=False,
            ))
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
    if engine_key == "vasp":
        try:
            metadata = await _try_read_vasp_metadata(hpc, work_dir)
            result.update(metadata)
            if metadata:
                logger.info(
                    "VASP realized metadata for %s: %s",
                    node_id, sorted(metadata),
                )
        except Exception as exc:
            logger.warning("Failed to extract VASP metadata for %s: %s", node_id, exc)

    # Backward-compatible energy fallback if the metadata pass found no TOTEN.
    if engine_key == "vasp" and "energy" not in result:
        try:
            safe_dir = _quote_remote_dir(work_dir)
            grep_result = await hpc.run_on_owner(lambda: hpc.conn.run(
                f"grep 'free  energy   TOTEN' {safe_dir}/OUTCAR | tail -1",
                check=False,
            ))
            if grep_result.exit_status == 0 and grep_result.stdout.strip():
                # Format: "  free  energy   TOTEN  =      -123.45678901 eV"
                energy_str = grep_result.stdout.strip().split("=")[-1].strip().split()[0]
                energy = float(energy_str)
                result["energy"] = energy
                logger.info("VASP energy for %s: %.6f eV", node_id, energy)
        except Exception as exc:
            logger.warning("Failed to extract VASP energy for %s: %s", node_id, exc)

    # Extract CP2K final energy for downstream nodes
    if engine_key == "cp2k" and "energy" not in result:
        try:
            grep_result = await hpc.run_on_owner(lambda: hpc.conn.run(
                f"grep 'ENERGY| Total' {work_dir}/cp2k.out | tail -1",
                check=False,
            ))
            if grep_result.exit_status == 0 and grep_result.stdout.strip():
                # Format: " ENERGY| Total FORCE_EVAL ( QS ) energy [a.u.]:          -123.456789"
                energy_ha = float(grep_result.stdout.strip().split()[-1])
                energy_ev = energy_ha * 27.211386245988  # Hartree to eV
                result["energy"] = energy_ev
                logger.info("CP2K energy for %s: %.6f eV (%.6f Ha)", node_id, energy_ev, energy_ha)
        except Exception as exc:
            logger.warning("Failed to extract CP2K energy for %s: %s", node_id, exc)

    # Record ORCA .gbw wavefunction path for downstream nodes (restart speedup)
    if engine_key == "orca":
        gbw_path = f"{work_dir}/ORCA.gbw"
        try:
            check = await hpc.run_on_owner(lambda: hpc.conn.run(f"test -f {gbw_path} && echo exists", check=False))
            if check.exit_status == 0 and "exists" in (check.stdout or ""):
                result["wavefunction_file"] = gbw_path
                logger.info("ORCA .gbw found for %s: %s", node_id, gbw_path)
        except Exception:
            logger.debug("Failed to check for ORCA .gbw at %s", gbw_path, exc_info=True)

    # Extract ORCA final energy from ORCA.out for downstream nodes
    if engine_key == "orca" and "energy" not in result:
        try:
            grep_result = await hpc.run_on_owner(lambda: hpc.conn.run(
                f"grep 'FINAL SINGLE POINT ENERGY' {work_dir}/ORCA.out | tail -1",
                check=False,
            ))
            if grep_result.exit_status == 0 and grep_result.stdout.strip():
                # Format: "FINAL SINGLE POINT ENERGY      -123.456789012345"
                energy_ha = float(grep_result.stdout.strip().split()[-1])
                energy_ev = energy_ha * 27.211386245988  # Hartree to eV
                result["energy"] = energy_ev
                result["energy_eh"] = energy_ha
                logger.info("ORCA energy for %s: %.6f eV (%.10f Eh)", node_id, energy_ev, energy_ha)
        except Exception as exc:
            logger.warning("Failed to extract ORCA energy for %s: %s", node_id, exc)

    # Extract ORCA-specific results (frequencies, convergence, UV-Vis)
    # Check params for software type since unified types (freq, geo_opt) don't indicate engine
    is_orca_task = engine_key == "orca" or params.get("software") == "orca"
    if is_orca_task and node_type in ("freq", "orca_freq", "geo_opt", "orca_opt",
                                       "uvvis", "orca_uvvis", "irc", "orca_irc", "orca_neb_ts"):
        try:
            orca_output = await _read_orca_output(hpc, work_dir, node_id)
        except Exception as exc:
            logger.debug(f"Failed to read ORCA.out for {node_id}: {exc}")
            orca_output = None

        if orca_output:
            try:
                # Route to correct parser based on node type
                if node_type in ("freq", "orca_freq"):
                    from catgo.utils.orca_output import OrcaFreqOutput
                    parser = OrcaFreqOutput(orca_output)
                    orca_results = parser.get_summary()
                    result.update(orca_results)
                    logger.info("ORCA freq parsed: %d frequencies, %d imaginary",
                               len(orca_results.get("frequencies", [])),
                               orca_results.get("num_imaginary", 0))

                elif node_type in ("geo_opt", "orca_opt"):
                    from catgo.utils.orca_output import OrcaOptOutput
                    parser = OrcaOptOutput(orca_output)
                    orca_results = parser.get_summary()
                    result.update(orca_results)
                    conv_pts = orca_results.get("convergence_points", [])
                    logger.info("ORCA opt parsed: %d convergence points, converged=%s",
                               len(conv_pts), orca_results.get("converged", False))

                elif node_type in ("uvvis", "orca_uvvis"):
                    from catgo.utils.orca_output import OrcaUvVisOutput
                    parser = OrcaUvVisOutput(orca_output)
                    orca_results = parser.get_summary()
                    result.update(orca_results)
                    logger.info("ORCA UV-Vis parsed: %d excitations", len(orca_results.get("excitations", [])))

                elif node_type in ("irc", "orca_irc"):
                    from catgo.utils.orca_output import OrcaIrcOutput
                    parser = OrcaIrcOutput(orca_output)
                    orca_results = parser.get_summary()
                    result.update(orca_results)
                    conv_pts = orca_results.get("convergence_points", [])
                    logger.info("ORCA IRC parsed: %d path points", len(conv_pts))

                elif node_type == "orca_neb_ts":
                    from catgo.utils.orca_output import OrcaNebOutput
                    parser = OrcaNebOutput(orca_output)
                    orca_results = parser.get_summary()
                    result.update(orca_results)
                    logger.info("ORCA NEB-TS parsed")

                    # Read ORCA.interp for per-iteration image energies
                    try:
                        from catgo.utils.job_parser import _parse_interp_content
                        interp_result = await hpc.run_on_owner(lambda: hpc.conn.run(
                            f"cat {work_dir}/ORCA.interp", check=False
                        ))
                        if interp_result.exit_status == 0 and interp_result.stdout:
                            image_energies = _parse_interp_content(interp_result.stdout)
                            if image_energies:
                                # Convert tuple values to lists for JSON serialization
                                result["image_energies"] = {
                                    str(k): [[img_idx, energy] for img_idx, energy in v]
                                    for k, v in image_energies.items()
                                }
                                logger.info("ORCA NEB-TS: parsed %d iterations from .interp",
                                           len(image_energies))
                    except Exception as exc:
                        logger.debug("Failed to read ORCA.interp for %s: %s", node_id, exc)

            except Exception as exc:
                logger.warning(f"Failed to parse ORCA results for {node_id}: {exc}", exc_info=True)

    # Extract frequency data for VASP freq nodes
    if node_type == "freq" and engine_key == "vasp":
        try:
            from catgo.utils.vasp_freq_parser import parse_vasp_frequencies
            freq_data = await hpc.run_on_owner(lambda: parse_vasp_frequencies(hpc.conn, work_dir))
            if freq_data.get("success"):
                result.update(freq_data)
        except Exception as exc:
            logger.warning(
                "Failed to parse VASP frequencies for %s: %s", node_id, exc
            )

    return result


async def _read_orca_output(hpc_connection: Any, work_dir: str, task_id: str) -> str:
    """Read ORCA.out from HPC. Returns output text or raises on failure."""
    result = await hpc_connection.run_on_owner(lambda: hpc_connection.conn.run(
        f"cat {work_dir}/ORCA.out",
        check=True,
    ))
    return result.stdout


async def collect_orca_freq_results(
    hpc_connection: Any,
    work_dir: str,
    task_id: str,
) -> str:
    """Collect frequency calculation results from completed ORCA job.

    Uses OrcaFreqOutput.get_summary() which produces the exact format
    the frontend NodeStatusPanel expects: frequencies as array-of-objects
    with index/frequency_cm/imaginary/ir_intensity_km_mol, plus
    num_imaginary, zpe_kj_mol, enthalpy_eh, entropy_j_mol_k, gibbs_eh.
    """
    from catgo.utils.orca_output import OrcaFreqOutput

    try:
        output_text = await _read_orca_output(hpc_connection, work_dir, task_id)
    except Exception as e:
        logger.error(f"Task {task_id}: failed to read ORCA.out: {e}")
        return json.dumps({"error": f"Failed to read output: {str(e)}"})

    try:
        parser = OrcaFreqOutput(output_text)
        results_dict = parser.get_summary()
        results_dict["type"] = "orca_freq"

        n_freqs = len(results_dict.get("frequencies", []))
        logger.info(f"Task {task_id}: parsed {n_freqs} frequencies, "
                     f"num_imaginary={results_dict.get('num_imaginary', 0)}")
        return json.dumps(results_dict)

    except Exception as e:
        logger.error(f"Task {task_id}: failed to parse ORCA output: {e}", exc_info=True)
        return json.dumps({"error": f"Parsing failed: {str(e)}"})


async def collect_orca_irc_results(
    hpc_connection: Any,
    work_dir: str,
    task_id: str,
) -> str:
    """Collect IRC path results from completed ORCA job.

    Uses OrcaIrcOutput.get_summary() which produces: irc_converged,
    forward_converged, backward_converged, convergence_thresholds,
    convergence_points (array for IrcPathPlot), forward_endpoint,
    backward_endpoint, reaction_coordinate_data.
    """
    from catgo.utils.orca_output import OrcaIrcOutput

    try:
        output_text = await _read_orca_output(hpc_connection, work_dir, task_id)
    except Exception as e:
        logger.error(f"Task {task_id}: failed to read ORCA.out: {e}")
        return json.dumps({"error": f"Failed to read output: {str(e)}"})

    try:
        parser = OrcaIrcOutput(output_text)
        results_dict = parser.get_summary()
        results_dict["type"] = "orca_irc"

        n_points = len(results_dict.get("convergence_points", []))
        logger.info(f"Task {task_id}: parsed IRC with {n_points} points, "
                     f"converged={results_dict.get('irc_converged')}")
        return json.dumps(results_dict)

    except Exception as e:
        logger.error(f"Task {task_id}: failed to parse ORCA IRC: {e}", exc_info=True)
        return json.dumps({"error": f"Parsing failed: {str(e)}"})


async def collect_orca_opt_results(
    hpc_connection: Any,
    work_dir: str,
    task_id: str,
) -> str:
    """Collect geometry optimization results from completed ORCA job.

    Uses OrcaOptOutput.get_summary() which produces: energy_eh, energy_ev,
    converged, n_steps, max_gradient, rms_gradient, convergence_points
    (array for ConvergencePlot).
    """
    from catgo.utils.orca_output import OrcaOptOutput

    try:
        output_text = await _read_orca_output(hpc_connection, work_dir, task_id)
    except Exception as e:
        logger.error(f"Task {task_id}: failed to read ORCA.out: {e}")
        return json.dumps({"error": f"Failed to read output: {str(e)}"})

    try:
        parser = OrcaOptOutput(output_text)
        results_dict = parser.get_summary()
        results_dict["type"] = "orca_opt"

        logger.info(f"Task {task_id}: collected ORCA opt results, "
                     f"energy={results_dict.get('energy_eh')}, "
                     f"converged={results_dict.get('converged')}, "
                     f"steps={results_dict.get('n_steps')}")
        return json.dumps(results_dict)

    except Exception as e:
        logger.error(f"Task {task_id}: failed to parse ORCA opt output: {e}", exc_info=True)
        return json.dumps({"error": f"Parsing failed: {str(e)}"})


async def collect_orca_neb_results(
    hpc_connection: Any,
    work_dir: str,
    task_id: str,
) -> str:
    """Collect NEB-TS results from completed ORCA job.

    Uses OrcaNebOutput.get_summary() which produces: ts_converged,
    activation_barrier_kcal_mol, ts_imaginary_frequency,
    path_summary (with images array for NebPathPlot), convergence_points,
    vibrational_data, warnings.
    """
    from catgo.utils.orca_output import OrcaNebOutput

    try:
        output_text = await _read_orca_output(hpc_connection, work_dir, task_id)
    except Exception as e:
        logger.error(f"Task {task_id}: failed to read ORCA.out: {e}")
        return json.dumps({"error": f"Failed to read output: {str(e)}"})

    try:
        parser = OrcaNebOutput(output_text)
        results_dict = parser.get_summary()
        results_dict["type"] = "orca_neb_ts"

        # Read ORCA.interp for per-iteration image energies (same as
        # collect_completed_results does for the generic path).  Without
        # this, the early-exit in collector.py skips the generic collector
        # and image_energies never make it into the stored results.
        try:
            from catgo.utils.job_parser import _parse_interp_content
            interp_result = await hpc_connection.conn.run(
                f"cat {work_dir}/ORCA.interp", check=False
            )
            if interp_result.exit_status == 0 and interp_result.stdout:
                image_energies = _parse_interp_content(interp_result.stdout)
                if image_energies:
                    results_dict["image_energies"] = {
                        str(k): [[img_idx, energy] for img_idx, energy in v]
                        for k, v in image_energies.items()
                    }
                    logger.info("Task %s: parsed %d iterations from .interp",
                               task_id, len(image_energies))
        except Exception as exc:
            logger.debug("Task %s: failed to read ORCA.interp: %s", task_id, exc)

        logger.info(f"Task {task_id}: collected ORCA NEB results, "
                     f"ts_converged={results_dict.get('ts_converged')}, "
                     f"barrier={results_dict.get('activation_barrier_kcal_mol')}")
        return json.dumps(results_dict)

    except Exception as e:
        logger.error(f"Task {task_id}: failed to parse ORCA NEB output: {e}", exc_info=True)
        return json.dumps({"error": f"Parsing failed: {str(e)}"})


async def collect_orca_sp_results(
    hpc_connection: Any,
    work_dir: str,
    task_id: str,
) -> str:
    """Collect single point energy results from completed ORCA job.

    Uses OrcaSinglePointOutput.get_summary() which produces: energy_eh,
    energy_ev, convergence_points.
    """
    from catgo.utils.orca_output import OrcaSinglePointOutput

    try:
        output_text = await _read_orca_output(hpc_connection, work_dir, task_id)
    except Exception as e:
        logger.error(f"Task {task_id}: failed to read ORCA.out: {e}")
        return json.dumps({"error": f"Failed to read output: {str(e)}"})

    try:
        parser = OrcaSinglePointOutput(output_text)
        results_dict = parser.get_summary()
        results_dict["type"] = "orca_sp"
        results_dict["converged"] = results_dict.get("energy_eh") is not None

        logger.info(f"Task {task_id}: collected ORCA SP results, "
                     f"energy={results_dict.get('energy_eh')}")
        return json.dumps(results_dict)

    except Exception as e:
        logger.error(f"Task {task_id}: failed to parse ORCA SP output: {e}", exc_info=True)
        return json.dumps({"error": f"Parsing failed: {str(e)}"})


async def collect_orca_uvvis_results(
    hpc_connection: Any,
    work_dir: str,
    task_id: str,
) -> str:
    """Collect UV-Vis spectroscopy results from completed ORCA job.

    Uses OrcaUvVisOutput.get_summary() which produces: transitions,
    n_transitions, method, brightest_wavelength_nm,
    brightest_oscillator_strength, convergence_points.
    """
    from catgo.utils.orca_output import OrcaUvVisOutput

    try:
        output_text = await _read_orca_output(hpc_connection, work_dir, task_id)
    except Exception as e:
        logger.error(f"Task {task_id}: failed to read ORCA.out: {e}")
        return json.dumps({"error": f"Failed to read output: {str(e)}"})

    try:
        parser = OrcaUvVisOutput(output_text)
        results_dict = parser.get_summary()
        results_dict["type"] = "orca_uvvis"

        logger.info(f"Task {task_id}: collected ORCA UV-Vis results, "
                     f"n_transitions={results_dict.get('n_transitions')}")
        return json.dumps(results_dict)

    except Exception as e:
        logger.error(f"Task {task_id}: failed to parse ORCA UV-Vis output: {e}", exc_info=True)
        return json.dumps({"error": f"Parsing failed: {str(e)}"})
