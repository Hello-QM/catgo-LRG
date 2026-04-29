# CatGO Live Demo: High-Throughput Catalyst Screening

## Before You Start

```bash
cd ~/CatGO && pnpm desktop:serve
```

Check calculators: http://localhost:8000/api/optimize/calculators
EMT (always available) works with metals: Cu, Ag, Au, Ni, Pd, Pt, Al.

---

## Step 1: Import Structure

**GUI:** I/O pane → Import → OPTIMADE Search (database icon)

1. Search: formula = `Cu`, database = Materials Project
2. Select **mp-30** (FCC Cu, Fm-3m)
3. Click **Load**

**Talking point:** "CatGO pulls structures from 20+ crystallographic databases via the OPTIMADE standard — no file downloads needed."

---

## Step 2: Create Pure Slab

**GUI:** Build → Slab tab

1. Open Build panel (hammer icon)
2. Select **Slab** tab
3. Miller indices: **h=1, k=1, l=1** (Cu(111) — most catalytically active face)
4. Layers = **2** (fine for demo; use 3-4 for real research)
5. In-plane supercell: **3×3**
6. Watch the real-time 3D preview
7. Click **Apply**

**Talking point:** "The slab preview updates in real-time. Cu(111) is the most stable FCC face and the most studied for catalysis."

---

## Step 3: Add Dopants

**GUI:** Build → Doping tab

**IMPORTANT:** Use "By Selection" mode, NOT "By Element"!
- "By Element" replaces ALL atoms of that element (bulk substitution)
- "By Selection" replaces only the atoms you click (dilute doping)

1. In GROUP 1, switch to **"By Selection"**
2. In the 3D viewer, **click 2-3 surface Cu atoms** (top-layer atoms near the center)
3. Click **"Capture Selection"** to lock the indices
4. On the periodic table, click **one element** (e.g., **Ni**)
5. Click **Generate Structures**
6. The viewer updates with your doped slab

**Talking point:** "We select specific surface sites and substitute them — realistic dilute doping for modeling single-atom or few-atom catalytic dopants."

---

## Step 4: Build & Run the Workflow

**GUI:** Workflow toolbar icon → "+ New Workflow (with current structure)"

This creates a new workflow with your doped slab pre-loaded.

### Wire the nodes

```
[Structure Input] → [Doping Gen] → [Geometry Optimization] → [Energy Compare] → [Export]
```

### Configure each node (click node → right panel)

| Node | Key Settings |
|------|-------------|
| **Structure Input** | Already has your doped slab |
| **Doping Gen** | Dopant: **Ni**, Count: **3**, Target: leave empty (auto-detects Cu) |
| **Geometry Optimization** | Software: **MLP (MACE)**, Max steps: **100** |
| **Energy Compare** | Metric: **relative_stability** |
| **Export** | Format: **ASE Database (.db)** |

### Run

1. Click **Run** → select **Local** execution mode → **Start**
2. Watch nodes turn green as they complete
3. Export node creates files in `~/CatGO/exports/<workflow-id>/`

### Output files

| File | Contents |
|------|----------|
| `results.db` | ASE database with optimized structure + energy |
| `results.json` | Summary: formula, energy, relative energies |
| `structure_*.vasp` | Optimized structure in VASP/POSCAR format |

Click **Browse Files** on the Export node to view outputs.

---

## Step 5: Compare Multiple Dopants

To screen multiple dopant elements, **run the workflow multiple times** with different dopants:

1. Go back to the pure Cu(111) slab (undo doping, or reload from Step 2)
2. Create a new workflow → change Doping Gen dopant to **Pd**
3. Run → Export
4. Repeat for **Pt**, **Au**, etc.

**Tip:** Save all workflows to the **same project** in the sidebar for easy comparison.

### View results

1. **Sidebar** → Local DB → your project
2. **Results Table** tab: all structures with energies, sortable by formula/energy
3. **Results Plot** tab: bar or scatter plot comparing energies across dopants

