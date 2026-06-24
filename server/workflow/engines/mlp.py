"""ML potential (CHGNet/MACE/M3GNet) input generation for workflow engine."""

import asyncio
import json
import logging
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any, Optional


logger = logging.getLogger(__name__)

__all__ = [
    "generate_mlp_input_files",
    "generate_mlp_inputs",
    "execute_mlp_local",
    "execute_mlp_local_batch",
]


def _resolve_device(params: dict[str, Any]) -> str:
    """Pick a device literal suitable for ASE calculators.

    Returns a Python *expression* (not a resolved string) that evaluates
    inside the generated script. Using an expression lets the script
    auto-detect CUDA availability at run-time (the machine that generates
    the script and the machine that runs it are not necessarily the same).

    Accepted param values: ``auto`` (default), ``cpu``, ``cuda``.
    """
    choice = str(params.get("device", "auto") or "auto").lower()
    if choice == "cpu":
        return '"cpu"'
    if choice in ("cuda", "gpu"):
        return '"cuda"'
    # auto — resolved inside the generated script
    return '"cuda" if __import__("torch").cuda.is_available() else "cpu"'


def _build_calculator_block(model: str, params: dict[str, Any] | None = None) -> str:
    """Return Python code block that sets up the ML calculator.

    The generated block binds these locals so the metadata footer can
    record what actually ran:
      - ``__mace_device``: resolved device string ("cpu" / "cuda")
      - ``__mace_model_name``: user-visible model name
      - ``__mace_model_path``: path to checkpoint file on disk (or "" if built-in)
    """
    params = params or {}
    mu = model.upper()
    device_expr = _resolve_device(params)
    model_path = str(params.get("model_path", "") or "").strip()

    if mu == "MACE" or mu.startswith("MACE-MP"):
        if model_path:
            # User-supplied fine-tuned checkpoint.
            lines = [
                "from mace.calculators import MACECalculator",
                f"__mace_device = {device_expr}",
                f"__mace_model_path = {model_path!r}",
                "__mace_model_name = __mace_model_path",
                "calc = MACECalculator(model_paths=[__mace_model_path], device=__mace_device, default_dtype=\"float64\")",
            ]
        else:
            # Default foundation model (mace-mp-0 medium).
            # __mace_model_path stays empty for the built-in foundation model
            # — mace_mp does not expose the cache file path and attempting to
            # introspect calc.models[0] dumps the torch module repr (~4 KB of
            # architecture) into metadata.json. The "mace_model" field is
            # sufficient provenance for the default model; users who care
            # about byte-exact reproducibility can pin a local checkpoint via
            # the model_path param, which IS hashed below.
            lines = [
                "from mace.calculators import mace_mp",
                f"__mace_device = {device_expr}",
                "__mace_model_name = \"mace-mp-0-medium\"",
                "__mace_model_path = \"\"",
                "calc = mace_mp(model=\"medium\", default_dtype=\"float64\", device=__mace_device)",
            ]
        return "\n".join(lines) + "\n"

    if mu in ("CHGNET", "M3GNET"):
        lines = [
            "from matgl.ext.ase import M3GNetCalculator",
            "import matgl",
            f"__mace_device = {device_expr}",
            f"__mace_model_name = {model!r}",
            "__mace_model_path = \"\"",
            f"pot = matgl.load_model({model!r})",
            "calc = M3GNetCalculator(pot)",
        ]
        return "\n".join(lines) + "\n"

    return f'raise RuntimeError("Unknown ML model: {model}")\n'


# Python code executed at the TOP of every generated MLP script. Starts a
# wall-clock timer and records context that doesn't require the calculator
# to be instantiated yet (torch version, hostname, timestamp).
_MLP_METADATA_PREAMBLE = '''\
import hashlib as __hashlib
import json as __json
import os as __os
import socket as __socket
import time as __time
from datetime import datetime as __datetime, timezone as __timezone

__t_start = __time.time()
__mace_metadata = {
    "timestamp": __datetime.now(__timezone.utc).isoformat(),
    "host": __socket.gethostname(),
    "pid": __os.getpid(),
}
try:
    import torch as __torch
    __mace_metadata["torch_version"] = __torch.__version__
    __mace_metadata["cuda_available"] = bool(__torch.cuda.is_available())
    if __torch.cuda.is_available():
        try:
            __mace_metadata["gpu_name"] = __torch.cuda.get_device_name(0)
        except Exception:
            __mace_metadata["gpu_name"] = None
except Exception:
    __mace_metadata["torch_version"] = None
try:
    import mace as __mace_pkg
    __mace_metadata["mace_torch_version"] = getattr(__mace_pkg, "__version__", None)
except Exception:
    __mace_metadata["mace_torch_version"] = None
'''

# Python code executed at the BOTTOM of every generated MLP script. Merges
# the calculator-resolved locals (__mace_device, __mace_model_name,
# __mace_model_path) with the preamble context and hashes the checkpoint
# file for reproducibility.
_MLP_METADATA_FOOTER = '''\
# --- metadata footer (C1 reproducibility plumbing) ---
try:
    __mace_metadata["mace_model"] = __mace_model_name
    __mace_metadata["device"] = __mace_device
    __mace_metadata["model_path"] = __mace_model_path
    if __mace_model_path and __os.path.isfile(__mace_model_path):
        __h = __hashlib.sha256()
        with open(__mace_model_path, "rb") as __mf:
            for __chunk in iter(lambda: __mf.read(65536), b""):
                __h.update(__chunk)
        __mace_metadata["model_sha256"] = __h.hexdigest()
    else:
        __mace_metadata["model_sha256"] = None
except NameError:
    # Calculator block didn't define the expected locals — still record what we have.
    pass
__mace_metadata["wall_time_s"] = round(__time.time() - __t_start, 3)
try:
    with open("metadata.json", "w") as __mf:
        __json.dump(__mace_metadata, __mf, indent=2, default=str)
except Exception as __exc:
    print(f"[metadata] failed to write metadata.json: {__exc}")
'''


