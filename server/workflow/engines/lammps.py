"""LAMMPS input generation and local execution for workflow engine."""

import json
import logging
import os
import re
import shlex
import shutil
import subprocess
from io import StringIO
from typing import Any, Optional

from workflow.engines.vasp import _structure_to_pymatgen_dict

logger = logging.getLogger(__name__)

__all__ = [
    "generate_lammps_inputs",
    "execute_lammps_local",
]


async def generate_lammps_inputs(
    hpc: Any,
    work_dir: str,
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
):
    """Generate LAMMPS input files and upload to HPC.

    Delegates to generate_lammps_input_files() for pure paths.
    Polymer and forcefield paths remain async.
    Packmol pre-step runs first if enabled.
    """
    from catgo.utils.job_parser import write_remote_files

    workflow_inputs: dict[str, Any] = {}
    raw_wi = params.pop("_resolved_workflow_inputs", None)
    if isinstance(raw_wi, dict):
        workflow_inputs = raw_wi

    # Packmol pre-step (if enabled)
    packmol_enabled = params.get("packmol_enabled", False)
    if packmol_enabled:
        structure_str = await _run_packmol(
            hpc, work_dir, params, structure_str, workflow_inputs,
        )
        if not structure_str:
            raise RuntimeError("Packmol execution failed or did not return a structure")

    # Polymer path (async — calls sub-generator)
    if node_type == "polymer_md":
        files = _generate_polymer_input_files(params, structure_str)
        await write_remote_files(hpc.conn, {f"{work_dir}/{k}": v for k, v in files.items()})
        return

    # Forcefield path (async — calls backend API via httpx)
    use_forcefield = params.get("use_forcefield", False)
    forcefield = params.get("forcefield", "")
    if (use_forcefield or forcefield) and structure_str:
        await _generate_lammps_with_forcefield(hpc, work_dir, params, structure_str)
        return

    # Standard / custom / data-file paths (all pure)
    files = generate_lammps_input_files(node_type, params, structure_str)
    await write_remote_files(hpc.conn, {f"{work_dir}/{k}": v for k, v in files.items()})


def _packmol_exit_ok(result: Any) -> bool:
    es = getattr(result, "exit_status", None)
    if es is not None:
        return es == 0
    return int(result.get("exit_status", result.get("exit_code", 1))) == 0


def _smiles_to_pdb_string(smiles: str) -> str:
    """Build a single-molecule PDB from SMILES using Open Babel (server-side)."""
    obabel = shutil.which("obabel")
    if not obabel:
        raise RuntimeError(
            "Open Babel CLI (obabel) not found in PATH; required for Packmol mixture (SMILES) building."
        )
    smi = smiles.strip()
    if not smi:
        raise ValueError("Empty SMILES in packmol_components")
    proc = subprocess.run(
        [obabel, "-ismi", "-opdb", "--gen3d", "-h"],
        input=smi.encode("utf-8"),
        capture_output=True,
        timeout=180,
    )
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"obabel failed for SMILES {smi!r}: {err}")
    out = proc.stdout.decode("utf-8", errors="replace")
    if not out.strip():
        raise RuntimeError(f"obabel produced empty PDB for SMILES {smi!r}")
    return out


def _molecule_to_pdb_text(mol: Any) -> str:
    from pymatgen.io.ase import AseAtomsAdaptor
    from ase.io import write

    buf = StringIO()
    atoms = AseAtomsAdaptor.get_atoms(mol)
    for fmt in ("proteindatabank", "pdb"):
        try:
            buf.seek(0)
            buf.truncate(0)
            write(buf, atoms, format=fmt)
            return buf.getvalue()
        except Exception:
            continue
    raise RuntimeError("ASE cannot write PDB format for this structure")


def _sniff_molecular_text_format(text: str) -> Optional[str]:
    t = text.strip()
    if not t:
        return None
    if t.lstrip().startswith("@<TRIPOS>"):
        return "mol2"
    u = t[:800].upper()
    if "CRYST1" in u or u.startswith("HEADER") or u.startswith("ATOM") or u.startswith("HETATM"):
        return "pdb"
    lines = t.splitlines()
    if lines and lines[0].strip().replace(" ", "").isdigit():
        return "xyz"
    return None


def _obabel_text_to_pdb(text: str, in_format: Optional[str] = None) -> str:
    """Decode molecular file text to PDB using Open Babel."""
    obabel = shutil.which("obabel")
    if not obabel:
        raise RuntimeError(
            "Open Babel (obabel) is required to read MOL2/XYZ and other molecular text formats."
        )
    order: list[str] = []
    if in_format:
        order.append(in_format.lower())
    sniffed = _sniff_molecular_text_format(text)
    if sniffed and sniffed not in order:
        order.append(sniffed)
    for f in ("mol2", "xyz", "pdb", "sdf", "cif", "mol"):
        if f not in order:
            order.append(f)
    last_err = ""
    for inf in order:
        proc = subprocess.run(
            [obabel, f"-i{inf}", "-opdb", "--gen3d", "-h"],
            input=text.encode("utf-8"),
            capture_output=True,
            timeout=300,
        )
        if proc.returncode == 0:
            out = proc.stdout.decode("utf-8", errors="replace").strip()
            if len(out) > 20:
                return out
        last_err = (proc.stderr or b"").decode("utf-8", errors="replace")[:400]
    raise RuntimeError(f"Open Babel could not read molecular file text: {last_err}")


def _box_molecule_as_structure(mol: Any) -> Any:
    """Place a disconnected molecule in a minimal orthorhombic cell (for parsers)."""
    from pymatgen.core import Lattice, Structure
    import numpy as np

    coords = np.array(mol.cart_coords)
    pad = 10.0
    cmin = coords.min(axis=0)
    cmax = coords.max(axis=0)
    span = np.maximum(cmax - cmin + 2 * pad, [8.0, 8.0, 8.0])
    origin = cmin - pad
    shifted = coords - origin
    lat = Lattice.orthorhombic(float(span[0]), float(span[1]), float(span[2]))
    return Structure(lat, mol.species_and_occu, shifted, coords_are_cartesian=True)


