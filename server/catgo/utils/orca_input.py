"""ORCA input file generation utilities."""

from typing import Optional, Dict, Any
from pymatgen.core import Structure, Molecule


def _structure_to_xyz_string(structure: Any, charge: int = 0, multiplicity: int = 1) -> str:
    """Convert a structure to XYZ format string.

    Args:
        structure: pymatgen Structure or Molecule object
        charge: Molecular charge
        multiplicity: Spin multiplicity

    Returns:
        XYZ format string (without xyz header lines, just atoms)
    """
    lines = []

    try:
        if isinstance(structure, dict):
            structure = Structure.from_dict(structure)
    except (TypeError, KeyError, ValueError):
        pass

    if not hasattr(structure, 'sites'):
        raise AttributeError(f"Structure object has no 'sites' attribute. Type: {type(structure)}")

    for site in structure.sites:
        # Extract element symbol from species
        element = "X"  # default fallback
        if hasattr(site, 'species_string'):
            element = site.species_string.split(":")[0] if ":" in site.species_string else site.species_string
        elif hasattr(site, 'species'):
            # Try species property (dict or list format)
            if isinstance(site.species, dict):
                element = list(site.species.keys())[0] if site.species else "X"
            elif isinstance(site.species, (list, tuple)) and len(site.species) > 0:
                sp = site.species[0]
                element = sp.get('element') if isinstance(sp, dict) else str(sp)

        x, y, z = site.xyz
        lines.append(f"{element:3s} {x:12.8f} {y:12.8f} {z:12.8f}")

    return "\n".join(lines)


def _structure_to_xyz_file_content(structure: Any) -> str:
    """Convert a structure to XYZ file format (with header).

    Args:
        structure: pymatgen Structure/Molecule dict or object

    Returns:
        XYZ file content (with atom count and comment line)
    """
    # Handle raw dict format (from API serialization)
    if isinstance(structure, dict):
        # Try direct dict access first before converting
        if "sites" in structure and isinstance(structure["sites"], list):
            lines = [str(len(structure["sites"])), "Coordinates from CatGO"]

            for site_dict in structure["sites"]:
                element = _extract_element_from_site_dict(site_dict)

                # Get coordinates
                if "xyz" in site_dict:
                    coords = site_dict["xyz"]
                elif "coordinates" in site_dict:
                    coords = site_dict["coordinates"]
                else:
                    raise ValueError(f"No coordinates found in site: {site_dict}")

                x, y, z = float(coords[0]), float(coords[1]), float(coords[2])
                line = f"{element:>2s} {x:>18.14f} {y:>18.14f} {z:>18.14f}"
                lines.append(line)

            return "\n".join(lines)

        # Fall back to Structure.from_dict if direct dict parsing fails
        try:
            structure = Structure.from_dict(structure)
        except (TypeError, KeyError, ValueError) as e:
            raise ValueError(f"Failed to parse structure dict: {e}")

    # Verify it's a valid structure object
    if not hasattr(structure, 'sites'):
        raise AttributeError(f"Structure object must have 'sites' attribute. Got type: {type(structure)}")

    if not structure.sites or len(structure.sites) == 0:
        raise ValueError("Structure has no atoms/sites")

    lines = []

    # XYZ file header
    lines.append(str(len(structure.sites)))
    lines.append("Coordinates from CatGO")

    # Atomic coordinates
    for site in structure.sites:
        element = _extract_element_from_site_object(site)

        # Get coordinates - validate they're floats
        try:
            coords = site.xyz
            x = float(coords[0])
            y = float(coords[1])
            z = float(coords[2])
        except (ValueError, TypeError, IndexError) as e:
            raise ValueError(f"Invalid coordinates for site: {e}")

        # Format: Element symbol (right-aligned 2 chars) + coordinates with consistent spacing
        line = f"{element:>2s} {x:>18.14f} {y:>18.14f} {z:>18.14f}"
        lines.append(line)

    return "\n".join(lines)