def _build_optimizer_block(optimizer: str, target_var: str, fmax: float, max_steps: int) -> str:
    """Return Python code that sets up and runs the ASE optimizer."""
    supported = {"LBFGS", "BFGS", "FIRE"}
    opt_cls = optimizer.upper()
    if opt_cls not in supported:
        raise ValueError(f"Unknown optimizer '{optimizer}'. Supported: {sorted(supported)}")
    return (
        f'from ase.optimize import {opt_cls}\n'
        f'opt = {opt_cls}({target_var}, trajectory="opt.traj", logfile="opt.log")\n'
        f'opt.run(fmax={fmax}, steps={max_steps})\n'
    )


def _build_vibration_indices_block(params: dict[str, Any]) -> str:
    """Return Python code block that computes vibration indices from freeze params.

    The generated code sets a variable ``indices`` to either ``None`` (all atoms)
    or a ``list[int]`` of atom indices to displace.
    """
    freeze_mode = params.get("freeze_mode", "none")

    if freeze_mode == "none":
        return "indices = None  # vibrate all atoms"

    freeze_invert = bool(params.get("freeze_invert", False))
    freeze_indices = params.get("freeze_indices", "")
    freeze_elements = params.get("freeze_elements", "")
    freeze_z_below = params.get("freeze_z_below", 0)
    freeze_layers = params.get("freeze_layers", 0)

    lines = [
        "# Determine which atoms to vibrate based on freeze settings",
        f"freeze_mode = {freeze_mode!r}",
        f"freeze_invert = {freeze_invert!r}",
        "frozen = set()",
    ]

    if freeze_mode in ("indices", "manual"):
        lines.append(f"_idx_str = {freeze_indices!r}")
        lines.append("for part in _idx_str.split(','):")
        lines.append("    part = part.strip()")
        lines.append("    if not part: continue")
        lines.append("    if '-' in part:")
        lines.append("        a, b = part.split('-', 1)")
        lines.append("        frozen.update(range(int(a), int(b)+1))")
        lines.append("    else:")
        lines.append("        frozen.add(int(part))")
    elif freeze_mode == "element":
        lines.append(f"_raw_elems = {freeze_elements!r}.split(',')")
        lines.append("_elems = set()")
        lines.append("for _e in _raw_elems:")
        lines.append("    _e = _e.strip()")
        lines.append("    if _e: _elems.add(_e)")
        lines.append("for i, sym in enumerate(atoms.get_chemical_symbols()):")
        lines.append("    if sym in _elems:")
        lines.append("        frozen.add(i)")
    elif freeze_mode == "z_range":
        lines.append(f"_z_cut = {float(freeze_z_below)}")
        lines.append("for i, pos in enumerate(atoms.positions):")
        lines.append("    if pos[2] < _z_cut:")
        lines.append("        frozen.add(i)")
    elif freeze_mode == "layers":
        lines.append(f"_n_layers = {int(freeze_layers)}")
        lines.append("_zs = sorted(set(round(p[2], 2) for p in atoms.positions))")
        lines.append("_frozen_zs = set(_zs[:_n_layers])")
        lines.append("for i, pos in enumerate(atoms.positions):")
        lines.append("    if round(pos[2], 2) in _frozen_zs:")
        lines.append("        frozen.add(i)")

    lines.append("all_idx = set(range(len(atoms)))")
    lines.append("if freeze_invert:")
    lines.append("    _idx_list = sorted(frozen) if frozen else None")
    lines.append("else:")
    lines.append("    _idx_list = sorted(all_idx - frozen) if frozen else None")
    lines.append("# Convert to int list for ASE (empty list → None to vibrate all)")
    lines.append("if _idx_list is not None and len(_idx_list) == 0:")
    lines.append("    indices = None  # no atoms selected → vibrate all")
    lines.append("elif _idx_list is not None:")
    lines.append("    indices = [int(i) for i in _idx_list]")
    lines.append("else:")
    lines.append("    indices = None")

    return "\n".join(lines)


