# MACE in CatGO vs SuperMace: Analysis and Integration Path

## 1. Our Current MACE Implementation

Our MACE calculator (`server/calculators/mace.py`) is a thin wrapper around the
upstream `mace-torch` package. It plugs into CatGO's server as one of several
ASE-compatible calculators (alongside EMT, xTB, CHGNet, and M3GNet).

**What it does:**

- Loads a pre-trained MACE-MP foundation model (small/medium/large) or a custom
  `.model` file
- Returns a standard ASE `Calculator` that computes energies, forces, and stresses
  for a single structure
- Supports CPU or CUDA device selection
- Works with all our ASE-based optimizers: BFGS, Sella (minimization and TS
  search), and IRC

**Current limitations:**

- **No model caching** -- the model is instantiated fresh on every request via
  `get_calculator()`. This means the model weights are reloaded into memory (and
  potentially onto the GPU) each time a calculation is requested.
- **Single-structure inference only** -- each call processes one atomic structure
  through the neural network. There is no way to batch multiple structures into a
  single forward pass.
- **No Hessian support** -- the calculator only returns energies, forces, and
  stresses. Hessian matrices (second derivatives) are not exposed, even though
  MACE models can compute them. This matters for transition state methods like
  Sella and CCQN, which rely on curvature information.
- **No GPU server mode** -- the calculator runs in-process on whatever device is
  specified. There is no way to run a persistent GPU inference server that
  multiple jobs can connect to.

## 2. What SuperMace Does

