# LAMMPS Script Validation & Generation

**When to use:** Validate LAMMPS input scripts (.in files) for syntax errors and parameter conflicts before running MD simulations. Generate LAMMPS input scripts from workflow node parameters.

**Prerequisites:**
- LAMMPS installed on HPC or local system
- Input structure (PDB, MOL2, or LAMMPS data file)
- Understanding of potential types and force fields

## Workflow Steps

### 1. Validate Existing LAMMPS Script

If you have a custom `in.lammps` script:
- Check syntax errors (missing semicolons, invalid commands)
- Verify command ordering (bond_style before read_data, etc.)
- Confirm parameter compatibility (e.g., PPPM with charged atoms)
- Detect mismatches between script and data file

```bash
# Use the validation skill
Input: in.lammps script content
Output: List of errors or "Script is valid"
```

### 2. Generate LAMMPS Script from Parameters

If you have workflow node parameters (potential type, temperature, steps, etc.):
- Auto-generate correct command sequence
- Set force field parameters automatically
- Include ensemble fixes (NVT/NPT/NVE)
- Add thermodynamic output and trajectory dumps

```bash
# Use the generation skill
Input: Node parameters (potential_type, temperature, steps, etc.)
Output: Complete in.lammps script ready to run
```

### 3. Workflow Integration

In CatGo MD nodes:
1. **MD Node** — Classical MD simulations with NVT/NPT/NVE ensembles
2. **MD Minimize Node** — Energy minimization with conjugate gradient or FIRE
3. **Packmol Option** — Build initial box from molecules (MD Minimize only)

## Key Parameters

### Potential Type

- **Force Field** (GAFF2, OPLS-AA, COMPASS) — Auto-generates bonds, angles, charges
- **Lennard-Jones** — Simple pair-wise LJ potential
- **CHARMM** — With long-range Coulomb (PPPM kspace)
- **Buckingham** — For ionic materials
- **EAM** — For metals (copper, aluminum, etc.)
- **Tersoff** — For covalent materials (Si, Ge)
- **Custom** — Manual pair_style and coefficients

### Ensemble

- **NVE** — Microcanonical (constant energy)
- **NVT** — Canonical (constant temperature, Berendsen thermostat)
- **NPT** — Isothermal-isobaric (constant T and P)
- **Minimize** — Energy minimization (CG, SD, FIRE)

### Force Field Settings

Auto-configured based on potential type:

| Potential | Pair Style | Kspace | Bond/Angle |
|-----------|-----------|--------|-------------|
| Force Field | lj/charmm/coul/long | PPPM | Auto |
| CHARMM | lj/charmm/coul/long | PPPM | harmonic |
| OPLS-AA | lj/charmm/coul/long | PPPM | harmonic |
| EAM | eam/alloy | None | N/A |
| Tersoff | tersoff | None | N/A |

## Common Issues & Fixes

### Issue: "Pair style mismatch with data file"
**Cause:** Data file has bonds but script uses atom_style=atomic
**Fix:** Change atom_style to "full" or "molecular"

### Issue: "PPPM setup error"
**Cause:** Using PPPM without charged atoms or with non-periodic boundary
**Fix:** Remove kspace_style or set boundary to periodic (ppp)

### Issue: "Minimize never converges"
**Cause:** Energy tolerance (etol) too small or maxiter too low
**Fix:** Increase etol to 1e-4 or maxiter to 50000

### Issue: "Temperature oscillates wildly in NVT"
**Cause:** Thermostat damping too large or timestep too large
**Fix:** Reduce timestep or adjust thermostat Tdamp parameter

## Example Workflows

### Minimize LJ fluid

```
Structure (PDB) → MD Minimize Node
  - Potential: Lennard-Jones
  - Min Style: CG
  - Max Iter: 10000
  - Etol: 1e-6
→ Output: trajectory.dump, system_minimized.data
```

### Pack and relax water

```
Water molecule (PDB) → MD Minimize Node
  - Packmol: enabled (100 molecules, 1.0 g/cm³)
  - Force Field: GAFF2
  - Charge: Gasteiger
  - Min Style: FIRE
  - Etol: 1e-4
→ Output: packed structure, minimized trajectory
```

### NVT MD for protein

```
Protein structure (PDB) → MD Node
  - Force Field: OPLS-AA
  - Ensemble: NVT
  - Temperature: 300 K
  - Steps: 100000
  - Timestep: 1.0 fs
→ Output: trajectory.dump, thermodynamic data
```

## Validation Checklist

Before running MD:

- [ ] Data file has atoms matching atom_style
- [ ] Pair style compatible with potential type
- [ ] Bonds/angles only if molecule or full atom_style
- [ ] Kspace only if periodic (ppp) with charged atoms
- [ ] Timestep < 5 fs (1 fs typical for all-atom)
- [ ] Thermo freq < total steps
- [ ] Dump freq for trajectory output
- [ ] Temperature/pressure values reasonable
- [ ] Min_style and tolerances set for minimization

## References

- LAMMPS Manual: https://lammps.sandia.gov/doc/Manual.html
- Force Field Database: https://www.ff14sb.net/ (AMBER)
- OPLS-AA Parameters: https://zarbi.chem.yale.edu/oplsaal/