def _extract_element_from_site_dict(site_dict: Dict[str, Any]) -> str:
    """Extract element symbol from a site dict (from pymatgen serialization).

    Args:
        site_dict: Dictionary with site data

    Returns:
        Element symbol (1-2 characters)
    """
    element = None

    # Method 1: Direct species list with element dicts
    if "species" in site_dict and isinstance(site_dict["species"], list):
        if len(site_dict["species"]) > 0:
            first_species = site_dict["species"][0]
            if isinstance(first_species, dict) and "element" in first_species:
                element = first_species["element"]
            elif isinstance(first_species, str):
                element = first_species

    # Method 2: Direct element field
    if not element and "element" in site_dict:
        element = site_dict["element"]

    # Method 3: Label extraction
    if not element and "label" in site_dict:
        label = str(site_dict["label"]).strip()
        element = ''.join([c for c in label if c.isalpha()])[:2]

    # Fallback
    if not element:
        element = "X"

    # Clean up
    element = str(element).strip()
    if len(element) > 2:
        element = element[:2]

    return element


def _extract_element_from_site_object(site: Any) -> str:
    """Extract element symbol from a pymatgen Site object.

    Args:
        site: pymatgen Site object

    Returns:
        Element symbol (1-2 characters)
    """
    element = None

    # Method 1: Direct element property with symbol
    if hasattr(site, 'element') and site.element:
        try:
            el = site.element
            if hasattr(el, 'symbol'):
                element = el.symbol
            else:
                element = str(el).strip()
        except Exception:
            pass

    # Method 2: species dict or list - most likely to work with pymatgen structures
    if not element and hasattr(site, 'species') and site.species:
        try:
            species = site.species
            if isinstance(species, dict):
                # species is a dict: {Element: fraction}
                first_key = list(species.keys())[0]
                # The key might be an Element object or string
                if hasattr(first_key, 'symbol'):
                    element = first_key.symbol
                else:
                    element = str(first_key).strip()
            elif isinstance(species, (list, tuple)) and len(species) > 0:
                # species is a list of Species objects
                first_species = species[0]
                if hasattr(first_species, 'element'):
                    el = first_species.element
                    if hasattr(el, 'symbol'):
                        element = el.symbol
                    else:
                        element = str(el).strip()
        except Exception:
            pass

    # Method 3: species_string property
    if not element and hasattr(site, 'species_string') and site.species_string:
        try:
            element = site.species_string.split(":")[0].strip()
        except Exception:
            pass

    # Method 4: Check if site has label or name
    if not element:
        try:
            if hasattr(site, 'label') and site.label:
                label = str(site.label).strip()
                # Extract element from labels like "Fe1", "O2a", etc.
                element = ''.join([c for c in label if c.isalpha()])[:2]
        except Exception:
            pass

    # Fallback
    if not element:
        element = "X"

    # Clean up
    element = str(element).strip()
    if len(element) > 2:
        element = element[:2]

    return element


