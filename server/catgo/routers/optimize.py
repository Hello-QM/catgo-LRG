"""Structure optimization API endpoints."""

import asyncio

import numpy as np
from ase.optimize import BFGS, FIRE
from ase.filters import ExpCellFilter
from ase.constraints import FixAtoms
from fastapi import APIRouter, HTTPException

from catgo.calculators import get_calculator
from catgo.models import (
    CalculatorType,
    OptimizerType,
    OptimizationRequest,
    OptimizationResult,
    OptimizationStep,
)
from catgo.utils import ase_to_pymatgen, pymatgen_to_ase


def _create_optimizer(request: OptimizationRequest, opt_atoms):
    """Create the appropriate optimizer based on request.optimizer."""
    optimizer_type = request.optimizer

    if optimizer_type == OptimizerType.BFGS:
        return BFGS(opt_atoms, logfile=None)

    # Sella-based optimizers (lazy import)
    try:
        from sella import Sella, IRC
    except ImportError:
        raise ImportError(
            "Sella is not installed. Install it with: pip install sella"
        )

    if optimizer_type == OptimizerType.SELLA_MIN:
        kw = {}
        if request.sella_params:
            params = request.sella_params
            if params.delta0 is not None:
                kw["delta0"] = params.delta0
            if params.sigma_inc is not None:
                kw["sigma_inc"] = params.sigma_inc
            if params.sigma_dec is not None:
                kw["sigma_dec"] = params.sigma_dec
            if params.rho_inc is not None:
                kw["rho_inc"] = params.rho_inc
            if params.rho_dec is not None:
                kw["rho_dec"] = params.rho_dec
        return Sella(opt_atoms, order=0, logfile=None, **kw)

    if optimizer_type == OptimizerType.SELLA_TS:
        kw = {}
        if request.sella_params:
            params = request.sella_params
            if params.delta0 is not None:
                kw["delta0"] = params.delta0
            if params.sigma_inc is not None:
                kw["sigma_inc"] = params.sigma_inc
            if params.sigma_dec is not None:
                kw["sigma_dec"] = params.sigma_dec
            if params.rho_inc is not None:
                kw["rho_inc"] = params.rho_inc
            if params.rho_dec is not None:
                kw["rho_dec"] = params.rho_dec
        return Sella(opt_atoms, order=1, logfile=None, **kw)

    if optimizer_type == OptimizerType.IRC:
        kw = {}
        if request.irc_params:
            params = request.irc_params
            if params.dx is not None:
                kw["dx"] = params.dx
            if params.eta is not None:
                kw["eta"] = params.eta
            if params.gamma is not None:
                kw["gamma"] = params.gamma
        return IRC(opt_atoms, logfile=None, **kw)

    raise ValueError(f"Unknown optimizer type: {optimizer_type}")

router = APIRouter(prefix="/optimize", tags=["optimization"])


@router.get("/calculators")
def list_calculators() -> dict:
    """List available calculators and their status (built-in + plugins)."""
    calculators = {}

    # Built-in calculators
    for calc_type in CalculatorType:
        try:
            calc = get_calculator(calc_type.value)
            calculators[calc_type.value] = {
                "available": True,
                "name": calc.name,
                "description": calc.description,
                "supported_elements": calc.supported_elements,
                "is_plugin": False,
            }
        except ValueError:
            calculators[calc_type.value] = {
                "available": False,
                "name": calc_type.value,
                "description": f"{calc_type.value} calculator not installed",
                "supported_elements": None,
                "is_plugin": False,
            }

    # Plugin calculators
    try:
        from catgo.plugins import plugin_manager

        for calc_info in plugin_manager.get_all_calculators():
            calculators[calc_info["id"]] = {
                "available": calc_info["enabled"],
                "name": calc_info["display_name"],
                "description": calc_info["description"],
                "supported_elements": calc_info["supported_elements"],
                "is_plugin": True,
                "parameter_schema": calc_info.get("parameter_schema"),
            }
    except ImportError:
        pass

    return {"calculators": calculators}