def load_structure_for_lammps(structure_str: str) -> Any:
    """Parse structure from CatGo JSON, embedded MOL2/XYZ/PDB blobs, POSCAR/CIF, or raw molecular text."""
    from pymatgen.core import Structure, Molecule

    s = structure_str.strip()
    if not s:
        raise ValueError("Empty structure string")

    if s.startswith("{"):
        d = json.loads(s)
        if not isinstance(d, dict):
            raise ValueError("Structure JSON must decode to an object")
        for key, fmt in (
            ("_mol2_content", "mol2"),
            ("_xyz_content", "xyz"),
            ("_pdb_content", "pdb"),
        ):
            blob = d.get(key)
            if blob and str(blob).strip():
                pdb_txt = _obabel_text_to_pdb(str(blob), fmt)
                mol = Molecule.from_str(pdb_txt, fmt="pdb")
                return _box_molecule_as_structure(mol)
        blob = d.get("file_content")
        if blob and str(blob).strip():
            hint = (d.get("file_format") or "").strip().lower() or None
            if not hint:
                hint = _sniff_molecular_text_format(str(blob))
            pdb_txt = _obabel_text_to_pdb(str(blob), hint)
            mol = Molecule.from_str(pdb_txt, fmt="pdb")
            return _box_molecule_as_structure(mol)
        if d.get("sites"):
            clean = {k: v for k, v in d.items() if not str(k).startswith("_")}
            if clean.get("lattice"):
                return Structure.from_dict(clean)
            mol = Molecule.from_dict(clean)
            return _box_molecule_as_structure(mol)
        raise ValueError(
            "Structure JSON has no recognizable geometry (sites, file_content, or _mol2/_xyz/_pdb content)",
        )

    for fmt in ("poscar", "cif", "xyz", "mol2", "pdb", "gjf"):
        try:
            return Structure.from_str(s, fmt=fmt)
        except Exception:
            try:
                mol = Molecule.from_str(s, fmt=fmt)
                return _box_molecule_as_structure(mol)
            except Exception:
                continue
    pdb_txt = _obabel_text_to_pdb(s, None)
    mol = Molecule.from_str(pdb_txt, fmt="pdb")
    return _box_molecule_as_structure(mol)


def _structure_input_to_pdb_string(structure_str: str) -> str:
    """Single-molecule PDB text for Packmol from any supported upstream format."""
    from pymatgen.core import Molecule

    st = load_structure_for_lammps(structure_str)
    mol = Molecule(st.species_and_occu, st.cart_coords)
    return _molecule_to_pdb_text(mol)


def _pdb_template_molar_mass(pdb_str: str) -> float:
    from pymatgen.core import Molecule

    mol = Molecule.from_str(pdb_str, fmt="pdb")
    return float(mol.composition.weight)


def _packed_pdb_to_structure_json(pdb_str: str, box_edge_angstrom: float) -> str:
    """Wrap Packmol PDB (no CRYST1) in an orthorhombic periodic Structure."""
    from pymatgen.core import Lattice, Molecule, Structure

    try:
        pmol = Molecule.from_str(pdb_str, fmt="pdb")
    except Exception:
        from pymatgen.core import Structure as PMGS

        struct = PMGS.from_str(pdb_str, fmt="pdb")
        d = struct.as_dict()
        d["_pdb_content"] = pdb_str.strip()
        return json.dumps(d)

    lat = Lattice.cubic(box_edge_angstrom)
    struct = Structure(
        lat,
        pmol.species_and_occu,
        pmol.cart_coords,
        coords_are_cartesian=True,
    )
    d = struct.as_dict()
    d["_pdb_content"] = pdb_str.strip()
    return json.dumps(d)


def _structure_templates_list(
    structure_str: Optional[str],
    workflow_inputs: Optional[dict[str, Any]],
) -> list[str]:
    """Ordered list of structure JSON templates from the single ``structure`` port.

    Multiple Structure Input nodes may connect to the same port; the workflow
    resolver then passes ``workflow_inputs['structure']`` as a list.
    """
    wi = workflow_inputs or {}
    s = wi.get("structure")
    if isinstance(s, list):
        return [str(x) for x in s if x and str(x).strip()]
    if s is not None and str(s).strip():
        return [str(s)]
    if structure_str and str(structure_str).strip():
        return [str(structure_str)]
    return []


def _parse_packmol_file_counts(params: dict[str, Any]) -> Optional[list[int]]:
    raw = params.get("packmol_file_counts")
    if raw is None:
        return None
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return None
        data = json.loads(s)
    else:
        data = raw
    if not isinstance(data, list) or not data:
        return None
    return [int(x) for x in data]