**Talking point:** "Each dopant produces a different formation energy. Lower energy = more thermodynamically favorable substitution. We can rank Cu(111) dopants by stability."

---

## Step 6: Geometry Optimization (manual/interactive)

For quick single-structure optimization without a workflow:

**GUI:** Analysis → Optimize

1. With a doped structure loaded, open **Optimize**
2. Select calculator: **EMT** (instant for metals)
3. Click **Optimize**
4. Watch energy curve converge in real-time

---

## Step 7: Add Adsorbates

**GUI:** Build → Adsorbate tab

1. Load optimized doped slab
2. Select preset: **CO** (classic probe molecule)
3. Click **Find Sites** → site markers appear on surface (both top and bottom)
4. Choose a **top-surface** site near the dopant atom (rotate to side view to identify top vs bottom)
5. Height: ~2.0 Å
6. Click **Place**
7. For relaxation, use **EMT** from the Quick Optimize dropdown

**WARNING:** Do NOT use UFF Quick Optimize on slabs (100+ atoms). UFF is for small molecules only — it will freeze the UI. Use EMT instead.

**Talking point:** "CatGO finds adsorption sites using alpha shapes on both slab faces, then you click to place on the surface of interest."

---

## Step 8: Adsorption Energy

**Formula:**
```
E_ads = E(slab+adsorbate) - E(slab) - E(adsorbate_gas)
```

To compute manually:
1. Note the energy of the clean doped slab (from Step 4 export)
2. Optimize the slab+CO system (Step 7)
3. Note the optimized energy
4. Subtract: E_ads = E(slab+CO) - E(clean_slab) - E(CO_gas)

Or use CatBot: "Calculate the adsorption energy of CO on this surface"

---

## Step 9: Analyze & Plot

**GUI:** Analysis pane

- **Coordination analysis**: How dopants change local bonding environment
- **XRD**: Compare diffraction patterns before/after doping
- **Project Dashboard**: Results Table (sortable) + Results Plot (bar/scatter/line charts)
  - X-axis: formula, energy, energy_per_atom, volume, lattice params
  - Y-axis: same options
  - Color by: node_type, workflow_name, formula

**Talking point:** "The Project Dashboard gives an at-a-glance comparison of all screening candidates — you can immediately see which dopant gives the lowest energy."

---

## Step 10: Report

Use **CatBot**: "Summarize the screening results for Cu(111) with Ni, Pd, Pt, Au dopants. Include formation energies and CO adsorption energies."

Or use exported files directly:
- `results.db` → open with ASE: `ase db results.db` or `python -c "from ase.db import connect; db = connect('results.db'); print(list(db.select()))"`
- `results.json` → parse with any JSON tool
- `structure_*.vasp` → load into VESTA, ASE, or any atomistic viewer

---

## Quick Demo Version (90 seconds)

| Step | Action | Time |
|------|--------|------|
| 1 | OPTIMADE search → load Cu | 15s |
| 2 | Build → Slab → Cu(111) 3×3, 2 layers | 20s |
| 3 | Build → Doping → select sites, replace with Ni | 10s |
| 4 | Workflow → Structure Input → Doping Gen → Geo Opt → Energy Compare → Export | 20s |
| 5 | Run (Local) → watch nodes complete | 10s |
| 6 | Browse Files → show exported .db + .vasp + .json | 10s |

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| UFF Quick Optimize freezes UI | UFF blocks main thread, too slow for 100+ atoms | Use EMT instead |
| "No atoms in structure" after optimize | UFF bug (fixed) — old code passed wrong object | Update to latest code |
| Old structure persists after restart | Backend process survived browser close | Restart with Ctrl+C then `pnpm desktop:serve` |
| Export node shows no files | Export was a stub (fixed) | Update to latest code, check `~/CatGO/exports/` |
| Browse Files button does nothing | Only worked for HPC (fixed) | Update to latest code |
| Workflow run button grayed out | Need to select execution mode | Click Run → select **Local** → Start |
