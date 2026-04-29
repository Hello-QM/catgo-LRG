---
name: data-router
description: >
  Route data processing requests to the appropriate tool. Covers format conversion
  (dpdata, OpenBabel), structure packing (Packmol), and data manipulation.
compatibility: >
  Tools are Python packages or standalone binaries. Check individual sub-skills for requirements.
---

# Data Processing Router

Route data processing and format conversion requests to the correct sub-skill.

## Routing Table

| User intent | Route to |
|---|---|
| Convert DFT output (VASP/QE/CP2K) to DeePMD/other format | `dpdata/SKILL.md` |
| Convert molecular file formats (mol2, sdf, pdb, smiles) | `openbabel/SKILL.md` |
| Build liquid/mixture/solution simulation boxes | `packmol/SKILL.md` |

## Quick Decision Guide

- "Convert OUTCAR to DeePMD" / "make training data" → `dpdata/SKILL.md`
- "Convert SMILES to 3D" / "mol2 to pdb" / "add hydrogens" → `openbabel/SKILL.md`
- "Pack molecules in box" / "water box" / "mixture" → `packmol/SKILL.md`
- "Build slab" / "add adsorbate" → use CatGo's `structure/SKILL.md` instead
