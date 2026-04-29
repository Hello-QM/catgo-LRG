# CatGo COHP Analysis Extension

This extension provides tools for Crystal Orbital Hamilton Population (COHP) analysis of DFT calculation results.

## Capabilities

- **LOBSTER Parser**: Parse COHPCAR, ICOHPLIST, and DOSCAR.LOBSTER files.
- **Bond Analysis**: Analyze bonding vs. anti-bonding interactions for specific atom pairs.
- **Integration**: Works with the CatGo backend to provide visual COHP plots in the frontend.

## Implementation

The core logic is implemented in the `catgo_cohp/` directory using `pymatgen.command_line.lobster_caller` and related utilities.