def generate_orca_neb_inputs(request: Any) -> Dict[str, str]:
    """Generate ORCA NEB-TS input file and structure files for transition state search.

    Args:
        request: Object with structure_reactant, structure_product, and NEB parameters

    Returns:
        Dictionary with 'inp', 'reactant_xyz', 'product_xyz', and optional 'notes' keys
    """
    method = request.method or "B3LYP"
    basis_set = request.basis or "6-31G"
    wavefunction = getattr(request, 'wavefunction', None)
    uno = getattr(request, 'uno', False)
    uco = getattr(request, 'uco', False)
    nimages = request.nimages or 8
    ts_opt = request.ts_opt if hasattr(request, 'ts_opt') else True
    neb_cycles = request.neb_cycles or 100
    interpolation = request.interpolation or "IDPP"
    charge = request.charge or 0
    multiplicity = request.multiplicity or 1
    num_cores = request.num_cores or 8

    lines = []

    # Header comment
    lines.append("# ORCA NEB-TS input file generated by CatGO")
    lines.append(f"# Method: {method}, Basis set: {basis_set}")
    lines.append(f"# NEB Images: {nimages}")
    lines.append(f"# TS Optimization: {'Yes' if ts_opt else 'No'}")
    lines.append("")

    # Parallelization and memory
    lines.append(f"%pal nprocs {num_cores} end")
    lines.append("%MaxCore 4000")
    lines.append("")

    # Route line with NEB-TS keywords
    route_line = f"! {method} {basis_set} NEB-TS"
    if ts_opt:
        route_line += " Freq"
    if wavefunction:
        route_line += f" {wavefunction}"
    if uno:
        route_line += " UNO"
    if uco:
        route_line += " UCO"
    lines.append(route_line)
    lines.append("")

    # NEB block
    lines.append("%NEB")
    lines.append(f"Product \"product.xyz\"")
    lines.append(f"NImages {nimages}")
    lines.append(f"Interpolation {interpolation}")
    lines.append(f"MaxIter {neb_cycles}")

    if ts_opt:
        lines.append(f"NEB_TS true")
        lines.append(f"CI true")
    else:
        lines.append(f"NEB_TS false")
        lines.append(f"CI false")

    lines.append("END")
    lines.append("")

    # Reference to external reactant.xyz file
    lines.append(f"*xyzfile {charge} {multiplicity} reactant.xyz")
    lines.append("")

    inp_content = "\n".join(lines)

    # Generate XYZ file contents
    reactant_xyz = ""
    product_xyz = ""

    try:
        if request.structure_reactant:
            try:
                reactant_xyz = _structure_to_xyz_file_content(request.structure_reactant)
            except Exception as e:
                import traceback
                print(f"ERROR in reactant structure conversion: {e}")
                print(f"Structure type: {type(request.structure_reactant)}")
                print(traceback.format_exc())
                raise
        else:
            # Placeholder XYZ with blank structure
            reactant_xyz = "0\nPlaceholder reactant structure\n"
    except Exception as e:
        reactant_xyz = f"0\nError converting reactant: {str(e)}\n"

    try:
        if request.structure_product:
            try:
                product_xyz = _structure_to_xyz_file_content(request.structure_product)
            except Exception as e:
                import traceback
                print(f"ERROR in product structure conversion: {e}")
                print(f"Structure type: {type(request.structure_product)}")
                print(traceback.format_exc())
                raise
        else:
            # Placeholder XYZ with blank structure
            product_xyz = "0\nPlaceholder product structure\n"
    except Exception as e:
        product_xyz = f"0\nError converting product: {str(e)}\n"

    # Build notes with setup instructions
    notes = []
    notes.append("**ORCA NEB-TS Setup Complete!**")
    notes.append("")
    notes.append("Three files have been generated:")
    notes.append("")
    notes.append("1. **ORCA.inp** - Main input file with NEB parameters")
    notes.append("2. **reactant.xyz** - Starting structure for NEB path")
    notes.append("3. **product.xyz** - Ending structure for NEB path")
    notes.append("")
    notes.append("**How to use:**")
    notes.append("1. Place all three files in the same directory on HPC")
    notes.append("2. Both structures must have the **same number of atoms**")
    notes.append("3. The NEB will create {} intermediate images between them".format(nimages))
    notes.append("4. ORCA will find the minimum energy path (MEP)")
    notes.append("")
    if ts_opt:
        notes.append("**TS Optimization is ENABLED**: After NEB, the highest-energy")
        notes.append("image will be refined to a true transition state with 1 imaginary frequency.")
    else:
        notes.append("**Note**: TS optimization is disabled. The highest-energy NEB image")
        notes.append("may not be a true transition state (check frequencies after).")

    return {
        "inp": inp_content,
        "reactant_xyz": reactant_xyz,
        "product_xyz": product_xyz,
        "notes": "\n".join(notes)
    }