def generate_mlp_input_files(
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
) -> dict[str, str]:
    """Pure function: return {filename: content} for MLP calculation."""
    model = params.get("model", "MACE")
    calc_block = _build_calculator_block(model, params)
    meta_preamble = _MLP_METADATA_PREAMBLE
    meta_footer = _MLP_METADATA_FOOTER

    if node_type == "mlp_relax":
        fmax = params.get("fmax", 0.01)
        max_steps = params.get("max_steps", 500)
        relax_cell = params.get("relax_cell", False)
        optimizer = params.get("mlp_optimizer") or params.get("optimizer", "BFGS")
        opt_block = _build_optimizer_block(optimizer, "target" if relax_cell else "atoms", fmax, max_steps)

        cell_filter_block = ""
        if relax_cell:
            cell_filter_block = (
                "from ase.filters import ExpCellFilter\n"
                "target = ExpCellFilter(atoms)\n"
            )

        script = f'''#!/usr/bin/env python3
"""ML potential relaxation generated by CatGo workflow engine."""
{meta_preamble}
from ase.io import read, write

atoms = read("POSCAR", format="vasp")

{calc_block}
atoms.calc = calc
{cell_filter_block}
{opt_block}

write("CONTCAR", atoms, format="vasp")
print(f"Final energy: {{atoms.get_potential_energy():.6f}} eV")
{meta_footer}'''
    elif node_type == "mlp_md":
        temp = params.get("temp", 300)
        steps = params.get("steps", 10000)
        timestep = params.get("timestep", 1.0)
        script = f'''#!/usr/bin/env python3
"""ML potential MD generated by CatGo workflow engine."""
{meta_preamble}
from ase.io import read, write
from ase.md.langevin import Langevin
from ase import units

atoms = read("POSCAR", format="vasp")

{calc_block}
atoms.calc = calc

dyn = Langevin(atoms, timestep={timestep}*units.fs, temperature_K={temp}, friction=0.01)

def write_frame(a=atoms):
    write("trajectory.xyz", a, format="extxyz", append=True)

dyn.attach(write_frame, interval=10)
dyn.run({steps})

write("CONTCAR", atoms, format="vasp")
{meta_footer}'''
    elif node_type == "mlp_single_point":
        script = f'''#!/usr/bin/env python3
"""ML potential single-point energy generated by CatGo workflow engine."""
{meta_preamble}
import json
import numpy as np
from ase.io import read, write

atoms = read("POSCAR", format="vasp")

{calc_block}
atoms.calc = calc

energy = atoms.get_potential_energy()
forces = atoms.get_forces()
max_force = float(np.max(np.linalg.norm(forces, axis=1)))

result = {{
    "energy_ev": energy,
    "max_force_ev_ang": max_force,
    "n_atoms": len(atoms),
}}
with open("single_point.json", "w") as fp:
    json.dump(result, fp, indent=2)

write("CONTCAR", atoms, format="vasp")
print(f"Final energy: {{energy:.6f}} eV")
print(f"Max force: {{max_force:.6f}} eV/A")
{meta_footer}'''
    elif node_type == "mlp_vibrations":
        delta = params.get("delta", 0.01)
        nfree = params.get("nfree", 2)
        indices_block = _build_vibration_indices_block(params)

        script = f'''#!/usr/bin/env python3
"""ML potential vibrations generated by CatGo workflow engine."""
{meta_preamble}
import json
import numpy as np
from ase.io import read, write
from ase.vibrations import Vibrations

atoms = read("POSCAR", format="vasp")

{calc_block}
atoms.calc = calc

{indices_block}

vib = Vibrations(atoms, indices=indices, delta={delta}, nfree={nfree}, name="vib")
vib.clean()  # remove stale cache from any previous run
vib.run()

# Convert complex frequencies to real list (negative = imaginary)
raw_freqs = vib.get_frequencies()
freq_list = []
for f in raw_freqs:
    if abs(f.imag) > abs(f.real):
        freq_list.append(-abs(f.imag))
    else:
        freq_list.append(float(f.real))

zpe = float(vib.get_zero_point_energy())

# Transition-state validation (C2): a valid TS has exactly ONE imaginary
# mode with |freq| above a trivial-mode threshold (rotations/translations
# of loose adsorbates show up as tiny negatives around a few cm^-1).
imag_modes = [float(f) for f in freq_list if f < 0]
imag_modes.sort()  # most-negative first
dominant_imag = imag_modes[0] if imag_modes else None
# Filter trivial near-zero imaginary modes (< 20 cm^-1 in magnitude).
nontrivial_imag = [f for f in imag_modes if abs(f) >= 20.0]
is_valid_ts = len(nontrivial_imag) == 1

result = {{
    "frequencies_cm": freq_list,
    "zpe_ev": zpe,
    "n_atoms_displaced": len(indices) if indices is not None else len(atoms),
    "n_frequencies": len(freq_list),
    "imag_modes_cm": imag_modes,
    "dominant_imag_freq_cm": dominant_imag,
    "is_valid_ts": is_valid_ts,
    "n_nontrivial_imag": len(nontrivial_imag),
}}
with open("frequencies.json", "w") as fp:
    json.dump(result, fp, indent=2)

vib.summary()
print(f"ZPE: {{zpe:.6f}} eV")

write("CONTCAR", atoms, format="vasp")
print(f"Final energy: {{atoms.get_potential_energy():.6f}} eV")
{meta_footer}'''
    elif node_type == "mlp_neb":
        n_images = params.get("nimages", 8)
        fmax = params.get("fmax", 0.05)
        max_steps = params.get("max_steps", 500)
        climb = params.get("climb", True)
        optimizer = params.get("mlp_optimizer") or params.get("optimizer", "FIRE")
        # Indent calc_block for use inside make_calc() function body
        calc_block_indented = "\n".join(
            "    " + line for line in calc_block.strip().splitlines()
        )

        script = f'''#!/usr/bin/env python3
"""ML potential NEB generated by CatGo workflow engine."""
{meta_preamble}
import json
import numpy as np
from ase.io import read, write
try:
    from ase.mep import DyNEB
except ImportError:
    from ase.neb import DyNEB
from ase.optimize import {optimizer}

initial = read("POSCAR_initial", format="vasp")
final = read("POSCAR_final", format="vasp")

# Module-level metadata bindings (populated by first make_calc call below).
__mace_device = ""
__mace_model_name = ""
__mace_model_path = ""

# Each NEB image needs its own calculator instance
def make_calc():
    global __mace_device, __mace_model_name, __mace_model_path
{calc_block_indented}
    return calc

initial.calc = make_calc()
final.calc = make_calc()

images = [initial]
for _ in range({n_images}):
    img = initial.copy()
    img.calc = make_calc()
    images.append(img)
images.append(final)

neb = DyNEB(images, climb={climb}, fmax={fmax})
neb.interpolate("idpp", mic=True)

opt = {optimizer}(neb, trajectory="neb.traj", logfile="neb.log")
opt.run(fmax={fmax}, steps={max_steps})
converged = opt.nsteps < {max_steps}

energies = [float(img.get_potential_energy()) for img in images]
e_ref = energies[0]
ts_idx = int(np.argmax(energies))
barrier_ev = energies[ts_idx] - e_ref
barrier_kcal = barrier_ev * 23.0609

path_images = []
for i, e in enumerate(energies):
    de = (e - e_ref) * 23.0609
    entry = {{"image": str(i), "de_kcal_mol": round(de, 4)}}
    if i == ts_idx:
        entry["is_ts"] = True
        entry["image"] = "TS"
    path_images.append(entry)

ts_atoms = images[ts_idx]
write("CONTCAR", ts_atoms, format="vasp")
write("ts_structure.xyz", ts_atoms, format="extxyz")

result = {{
    "neb_converged": bool(converged),
    "activation_barrier_kcal_mol": round(barrier_kcal, 4),
    "path_summary": {{"images": path_images}},
    "energies_ev": [round(e, 6) for e in energies],
    "energy": round(energies[ts_idx], 6),
}}
with open("neb_results.json", "w") as fp:
    json.dump(result, fp, indent=2)

print(f"Final energy: {{energies[ts_idx]:.6f}} eV")
print(f"Barrier: {{barrier_kcal:.2f}} kcal/mol")
print(f"NEB converged: {{converged}}")
{meta_footer}'''
    else:
        raise RuntimeError(f"Unknown MLP node type: {node_type}")

    # NEB uses two POSCAR files instead of one
    if node_type == "mlp_neb":
        files = {"run_mlp.py": script}
        from workflow.engines import ensure_poscar
        if structure_str:
            try:
                files["POSCAR_initial"] = ensure_poscar(structure_str)
            except Exception:
                files["POSCAR_initial"] = structure_str
        product_str = params.get("_product_structure")
        if product_str:
            try:
                files["POSCAR_final"] = ensure_poscar(product_str)
            except Exception:
                files["POSCAR_final"] = product_str
        return files

    files = {"run_mlp.py": script}
    if structure_str:
        from workflow.engines import ensure_poscar
        try:
            files["POSCAR"] = ensure_poscar(structure_str)
        except Exception:
            files["POSCAR"] = structure_str
    return files


