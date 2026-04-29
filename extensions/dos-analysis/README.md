# CatGo DOS Analysis Extension

This extension provides advanced tools for Density of States (DOS) analysis in materials science.

## Capabilities

- **Bader Charge Analysis**: Parser for VASP `ACF.dat` files.
- **d-Band Center**: Computation of d-band centers, widths, and filling (important for catalysis).
- **Projected DOS (PDOS)**: Grouping and orbital-specific projections.
- **VaspData Sessions**: Manages server-side HDF5/XML sessions for fast DOS/Bands browsing.

## Implementation

The logic resides in `catgo_dos/` and integrates with the `VaspData` session manager in the Python backend.