@router.post("/structure", response_model=OptimizationResult)
async def optimize_structure(request: OptimizationRequest) -> OptimizationResult:
    """Optimize a crystal/molecular structure.

    Args:
        request: Optimization request with structure and parameters

    Returns:
        OptimizationResult with optimized structure and energetics
    """
    try:
        # Get calculator with optional parameters
        calc_wrapper = get_calculator(request.calculator, request.calculator_params)

        # Convert structure to ASE Atoms
        atoms = pymatgen_to_ase(request.structure)

        # Check element support
        symbols = atoms.get_chemical_symbols()
        supported, msg = calc_wrapper.supports_structure(symbols)
        if not supported:
            return OptimizationResult(
                success=False,
                message=f"Calculator '{request.calculator}' does not support this structure: {msg}",
            )

        # Handle fragment extraction or atom constraints
        original_atoms = None
        fragment_indices = None
        if request.mobile_indices is not None and len(request.mobile_indices) > 0:
            if request.extract_fragment:
                # Extract selected atoms as a standalone molecule (no PBC)
                original_atoms = atoms.copy()
                fragment_indices = sorted(request.mobile_indices)
                atoms = atoms[fragment_indices]
                atoms.set_pbc(False)
                atoms.set_cell(None)
            else:
                # Fix unselected atoms in place
                n_atoms = len(atoms)
                mobile_set = set(request.mobile_indices)
                fixed_indices = [i for i in range(n_atoms) if i not in mobile_set]
                if fixed_indices:
                    atoms.set_constraint(FixAtoms(indices=fixed_indices))

        # Run entire optimization in thread pool to avoid blocking the event loop.
        # Calculator calls (get_potential_energy, get_forces, optimizer.run) are
        # CPU-bound and would freeze all other HTTP/WS handlers if run on the
        # async event loop directly.
        loop = asyncio.get_event_loop()

        def _run_optimization():
            calc = calc_wrapper.get_calculator()
            atoms.calc = calc

            # Get initial energy and forces
            initial_energy = atoms.get_potential_energy()
            initial_forces = atoms.get_forces()
            initial_fmax = np.max(np.linalg.norm(initial_forces, axis=1))

            # Setup optimizer
            trajectory = []

            if request.return_trajectory:
                trajectory.append(
                    OptimizationStep(
                        step=0,
                        energy=float(initial_energy),
                        fmax=float(initial_fmax),
                        structure=ase_to_pymatgen(atoms),
                    )
                )

            if request.optimize_cell:
                opt_atoms = ExpCellFilter(atoms)
            else:
                opt_atoms = atoms

            optimizer = _create_optimizer(request, opt_atoms)

            step_counter = [0]

            def record_step():
                step_counter[0] += 1
                if request.return_trajectory:
                    current_atoms = atoms if not request.optimize_cell else atoms
                    forces = current_atoms.get_forces()
                    fmax = np.max(np.linalg.norm(forces, axis=1))
                    trajectory.append(
                        OptimizationStep(
                            step=step_counter[0],
                            energy=float(current_atoms.get_potential_energy()),
                            fmax=float(fmax),
                            structure=ase_to_pymatgen(current_atoms),
                        )
                    )

            optimizer.attach(record_step)
            converged = optimizer.run(fmax=request.fmax, steps=request.steps)

            final_energy = atoms.get_potential_energy()
            final_forces = atoms.get_forces()
            final_fmax = np.max(np.linalg.norm(final_forces, axis=1))

            # Merge fragment back if extracted
            if original_atoms is not None and fragment_indices is not None:
                optimized_positions = atoms.get_positions()
                original_positions = original_atoms.get_positions()
                for i, orig_idx in enumerate(fragment_indices):
                    original_positions[orig_idx] = optimized_positions[i]
                original_atoms.set_positions(original_positions)
                final_structure = ase_to_pymatgen(original_atoms)
            else:
                final_structure = ase_to_pymatgen(atoms)

            return OptimizationResult(
                success=True,
                message="Optimization converged" if converged else f"Reached max steps ({request.steps})",
                initial_energy=float(initial_energy),
                final_energy=float(final_energy),
                energy_change=float(final_energy - initial_energy),
                initial_fmax=float(initial_fmax),
                final_fmax=float(final_fmax),
                steps_taken=step_counter[0],
                structure=final_structure,
                trajectory=trajectory if request.return_trajectory else None,
            )

        return await loop.run_in_executor(None, _run_optimization)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/energy")
async def calculate_energy(
    request: OptimizationRequest,
) -> dict:
    """Calculate single-point energy and forces without optimization.

    Args:
        request: Request with structure and calculator choice

    Returns:
        Energy and forces
    """
    try:
        calc_wrapper = get_calculator(request.calculator, request.calculator_params)
        atoms = pymatgen_to_ase(request.structure)

        # Check element support
        symbols = atoms.get_chemical_symbols()
        supported, msg = calc_wrapper.supports_structure(symbols)
        if not supported:
            raise HTTPException(
                status_code=400,
                detail=f"Calculator '{request.calculator}' does not support: {msg}",
            )

        loop = asyncio.get_event_loop()

        def _compute():
            calc = calc_wrapper.get_calculator()
            atoms.calc = calc
            energy = atoms.get_potential_energy()
            forces = atoms.get_forces()
            fmax = np.max(np.linalg.norm(forces, axis=1))
            return {
                "energy": float(energy),
                "energy_per_atom": float(energy / len(atoms)),
                "forces": forces.tolist(),
                "fmax": float(fmax),
                "units": {"energy": "eV", "forces": "eV/Angstrom"},
            }

        return await loop.run_in_executor(None, _compute)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