async def generate_mlp_inputs(
    hpc: Any,
    work_dir: str,
    node_type: str,
    params: dict[str, Any],
    structure_str: Optional[str],
):
    """Generate MLP input files and upload to HPC."""
    from catgo.utils.job_parser import write_remote_files
    files = generate_mlp_input_files(node_type, params, structure_str)
    await write_remote_files(hpc.conn, {f"{work_dir}/{k}": v for k, v in files.items()})


async def execute_mlp_local(
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
    """Run MLP (MACE/CHGNet/M3GNet) locally via subprocess."""
    from catgo.models.workflow import StepStatus
    from catgo.utils.workflow_db import update_step

    def _safe_update_step(wf_id: str, s_id: str, data: dict) -> None:
        """Update V1 workflow_steps table, ignoring KeyError for V2-only tasks."""
        try:
            update_step(wf_id, s_id, data)
        except KeyError:
            pass  # V2 engine tasks don't exist in V1 table — scanner handles status

    try:
        now = datetime.now(timezone.utc).isoformat()
        _safe_update_step(workflow_id, step_id, {
            "status": StepStatus.RUNNING.value,
            "started_at": now,
        })
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "running"
        })

        # Get input structure from parent nodes
        parent_ids = _get_parent_step_ids_fn(step_id, edges)
        input_structure_str = None
        for pid in parent_ids:
            parent_result = step_results.get(pid, {})
            if parent_result.get("contcar"):
                input_structure_str = parent_result["contcar"]
                break
            if parent_result.get("structure_json"):
                input_structure_str = parent_result["structure_json"]
                break
            if parent_result.get("structure"):
                input_structure_str = parent_result["structure"]
                break
            # Fan-out parent (loop / doping_gen / batch_slab_gen) that produced
            # only a `structures` list and no scalar: fall back to the first
            # structure so a single-structure step still runs instead of raising.
            structs = parent_result.get("structures")
            if structs:
                first = structs[0]
                input_structure_str = json.dumps(first) if isinstance(first, dict) else first
                break
        if not input_structure_str:
            config_str = params.get("structure_json") or params.get("poscar")
            if config_str:
                input_structure_str = config_str

        if not input_structure_str:
            raise RuntimeError(f"No input structure for MLP step {step_id}")

        # Convert structure to POSCAR if needed
        from workflow.engines import ensure_poscar
        try:
            # If input is a dict (pymatgen structure dict), convert to JSON string first
            if isinstance(input_structure_str, dict):
                import json as _json
                input_structure_str = _json.dumps(input_structure_str)
            poscar_str = ensure_poscar(input_structure_str)
        except Exception:
            poscar_str = input_structure_str

        # For NEB: resolve reactant + product structures. Positional ordering
        # (parent_ids[0]=reactant, [1]=product) is ambiguous — SQLite doesn't
        # guarantee edge iteration order, and users building NEB graphs by
        # hand have no way to know which parent is "first". Prefer explicit
        # params.initial_step_id / params.final_step_id when set; fall back
        # to positional otherwise and log the choice so debug output shows
        # which parent was treated as which endpoint.
        product_poscar_str = None
        initial_pid = parent_ids[0] if parent_ids else None
        final_pid = parent_ids[1] if len(parent_ids) >= 2 else None
        if node_type == "mlp_neb":
            explicit_initial = params.get("initial_step_id")
            explicit_final = params.get("final_step_id")
            if explicit_initial and explicit_initial in parent_ids:
                initial_pid = explicit_initial
            if explicit_final and explicit_final in parent_ids:
                final_pid = explicit_final
            if initial_pid == final_pid:
                raise RuntimeError(
                    "NEB initial and final structures are the same step. "
                    "Set distinct initial_step_id / final_step_id params "
                    "on the TS Search node."
                )
            if initial_pid:
                reactant_result = step_results.get(initial_pid, {})
                reactant_str = (
                    reactant_result.get("contcar")
                    or reactant_result.get("structure_json")
                    or reactant_result.get("structure")
                )
                if reactant_str:
                    if isinstance(reactant_str, dict):
                        reactant_str = json.dumps(reactant_str)
                    try:
                        poscar_str = ensure_poscar(reactant_str)
                    except Exception:
                        poscar_str = reactant_str
            if final_pid:
                product_result = step_results.get(final_pid, {})
                product_str = (
                    product_result.get("contcar")
                    or product_result.get("structure_json")
                    or product_result.get("structure")
                )
                if product_str:
                    if isinstance(product_str, dict):
                        product_str = json.dumps(product_str)
                    try:
                        product_poscar_str = ensure_poscar(product_str)
                    except Exception:
                        product_poscar_str = product_str
            if not product_poscar_str:
                raise RuntimeError(
                    "NEB requires two input structures (reactant + product). "
                    "Connect two parent nodes to the TS Search node."
                )
            logger.info(
                "NEB endpoints: initial=%s, final=%s (explicit=%s)",
                initial_pid, final_pid,
                bool(explicit_initial and explicit_final),
            )

        # Create local work directory
        config_local_dir = getattr(config, "local_work_dir", "") or ""
        if config_local_dir:
            local_work_dir = os.path.join(config_local_dir, f"{node_type}_{step_id[:8]}")
            os.makedirs(local_work_dir, exist_ok=True)
        else:
            local_work_dir = tempfile.mkdtemp(prefix=f"catgo_mlp_{step_id[:8]}_")

        # Persist work_dir to BOTH V1 (workflow_steps table) and V2
        # (tasks table via workflow_engine._db). The scanner previously
        # wrote work_dir to V2 only at COMPLETED status, which left the
        # UI (which polls `work_dir` during `running`) without a path to
        # the opt.log / neb.log. Also re-runs of the same step would
        # leave stale values from the previous attempt's tempdir, making
        # live progress polling silently read from a dead directory.
        from catgo.utils.workflow_db import update_step_work_dir
        try:
            await asyncio.to_thread(update_step_work_dir, workflow_id, step_id, local_work_dir)
        except KeyError:
            pass  # V1 row doesn't exist for V2-native workflows
        try:
            from catgo.routers.workflow_engine import _db as _engine_db
            if _engine_db is not None:
                # update_task is a synchronous SQLite write that takes
                # self._lock. Running it directly on the event loop can
                # block up to busy_timeout=5s under contention with the
                # scanner thread. Offload to a worker so the async
                # scanner callers don't stall.
                await asyncio.to_thread(_engine_db.update_task, step_id, work_dir=local_work_dir)
        except Exception:
            # V2 write failures are user-visible — they leave the step's
            # work_dir pointing at the previous attempt's tempdir, which
            # then gets served as "live" data by the mlp-progress endpoint.
            # Logging at WARNING so it surfaces in uvicorn's default INFO+
            # stream, not buried at DEBUG.
            logger.warning(
                "V2 engine DB sync failed for step %s work_dir=%s — live "
                "progress polling may read stale data. Details follow.",
                step_id, local_work_dir, exc_info=True,
            )

        # Write structure file(s)
        if node_type == "mlp_neb":
            with open(os.path.join(local_work_dir, "POSCAR_initial"), "w") as f:
                f.write(poscar_str)
            with open(os.path.join(local_work_dir, "POSCAR_final"), "w") as f:
                f.write(product_poscar_str)
        else:
            poscar_path = os.path.join(local_work_dir, "POSCAR")
            with open(poscar_path, "w") as f:
                f.write(poscar_str)

        # Build the MLP Python script
        model = params.get("model", "MACE")
        script = _build_mlp_script(node_type, model, params)

        script_path = os.path.join(local_work_dir, "run_mlp.py")
        with open(script_path, "w") as f:
            f.write(script)

        logger.info(
            "Running MLP %s locally in %s (model=%s, python=%s)",
            node_type, local_work_dir, model, sys.executable,
        )

        # Run the script
        proc = await asyncio.create_subprocess_exec(
            sys.executable, script_path,
            cwd=local_work_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, stderr_bytes = await proc.communicate()
        stdout_str = stdout_bytes.decode("utf-8", errors="replace")
        stderr_str = stderr_bytes.decode("utf-8", errors="replace")

        if proc.returncode != 0:
            logger.error(
                "MLP %s FAILED (exit %d) in %s\nSTDERR:\n%s\nSTDOUT:\n%s",
                node_type, proc.returncode, local_work_dir,
                stderr_str[:3000], stdout_str[:1000],
            )
            error_msg = stderr_str or stdout_str or f"MLP exited with code {proc.returncode}"
            # Provide actionable error for common import failures
            if "ModuleNotFoundError" in error_msg or "No module named" in error_msg:
                if "mace" in error_msg:
                    error_msg = (
                        f"MACE is not installed in this Python environment ({sys.executable}). "
                        f"Install with: pip install mace-torch\n\n"
                        f"Or switch to HPC Cluster mode in Run Config to run on a remote cluster "
                        f"where MACE is installed.\n\nOriginal error: {error_msg[:500]}"
                    )
                elif "chgnet" in error_msg or "matgl" in error_msg:
                    error_msg = (
                        f"ML potential package not installed locally. "
                        f"Install the required package, or switch to HPC Cluster mode.\n\n"
                        f"Original error: {error_msg[:500]}"
                    )
            raise RuntimeError(error_msg[:2000])

        logger.info("MLP %s completed successfully", node_type)

        # Parse energy from stdout
        energy = None
        for line in stdout_str.splitlines():
            if "Final energy:" in line:
                try:
                    energy = float(line.split("Final energy:")[1].strip().split()[0])
                except (ValueError, IndexError):
                    pass

        # Read output structure (CONTCAR)
        contcar_path = os.path.join(local_work_dir, "CONTCAR")
        contcar_str = ""
        if os.path.isfile(contcar_path):
            with open(contcar_path, "r") as f:
                contcar_str = f.read()

        result_data: dict[str, Any] = {
            "node_type": node_type,
            "contcar": contcar_str,
            "stdout": stdout_str[-2000:],
            "work_dir": local_work_dir,
        }
        if energy is not None:
            result_data["energy"] = energy

        # Reproducibility metadata — every MLP script now writes metadata.json
        # on exit containing mace-torch version, torch version, model name,
        # model checkpoint SHA256, device (cpu/cuda), host, wall time, etc.
        # See _MLP_METADATA_PREAMBLE / _MLP_METADATA_FOOTER in this module.
        metadata_path = os.path.join(local_work_dir, "metadata.json")
        if os.path.isfile(metadata_path):
            try:
                with open(metadata_path, "r") as f:
                    result_data["metadata"] = json.load(f)
            except Exception as exc:
                logger.warning("Failed to parse metadata.json for step %s: %s", step_id, exc)

        # Parse single-point results from single_point.json
        if node_type == "mlp_single_point":
            sp_json_path = os.path.join(local_work_dir, "single_point.json")
            if os.path.isfile(sp_json_path):
                with open(sp_json_path, "r") as f:
                    sp_data = json.load(f)
                result_data["max_force"] = sp_data.get("max_force_ev_ang")
                result_data["n_atoms"] = sp_data.get("n_atoms")

        # Parse vibration results from frequencies.json
        if node_type == "mlp_vibrations":
            freq_json_path = os.path.join(local_work_dir, "frequencies.json")
            if os.path.isfile(freq_json_path):
                with open(freq_json_path, "r") as f:
                    freq_data = json.load(f)
                raw_freqs = freq_data.get("frequencies_cm", [])
                result_data["frequencies"] = raw_freqs
                result_data["zpe"] = freq_data.get("zpe_ev")
                result_data["n_frequencies"] = freq_data.get("n_frequencies")
                result_data["n_imag_freqs"] = sum(1 for f in raw_freqs if f < 0)
                result_data["n_real_freqs"] = sum(1 for f in raw_freqs if f >= 0)
                # C2: TS validation fields written by the script
                if "imag_modes_cm" in freq_data:
                    result_data["imag_modes_cm"] = freq_data["imag_modes_cm"]
                if "dominant_imag_freq_cm" in freq_data:
                    result_data["dominant_imag_freq_cm"] = freq_data["dominant_imag_freq_cm"]
                if "is_valid_ts" in freq_data:
                    result_data["is_valid_ts"] = freq_data["is_valid_ts"]
                if "n_nontrivial_imag" in freq_data:
                    result_data["n_nontrivial_imag"] = freq_data["n_nontrivial_imag"]

        # Parse NEB results from neb_results.json
        if node_type == "mlp_neb":
            neb_json_path = os.path.join(local_work_dir, "neb_results.json")
            if os.path.isfile(neb_json_path):
                with open(neb_json_path, "r") as f:
                    neb_data = json.load(f)
                result_data["neb_converged"] = neb_data.get("neb_converged", False)
                result_data["activation_barrier_kcal_mol"] = neb_data.get("activation_barrier_kcal_mol")
                result_data["path_summary"] = neb_data.get("path_summary")
                result_data["energies_ev"] = neb_data.get("energies_ev")
                if neb_data.get("energy") is not None:
                    result_data["energy"] = neb_data["energy"]
                # Use TS structure as contcar for downstream
                contcar_path_ts = os.path.join(local_work_dir, "CONTCAR")
                if os.path.isfile(contcar_path_ts):
                    with open(contcar_path_ts, "r") as f:
                        result_data["contcar"] = f.read()

        step_results[step_id] = result_data
        _safe_update_step(workflow_id, step_id, {
            "status": StepStatus.COMPLETED.value,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "result_json": json.dumps(result_data),
            "error_message": None,
        })
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "completed",
            "result": result_data,
        })

    except Exception as exc:
        logger.exception("MLP local execution failed for step %s", step_id)
        _safe_update_step(workflow_id, step_id, {
            "status": StepStatus.FAILED.value,
            "error_message": str(exc)[:500],
        })
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "failed",
            "error": str(exc)[:500],
        })