def generate_orca_irc_inputs(request: Any) -> Dict[str, str]:
    """Generate ORCA IRC input file for intrinsic reaction coordinate following.

    Args:
        request: Object with structure and IRC parameters
                 - structure: embedded TS structure (optional)
                 - external_ts_file: path to external TS XYZ file (optional, takes precedence)

    Returns:
        Dictionary with 'inp', 'ts_xyz', and optional 'notes' keys
    """
    method = request.method or "r2SCAN-3c"
    basis_set = request.basis or "6-31G"
    wavefunction = getattr(request, 'wavefunction', None)
    uno = getattr(request, 'uno', False)
    uco = getattr(request, 'uco', False)
    max_iterations = request.max_iterations or 30
    num_cores = request.num_cores or 4
    charge = request.charge or 0
    multiplicity = request.multiplicity or 1
    external_ts_file = getattr(request, 'external_ts_file', None)  # e.g., "NEB-TS_converged.xyz"

    lines = []

    # Header comment
    lines.append("# ORCA IRC input file generated by CatGO")
    lines.append(f"# Method: {method}, Basis set: {basis_set}")
    lines.append(f"# Max IRC iterations: {max_iterations}")
    lines.append("")

    # Parallelization and memory
    if num_cores > 1:
        lines.append(f"%pal nprocs {num_cores} end")
        lines.append("%maxcore 4000")
        lines.append("")

    # Route line with IRC keyword
    route_line = f"! {method} {basis_set} IRC"
    if wavefunction:
        route_line += f" {wavefunction}"
    if uno:
        route_line += " UNO"
    if uco:
        route_line += " UCO"
    lines.append(route_line)
    lines.append("")

    # IRC block with settings
    lines.append("%IRC")
    lines.append(f"MaxIter {max_iterations}")
    lines.append("END")
    lines.append("")

    # Geometry specification - support both embedded structures and external file references
    if external_ts_file:
        # Mode 1: Reference external TS file (e.g., from NEB-TS output)
        lines.append(f"*xyzfile {charge} {multiplicity} {external_ts_file}")
    elif request.structure:
        # Mode 2: Embed structure directly in INP file
        try:
            structure_dict = request.structure

            # Try to construct Structure from dict
            if isinstance(structure_dict, dict):
                try:
                    structure = Structure.from_dict(structure_dict)
                except (TypeError, KeyError, ValueError):
                    structure = structure_dict  # type: ignore
            else:
                structure = request.structure

            # Check if molecular or periodic
            is_molecular = not hasattr(structure, 'lattice') or structure.lattice is None

            # Geometry block
            lines.append(f"* xyz {charge} {multiplicity}")

            if not hasattr(structure, 'sites'):
                raise AttributeError(f"Structure object has no 'sites' attribute. Type: {type(structure)}")

            for site in structure.sites:
                element = _extract_element_from_site_object(site)
                x, y, z = site.xyz
                lines.append(f"{element:3s} {x:12.8f} {y:12.8f} {z:12.8f}")

            lines.append("*")

        except Exception as e:
            import traceback
            error_detail = f"{type(e).__name__}: {str(e)}"
            print(f"ERROR in ORCA IRC input generation: {error_detail}")
            print(f"Traceback: {traceback.format_exc()}")
            lines.append(f"* xyz {charge} {multiplicity}")
            lines.append("# Error parsing structure - please define geometry manually")
            lines.append(f"# {error_detail}")
            lines.append("*")
    else:
        # Fallback: neither external file nor structure provided
        lines.append(f"* xyz {charge} {multiplicity}")
        lines.append("# Add your TS geometry here")
        lines.append("*")

    inp_content = "\n".join(lines)

    # Build setup notes
    notes = []
    notes.append("**ORCA IRC Setup Complete!**")
    notes.append("")
    notes.append("**Important**: This calculation requires a **transition state structure** as input.")
    notes.append("")
    notes.append("**Output Files**:")
    notes.append("- `IRC_Full_trj.xyz` — Complete IRC trajectory (TS to both products)")
    notes.append("- `IRC_F_trj.xyz` — Forward trajectory (TS → forward direction)")
    notes.append("- `IRC_B_trj.xyz` — Backward trajectory (TS → backward direction)")
    notes.append("- `IRC_F.xyz` — Final structure in forward direction")
    notes.append("- `IRC_B.xyz` — Final structure in backward direction")
    notes.append("")
    notes.append("**How to Use:**")
    notes.append("1. Ensure the input structure is a **true transition state** (found via NEB-TS or OptTS)")
    notes.append("2. Run IRC to trace the reaction path from TS to nearby intermediates")
    notes.append("3. The forward and backward endpoints show connected reactant/product structures")
    notes.append("4. Note: Endpoints are NOT fully optimized—run orca_opt on them for converged structures")
    notes.append("")
    notes.append(f"**Configuration:**")
    notes.append(f"- Method: {method}")
    notes.append(f"- Basis Set: {basis_set}")
    notes.append(f"- Max IRC Iterations: {max_iterations}")

    # Generate ts.xyz file content
    ts_xyz = ""
    try:
        if request.structure:
            ts_xyz = _structure_to_xyz_file_content(request.structure)
        else:
            ts_xyz = "0\nPlaceholder TS structure\n"
    except Exception as e:
        ts_xyz = f"0\nError converting structure: {str(e)}\n"

    return {
        "inp": inp_content,
        "ts_xyz": ts_xyz,
        "notes": "\n".join(notes)
    }