def build_packmol_workspace_files(
    params: dict[str, Any],
    structure_str: Optional[str],
    workflow_inputs: Optional[dict[str, Any]] = None,
) -> tuple[dict[str, str], float]:
    """Return {basename: file content} for Packmol and cubic box edge (Å).

    Mixture modes:

    - ``packmol_components`` JSON: ``smiles`` and/or ``input: \"structure\"`` with optional
      ``template_index`` (0-based) when several structures share the structure port.
    - ``packmol_file_counts`` JSON array: e.g. ``[100, 50]`` → counts for the 1st, 2nd, …
      template from that ordered list.

    Single-species: empty mixture and no file_counts → ``structure_str`` +
    ``packmol_n_molecules``.
    """
    density = float(params.get("packmol_density", 1.0))
    if density <= 0:
        raise ValueError(f"Invalid packmol_density: {density}")
    tol = float(params.get("packmol_tolerance", 2.0))
    if tol <= 0:
        raise ValueError(f"Invalid packmol_tolerance: {tol}")

    na = 6.02214076e23
    raw_components = params.get("packmol_components")
    mixture: list[dict[str, Any]] = []
    if isinstance(raw_components, str):
        s = raw_components.strip()
        if s:
            mixture = json.loads(s)
    elif isinstance(raw_components, list):
        mixture = raw_components

    files: dict[str, str] = {}
    entries: list[tuple[str, str, int]] = []  # pdb basename, pdb content, count
    total_mass_g = 0.0

    if mixture:
        if not isinstance(mixture, list) or len(mixture) < 1:
            raise ValueError("packmol_components must be a non-empty JSON array")
        for i, item in enumerate(mixture):
            if not isinstance(item, dict):
                raise ValueError(f"packmol_components[{i}] must be an object")
            count = int(item.get("count", 0))
            if count < 1:
                raise ValueError(f"packmol_components[{i}]: count must be >= 1")
            smi = (item.get("smiles") or "").strip()
            in_key = (item.get("input") or item.get("from_input") or "").strip()
            if smi:
                pdb = _smiles_to_pdb_string(smi)
            elif in_key:
                if in_key != "structure":
                    raise ValueError(
                        f"packmol_components[{i}]: unknown input '{in_key}'. "
                        "Use input \"structure\" with optional template_index (0,1,…) "
                        "when multiple Structure Input nodes connect to the same port.",
                    )
                tmpl = _structure_templates_list(structure_str, workflow_inputs)
                idx = int(item.get("template_index", 0))
                if not tmpl:
                    raise ValueError(
                        f"packmol_components[{i}]: no structure templates (connect Structure Input).",
                    )
                if idx < 0 or idx >= len(tmpl):
                    raise ValueError(
                        f"packmol_components[{i}]: template_index {idx} out of range "
                        f"({len(tmpl)} template(s) on structure port)",
                    )
                pdb = _structure_input_to_pdb_string(tmpl[idx])
            else:
                raise ValueError(
                    f"packmol_components[{i}]: provide 'smiles' and/or 'input' (port key)",
                )
            mw = _pdb_template_molar_mass(pdb)
            base = f"species_{i}.pdb"
            files[base] = pdb
            entries.append((base, pdb, count))
            total_mass_g += count * mw / na
    else:
        file_counts = _parse_packmol_file_counts(params)
        if file_counts:
            tmpl = _structure_templates_list(structure_str, workflow_inputs)
            n_mol = 0
            for j, cnt in enumerate(file_counts):
                if cnt < 1:
                    continue
                if j >= len(tmpl):
                    raise ValueError(
                        f"packmol_file_counts[{j}]: missing template — only {len(tmpl)} "
                        "structure(s) on the structure port (add Structure Input nodes "
                        "or use a shorter counts array).",
                    )
                pdb = _structure_input_to_pdb_string(tmpl[j])
                mw = _pdb_template_molar_mass(pdb)
                base = f"species_{j}.pdb"
                files[base] = pdb
                entries.append((base, pdb, cnt))
                total_mass_g += cnt * mw / na
                n_mol += 1
            if n_mol == 0:
                raise ValueError(
                    "packmol_file_counts: need at least one positive count with a structure",
                )
        else:
            n_molecules = int(params.get("packmol_n_molecules", 100))
            if n_molecules < 1:
                raise ValueError(f"Invalid packmol_n_molecules: {n_molecules}")
            tmpl = _structure_templates_list(structure_str, workflow_inputs)
            if not tmpl:
                raise ValueError(
                    "Packmol (single species): connect a structure input, or set "
                    "packmol_components / packmol_file_counts for mixtures.",
                )
            pdb = _structure_input_to_pdb_string(tmpl[0])
            base = "molecule.pdb"
            files[base] = pdb
            mw = _pdb_template_molar_mass(pdb)
            entries.append((base, pdb, n_molecules))
            total_mass_g += n_molecules * mw / na

    volume_cm3 = total_mass_g / density
    volume_ang3 = volume_cm3 * 1e24
    box_edge = volume_ang3 ** (1.0 / 3.0)
    if box_edge <= 0:
        raise RuntimeError("Computed Packmol box edge is non-positive; check density and counts")

    lines = [
        f"tolerance {tol:.3f}",
        "filetype pdb",
        "output packed.pdb",
        "",
    ]
    for base, _pdb, count in entries:
        lines.extend(
            [
                f"structure {base}",
                f"  number {count}",
                f"  inside box 0.0 0.0 0.0 {box_edge:.6f} {box_edge:.6f} {box_edge:.6f}",
                "end structure",
                "",
            ]
        )
    files["packmol.inp"] = "\n".join(lines).rstrip() + "\n"
    return files, box_edge


