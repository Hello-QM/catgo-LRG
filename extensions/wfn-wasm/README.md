# wfn-wasm — built-in wavefunction engine

Loads `.fchk` / `.molden` / `.wfn` / `.wfx` files and computes, entirely in
the browser:

- orbitals, the electron density, its gradient and Hessian on grids
- IRI and sign(λ2)ρ (weak and covalent interactions)
- IGMH δg_inter between fragments (Hirshfeld partition with built-in
  free-atom densities)
- the electrostatic potential (own McMurchie–Davidson integrals), evaluated
  near the ρ = 0.001 a.u. surface and exactly at surface extrema
- QTAIM critical points with ρ, ∇²ρ, G, V, H, ELF, ellipticity, η and the
  bond paths

It is compiled to WebAssembly (`pnpm build:wasm`, target `wfn`) and runs in a
pool of Web Workers (`src/lib/wavefunction/engine.ts`); neither the backend nor
an external Multiwfn executable is involved.

## Citation

The algorithms are ported from **Multiwfn** (Tian Lu, http://sobereva.com/multiwfn).
Work that uses these analyses must cite:

- Tian Lu, Feiwu Chen, *J. Comput. Chem.* **33**, 580–592 (2012)
- Tian Lu, *J. Chem. Phys.* **161**, 082503 (2024)

## Notice

- Scope: `extensions/wfn-wasm/src/` (Rust, compiled to WebAssembly for the
  orbital, electron-density and IRI analyses in the wavefunction panel)
- Upstream: Multiwfn by Tian Lu, http://sobereva.com/multiwfn — ported from
  the 2026.10.1 source distribution
- Ported routines: `readfch`, `readmolden`, `readwfn`, `readwfx`
  (`fileIO.f90`); `gensphcartab`, `normgau`, `renormmoldengau`,
  `renormgau_ORCA`, `genn1n2nf` (`sub.f90`); `orbderv`, `calchessmat_dens`,
  `EDFrho`, `signlambda2rho_RDG`, `IRI_s2lr` (`function.f90`); the
  low/medium/high branches of `setgrid` (`grid.f90`); the `type2ix/iy/iz`
  and `shtype2nbas` tables (`define.f90`); `IGMgrad_Hirsh`,
  `delta_g_inter_Hirsh`, `proatmgrad`, `nucesp` (`function.f90`) with
  `lagintpol` (`util.f90`) and the free-atom radial densities of
  `atmraddens.f90` (`src/atom_densities.rs`, generated); `findcp`,
  `findpath` and the CP search modes of `topology.f90`, `Lagkin` and
  `ELF_LOL` (`function.f90`), the Bondi radii of `define.f90`. The Rust code
  reorganises the evaluation per shell. The electronic ESP uses
  McMurchie–Davidson integrals written for CatGo; the LIBRETA integral
  library shipped with Multiwfn (`libreta_hybrid/`) is not used.
- License terms stated on the official Multiwfn page: Multiwfn is free and
  open-source for academic and commercial use, and anyone may distribute the
  original or modified code; it may be used as a free component of commercial
  code, but selling a modified version requires Tian Lu's consent; it comes
  with no warranty. Code that incorporates any part of Multiwfn must cite, in
  the main text of the paper or in the code:
  - Tian Lu, Feiwu Chen, J. Comput. Chem. 33, 580–592 (2012)
  - Tian Lu, J. Chem. Phys. 161, 082503 (2024)

Both citations are repeated in the crate's source header and shown in the
wavefunction panel. The crate's tests compare its results with PySCF, not
with Multiwfn output.


## Tests

`cargo test --release` compares ρ, ∇ρ, the Hessian of ρ, the HOMO and the ESP
with PySCF at sample points for every format (`tests/data`: PySCF
calculations written as Molden by PySCF and converted to the other formats
with IOData), checks Tr(P·S) = N, the derivatives against finite differences,
that each free-atom density integrates to Z, the QTAIM topology of water and
the water dimer (Poincaré–Hopf, the hydrogen-bond critical point) and that
IGMH picks out the dimer's hydrogen bond.

`cargo run --release --example check -- FILE…` prints the electron count and
Tr(P·S) of any files, the same sanity check Multiwfn does when it loads a
file.