def _calc_import_lines(model: str, params: dict[str, Any] | None = None) -> str:
    """Return calculator import/setup lines for the given model.

    Delegates to ``_build_calculator_block`` so the local and HPC paths
    emit identical calculator setup — including the metadata bindings
    (``__mace_device``, ``__mace_model_name``, ``__mace_model_path``)
    that the metadata footer depends on.
    """
    return _build_calculator_block(model, params or {})


def _build_mlp_script(node_type: str, model: str, params: dict[str, Any]) -> str:
    """Build a standalone Python script for MLP execution."""
    calc_lines = _calc_import_lines(model, params)
    meta_preamble = _MLP_METADATA_PREAMBLE
    meta_footer = _MLP_METADATA_FOOTER

    if node_type == "mlp_relax":
        fmax = params.get("fmax", 0.01)
        max_steps = params.get("max_steps", 500)
        relax_cell = params.get("relax_cell", False)
        optimizer = params.get("mlp_optimizer") or params.get("optimizer", "BFGS")
        opt_block = _build_optimizer_block(optimizer, "target" if relax_cell else "atoms", fmax, max_steps)

        cell_filter_block = ""
        if relax_cell:
            cell_filter_block = (
                "from ase.filters import ExpCellFilter\n"
                "target = ExpCellFilter(atoms)\n"
            )

        return f"""#!/usr/bin/env python3
\"\"\"ML potential relaxation (local execution).\"\"\"
{meta_preamble}
from ase.io import read, write

atoms = read("POSCAR", format="vasp")

{calc_lines}
atoms.calc = calc
{cell_filter_block}
{opt_block}

write("CONTCAR", atoms, format="vasp")
print(f"Final energy: {{atoms.get_potential_energy():.6f}} eV")
{meta_footer}"""
    elif node_type == "mlp_md":
        temp = params.get("temp", 300)
        steps = params.get("steps", 10000)
        timestep = params.get("timestep", 1.0)
        return f"""#!/usr/bin/env python3
\"\"\"ML potential MD (local execution).\"\"\"
{meta_preamble}
from ase.io import read, write
from ase.md.langevin import Langevin
from ase import units

atoms = read("POSCAR", format="vasp")

{calc_lines}
atoms.calc = calc

dyn = Langevin(atoms, timestep={timestep}*units.fs, temperature_K={temp}, friction=0.01)

def write_frame(a=atoms):
    write("trajectory.xyz", a, format="extxyz", append=True)

dyn.attach(write_frame, interval=10)
dyn.run({steps})

write("CONTCAR", atoms, format="vasp")
print(f"Final energy: {{atoms.get_potential_energy():.6f}} eV")
{meta_footer}"""
    elif node_type == "mlp_single_point":
        return f"""#!/usr/bin/env python3
\"\"\"ML potential single-point energy (local execution).\"\"\"
{meta_preamble}
import json
import numpy as np
from ase.io import read, write

atoms = read("POSCAR", format="vasp")

{calc_lines}
atoms.calc = calc

energy = atoms.get_potential_energy()
forces = atoms.get_forces()
max_force = float(np.max(np.linalg.norm(forces, axis=1)))

result = {{
    "energy_ev": energy,
    "max_force_ev_ang": max_force,
    "n_atoms": len(atoms),
}}
with open("single_point.json", "w") as fp:
    json.dump(result, fp, indent=2)

write("CONTCAR", atoms, format="vasp")
print(f"Final energy: {{energy:.6f}} eV")
print(f"Max force: {{max_force:.6f}} eV/A")
{meta_footer}"""
    elif node_type == "mlp_vibrations":
        delta = params.get("delta", 0.01)
        nfree = params.get("nfree", 2)
        indices_block = _build_vibration_indices_block(params)

        return f"""#!/usr/bin/env python3
\"\"\"ML potential vibrations (local execution).\"\"\"
{meta_preamble}
import json
import numpy as np
from ase.io import read, write
from ase.vibrations import Vibrations

atoms = read("POSCAR", format="vasp")

{calc_lines}
atoms.calc = calc

{indices_block}

vib = Vibrations(atoms, indices=indices, delta={delta}, nfree={nfree}, name="vib")
vib.clean()  # remove stale cache from any previous run
vib.run()

# Convert complex frequencies to real list (negative = imaginary)
raw_freqs = vib.get_frequencies()
freq_list = []
for f in raw_freqs:
    if abs(f.imag) > abs(f.real):
        freq_list.append(-abs(f.imag))
    else:
        freq_list.append(float(f.real))

zpe = float(vib.get_zero_point_energy())

# Transition-state validation (C2): a valid TS has exactly ONE imaginary
# mode with |freq| above a trivial-mode threshold (rotations/translations
# of loose adsorbates show up as tiny negatives around a few cm^-1).
imag_modes = [float(f) for f in freq_list if f < 0]
imag_modes.sort()
dominant_imag = imag_modes[0] if imag_modes else None
nontrivial_imag = [f for f in imag_modes if abs(f) >= 20.0]
is_valid_ts = len(nontrivial_imag) == 1

result = {{
    "frequencies_cm": freq_list,
    "zpe_ev": zpe,
    "n_atoms_displaced": len(indices) if indices is not None else len(atoms),
    "n_frequencies": len(freq_list),
    "imag_modes_cm": imag_modes,
    "dominant_imag_freq_cm": dominant_imag,
    "is_valid_ts": is_valid_ts,
    "n_nontrivial_imag": len(nontrivial_imag),
}}
with open("frequencies.json", "w") as fp:
    json.dump(result, fp, indent=2)

vib.summary()
print(f"ZPE: {{zpe:.6f}} eV")

write("CONTCAR", atoms, format="vasp")
print(f"Final energy: {{atoms.get_potential_energy():.6f}} eV")
{meta_footer}"""
    elif node_type == "mlp_neb":
        n_images = params.get("nimages", 8)
        fmax = params.get("fmax", 0.05)
        max_steps = params.get("max_steps", 500)
        climb = params.get("climb", True)
        optimizer = params.get("mlp_optimizer") or params.get("optimizer", "FIRE")

        # Indent calc_lines for use inside make_calc() function body
        calc_lines_indented = "\n".join(
            "    " + line for line in calc_lines.strip().splitlines()
        )

        return f"""#!/usr/bin/env python3
\"\"\"ML potential NEB (local execution).\"\"\"
{meta_preamble}
import json
import numpy as np
from ase.io import read, write
try:
    from ase.mep import DyNEB
except ImportError:
    from ase.neb import DyNEB
from ase.optimize import {optimizer}

initial = read("POSCAR_initial", format="vasp")
final = read("POSCAR_final", format="vasp")

# Module-level metadata bindings (populated by first make_calc() call).
__mace_device = ""
__mace_model_name = ""
__mace_model_path = ""

def make_calc():
    global __mace_device, __mace_model_name, __mace_model_path
{calc_lines_indented}
    return calc

initial.calc = make_calc()
final.calc = make_calc()

images = [initial]
for _ in range({n_images}):
    img = initial.copy()
    img.calc = make_calc()
    images.append(img)
images.append(final)

neb = DyNEB(images, climb={climb}, fmax={fmax})
neb.interpolate("idpp", mic=True)

opt = {optimizer}(neb, trajectory="neb.traj", logfile="neb.log")
opt.run(fmax={fmax}, steps={max_steps})
converged = opt.nsteps < {max_steps}

energies = [float(img.get_potential_energy()) for img in images]
e_ref = energies[0]
ts_idx = int(np.argmax(energies))
barrier_ev = energies[ts_idx] - e_ref
barrier_kcal = barrier_ev * 23.0609

path_images = []
for i, e in enumerate(energies):
    de = (e - e_ref) * 23.0609
    entry = {{"image": str(i), "de_kcal_mol": round(de, 4)}}
    if i == ts_idx:
        entry["is_ts"] = True
        entry["image"] = "TS"
    path_images.append(entry)

ts_atoms = images[ts_idx]
write("CONTCAR", ts_atoms, format="vasp")
write("ts_structure.xyz", ts_atoms, format="extxyz")

result = {{
    "neb_converged": bool(converged),
    "activation_barrier_kcal_mol": round(barrier_kcal, 4),
    "path_summary": {{"images": path_images}},
    "energies_ev": [round(e, 6) for e in energies],
    "energy": round(energies[ts_idx], 6),
}}
with open("neb_results.json", "w") as fp:
    json.dump(result, fp, indent=2)

print(f"Final energy: {{energies[ts_idx]:.6f}} eV")
print(f"Barrier: {{barrier_kcal:.2f}} kcal/mol")
print(f"NEB converged: {{converged}}")
{meta_footer}"""
    else:
        raise ValueError(f"Unknown MLP node type: {node_type}")


