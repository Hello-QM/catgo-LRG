"""ASE database wrapper for storing workflow structures and results.

Stores calculation results (structures, energies, forces) locally on the CatGo
server.  Structures/energies are downloaded from HPC after each job completes.
All queries happen locally — no SSH needed.
"""

import logging
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

DB_DIR = Path(__file__).parent.parent / "data"
DB_PATH = DB_DIR / "catgo_results.db"

# [2025-02] Mutable active DB path — changed by new/open/save-as operations
_active_db_path: Optional[str] = None

# Persisted record of the last active DB path. Lives at a fixed, CWD-independent
# location so a freshly-started backend restores the DB the user last opened
# instead of silently reverting to the packaged default — which would orphan any
# workflow created via the API before the frontend re-opens its project DB.
_ACTIVE_DB_STATE = DB_DIR / ".active_db_path"


def get_active_db_path() -> str:
    """Return the current active ASE DB path."""
    return _active_db_path or str(DB_PATH)


def _persist_active_db_path(path: Optional[str]) -> None:
    """Record (or clear) the active DB path so it survives a backend restart."""
    try:
        DB_DIR.mkdir(parents=True, exist_ok=True)
        if path:
            _ACTIVE_DB_STATE.write_text(path)
        elif _ACTIVE_DB_STATE.exists():
            _ACTIVE_DB_STATE.unlink()
    except OSError as exc:  # best-effort; persistence failure must not break ops
        logger.warning("Could not persist active DB path: %s", exc)


def set_active_db_path(path: Optional[str]):
    """Switch the active ASE DB and its paired workflows DB.

    [2025-02] ASE tables (systems, keys, etc.) and workflow tables (projects,
    workflows, etc.) coexist in the SAME SQLite file.  No separate *_workflows.db
    is created.  Previous versions used a separate file — see git history for
    rollback if needed.

    The path is resolved to an absolute path so create/list/get agree regardless
    of the process working directory, and the choice is persisted so the next
    backend start restores it (see restore_active_db_path).
    """
    global _active_db_path
    abs_path = str(Path(path).resolve()) if path else None
    _active_db_path = abs_path
    logger.info("Switched active ASE DB to: %s", get_active_db_path())
    _persist_active_db_path(abs_path)
    # Point workflow_db at the same file so all data lives in one .db
    from catgo.utils.workflow_db import set_active_wf_db_path
    set_active_wf_db_path(abs_path)


def restore_active_db_path() -> Optional[str]:
    """Restore the last active DB path persisted by set_active_db_path().

    Call once at backend startup. If the persisted file is missing/stale the
    packaged default is kept. Returns the restored path, or None."""
    try:
        if _ACTIVE_DB_STATE.exists():
            stored = _ACTIVE_DB_STATE.read_text().strip()
            if stored and Path(stored).exists():
                set_active_db_path(stored)
                logger.info("Restored active DB from persisted state: %s", stored)
                return stored
            if stored:
                logger.warning("Persisted active DB no longer exists: %s", stored)
    except OSError as exc:
        logger.warning("Could not restore active DB path: %s", exc)
    return None


def _ensure_dir():
    DB_DIR.mkdir(parents=True, exist_ok=True)


def _get_db(db_path: Optional[str] = None):
    """Get an ASE database connection."""
    from ase.db import connect

    path = db_path or get_active_db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    return connect(path)


def store_result(
    atoms,
    workflow_id: str,
    step_id: str,
    node_type: str,
    energy: Optional[float] = None,
    forces: Optional[np.ndarray] = None,
    stress: Optional[np.ndarray] = None,
    db_path: Optional[str] = None,
    data_dict: Optional[dict] = None,
    **extra_data,
) -> int:
    """Store a calculation result in the ASE database.

    Parameters
    ----------
    atoms : ase.Atoms
        The structure to store (with cell, positions, elements).
    workflow_id : str
        Workflow that produced this result.
    step_id : str
        Workflow step that produced this result.
    node_type : str
        Type of calculation node (e.g. "vasp_relax", "vasp_static").
    energy : float, optional
        Total energy in eV.
    forces : ndarray, optional
        Forces array (N x 3) in eV/Angstrom.
    stress : ndarray, optional
        Stress tensor (6,) in eV/Angstrom^3.
    db_path : str, optional
        Override database path.
    data_dict : dict, optional
        Additional data to store (e.g. site_properties for pseudo-H round-trip).
    **extra_data
        Additional key-value pairs to store.

    Returns
    -------
    int
        ASE database row ID for this entry.
    """
    from ase.calculators.singlepoint import SinglePointCalculator

    db = _get_db(db_path)

    # Attach results as a SinglePointCalculator if we have energy/forces
    if energy is not None or forces is not None or stress is not None:
        calc = SinglePointCalculator(
            atoms,
            energy=energy,
            forces=forces,
            stress=stress,
        )
        atoms.calc = calc

    # Store with metadata as key-value pairs
    key_value_pairs = {
        "workflow_id": workflow_id,
        "step_id": step_id,
        "node_type": node_type,
    }
    key_value_pairs.update(extra_data)

    # Data dict for non-indexable fields
    data = data_dict.copy() if data_dict else {}
    if forces is not None:
        data["forces"] = forces.tolist()

    row_id = db.write(atoms, key_value_pairs=key_value_pairs, data=data)
    logger.info(
        "Stored result: workflow=%s step=%s type=%s energy=%s row_id=%d",
        workflow_id, step_id, node_type, energy, row_id,
    )
    return row_id