def generate_orca_inputs(request: Any) -> Dict[str, str]:
    """Generate ORCA input file based on structure and parameters.

    Args:
        request: ORCAInputRequest with structure and calculation parameters

    Returns:
        Dictionary with 'inp' and optional 'notes' keys
    """
    method = request.method or "B3LYP"
    basis_set = request.basis_set or "6-31G"
    wavefunction = getattr(request, 'wavefunction', None)
    opt_type = request.opt_type or "MinSteps"
    opt_convergence = getattr(request, 'opt_convergence', None)
    cartesian_opt = getattr(request, 'cartesian_opt', False)
    uno = getattr(request, 'uno', False)
    uco = getattr(request, 'uco', False)
    num_cores = request.num_cores or 4
    max_iterations = request.max_iterations or 50
    charge = request.charge or 0
    multiplicity = request.multiplicity or 1

    lines = []

    # Header comment
    lines.append("# ORCA input file generated by CatGO")
    lines.append(f"# Method: {method}, Basis set: {basis_set}")
    lines.append(f"# Optimization type: {opt_type}")
    lines.append("")

    # Parallelization and memory
    if num_cores > 1:
        lines.append(f"%pal nprocs {num_cores} end")
        lines.append("%maxcore 4000")
        lines.append("")

    # Route line (calculation type)
    route_parts = [method, basis_set]

    if opt_type == "Freq":
        route_parts.append("Freq")
    elif opt_type == "TS":
        route_parts.append("OptTS")
    elif opt_type == "SP":
        # Single point energy - no Opt or Freq keyword needed
        pass
    else:  # MinSteps (default optimization)
        route_parts.append("Opt")
        # Add optimization convergence and COpt if specified
        if opt_convergence and opt_convergence != "Opt":
            route_parts.append(opt_convergence)
        if cartesian_opt:
            route_parts.append("COpt")

    # Add wavefunction if specified
    if wavefunction:
        route_parts.append(wavefunction)

    # Add UNO/UCO if enabled
    if uno:
        route_parts.append("UNO")
    if uco:
        route_parts.append("UCO")

    # Add common keywords
    route_parts.append("TightSCF")

    route_line = f"! {' '.join(route_parts)}"
    lines.append(route_line)
    lines.append("")

    # Geometry block
    notes = None

    # If xyzfile_name is provided, use *xyzfile directive instead of inline geometry
    if getattr(request, 'xyzfile_name', None):
        lines.append(f"*xyzfile {charge} {multiplicity} {request.xyzfile_name}")
    elif request.structure:
        try:
            structure_dict = request.structure

            # Try to construct Structure from dict
            if isinstance(structure_dict, dict):
                # Check if it's already a proper pymatgen Structure dict
                try:
                    structure = Structure.from_dict(structure_dict)
                except (TypeError, KeyError, ValueError):
                    # Try to handle it as is - might already be a Structure object
                    structure = structure_dict  # type: ignore
            else:
                structure = request.structure

            # Get lattice type
            is_molecular = not hasattr(structure, 'lattice') or structure.lattice is None

            if is_molecular:
                # Molecule geometry
                lines.append("* xyz {} {}".format(charge, multiplicity))

                if not hasattr(structure, 'sites'):
                    raise AttributeError(f"Structure object has no 'sites' attribute. Type: {type(structure)}")

                for site in structure.sites:
                    # Handle both dict and object sites
                    if isinstance(site, dict):
                        element = _extract_element_from_site_dict(site)
                        coords = site.get('xyz') or site.get('coordinates')
                        if not coords:
                            raise ValueError(f"No coordinates in site dict: {site}")
                        x, y, z = float(coords[0]), float(coords[1]), float(coords[2])
                    else:
                        element = _extract_element_from_site_object(site)
                        x, y, z = site.xyz

                    lines.append(f"{element:3s} {x:12.8f} {y:12.8f} {z:12.8f}")

                lines.append("*")
            else:
                # Periodic geometry (simplified - use molecular approximation)
                lines.append("* xyz {} {}".format(charge, multiplicity))

                for site in structure.sites:
                    # Handle both dict and object sites
                    if isinstance(site, dict):
                        element = _extract_element_from_site_dict(site)
                        coords = site.get('xyz') or site.get('coordinates')
                        if not coords:
                            raise ValueError(f"No coordinates in site dict: {site}")
                        x, y, z = float(coords[0]), float(coords[1]), float(coords[2])
                    else:
                        element = _extract_element_from_site_object(site)
                        x, y, z = site.xyz

                    lines.append(f"{element:3s} {x:12.8f} {y:12.8f} {z:12.8f}")

                lines.append("*")

                # Add note about periodic structures
                notes = "Note: Periodic structure approximated as isolated cluster. Use ORCA's PBC features for true periodic calculations."
        except Exception as e:
            # Fallback if structure parsing fails
            import traceback
            error_detail = f"{type(e).__name__}: {str(e)}"
            print(f"ERROR in ORCA input generation: {error_detail}")
            print(f"Traceback: {traceback.format_exc()}")
            lines.append("# Error parsing structure - please define geometry manually")
            lines.append(f"# {error_detail}")
            notes = f"Error: {error_detail}"
    else:
        # No structure provided
        lines.append("* xyz {} {}".format(charge, multiplicity))
        lines.append("# Add your geometry here")
        lines.append("*")
        notes = "No structure provided. Please add atomic coordinates manually."

    inp_content = "\n".join(lines)

    result = {"inp": inp_content}
    if notes:
        result["notes"] = notes

    return result


