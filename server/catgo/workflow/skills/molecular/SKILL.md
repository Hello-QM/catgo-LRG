---
name: molecular-router
description: >
  Route molecular modeling tool requests. Covers RDKit (conformers, representations,
  fingerprints) and AmberTools antechamber (force field parameterization).
compatibility: >
  Requires RDKit and/or AmberTools installed depending on sub-skill.
---

# Molecular Tools Router

Route molecular-level tool requests to the correct sub-skill.

## Routing Table

| User intent | Route to |
|---|---|
| Conformer generation, SMILES/InChI parsing, molecular fingerprints | `rdkit/SKILL.md` |
| GAFF/AMBER force field parameterization, RESP charges | `antechamber/SKILL.md` |

## Quick Decision Guide

- "Generate conformers" / "SMILES to 3D" / "molecular fingerprint" → `rdkit/SKILL.md`
- "Parameterize molecule" / "GAFF" / "RESP charges" / "AMBER prep" → `antechamber/SKILL.md`
- "Convert mol2 to pdb" / "add hydrogens" → use `data/openbabel/SKILL.md` instead
- "Pack molecules into box" → use `data/packmol/SKILL.md` instead