def get_result(row_id: int, db_path: Optional[str] = None) -> dict:
    """Retrieve a result by ASE DB row ID.

    Returns dict with keys: atoms, energy, forces, key_value_pairs, data.
    """
    db = _get_db(db_path)
    row = db.get(id=row_id)
    result = {
        "id": row.id,
        "atoms": row.toatoms(),
        "formula": row.formula,
        "energy": row.get("energy"),
        "key_value_pairs": row.key_value_pairs,
        "data": row.data,
    }
    return result


def query_results(
    workflow_id: Optional[str] = None,
    node_type: Optional[str] = None,
    formula: Optional[str] = None,
    db_path: Optional[str] = None,
    limit: int = 100,
) -> list[dict]:
    """Query results with optional filters.

    Returns list of dicts with: id, formula, energy, workflow_id, step_id, node_type.
    """
    db = _get_db(db_path)

    # Build ASE DB query string
    conditions = []
    if workflow_id:
        conditions.append(f"workflow_id={workflow_id}")
    if node_type:
        conditions.append(f"node_type={node_type}")
    if formula:
        conditions.append(f"formula={formula}")

    query = ",".join(conditions) if conditions else ""

    results = []
    for row in db.select(query, limit=limit):
        results.append({
            "id": row.id,
            "formula": row.formula,
            "label": row.get("label", ""),
            "energy": row.get("energy"),
            "workflow_id": row.get("workflow_id", ""),
            "step_id": row.get("step_id", ""),
            "node_type": row.get("node_type", ""),
            "natoms": row.natoms,
        })

    return results


def update_result_label(row_id: int, label: str, db_path: Optional[str] = None):
    """Update the display label of a result."""
    db = _get_db(db_path)
    db.update(row_id, label=label)
    logger.info("Updated label for row_id=%d to '%s'", row_id, label)


def delete_result(row_id: int, db_path: Optional[str] = None):
    """Delete a result from the ASE database."""
    db = _get_db(db_path)
    db.delete([row_id])
    logger.info("Deleted row_id=%d", row_id)


def query_results_enriched(
    workflow_id: Optional[str] = None,
    node_type: Optional[str] = None,
    formula: Optional[str] = None,
    db_path: Optional[str] = None,
    limit: int = 200,
) -> list[dict]:
    """Extended query returning computed columns for dashboard display.

    Returns dicts with: id, formula, energy, energy_per_atom, natoms, volume,
    a, b, c, alpha, beta, gamma, workflow_id, step_id, node_type, frequencies (if orca_freq).
    """
    db = _get_db(db_path)

    conditions = []
    if workflow_id:
        conditions.append(f"workflow_id={workflow_id}")
    if node_type:
        conditions.append(f"node_type={node_type}")
    if formula:
        conditions.append(f"formula={formula}")

    query = ",".join(conditions) if conditions else ""

    results = []
    for row in db.select(query, limit=limit):
        atoms = row.toatoms()
        energy = row.get("energy")
        natoms = row.natoms

        # Compute derived values
        energy_per_atom = energy / natoms if energy is not None and natoms > 0 else None

        # Cell parameters
        try:
            volume = float(atoms.get_volume())
            cellpar = atoms.cell.cellpar()
            a, b, c, alpha, beta, gamma = [float(x) for x in cellpar]
        except Exception:
            volume = None
            a = b = c = alpha = beta = gamma = None

        result_dict = {
            "id": row.id,
            "formula": row.formula,
            "energy": energy,
            "energy_per_atom": energy_per_atom,
            "natoms": natoms,
            "volume": volume,
            "a": a, "b": b, "c": c,
            "alpha": alpha, "beta": beta, "gamma": gamma,
            "workflow_id": row.get("workflow_id", ""),
            "step_id": row.get("step_id", ""),
            "node_type": row.get("node_type", ""),
        }

        # Extract frequency data if available in result metadata
        if row.data and "frequencies" in row.data:
            result_dict["frequencies"] = row.data["frequencies"]
            result_dict["num_imaginary"] = row.data.get("num_imaginary", 0)

        results.append(result_dict)

    return results


# [2025-02] move_result only used for user_save rows; workflow results use copy_result
def move_result(row_id: int, project_id: str, db_path: Optional[str] = None):
    """Move a result to a different project by updating its workflow_id."""
    db = _get_db(db_path)
    db.update(row_id, workflow_id=project_id)
    logger.info("Moved row_id=%d to project %s", row_id, project_id)