SuperMace (https://gitee.com/yinkaaiwu/SuperMace) is a fork of `mace-torch` from
the same Python package namespace. It preserves all upstream MACE functionality
and adds three new components:

### 2a. `MACEBatchCalculator`

A new calculator class that accepts a **list** of `ase.Atoms` objects and
processes them in a single GPU forward pass using PyTorch Geometric batching.

- `calculate_batch(atoms_list)` -- batch energy/forces/stress
- `get_hessian_batch(atoms_list)` -- batch Hessian matrices
- `get_descriptors_batch(atoms_list)` -- batch MACE descriptor extraction

Configurable batch sizes per task type:
```yaml
efs_max_batch_size: 56      # up to 56 structures per forward pass
hess_max_batch_size: 4      # Hessians are memory-heavy, smaller batches
desc_max_batch_size: 64
```

This is the core performance innovation. Instead of N sequential forward passes,
structures are collated into a single PyTorch Geometric `Batch` object and
evaluated in one vectorized GPU call.

### 2b. `mace_apiserver` (HTTP Inference Server)

A Flask + Gunicorn server that decouples GPU inference from optimization logic:

```
Client  -->  POST /predict  -->  TaskStore (job queue)
                                       |
              ModelInferenceWorker  <---+  (one thread per GPU/model)
                     |
                     v
              MACEBatchCalculator.calculate_batch()
                     |
                     v
              TaskStore (results)  -->  GET /result/{task_id}  -->  Client
```

Key features:
- **Auto-batching**: collects incoming requests within a timeout window (e.g. 1s)
  and processes them together
- **Multi-GPU**: each model/GPU gets its own worker thread
- **Committee mode**: runs multiple models in parallel across GPUs, averages
  results for uncertainty quantification
- Launched via CLI: `mace_apiserver run -yml config.yml`

### 2c. `MACEOnlineCalculator` (Remote ASE Calculator)

A drop-in ASE `Calculator` that transparently sends work to the inference server
over HTTP:

```python
from mace.calculators import MACEOnlineCalculator

calc = MACEOnlineCalculator(
    server_address="http://gpu-node:8000",
    model_type="MACE",
    timeout=2,
    poll_interval=0.5,
)

atoms.calc = calc
# Any ASE optimizer works transparently -- BFGS, Sella, FIRE, etc.
```

The optimizer running on a CPU node doesn't know or care that forces are coming
from a remote GPU. It just calls `atoms.get_forces()` like any other calculator.

## 3. Why This Matters for Transition State Searches on Expanse

For TS searches (Sella, CCQN, NEB) on Expanse, the SuperMace architecture
enables an efficient GPU-sharing pattern:

```
GPU Node (Singularity container)
  mace_apiserver + MACE model(s) loaded on GPU(s)
  Persistent, always-hot, auto-batching
       |
       | HTTP (internal network)
       |
  +----+----+----+----+
  |    |    |    |    |
CPU  CPU  CPU  CPU  CPU   (compute nodes)
  Each runs an independent TS/NEB job
  using MACEOnlineCalculator
```

Benefits:
- **GPU utilization**: one GPU serves many concurrent CPU workers through batching
- **Cost efficiency**: GPU nodes are expensive on Expanse; this maximizes throughput
  per GPU-hour
- **NEB parallelism**: NEB images can all be evaluated in a single batched forward
  pass instead of sequentially
- **No GPU on compute nodes**: workers only need Python + ASE + requests

## 4. How We Could Implement This

Rather than depending on SuperMace directly (hosted on Gitee, replaces
`mace-torch`, hard to clone from US), we can implement the same ideas natively
within CatGO's server.

### Phase 1: Quick Wins (within existing calculator)

**A. Model Caching**

Add a module-level cache so the MACE model loads once and is reused:

```python
# server/calculators/mace.py
_model_cache = {}

class MACECalculator(BaseCalculator):
    def get_calculator(self):
        cache_key = (self.model, self.model_path, self.device)
        if cache_key not in _model_cache:
            _model_cache[cache_key] = self._load_model()
        return _model_cache[cache_key]
```

Effort: ~30 minutes. Eliminates redundant model loading on repeated requests.

**B. Hessian Support**

Expose MACE's Hessian computation for TS methods:

```python
# Add to optimization runner
def get_hessian(atoms, calculator):
    """Compute full Hessian matrix using MACE model."""
    from mace.tools import torch_geometric
    # MACE models support compute_hessian=True in their forward pass
    ...
```

Effort: ~1-2 hours. Enables proper Sella TS search and future CCQN integration.

### Phase 2: Batch Inference

Add a batch calculation method that collates multiple structures:

```python
class MACEBatchCalculator:
    def calculate_batch(self, atoms_list):
        """Process multiple structures in one forward pass."""
        from mace.tools.torch_geometric import atoms_to_batch
        batch = atoms_to_batch(atoms_list)
        results = self.model(batch)
        # Split results back to per-structure
        ...
```

Effort: ~1-2 days. Major speedup for NEB and parallel workloads.

### Phase 3: GPU Inference Server (for Expanse)

Build a lightweight FastAPI server (we already use FastAPI in our server) that:

1. Loads MACE model(s) on GPU at startup
2. Accepts structures via HTTP POST
3. Auto-batches concurrent requests
4. Returns results via polling or WebSocket

Then add a `MACERemoteCalculator` to `server/calculators/` that acts as a client
to this server -- same pattern as SuperMace's `MACEOnlineCalculator`.

Effort: ~3-5 days. Enables the full Expanse deployment pattern.

### Phase 4: CCQN Optimizer

Implement the Cone-Constrained Quasi-Newton method as an ASE-compatible optimizer
that works with any calculator (local MACE, remote MACE, VASP, etc.):

- Cone-constrained step in the positive-definite region
- Automatic switch to P-RFO near the saddle point
- Uses Hessian from Phase 1B

Effort: ~1-2 weeks (requires careful reading of the CCQN paper).

## 5. Summary

| Feature | Current CatGO | SuperMace | Proposed |
|---------|--------------|-----------|----------|
| Single-structure inference | Yes | Yes | Yes |
| Model caching | No | Yes | Phase 1A |
| Hessian calculation | No | Yes | Phase 1B |
| Batch inference | No | Yes | Phase 2 |
| GPU inference server | No | Yes | Phase 3 |
| Remote ASE calculator | No | Yes | Phase 3 |
| Committee/ensemble mode | No | Yes | Phase 3+ |
| CCQN TS optimizer | No | No | Phase 4 |

The phased approach lets us get immediate value (caching, Hessians) while
building toward the full HPC deployment on Expanse.