def collect_packmol_workflow_inputs_local(
    step_id: str,
    edges: list[dict[str, Any]],
    step_results: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Collect all structures wired to the main ``structure`` port (in-0), in edge order."""
    templates: list[str] = []
    for e in edges:
        tgt = e.get("to") or e.get("target")
        if tgt != step_id:
            continue
        to_h = str(e.get("toH") or e.get("toHandle") or "in-0")
        if to_h != "in-0":
            continue
        src = e.get("from") or e.get("source")
        if not src:
            continue
        pr = step_results.get(src, {})
        s = pr.get("contcar") or pr.get("structure_json")
        if s:
            templates.append(str(s))
    if not templates:
        return {}
    if len(templates) == 1:
        return {"structure": templates[0]}
    return {"structure": templates}


def run_packmol_local(
    work_dir: str,
    params: dict[str, Any],
    structure_str: Optional[str],
    workflow_inputs: Optional[dict[str, Any]] = None,
) -> str:
    """Run Packmol on the local machine; return packed structure JSON."""
    files, box_edge = build_packmol_workspace_files(
        params, structure_str, workflow_inputs,
    )
    for name, content in files.items():
        path = os.path.join(work_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    packmol_exe = shutil.which("packmol")
    if not packmol_exe:
        raise RuntimeError("packmol executable not found in PATH.")
    inp_path = os.path.join(work_dir, "packmol.inp")
    with open(inp_path, encoding="utf-8") as f:
        proc = subprocess.run(
            [packmol_exe],
            cwd=work_dir,
            stdin=f,
            capture_output=True,
            text=True,
            timeout=3600,
        )
    if proc.returncode != 0:
        raise RuntimeError(
            f"Packmol failed (exit {proc.returncode}): {proc.stderr or proc.stdout}"
        )
    packed_path = os.path.join(work_dir, "packed.pdb")
    if not os.path.isfile(packed_path):
        raise RuntimeError("Packmol did not produce packed.pdb")
    with open(packed_path, encoding="utf-8", errors="replace") as f:
        packed_pdb = f.read()
    return _packed_pdb_to_structure_json(packed_pdb, box_edge)


async def _run_packmol(
    hpc: Any,
    work_dir: str,
    params: dict[str, Any],
    structure_str: Optional[str],
    workflow_inputs: Optional[dict[str, Any]] = None,
) -> Optional[str]:
    """Run packmol on HPC to generate a packed molecule box.

    Returns structure JSON for the periodic box. SMILES mixtures are expanded
    with Open Babel on the CatGo server before files are uploaded.
    """
    from catgo.utils.job_parser import write_remote_files, read_remote_file

    files, box_edge = build_packmol_workspace_files(
        params, structure_str, workflow_inputs,
    )
    files_to_write = {f"{work_dir}/{name}": content for name, content in files.items()}
    await write_remote_files(hpc.conn, files_to_write)

    safe_dir = shlex.quote(work_dir)
    result = await hpc.conn.run(f"cd {safe_dir} && packmol < packmol.inp")
    if not _packmol_exit_ok(result):
        stderr = getattr(result, "stderr", None) or ""
        stdout = getattr(result, "stdout", None) or ""
        msg = stderr or stdout or str(result)
        logger.error(f"Packmol execution failed: {msg}")
        raise RuntimeError(f"Packmol failed: {msg}")

    packed_pdb = await read_remote_file(hpc.conn, f"{work_dir}/packed.pdb")
    if not (packed_pdb or "").strip():
        raise RuntimeError("Packmol produced an empty packed.pdb")

    try:
        return _packed_pdb_to_structure_json(packed_pdb, box_edge)
    except Exception as e:
        logger.error(f"Failed to parse packmol output: {e}")
        raise RuntimeError(f"Packmol output parsing failed: {e}") from e


def _extract_lammps_raw(structure_str: Optional[str]) -> Optional[str]:
    """Extract embedded _lammps_data_raw from structure JSON if present."""
    if not structure_str:
        return None
    try:
        d = json.loads(structure_str) if isinstance(structure_str, str) else structure_str
        if isinstance(d, dict):
            return d.get("_lammps_data_raw")
    except (json.JSONDecodeError, TypeError):
        pass
    return None


def generate_lammps_input_files(
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
) -> dict[str, str]:
    """Pure function: return {filename: content} for standard LAMMPS paths.

    Handles: custom input text, embedded data file, custom data file path, standard generation.
    Does NOT handle: polymer_md or forcefield conversion (those are async).
    """
    from catgo.routers.lammps import (
        extract_structure_info, generate_data_file, generate_input_script,
        parse_lammps_data_info, LammpsInputRequest, PymatgenStructure,
    )

    _lammps_raw = _extract_lammps_raw(structure_str)
    custom_data_file = params.get("custom_data_file", "")

    # Path 1: custom input script
    if params.get("custom_input_text"):
        files = {"in.lammps": params["custom_input_text"]}
        if _lammps_raw:
            files["system.data"] = _lammps_raw
        elif custom_data_file and os.path.isfile(custom_data_file):
            files[os.path.basename(custom_data_file)] = open(custom_data_file).read()
        elif structure_str:
            struct = load_structure_for_lammps(structure_str)
            pymatgen_struct = PymatgenStructure(**_structure_to_pymatgen_dict(struct))
            info = extract_structure_info(pymatgen_struct)
            files["system.data"] = generate_data_file(
                LammpsInputRequest(structure=pymatgen_struct, prefix="system"), info,
            )
        return files

    # --- Unified potential/force field handling ---
    potential_type = params.get("potential_type", "lj")
    # md_minimize nodes don't set potential_type — route to forcefield or custom path
    if node_type in ("md_minimize", "lammps_minimize") and "potential_type" not in params:
        potential_type = "forcefield" if params.get("use_forcefield") else "custom"
    kspace_style = None

    pair_style_map = {
        "lj": ("lj/cut", {"cutoff": params.get("lj_cutoff", 2.5)}),
        "charmm": ("lj/charmm/coul/long", {"inner": params.get("charmm_inner", 10.0), "outer": params.get("charmm_outer", 10.0)}),
        "buck": ("buck", {"cutoff": params.get("buck_cutoff", 10.0)}),
        "eam": ("eam/alloy", {}),
        "tersoff": ("tersoff", {}),
        "custom": (params.get("pair_style", "lj/cut 2.5"), {}),
    }

    if potential_type in pair_style_map:
        base_style, style_args = pair_style_map[potential_type]
        if potential_type == "lj":
            pair_style = f"{base_style} {style_args['cutoff']}"
            eps = params.get("lj_epsilon", 0.01)
            sig = params.get("lj_sigma", 2.5)
            pair_coeff = f"* * {eps} {sig}"
        elif potential_type == "charmm":
            pair_style = f"{base_style} {style_args['inner']} {style_args['outer']}"
            pair_coeff = "* * 0.0 0.0 0.0"
            kspace_style = "pppm 0.0001"
        elif potential_type == "buck":
            A = params.get("buck_A", 1000.0)
            rho = params.get("buck_rho", 0.3)
            C = params.get("buck_C", 0.0)
            pair_style = f"{base_style} {style_args['cutoff']}"
            pair_coeff = f"* * {A} {rho} {C}"
        elif potential_type == "eam":
            eam_file = params.get("eam_file", "")
            if eam_file:
                pair_style = base_style
                pair_coeff = f"* * {eam_file}"
            else:
                element = params.get("eam_element", "Cu")
                pair_style = base_style
                pair_coeff = f"* * {element}"
        elif potential_type == "tersoff":
            tersoff_file = params.get("tersoff_file", "")
            if not tersoff_file:
                raise RuntimeError("Tersoff potential requires a potential file (tersoff_file parameter)")
            pair_style = base_style
            pair_coeff = f"* * {tersoff_file}"
        else:  # custom
            pair_style = base_style
            pair_coeff = params.get("pair_coeff", "* * 1.0 1.0")
    else:
        pair_style = params.get("pair_style", "lj/cut 2.5")
        pair_coeff = params.get("pair_coeff", "* * 1.0 1.0")

    ensemble = params.get("ensemble", "nvt")
    temperature = params.get("temperature", 300)
    timestep = params.get("timestep", 0.001)
    steps = params.get("steps", 10000)
    dump_freq = params.get("dump_freq", 100)
    thermo_freq = params.get("thermo_freq", dump_freq)
    atom_style = params.get("atom_style", "atomic")
    extra_commands = params.get("extra_commands", "")
    units = params.get("units", "metal")

    is_minimize = ensemble.startswith("minimize_") or node_type in ("md_minimize", "lammps_minimize")
    if is_minimize:
        simulation_type = "minimize"
    else:
        simulation_type = {"nve": "nve", "nvt": "nvt", "npt": "npt"}.get(ensemble, "nvt")

    minimize_kwargs: dict[str, Any] = {}
    if is_minimize:
        if node_type in ("md_minimize", "lammps_minimize"):
            minimize_kwargs = {
                "min_style": params.get("min_style", "cg"),
                "etol": float(params.get("etol", 1e-6)),
                "ftol": float(params.get("ftol", 1e-6)),
                "maxiter": int(params.get("maxiter", 10000)),
                "maxeval": int(params.get("maxeval", 100000)),
            }
        else:
            minimize_kwargs = {
                "min_style": "sd" if ensemble == "minimize_sd" else "cg",
                "etol": float(params.get("minimize_etol", 1e-6)),
                "ftol": float(params.get("minimize_ftol", 1e-8)),
                "maxiter": int(params.get("minimize_maxiter", 10000)),
                "maxeval": int(params.get("minimize_maxeval", 100000)),
            }

    # Path 2: provided data file (embedded or local path)
    if _lammps_raw or (custom_data_file and os.path.isfile(custom_data_file)):
        data_content = _lammps_raw or open(custom_data_file).read()
        data_filename = "system.data" if _lammps_raw else os.path.basename(custom_data_file)
        info = parse_lammps_data_info(data_content)
        request = LammpsInputRequest(
            structure=PymatgenStructure(lattice=None, sites=[]),
            prefix="system",
            units=units,
            atom_style=atom_style,
            boundary="p p p",
            pair_style=pair_style,
            pair_coeff=pair_coeff,
            simulation_type=simulation_type,
            temperature=temperature,
            timestep=timestep,
            run_steps=steps,
            dump_freq=dump_freq,
            thermo_freq=thermo_freq,
            custom_data_file=data_filename,
            bond_style=params.get("bond_style"),
            bond_coeff=params.get("bond_coeff"),
            angle_style=params.get("angle_style"),
            angle_coeff=params.get("angle_coeff"),
            dihedral_style=params.get("dihedral_style"),
            dihedral_coeff=params.get("dihedral_coeff"),
            improper_style=params.get("improper_style"),
            improper_coeff=params.get("improper_coeff"),
            kspace_style=params.get("kspace_style") or kspace_style,
            special_bonds=params.get("special_bonds"),
            extra_commands=extra_commands or None,
            **minimize_kwargs,
        )
        return {"in.lammps": generate_input_script(request, info), data_filename: data_content}

    # Path 3: standard — convert structure and generate both files
    if not structure_str:
        raise RuntimeError("No structure provided for LAMMPS calculation")
    struct = load_structure_for_lammps(structure_str)
    pymatgen_struct = PymatgenStructure(**_structure_to_pymatgen_dict(struct))
    request = LammpsInputRequest(
        structure=pymatgen_struct,
        prefix="system",
        units=units,
        atom_style=atom_style,
        boundary="p p p",
        pair_style=pair_style,
        pair_coeff=pair_coeff,
        simulation_type=simulation_type,
        temperature=temperature,
        timestep=timestep,
        run_steps=steps,
        dump_freq=dump_freq,
        thermo_freq=thermo_freq,
        extra_commands=extra_commands or None,
        kspace_style=params.get("kspace_style") or kspace_style,
        **minimize_kwargs,
    )
    info = extract_structure_info(pymatgen_struct)
    return {
        "in.lammps": generate_input_script(request, info),
        "system.data": generate_data_file(request, info),
    }


def _generate_polymer_input_files(
    params: dict[str, Any],
    structure_str: Optional[str],
) -> dict[str, str]:
    """Pure function: return {filename: content} for polymer LAMMPS."""
    from catgo.routers.lammps import (
        extract_structure_info, generate_polymer_workflow_script,
        generate_polymer_workflow_data_file, PolymerWorkflowRequest, PymatgenStructure,
    )
    if not structure_str:
        raise RuntimeError("No structure provided for polymer LAMMPS calculation")
    struct = load_structure_for_lammps(structure_str)
    pymatgen_struct = PymatgenStructure(**_structure_to_pymatgen_dict(struct))
    request = PolymerWorkflowRequest(
        structure=pymatgen_struct, prefix="polymer",
        pair_style=params.get("pair_style", "lj/cut 2.5"),
        pair_coeff=params.get("pair_coeff", "* * 1.0 1.0"),
        bond_style=params.get("bond_style", "fene"),
        bond_coeff=params.get("bond_coeff", "1 30.0 1.5 1.0 1.0"),
        workflow_mode=params.get("workflow_mode", "polymer_kg"),
        temperature=params.get("temperature", 300),
        pressure=params.get("pressure", 1.0),
        timestep=params.get("timestep", 0.001),
        gen_steps_nvt=params.get("gen_steps_nvt", 5000),
        gen_steps_npt=params.get("gen_steps_npt", 50000),
        equil_steps=params.get("equil_steps", 100000),
        prod_steps=params.get("prod_steps", 100000),
        prod_dump_freq=params.get("prod_dump_freq", 1000),
        units="lj" if params.get("workflow_mode") == "polymer_kg" else "real",
        atom_style="molecular",
    )
    info = extract_structure_info(pymatgen_struct)
    script, _ = generate_polymer_workflow_script(request, info)
    data = generate_polymer_workflow_data_file(request, info)
    return {"in.lammps": script, "polymer.data": data}




async def _generate_lammps_with_forcefield(
    hpc: Any,
    work_dir: str,
    params: dict[str, Any],
    structure_str: str,
):
    """Generate LAMMPS input files with force field conversion for molecular structures."""
    import httpx
    from catgo.utils.job_parser import write_remote_files

    # Detect structure format
    struct_data = json.loads(structure_str) if isinstance(structure_str, str) else structure_str

    # Check if structure has embedded file content (PDB, MOL2, or XYZ)
    structure_content = None
    structure_format = None

    # First, check for explicit content keys
    if isinstance(struct_data, dict):
        if "_pdb_content" in struct_data:
            structure_content = struct_data["_pdb_content"]
            structure_format = "pdb"
        elif "_mol2_content" in struct_data:
            structure_content = struct_data["_mol2_content"]
            structure_format = "mol2"
        elif "_xyz_content" in struct_data:
            structure_content = struct_data["_xyz_content"]
            structure_format = "xyz"
        elif "file_content" in struct_data:
            structure_content = struct_data["file_content"]
            structure_format = params.get("file_format") or struct_data.get("file_format")
        elif "sites" in struct_data:
            if "file_content" in params:
                structure_content = params["file_content"]
                structure_format = params.get("file_format")

    # If still no content, check params directly
    if not structure_content and isinstance(params, dict):
        if "file_content" in params:
            structure_content = params["file_content"]
            structure_format = params.get("file_format")

    # Pymatgen geometry dict (incl. Packmol output with embedded _pdb_content stripped above)
    if not structure_content and isinstance(struct_data, dict) and struct_data.get("sites"):
        try:
            from pymatgen.core import Structure as PMGStructure
            from pymatgen.io.ase import AseAtomsAdaptor
            from ase.io import write

            clean_sd = {k: v for k, v in struct_data.items() if not str(k).startswith("_")}
            st = PMGStructure.from_dict(clean_sd)
            buf = StringIO()
            write(buf, AseAtomsAdaptor.get_atoms(st), format="proteindatabank")
            structure_content = buf.getvalue()
            structure_format = "pdb"
        except Exception as exc:
            logger.warning("Could not derive PDB for force field from structure dict: %s", exc)

    # Auto-detect format from content if not specified
    if structure_content and not structure_format:
        content_stripped = structure_content.strip()
        if content_stripped.startswith("@<TRIPOS>MOLECULE"):
            structure_format = "mol2"
        elif content_stripped.startswith("ATOM") or "CRYST1" in content_stripped[:200]:
            structure_format = "pdb"
        elif content_stripped.split('\n')[0].strip().isdigit():
            structure_format = "xyz"

    if not structure_content:
        raise RuntimeError(
            "Force field conversion requires a molecular structure file input. "
            "Please upload a PDB, MOL2, or XYZ file."
        )

    if not structure_format:
        raise RuntimeError(
            "Could not detect file format. Please specify file_format parameter."
        )

    # Call force field conversion service
    forcefield = params.get("forcefield", "gaff2")
    charge_method = params.get("charge_method", "gasteiger")
    solvate = params.get("solvate", False)
    water_model = params.get("water_model", "tip3p")
    box_padding = params.get("box_padding", 10.0)

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"http://localhost:{os.environ.get('SERVER_PORT', '8000')}/api/forcefield/convert",
                json={
                    "structure_content": structure_content,
                    "structure_format": structure_format,
                    "force_field": forcefield,
                    "charge_method": charge_method,
                    "solvate": solvate,
                    "water_model": water_model,
                    "box_padding": box_padding,
                    "include_init": True,
                }
            )
            response.raise_for_status()
            result = response.json()
    except httpx.HTTPError as e:
        raise RuntimeError(f"Force field conversion failed: {e.response.text}")

    if not result.get("success"):
        raise RuntimeError(f"Force field conversion failed: {result.get('message')}")

    # Write converted files
    data_file = result.get("data_file")
    init_file = result.get("init_file", "")

    files_to_write = {}
    if data_file:
        files_to_write[f"{work_dir}/system.data"] = data_file
        logger.info(f"[workflow] Prepared system.data with {result.get('num_atoms', 0)} atoms")

    # Generate proper input script with force-field-specific settings
    from routers.forcefield_utils import get_ff_settings
    ffs = get_ff_settings(forcefield)

    ensemble = params.get("ensemble", "nvt")
    temperature = params.get("temperature", 300)
    timestep = params.get("timestep", 1.0)
    steps = params.get("steps", 10000)
    dump_freq = params.get("dump_freq", 100)

    # Build input script — prefer moltemplate's init when available,
    # otherwise generate correct settings from FORCE_FIELD_SETTINGS.
    script_lines = []

    if init_file:
        for line in init_file.split('\n'):
            line = line.strip()
            if line and not line.startswith('#'):
                script_lines.append(line)
    else:
        # All style commands and special_bonds MUST appear before read_data
        script_lines.extend([
            "units           real",
            "atom_style      full",
            "",
            f"bond_style      {ffs['bond_style']}",
            f"angle_style     {ffs['angle_style']}",
            f"dihedral_style  {ffs['dihedral_style']}",
        ])
        if ffs.get("improper_style"):
            script_lines.append(f"improper_style  {ffs['improper_style']}")
        script_lines.extend([
            "",
            f"pair_style      {ffs['pair_style']}",
        ])
        if ffs.get("pair_modify"):
            script_lines.append(f"pair_modify     {ffs['pair_modify']}")
        script_lines.append(f"special_bonds   {ffs['special_bonds']}")
        if ffs.get("kspace_style"):
            script_lines.append(f"kspace_style    {ffs['kspace_style']}")

    # Build ensemble-specific fix and thermo commands
    pressure = params.get("pressure", 1.0)
    thermo_freq = params.get("thermo_freq", dump_freq)

    is_ff_minimize = ensemble.startswith("minimize_") or node_type in ("md_minimize", "lammps_minimize")

    script_lines.extend([
        "",
        "read_data       system.data",
        "",
        "neighbor        2.0 bin",
        "neigh_modify    delay 0 every 1 check yes",
        "",
    ])

    if is_ff_minimize:
        if node_type in ("md_minimize", "lammps_minimize"):
            min_style = params.get("min_style", "cg")
            etol = float(params.get("etol", 1e-6))
            ftol = float(params.get("ftol", 1e-6))
            maxiter = int(params.get("maxiter", 10000))
            maxeval = int(params.get("maxeval", 100000))
        else:
            min_style = "sd" if ensemble == "minimize_sd" else "cg"
            etol = float(params.get("minimize_etol", 1e-6))
            ftol = float(params.get("minimize_ftol", 1e-8))
            maxiter = int(params.get("minimize_maxiter", 10000))
            maxeval = int(params.get("minimize_maxeval", 100000))

        script_lines.extend([
            f"thermo          {thermo_freq}",
            f"thermo_style    custom step pe ke etotal press vol density",
            "",
            f"min_style       {min_style}",
            f"minimize        {etol} {ftol} {maxiter} {maxeval}",
            "",
            f"write_data      system_minimized_{min_style}.data",
        ])
    else:
        if ensemble == "nve":
            fix_cmd = "fix             1 all nve"
            thermo_style = "step temp pe ke etotal press vol density"
        elif ensemble == "npt":
            fix_cmd = f"fix             1 all npt temp {temperature} {temperature} 100.0 iso {pressure} {pressure} 1000.0"
            thermo_style = "step temp pe ke etotal press vol density lx ly lz"
        else:  # nvt (default)
            fix_cmd = f"fix             1 all nvt temp {temperature} {temperature} 100.0"
            thermo_style = "step temp pe ke etotal press vol density"

        script_lines.extend([
            f"timestep        {timestep}",
            f"velocity        all create {temperature} 12345 dist gaussian",
            fix_cmd,
            "",
            f"thermo          {thermo_freq}",
            f"thermo_style    custom {thermo_style}",
            f"dump            1 all custom {dump_freq} trajectory.dump id type x y z vx vy vz",
            "",
            f"run             {steps}",
            "",
            "write_data      system_final.data",
        ])

    final_script = "\n".join(script_lines)
    files_to_write[f"{work_dir}/in.lammps"] = final_script
    await write_remote_files(hpc.conn, files_to_write)
    logger.info(f"[workflow] Wrote in.lammps + data files for {steps} steps MD run")


async def execute_lammps_local(
    workflow_id: str,
    step_id: str,
    node_type: str,
    params: dict[str, Any],
    edges: list[dict[str, Any]],
    step_results: dict[str, dict[str, Any]],
    config: Any,
    _broadcast_fn: Any,
    _get_parent_step_ids_fn: Any,
):
    """Run LAMMPS simulation locally (no HPC) using subprocess."""
    from catgo.models.workflow import StepStatus
    from catgo.utils.workflow_db import update_step
    import tempfile

    try:
        update_step(workflow_id, step_id, {"status": StepStatus.RUNNING.value})
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "running"
        })

        parent_ids = _get_parent_step_ids_fn(step_id, edges)
        input_structure_str = None
        for pid in parent_ids:
            parent_result = step_results.get(pid, {})
            if "contcar" in parent_result:
                input_structure_str = parent_result["contcar"]
                break
            if "structure_json" in parent_result:
                input_structure_str = parent_result["structure_json"]
                break
        if not input_structure_str:
            config_str = params.get("structure_json") or params.get("poscar")
            if config_str:
                input_structure_str = config_str

        from catgo.routers.lammps import (
            extract_structure_info,
            parse_lammps_data_info,
            PymatgenStructure,
        )

        custom_data_file = params.get("custom_data_file", "")

        # Check for embedded LAMMPS data file from frontend upload
        _lammps_raw = None
        if not custom_data_file and input_structure_str:
            try:
                struct_data = json.loads(input_structure_str) if isinstance(input_structure_str, str) else input_structure_str
                if isinstance(struct_data, dict) and "_lammps_data_raw" in struct_data:
                    _lammps_raw = struct_data["_lammps_data_raw"]
            except (json.JSONDecodeError, TypeError):
                pass

        config_local_dir = getattr(config, "local_work_dir", "") or ""
        if config_local_dir:
            local_work_dir = os.path.join(config_local_dir, f"{node_type}_{step_id[:8]}")
            os.makedirs(local_work_dir, exist_ok=True)
        else:
            local_work_dir = tempfile.mkdtemp(prefix=f"catgo_lammps_{step_id[:8]}_")

        from catgo.utils.workflow_db import update_step_work_dir
        update_step_work_dir(workflow_id, step_id, local_work_dir)

        if params.get("packmol_enabled") and node_type != "polymer_md":
            from catgo.workflow.engine.resolver import primary_structure_input

            wi = collect_packmol_workflow_inputs_local(step_id, edges, step_results)
            if input_structure_str and not wi.get("structure"):
                wi["structure"] = input_structure_str
            primary = primary_structure_input(wi.get("structure")) or input_structure_str
            input_structure_str = run_packmol_local(
                local_work_dir, params, primary, wi,
            )

        if node_type == "polymer_md":
            if not input_structure_str:
                raise RuntimeError(f"No input structure for polymer LAMMPS step {step_id}")
            struct = load_structure_for_lammps(input_structure_str)
            struct_dict = _structure_to_pymatgen_dict(struct)
            pymatgen_struct = PymatgenStructure(**struct_dict)

            from catgo.routers.lammps import (
                generate_polymer_workflow_script,
                generate_polymer_workflow_data_file,
                PolymerWorkflowRequest,
            )
            polymer_request = PolymerWorkflowRequest(
                structure=pymatgen_struct,
                prefix="polymer",
                pair_style=params.get("pair_style", "lj/cut 2.5"),
                pair_coeff=params.get("pair_coeff", "* * 1.0 1.0"),
                bond_style=params.get("bond_style", "fene"),
                bond_coeff=params.get("bond_coeff", "1 30.0 1.5 1.0 1.0"),
                workflow_mode=params.get("workflow_mode", "polymer_kg"),
                temperature=params.get("temperature", 300),
                pressure=params.get("pressure", 1.0),
                timestep=params.get("timestep", 0.001),
                gen_steps_nvt=params.get("gen_steps_nvt", 5000),
                gen_steps_npt=params.get("gen_steps_npt", 50000),
                equil_steps=params.get("equil_steps", 100000),
                prod_steps=params.get("prod_steps", 100000),
                prod_dump_freq=params.get("prod_dump_freq", 1000),
                units="lj" if params.get("workflow_mode") == "polymer_kg" else "real",
                atom_style="molecular",
            )
            info = extract_structure_info(pymatgen_struct)
            input_script, _stages = generate_polymer_workflow_script(polymer_request, info)
            data_file = generate_polymer_workflow_data_file(polymer_request, info)
            data_filename = "polymer.data"

        elif _lammps_raw or (custom_data_file and os.path.isfile(custom_data_file)):
            from catgo.routers.lammps import generate_input_script, LammpsInputRequest

            if _lammps_raw:
                data_content = _lammps_raw
                data_filename = "system.data"
            else:
                data_content = open(custom_data_file).read()
                data_filename = os.path.basename(custom_data_file)

            info = parse_lammps_data_info(data_content)

            ensemble = params.get("ensemble", "nvt")
            _is_min = ensemble.startswith("minimize_") or node_type in ("md_minimize", "lammps_minimize")
            sim_type = "minimize" if _is_min else {"nve": "nve", "nvt": "nvt", "npt": "npt"}.get(ensemble, "nvt")
            min_kw: dict[str, Any] = {}
            if _is_min:
                if node_type in ("md_minimize", "lammps_minimize"):
                    min_kw = {
                        "min_style": params.get("min_style", "cg"),
                        "etol": float(params.get("etol", 1e-6)),
                        "ftol": float(params.get("ftol", 1e-6)),
                        "maxiter": int(params.get("maxiter", 10000)),
                        "maxeval": int(params.get("maxeval", 100000)),
                    }
                else:
                    min_kw = {
                        "min_style": "sd" if ensemble == "minimize_sd" else "cg",
                        "etol": float(params.get("minimize_etol", 1e-6)),
                        "ftol": float(params.get("minimize_ftol", 1e-8)),
                        "maxiter": int(params.get("minimize_maxiter", 10000)),
                        "maxeval": int(params.get("minimize_maxeval", 100000)),
                    }

            lammps_request = LammpsInputRequest(
                structure=PymatgenStructure(lattice=None, sites=[]),
                prefix="system",
                units=params.get("units", "metal"),
                atom_style=params.get("atom_style", "atomic"),
                boundary="p p p",
                pair_style=params.get("pair_style", "lj/cut 2.5"),
                pair_coeff=params.get("pair_coeff", "* * 1.0 1.0"),
                simulation_type=sim_type,
                temperature=params.get("temperature", 300),
                timestep=params.get("timestep", 0.001),
                run_steps=params.get("steps", 10000),
                dump_freq=params.get("dump_freq", 100),
                thermo_freq=params.get("thermo_freq", params.get("dump_freq", 100)),
                custom_data_file=data_filename,
                bond_style=params.get("bond_style"),
                bond_coeff=params.get("bond_coeff"),
                angle_style=params.get("angle_style"),
                angle_coeff=params.get("angle_coeff"),
                dihedral_style=params.get("dihedral_style"),
                dihedral_coeff=params.get("dihedral_coeff"),
                improper_style=params.get("improper_style"),
                improper_coeff=params.get("improper_coeff"),
                kspace_style=params.get("kspace_style"),
                special_bonds=params.get("special_bonds"),
                extra_commands=params.get("extra_commands") or None,
                **min_kw,
            )
            input_script = generate_input_script(lammps_request, info)

            with open(os.path.join(local_work_dir, data_filename), "w") as f:
                f.write(data_content)
            data_file = None  # already written

        else:
            if not input_structure_str:
                raise RuntimeError(f"No input structure for local LAMMPS step {step_id}")
            from catgo.routers.lammps import (
                generate_data_file,
                generate_input_script,
                LammpsInputRequest,
            )
            struct = load_structure_for_lammps(input_structure_str)

            struct_dict = _structure_to_pymatgen_dict(struct)
            pymatgen_struct = PymatgenStructure(**struct_dict)

            ensemble2 = params.get("ensemble", "nvt")
            _is_min2 = ensemble2.startswith("minimize_") or node_type in ("md_minimize", "lammps_minimize")
            sim_type2 = "minimize" if _is_min2 else {"nve": "nve", "nvt": "nvt", "npt": "npt"}.get(ensemble2, "nvt")
            min_kw2: dict[str, Any] = {}
            if _is_min2:
                if node_type in ("md_minimize", "lammps_minimize"):
                    min_kw2 = {
                        "min_style": params.get("min_style", "cg"),
                        "etol": float(params.get("etol", 1e-6)),
                        "ftol": float(params.get("ftol", 1e-6)),
                        "maxiter": int(params.get("maxiter", 10000)),
                        "maxeval": int(params.get("maxeval", 100000)),
                    }
                else:
                    min_kw2 = {
                        "min_style": "sd" if ensemble2 == "minimize_sd" else "cg",
                        "etol": float(params.get("minimize_etol", 1e-6)),
                        "ftol": float(params.get("minimize_ftol", 1e-8)),
                        "maxiter": int(params.get("minimize_maxiter", 10000)),
                        "maxeval": int(params.get("minimize_maxeval", 100000)),
                    }

            lammps_request = LammpsInputRequest(
                structure=pymatgen_struct,
                prefix="system",
                units=params.get("units", "metal"),
                atom_style=params.get("atom_style", "atomic"),
                boundary="p p p",
                pair_style=params.get("pair_style", "lj/cut 2.5"),
                pair_coeff=params.get("pair_coeff", "* * 1.0 1.0"),
                simulation_type=sim_type2,
                temperature=params.get("temperature", 300),
                timestep=params.get("timestep", 0.001),
                run_steps=params.get("steps", 10000),
                dump_freq=params.get("dump_freq", 100),
                thermo_freq=params.get("thermo_freq", params.get("dump_freq", 100)),
                extra_commands=params.get("extra_commands") or None,
                **min_kw2,
            )
            info = extract_structure_info(pymatgen_struct)
            input_script = generate_input_script(lammps_request, info)
            data_file = generate_data_file(lammps_request, info)
            data_filename = "system.data"

        from catgo.routers.lammps import run_lammps_local

        lmp_cmd = params.get("lmp_command") or getattr(config, "lmp_command", "") or "lmp_serial"

        result = await run_lammps_local(
            input_script=input_script,
            data_file=data_file,
            potential_file=None,
            restart_file=None,
            lmp_command=lmp_cmd,
            work_dir=local_work_dir,
            write_restart=params.get("write_restart", True),
        )

        if result.get("exit_code", 1) != 0:
            error_msg = result.get("stderr", "LAMMPS local execution failed")
            update_step(workflow_id, step_id, {
                "status": StepStatus.FAILED.value,
                "error_message": error_msg[:2000],
            })
            await _broadcast_fn(workflow_id, {
                "type": "step_status", "step_id": step_id, "status": "failed"
            })
            return

        step_result = {"work_dir": local_work_dir}
        output_files = result.get("output_files", [])
        for f in output_files:
            if f.endswith(".dump"):
                step_result["trajectory"] = f
            elif f.endswith(".log"):
                step_result["log"] = f
            elif f.endswith(".restart"):
                step_result["restart"] = f
        step_results[step_id] = step_result

        update_step(workflow_id, step_id, {
            "status": StepStatus.COMPLETED.value,
            "result_json": json.dumps(step_result),
        })
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "completed"
        })

    except Exception as e:
        logger.exception("Local LAMMPS execution failed for step %s", step_id)
        from catgo.utils.workflow_db import update_step
        update_step(workflow_id, step_id, {
            "status": StepStatus.FAILED.value,
            "error_message": str(e)[:2000],
        })
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "failed"
        })