# [2025-02] Added: drag-and-drop workflow results creates a copy instead of moving,
# so the original workflow result is preserved. User-saved structures still use move_result.
def copy_result(row_id: int, target_project_id: str, db_path: Optional[str] = None) -> int:
    """Copy a result to a project folder (new row with workflow_id=project_id)."""
    from ase.calculators.singlepoint import SinglePointCalculator

    db = _get_db(db_path)
    row = db.get(id=row_id)
    atoms = row.toatoms()

    # Preserve calculator if present
    energy = row.get("energy")
    forces_data = row.data.get("forces") if row.data else None
    if energy is not None or forces_data is not None:
        atoms.calc = SinglePointCalculator(
            atoms, energy=energy, forces=forces_data,
        )

    kvp = {
        "workflow_id": target_project_id,
        "step_id": "__saved__",
        "node_type": "user_save",
        "label": row.get("label", ""),
    }
    # Preserve all stored data (forces, site_properties, site_labels, etc.)
    data = dict(row.data) if row.data else {}
    if forces_data is not None:
        data["forces"] = forces_data

    new_id = db.write(atoms, key_value_pairs=kvp, data=data)
    logger.info("Copied row_id=%d to project %s as new row_id=%d", row_id, target_project_id, new_id)
    return new_id


def delete_result(row_id: int, db_path: Optional[str] = None):
    """Delete a result by row ID."""
    db = _get_db(db_path)
    db.delete([row_id])


def atoms_from_pymatgen(structure) -> "ase.Atoms":
    """Convert a pymatgen Structure to ASE Atoms."""
    from ase import Atoms

    symbols = [str(site.specie) for site in structure]
    positions = [site.coords for site in structure]
    cell = structure.lattice.matrix
    pbc = True

    return Atoms(symbols=symbols, positions=positions, cell=cell, pbc=pbc)


def pymatgen_from_poscar_str(poscar_content: str):
    """Parse a POSCAR/CONTCAR string into a pymatgen Structure."""
    from pymatgen.core import Structure

    return Structure.from_str(poscar_content, fmt="poscar")


def is_xyz_format(content: str) -> bool:
    """Return True if content is XYZ format (first line is an integer)."""
    first_line = content.strip().split('\n')[0].strip()
    try:
        int(first_line)
        return True
    except ValueError:
        return False


def atoms_from_xyz_str(xyz_content: str):
    """Parse XYZ string into ASE Atoms using ase.io."""
    import io
    from ase.io import read
    return read(io.StringIO(xyz_content), format="xyz")


def query_task_results(workflow_id: str, db_path: Optional[str] = None) -> list[dict]:
    """Query ORCA and other engine-specific results from task_results table.

    Returns task results with:
    - task_id, workflow_id, task_type, status
    - outputs_json (full parser output)
    - Extracted fields: real_freqs_json, imag_freqs_json, convergence_json, zpe, gibbs, energy

    Parameters
    ----------
    workflow_id : str
        Workflow ID to query results for
    db_path : str, optional
        Override database path

    Returns
    -------
    list[dict]
        Task results with ORCA-specific data
    """
    import json
    from catgo.utils.workflow_db import get_db as get_wf_db

    results = []
    try:
        with get_wf_db(db_path) as conn:
            # task_type + status are properties of the task, not the result —
            # LEFT JOIN tasks to surface them without duplicating columns.
            # LEFT JOIN preserves orphan results (task row deleted but result
            # row lingered) rather than silently dropping them.
            rows = conn.execute("""
                SELECT
                    r.task_id, r.workflow_id, t.task_type, t.status,
                    r.outputs_json, r.real_freqs_json, r.imag_freqs_json,
                    r.convergence_json, r.zpe, r.gibbs, r.energy
                FROM task_results r
                LEFT JOIN tasks t ON t.id = r.task_id
                WHERE r.workflow_id = ?
                ORDER BY r.created_at DESC
            """, (workflow_id,)).fetchall()

            for row in rows:
                task_result = {
                    "task_id": row["task_id"],
                    "task_type": row["task_type"],
                    "status": row["status"],
                    "energy": row["energy"],
                    "zpe": row["zpe"],
                    "gibbs": row["gibbs"],
                }

                # Parse and include ORCA-specific data
                if row["outputs_json"]:
                    try:
                        outputs = json.loads(row["outputs_json"])
                        # Include all parsed output keys
                        task_result["outputs"] = outputs
                    except (json.JSONDecodeError, TypeError):
                        pass

                # Also extract pre-normalized fields if they exist
                if row["real_freqs_json"]:
                    try:
                        task_result["real_freqs"] = json.loads(row["real_freqs_json"])
                    except (json.JSONDecodeError, TypeError):
                        pass

                if row["imag_freqs_json"]:
                    try:
                        task_result["imag_freqs"] = json.loads(row["imag_freqs_json"])
                    except (json.JSONDecodeError, TypeError):
                        pass

                if row["convergence_json"]:
                    try:
                        task_result["convergence_points"] = json.loads(row["convergence_json"])
                    except (json.JSONDecodeError, TypeError):
                        pass

                results.append(task_result)

    except Exception as e:
        logger.exception(f"Error querying task_results for workflow {workflow_id}: {e}")

    return results
