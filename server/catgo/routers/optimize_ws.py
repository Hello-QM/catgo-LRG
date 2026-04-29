"""WebSocket endpoint for real-time structure optimization progress."""

import asyncio
import json
from typing import Optional

import numpy as np
from ase.optimize import BFGS
from ase.filters import ExpCellFilter
from ase.constraints import FixAtoms
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from catgo.calculators import get_calculator
from catgo.models import (
    CalculatorType,
    OptimizerType,
    WSMessageType,
    WSOptimizationRequest,
    WSProgressMessage,
)
from catgo.utils import ase_to_pymatgen, pymatgen_to_ase

router = APIRouter(tags=["optimization-ws"])


class OptimizationRunner:
    """Async wrapper for running ASE optimization with progress callbacks."""

    def __init__(
        self,
        websocket: WebSocket,
        request: WSOptimizationRequest,
    ):
        self.websocket = websocket
        self.request = request
        self.cancelled = False
        self.step_counter = 0
        self.atoms = None
        self.optimizer = None
        self.original_atoms = None  # For fragment extraction
        self.fragment_indices = None  # For fragment extraction
        self.loop = asyncio.get_event_loop()

    async def send_progress(
        self,
        msg_type: WSMessageType,
        energy: float,
        fmax: float,
        converged: bool = False,
        message: str = "",
        include_structure: bool = False,
    ):
        """Send progress message via WebSocket."""
        structure = None
        if include_structure and self.atoms is not None:
            # If fragment was extracted, merge back into original structure
            if self.original_atoms is not None and self.fragment_indices is not None:
                optimized_positions = self.atoms.get_positions()
                original_positions = self.original_atoms.get_positions()
                for i, orig_idx in enumerate(self.fragment_indices):
                    original_positions[orig_idx] = optimized_positions[i]
                self.original_atoms.set_positions(original_positions)
                structure = ase_to_pymatgen(self.original_atoms)
            else:
                structure = ase_to_pymatgen(self.atoms)

        msg = WSProgressMessage(
            type=msg_type,
            step=self.step_counter,
            total_steps=self.request.steps,
            energy=energy,
            fmax=fmax,
            converged=converged,
            message=message,
            structure=structure,
        )
        await self.websocket.send_json(msg.model_dump())

    def step_callback(self):
        """Callback called after each optimization step."""
        self.step_counter += 1

        # ASE Dynamics.irun() ignores observer return values, so we stop the
        # optimizer by forcing max_steps == nsteps — the while-loop condition
        # `nsteps < max_steps` will fail on the next iteration.
        if self.cancelled and self.optimizer is not None:
            self.optimizer.max_steps = self.optimizer.nsteps

        if self.atoms is None:
            return

        energy = float(self.atoms.get_potential_energy())
        forces = self.atoms.get_forces()
        fmax = float(np.max(np.linalg.norm(forces, axis=1)))

        # Schedule async send in the event loop
        # Include structure with forces for trajectory recording
        asyncio.run_coroutine_threadsafe(
            self.send_progress(WSMessageType.PROGRESS, energy, fmax, include_structure=True),
            self.loop,
        )

    def _create_optimizer(self, opt_atoms):
        """Create the appropriate optimizer based on request.optimizer."""
        optimizer_type = getattr(self.request, "optimizer", OptimizerType.BFGS)

        if optimizer_type == OptimizerType.BFGS:
            return BFGS(opt_atoms, logfile=None)

        # Sella-based optimizers (lazy import)
        try:
            from sella import Sella, IRC
        except ImportError:
            raise RuntimeError(
                "Sella is not installed. Install it with: pip install sella"
            )

        if optimizer_type == OptimizerType.SELLA_MIN:
            kw = {}
            if self.request.sella_params:
                params = self.request.sella_params
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
            if self.request.sella_params:
                params = self.request.sella_params
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
            if self.request.irc_params:
                params = self.request.irc_params
                if params.dx is not None:
                    kw["dx"] = params.dx
                if params.eta is not None:
                    kw["eta"] = params.eta
                if params.gamma is not None:
                    kw["gamma"] = params.gamma
            return IRC(opt_atoms, logfile=None, **kw)

        raise ValueError(f"Unknown optimizer type: {optimizer_type}")

    async def run(self) -> bool:
        """Run the optimization. Returns True if converged."""
        try:
            # Get calculator with optional parameters
            calc_wrapper = get_calculator(
                self.request.calculator, self.request.calculator_params
            )

            # Convert structure to ASE Atoms
            self.atoms = pymatgen_to_ase(self.request.structure)

            # Handle fragment extraction or atom constraints
            self.original_atoms = None
            self.fragment_indices = None
            if self.request.mobile_indices is not None and len(self.request.mobile_indices) > 0:
                if getattr(self.request, 'extract_fragment', False):
                    # Extract selected atoms as a standalone molecule (no PBC)
                    self.original_atoms = self.atoms.copy()
                    self.fragment_indices = sorted(self.request.mobile_indices)
                    self.atoms = self.atoms[self.fragment_indices]
                    self.atoms.set_pbc(False)
                    self.atoms.set_cell(None)
                else:
                    # Fix unselected atoms in place
                    n_atoms = len(self.atoms)
                    mobile_set = set(self.request.mobile_indices)
                    fixed_indices = [i for i in range(n_atoms) if i not in mobile_set]
                    if fixed_indices:
                        self.atoms.set_constraint(FixAtoms(indices=fixed_indices))

            # Check element support
            symbols = self.atoms.get_chemical_symbols()
            supported, msg = calc_wrapper.supports_structure(symbols)
            if not supported:
                await self.send_progress(
                    WSMessageType.ERROR,
                    energy=0.0,
                    fmax=0.0,
                    message=f"Calculator does not support this structure: {msg}",
                )
                return False

            # Attach calculator (may import heavy libraries like tblite)
            loop = asyncio.get_event_loop()
            calc = await loop.run_in_executor(None, calc_wrapper.get_calculator)
            self.atoms.calc = calc

            # Get initial state — must run in executor to avoid blocking event loop
            def _compute_initial():
                energy = float(self.atoms.get_potential_energy())
                forces = self.atoms.get_forces()
                fmax = float(np.max(np.linalg.norm(forces, axis=1)))
                return energy, forces, fmax

            initial_energy, initial_forces, initial_fmax = await loop.run_in_executor(
                None, _compute_initial
            )

            # Send initial progress
            await self.send_progress(
                WSMessageType.PROGRESS,
                initial_energy,
                initial_fmax,
            )

            # Setup optimizer
            if self.request.optimize_cell:
                opt_atoms = ExpCellFilter(self.atoms)
            else:
                opt_atoms = self.atoms

            optimizer = self._create_optimizer(opt_atoms)
            self.optimizer = optimizer

            # Attach step callback
            optimizer.attach(self.step_callback)

            # Run optimization in thread pool to avoid blocking
            def run_optimizer():
                return optimizer.run(fmax=self.request.fmax, steps=self.request.steps)

            converged = await asyncio.get_event_loop().run_in_executor(
                None, run_optimizer
            )

            # Helper to read final energy/forces without blocking event loop
            def _compute_final():
                e = float(self.atoms.get_potential_energy())
                f = self.atoms.get_forces()
                fm = float(np.max(np.linalg.norm(f, axis=1)))
                return e, f, fm

            if self.cancelled:
                # Cancelled during optimization
                final_energy, final_forces, final_fmax = await loop.run_in_executor(
                    None, _compute_final
                )
                await self.send_progress(
                    WSMessageType.CANCELLED,
                    final_energy,
                    final_fmax,
                    message="Optimization cancelled by user",
                    include_structure=True,
                )
                return False

            # Get final state
            final_energy, final_forces, final_fmax = await loop.run_in_executor(
                None, _compute_final
            )

            # Send completion
            await self.send_progress(
                WSMessageType.COMPLETE,
                final_energy,
                final_fmax,
                converged=converged,
                message="Optimization converged" if converged else f"Reached max steps ({self.request.steps})",
                include_structure=True,
            )

            return converged

        except Exception as e:
            await self.send_progress(
                WSMessageType.ERROR,
                energy=0.0,
                fmax=0.0,
                message=str(e),
            )
            return False

    def cancel(self):
        """Request cancellation of the optimization."""
        self.cancelled = True


