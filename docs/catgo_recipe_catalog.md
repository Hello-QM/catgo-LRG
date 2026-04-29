# CatGo Workflow Recipe Catalog

Last updated: 2026-03-13

## Recipe Index

| # | Recipe | Execution path | HPC required |
|---|--------|---------------|--------------|
| 1 | VASP Double Relaxation | Python HPC | Yes |
| 2 | VASP Electronic Structure | Python HPC | Yes |
| 3 | VASP MP r²SCAN MetaGGA | Python HPC | Yes |
| 4 | CP2K Optimization + Static | Python HPC | Yes |
| 5 | CP2K Vibrational Analysis | Python HPC | Yes |
| 6 | ORCA Geometry Optimization | Rust-native | No |
| 7 | ORCA Transition State Search | Rust-native | No |
| 8 | MLP MD Pipeline (local) | Rust-native | No |
| 9 | Surface Catalysis (VASP) | Python HPC | Yes |
| 10 | Multi-fidelity MLP → DFT | Python HPC | Yes |
| 11 | Elastic Tensor | Python HPC | Yes |
| 12 | Band Structure | Python HPC | Yes |

---

## 1. VASP Double Relaxation

**Graph:**
```
structure_input → vasp_relax (coarse) → vasp_relax (fine) → vasp_static
```

**Execution path:** Python HPC adapters

**Inputs:**
- Crystal structure (loaded in viewer)
- HPC session with VASP + POTCAR configured
- ENCUT, KPOINTS, EDIFF/EDIFFG settings

**Node parameters:**

| Node | Key params |
|---|---|
| vasp_relax (coarse) | ENCUT=400, EDIFFG=-0.05, ISIF=3, NSW=100, PREC=Normal |
| vasp_relax (fine) | ENCUT=520, EDIFFG=-0.02, ISIF=3, NSW=200, PREC=Accurate |
| vasp_static | ENCUT=520, NSW=0, ISMEAR=-5 |

**Artifacts per step:**
- INCAR, POSCAR, KPOINTS, POTCAR (generated)
- CONTCAR (output structure, fed to next step)
- OUTCAR, vasprun.xml (results)

**Template ID:** `vasp_double_relax`

---

## 2. VASP Electronic Structure

**Graph:**
```
structure_input → vasp_relax → electronic → dos_analysis
                                          → charge_analysis
```

**Execution path:** Python HPC adapters

**Inputs:**
- Crystal structure
- HPC session

**Node parameters:**

| Node | Key params |
|---|---|
| vasp_relax | ENCUT=520, EDIFFG=-0.02, ISIF=3 |
| electronic | analysis="dos,bader", NEDOS=3001, LORBIT=11 |

**Artifacts:**
- DOSCAR (density of states)
- AECCAR0/AECCAR2 (charge density for Bader)
- Analysis results in workflow DB

**Template ID:** `vasp_electronic`

---

## 3. VASP MP r²SCAN MetaGGA

**Graph:**
```
structure_input → vasp_relax (PBEsol pre-relax)
               → vasp_relax (r²SCAN coarse)
               → vasp_relax (r²SCAN fine)
               → vasp_static (r²SCAN)
```

**Execution path:** Python HPC adapters

**Node parameters:**

| Node | Key params |
|---|---|
| Pre-relax | GGA=PS, ENCUT=400, EDIFFG=-0.05 |
| r²SCAN coarse | METAGGA=R2SCAN, ENCUT=520, EDIFFG=-0.05 |
| r²SCAN fine | METAGGA=R2SCAN, ENCUT=520, EDIFFG=-0.02 |
| Static | METAGGA=R2SCAN, ENCUT=520, NSW=0, ISMEAR=-5 |

**Template ID:** `vasp_mp_metagga`

---

## 4. CP2K Optimization + Static

**Graph:**
```
structure_input → cp2k_cellopt → cp2k_static → export_data
```

**Execution path:** Python HPC adapters

**Inputs:**
- Crystal structure
- HPC session with CP2K installed

**Node parameters:**

| Node | Key params |
|---|---|
| cp2k_cellopt | functional=PBE, basis=DZVP-MOLOPT, cutoff=400 |
| cp2k_static | functional=PBE, basis=DZVP-MOLOPT, cutoff=400 |

