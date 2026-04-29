# Searching Structure Databases

CatGO integrates with three online databases for finding crystal structures and molecules: **OPTIMADE**, **Materials Project**, and **PubChem**.

## OPTIMADE Search

[OPTIMADE](https://www.optimade.org/) is a standardized API for querying crystal structure databases. CatGO supports searching across multiple providers.

### Opening the Search

Click the **OPTIMADE** button in the toolbar (or the database icon) to open the search modal.

### Searching by Formula

1. Type a chemical formula in the **Formula** field (e.g., `NaCl`, `Fe2O3`, `SrTiO3`)
2. Click **Search** or press Enter
3. Results show structure ID, formula, number of sites, and crystal system

Formulas are automatically normalized to OPTIMADE format (alphabetically sorted elements).

### Searching by Elements

1. Enter element symbols in the **Elements** field (e.g., `Fe, O`)
2. Toggle **Elements only** to find structures containing *only* those elements
3. Set optional filters:
   - **Nelements** — Exact number of elements (or min/max range)
   - **Nsites** — Min/max number of atomic sites

### Using the Periodic Table

Click any element in the embedded periodic table to instantly search for structures containing that element.

### Choosing a Provider

Use the **Database** dropdown to select a provider:

- **Materials Project** — Large database of computed materials
- **AFLOW** — Automatic flow for materials discovery
- **COD** — Crystallography Open Database (experimental structures)
- And more OPTIMADE-compliant databases

### Materials Project Enrichment

If you configure a **Materials Project API key**, search results from MP are enriched with computed properties:

- Band gap (eV)
- Energy above hull (eV/atom) — stability metric
- Crystal system and space group
- Formation energy

To add your API key:
1. Click **Add API key** in the search modal
2. Enter your key from [materialsproject.org](https://materialsproject.org/)
3. The key is stored locally in your browser (localStorage)

### Importing a Structure

Click **Import** on any result to load it into the 3D viewer. For OPTIMADE results, a preview modal may appear first showing the structure before confirming the import.

## PubChem Search

[PubChem](https://pubchem.ncbi.nlm.nih.gov/) provides molecular compound data. Use this for organic molecules, drugs, and small molecules.

### Opening the Search

Click the **PubChem** button in the toolbar to open the search modal.

### Searching

- **By name** — Type a compound name (e.g., `benzene`, `aspirin`, `caffeine`)
- **By formula** — Type a molecular formula (e.g., `C6H6`, `H2O`)
- **By element** — Click elements in the periodic table

CatGO auto-detects whether you entered a name or formula.

### Results

Results show:
- PubChem Compound ID (CID)
- Molecular formula
- Compound name
- Molecular weight
- Composition pie chart

### Importing

Click **Import** to load the molecule's 3D structure. PubChem compounds are loaded as molecules (no periodic lattice). The 3D coordinates come from PubChem's computed conformer data.

## Key Differences

| Feature | OPTIMADE | PubChem |
|---------|----------|---------|
| Structure type | Crystals (periodic) | Molecules (non-periodic) |
| Lattice | Yes | No |
| Periodic boundaries | pbc = [true, true, true] | pbc = [false, false, false] |
| Search parameters | Formula, elements, nsites | Name, formula, elements |
| Authentication | Optional (MP API key) | None |
| Requires server | Yes (backend proxy for CORS) | Yes (backend proxy for CORS) |

## Server Requirement

Both database search features route through the Python backend to handle CORS restrictions. Make sure the server is running:

```bash
cd server
python main.py
```

## Tips

- **Start broad, then filter** — Search by elements first, then narrow down by formula or site count.
- **Use MP API key** — The enriched properties (band gap, stability) make it much easier to find useful structures.
- **Export after import** — Once imported, use the Export pane to save structures in your preferred format (CIF, POSCAR, etc.).
- **Combine with tools** — Import a bulk crystal from OPTIMADE, then use the slab cutter to create a surface.