async def execute_mlp_local_batch(
    workflow_id: str,
    step_id: str,
    node_type: str,
    params: dict[str, Any],
    structures: list,
    labels: list[str],
    step_results: dict[str, dict[str, Any]],
    config: Any,
    _broadcast_fn: Any,
):
    """Run MLP locally on multiple structures in parallel (fan-out batch)."""
    from catgo.models.workflow import StepStatus
    from catgo.utils.workflow_db import update_step, update_step_work_dir
    from workflow.engines import ensure_poscar

    def _safe_batch_update(wf_id: str, s_id: str, data: dict) -> None:
        try:
            update_step(wf_id, s_id, data)
        except KeyError:
            pass

    now = datetime.now(timezone.utc).isoformat()
    _safe_batch_update(workflow_id, step_id, {
        "status": StepStatus.RUNNING.value,
        "started_at": now,
    })
    await _broadcast_fn(workflow_id, {
        "type": "step_status", "step_id": step_id, "status": "running",
    })

    # Create base work directory
    config_local_dir = getattr(config, "local_work_dir", "") or ""
    if config_local_dir:
        base_dir = os.path.join(config_local_dir, f"{node_type}_{step_id[:8]}_batch")
        os.makedirs(base_dir, exist_ok=True)
    else:
        base_dir = tempfile.mkdtemp(prefix=f"catgo_mlp_batch_{step_id[:8]}_")

    try:
        await asyncio.to_thread(update_step_work_dir, workflow_id, step_id, base_dir)
    except KeyError:
        pass  # V1 row doesn't exist for V2-native workflows
    try:
        from catgo.routers.workflow_engine import _db as _engine_db
        if _engine_db is not None:
            # update_task is a synchronous SQLite write; offload to a worker
            # so the async caller doesn't stall on SQLite lock contention.
            await asyncio.to_thread(_engine_db.update_task, step_id, work_dir=base_dir)
    except Exception:
        logger.warning(
            "V2 engine DB sync failed for batch step %s work_dir=%s — "
            "live progress polling may read stale data. Details follow.",
            step_id, base_dir, exc_info=True,
        )

    model = params.get("model", "MACE")
    script_content = _build_mlp_script(node_type, model, params)
    total = len(structures)
    all_results: list[dict[str, Any]] = [{} for _ in range(total)]
    done_count = 0
    sem = asyncio.Semaphore(2)

    async def run_one(i: int, struct: Any, label: str):
        nonlocal done_count
        sub_dir = os.path.join(base_dir, f"sub_{i:04d}")
        os.makedirs(sub_dir, exist_ok=True)

        entry: dict[str, Any] = {
            "branch_id": f"{workflow_id}:{step_id}:{i}",
            "index": i,
            "label": label,
            "status": "failed",
            "result": {},
        }

        try:
            # Convert structure to POSCAR
            struct_str = struct if isinstance(struct, str) else json.dumps(struct)
            try:
                poscar_str = ensure_poscar(struct_str)
            except Exception as exc:
                logger.warning(
                    "MLP batch [%d/%d] %s: POSCAR conversion failed (%s), using raw string",
                    i + 1, total, label, exc,
                )
                poscar_str = struct_str

            # Write POSCAR
            poscar_path = os.path.join(sub_dir, "POSCAR")
            with open(poscar_path, "w") as f:
                f.write(poscar_str)

            # Write script
            script_path = os.path.join(sub_dir, "run_mlp.py")
            with open(script_path, "w") as f:
                f.write(script_content)

            async with sem:
                logger.info(
                    "MLP batch [%d/%d] %s: running in %s",
                    i + 1, total, label, sub_dir,
                )
                proc = await asyncio.create_subprocess_exec(
                    sys.executable, script_path,
                    cwd=sub_dir,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout_bytes, stderr_bytes = await proc.communicate()

            stdout_str = stdout_bytes.decode("utf-8", errors="replace")
            stderr_str = stderr_bytes.decode("utf-8", errors="replace")

            if proc.returncode != 0:
                error_msg = stderr_str or stdout_str or f"MLP exited with code {proc.returncode}"
                logger.error("MLP batch [%d/%d] %s FAILED: %s", i + 1, total, label, error_msg[:500])
                entry["result"]["error"] = error_msg[:1000]
            else:
                # Parse energy
                energy = None
                for line in stdout_str.splitlines():
                    if "Final energy:" in line:
                        try:
                            energy = float(line.split("Final energy:")[1].strip().split()[0])
                        except (ValueError, IndexError) as exc:
                            logger.warning(
                                "MLP batch [%d/%d] %s: could not parse energy from %r: %s",
                                i + 1, total, label, line.strip(), exc,
                            )
                        break

                if energy is None:
                    logger.warning(
                        "MLP batch [%d/%d] %s: process succeeded but no energy extracted",
                        i + 1, total, label,
                    )

                # Read CONTCAR
                contcar_path = os.path.join(sub_dir, "CONTCAR")
                contcar_str = ""
                if os.path.isfile(contcar_path):
                    with open(contcar_path, "r") as f:
                        contcar_str = f.read()
                else:
                    logger.warning(
                        "MLP batch [%d/%d] %s: CONTCAR not found after successful run",
                        i + 1, total, label,
                    )

                entry["status"] = "completed"
                entry["result"] = {
                    "energy": energy,
                    "contcar": contcar_str,
                    "structure": contcar_str,
                }

                # Parse vibration results if applicable
                if node_type == "mlp_vibrations":
                    freq_json_path = os.path.join(sub_dir, "frequencies.json")
                    if os.path.isfile(freq_json_path):
                        with open(freq_json_path, "r") as f:
                            freq_data = json.load(f)
                        entry["result"]["frequencies"] = freq_data.get("frequencies_cm", [])
                        entry["result"]["zpe"] = freq_data.get("zpe_ev")
                        entry["result"]["n_frequencies"] = freq_data.get("n_frequencies")

                logger.info(
                    "MLP batch [%d/%d] %s completed (energy=%s)",
                    i + 1, total, label, energy,
                )

        except Exception:
            logger.exception("MLP batch [%d/%d] %s exception", i + 1, total, label)
            entry["result"]["error"] = "Internal error; see server logs"

        all_results[i] = entry
        done_count += 1
        await _broadcast_fn(workflow_id, {
            "type": "step_status",
            "step_id": step_id,
            "status": "running",
            "progress": f"{done_count}/{total}",
        })

    # Launch all tasks
    tasks = [
        asyncio.create_task(run_one(i, struct, labels[i] if i < len(labels) else f"structure_{i}"))
        for i, struct in enumerate(structures)
    ]
    gather_results = await asyncio.gather(*tasks, return_exceptions=True)
    for i, gr in enumerate(gather_results):
        if isinstance(gr, BaseException):
            logger.error("MLP batch [%d/%d] uncaught exception: %s", i + 1, total, gr)
            if not all_results[i].get("status"):
                all_results[i] = {
                    "branch_id": f"{workflow_id}:{step_id}:{i}",
                    "index": i,
                    "label": labels[i] if i < len(labels) else f"structure_{i}",
                    "status": "failed",
                    "result": {"error": f"Task crashed: {gr}"},
                }

    n_completed = sum(1 for r in all_results if r.get("status") == "completed")
    n_failed = total - n_completed

    step_results[step_id] = {
        "node_type": node_type,
        "n_branches": total,
        "n_completed": n_completed,
        "n_failed": n_failed,
        "results": all_results,
        "_fan_out": True,
    }

    if n_completed == 0:
        _safe_batch_update(workflow_id, step_id, {
            "status": StepStatus.FAILED.value,
            "error_message": f"All {total} MLP sub-tasks failed",
            "result_json": json.dumps(step_results[step_id]),
        })
        await _broadcast_fn(workflow_id, {
            "type": "step_status", "step_id": step_id, "status": "failed",
            "error": f"All {total} MLP sub-tasks failed",
        })
        raise RuntimeError(f"All {total} MLP sub-tasks failed")

    _safe_batch_update(workflow_id, step_id, {
        "status": StepStatus.COMPLETED.value,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "result_json": json.dumps(step_results[step_id]),
    })
    await _broadcast_fn(workflow_id, {
        "type": "step_status", "step_id": step_id, "status": "completed",
        "result": step_results[step_id],
    })