**Template ID:** `cp2k_opt_static`

---

## 5. CP2K Vibrational Analysis

**Graph:**
```
structure_input → cp2k_geopt → cp2k_freq → analysis
```

**Execution path:** Python HPC adapters

**Template ID:** `cp2k_vibrational`

---

## 6. ORCA Geometry Optimization

**Graph:**
```
structure_input → orca_opt → orca_freq
```

**Execution path:** Rust-native (via tool_bridge)

**Inputs:**
- Molecular structure (loaded in viewer)
- ORCA installed locally or on accessible path

**Node parameters:**

| Node | Key params |
|---|---|
| orca_opt | method=B3LYP, basis=def2-SVP, nprocs=4 |
| orca_freq | method=B3LYP, basis=def2-SVP, nprocs=4 |

**Artifacts:**
- ORCA .inp input file
- ORCA .out output file
- .xyz optimized geometry
- Frequency table in workflow results

**Template ID:** (build manually or via CatBot)

---

## 7. ORCA Transition State Search

**Graph:**
```
structure_input → orca_neb_ts → orca_freq → condition (imaginary freq?)
                                           ├ yes → orca_irc
                                           └ no → (done)
```

**Execution path:** Rust-native

**Template ID:** (build manually)

---

## 8. MLP MD Pipeline (local)

**Graph:**
```
structure_input → mlp_md → md_analysis → export_data
```

**Execution path:** Rust-native (when execution_mode=local)

**Inputs:**
- Structure
- MLP model (MACE, CHGNet, or M3GNet)

**Node parameters:**

| Node | Key params |
|---|---|
| mlp_md | model=mace_mp_0, temperature=300, steps=10000, timestep=1.0 |

**Artifacts:**
- Trajectory file (.extxyz)
- MD analysis results (RDF, MSD, temperature)

**Template ID:** `mlp_md_pipeline`

---

## 9. Surface Catalysis (full pipeline)

**Graph:**
```
structure_input → bulk_opt → slab_gen → adsorbate_place
               → slab_relax → vasp_static → frequency → free_energy
```

**Execution path:** Python HPC adapters

**Description:** Full catalysis pipeline from bulk crystal to adsorption free energy. Generates slab, places adsorbate, relaxes, computes frequencies, derives thermodynamic corrections.

**Template ID:** `full_catalysis`

---

## 10. Multi-fidelity MLP → DFT

**Graph:**
```
structure_input → mlp_relax → convergence_check
               → vasp_relax → vasp_static → export_data
```

**Execution path:** Python HPC adapters (vasp_relax present)

**Description:** Pre-screen with fast ML potential, then refine with DFT. Convergence check validates MLP result quality before committing to expensive VASP.

**Template ID:** `mlp_pre_dft`

---

## 11. Elastic Tensor

**Graph:**
```
structure_input → vasp_relax → loop (deformed structures)
               → vasp_relax (each) → merge → analysis → export_data
```

**Execution path:** Python HPC adapters

**Description:** Generates strained structures, relaxes each, fits elastic constants.

**Template ID:** `elastic_tensor`

---

## 12. Band Structure

**Graph:**
```
structure_input → vasp_relax → vasp_static → electronic (bands)
```

**Execution path:** Python HPC adapters

**Template ID:** `band_structure`

---

## Creating Custom Workflows

### Via CatBot (MCP)

```
User: "Create a workflow with structure input, VASP relaxation, then DOS analysis"
CatBot: → catgo_workflow(action="create", name="My DOS workflow")
        → catgo_workflow(action="add_node", node_type="vasp_relax", ...)
        → catgo_workflow(action="add_node", node_type="electronic", ...)
        → catgo_workflow(action="connect", ...)
```

### Via Workflow Editor UI

1. Open Workflow Editor
2. Drag nodes from palette
3. Connect edges
4. Set parameters per node
5. Click Validate
6. Click Run → configure HPC settings → submit

### Via Template

```
POST /api/workflow/from-template/vasp_double_relax
```

Creates a pre-configured workflow from a built-in template.