def generate_orca_uvvis_inputs(request: Any) -> Dict[str, str]:
    """Generate ORCA input for UV/Vis spectroscopy (TD-DFT or STEOM-DLPNO-CCSD)."""

    lines = []

    # Extract parameters from request
    structure = getattr(request, 'structure', None)
    xyzfile_name = getattr(request, 'xyzfile_name', None)
    charge = getattr(request, 'charge', 0)
    multiplicity = getattr(request, 'multiplicity', 1)
    method = getattr(request, 'method', 'CAM-B3LYP')
    basis_set = getattr(request, 'basis_set', 'def2-TZVP')
    wavefunction = getattr(request, 'wavefunction', '')
    calc_type = getattr(request, 'calc_type', 'tddft')
    nroots = getattr(request, 'nroots', 10)
    triplets = getattr(request, 'triplets', False)
    tda = getattr(request, 'tda', True)
    donto = getattr(request, 'donto', False)
    solvation = getattr(request, 'solvation', 'none')
    solvent = getattr(request, 'solvent', 'water')
    aux_basis = getattr(request, 'aux_basis', 'def2-TZVP/C')
    num_cores = getattr(request, 'num_cores', 4)
    max_core_mb = getattr(request, 'max_core_mb', 4000)

    # Build the input file
    if num_cores > 1:
        lines.append(f"%pal nprocs {num_cores} end")
        lines.append(f"%maxcore {max_core_mb}")
        lines.append("")

    # Build route line based on calculation type
    route_keywords = []

    if calc_type == "steom":
        # STEOM-DLPNO-CCSD route
        route_keywords.append("STEOM-DLPNO-CCSD")
        route_keywords.append(basis_set)
        route_keywords.append(aux_basis)
        route_keywords.append("RIJCOSX")
    else:
        # TD-DFT route
        route_keywords.append(method)
        route_keywords.append(basis_set)

    route_keywords.append("TightSCF")

    # Add solvation to route line
    if solvation == "CPCM":
        route_keywords.append(f"CPCM({solvent})")

    route_line = "! " + " ".join(route_keywords)
    lines.append(route_line)
    lines.append("")

    # Add the %tddft or %mdci block
    if calc_type == "steom":
        lines.append("%mdci")
        lines.append(f"  NRoots {nroots}")
        if solvation == "CPCM":
            lines.append("  DOSOLV true")
        lines.append("end")
    else:
        # TD-DFT block
        lines.append("%tddft")
        lines.append(f"  NRoots {nroots}")
        if triplets:
            lines.append("  Triplets true")
        if not tda:
            lines.append("  TDA false")
        if donto:
            lines.append("  DONTO true")
        lines.append("end")

    lines.append("")

    # Add the geometry block
    if xyzfile_name:
        lines.append(f"* xyzfile {charge} {multiplicity} {xyzfile_name}")
    else:
        # Inline geometry
        lines.append(f"* xyz {charge} {multiplicity}")

        if structure:
            try:
                # Try full pymatgen deserialization first
                sites_iter = None
                sites_are_dicts = False

                if isinstance(structure, dict):
                    try:
                        # Full pymatgen dict format (@module, @class, etc.)
                        struct_obj = Structure.from_dict(structure)
                        sites_iter = struct_obj.sites
                        sites_are_dicts = False
                    except (TypeError, KeyError, ValueError):
                        # Fallback: the dict is _structure_to_pymatgen_dict format
                        # (has "sites" key but no @module/@class)
                        sites_iter = structure.get("sites", [])
                        sites_are_dicts = True
                else:
                    # Already a pymatgen object
                    struct_obj = structure
                    sites_iter = struct_obj.sites
                    sites_are_dicts = False

                # Write atom lines
                for site in sites_iter:
                    if sites_are_dicts or isinstance(site, dict):
                        # Site is a dict from _structure_to_pymatgen_dict
                        element = _extract_element_from_site_dict(site)
                        coords = site.get("xyz") or site.get("coordinates")
                        if not coords:
                            raise ValueError(f"No coordinates found in site: {site}")
                        x, y, z = float(coords[0]), float(coords[1]), float(coords[2])
                    else:
                        # Site is a pymatgen Site object
                        element = _extract_element_from_site_object(site)
                        x, y, z = site.xyz

                    lines.append(f"{element:3s} {x:12.8f} {y:12.8f} {z:12.8f}")

            except Exception as e:
                import traceback
                error_msg = f"{type(e).__name__}: {str(e)}"
                lines.append(f"# Error parsing structure: {error_msg}")
                # Include traceback lines for debugging
                for tb_line in traceback.format_exc().split('\n')[:3]:
                    if tb_line.strip():
                        lines.append(f"# {tb_line}")
        else:
            lines.append("# Warning: No structure provided")

        lines.append("*")

    inp_content = "\n".join(lines)

    return {"inp": inp_content}