@router.websocket("/optimize/ws")
async def optimization_websocket(websocket: WebSocket):
    """WebSocket endpoint for real-time optimization progress.

    Protocol:
    - Client sends: {"action": "start", "payload": WSOptimizationRequest}
    - Client sends: {"action": "cancel", "request_id": "..."}
    - Server sends: WSProgressMessage for each step
    """
    await websocket.accept()

    runner: Optional[OptimizationRunner] = None
    optimization_task: Optional[asyncio.Task] = None

    try:
        while True:
            # Receive message from client
            data = await websocket.receive_json()
            action = data.get("action")

            if action == "start":
                # Cancel any existing optimization
                if runner is not None:
                    runner.cancel()
                if optimization_task is not None:
                    optimization_task.cancel()
                    try:
                        await optimization_task
                    except asyncio.CancelledError:
                        pass

                # Parse request
                try:
                    request = WSOptimizationRequest(**data["payload"])
                except Exception as e:
                    await websocket.send_json({
                        "type": "error",
                        "step": 0,
                        "total_steps": 0,
                        "energy": 0.0,
                        "fmax": 0.0,
                        "message": f"Invalid request: {e}",
                    })
                    continue

                # Start new optimization
                runner = OptimizationRunner(websocket, request)
                optimization_task = asyncio.create_task(runner.run())

            elif action == "cancel":
                if runner is not None:
                    runner.cancel()

    except WebSocketDisconnect:
        # Client disconnected
        if runner is not None:
            runner.cancel()
        if optimization_task is not None:
            optimization_task.cancel()
    except Exception as e:
        # Unexpected error
        try:
            await websocket.send_json({
                "type": "error",
                "step": 0,
                "total_steps": 0,
                "energy": 0.0,
                "fmax": 0.0,
                "message": f"Server error: {e}",
            })
        except Exception:
            pass
