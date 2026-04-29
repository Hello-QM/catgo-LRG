# Database Integration

Search and load crystal structures from external databases: OPTIMADE, Materials Project, and PubChem.

**Source:** `src/lib/api/`

## OPTIMADE

The [OPTIMADE](https://www.optimade.org/) API provides a standardized interface to query crystal structure databases worldwide.

### Key Functions

```typescript
// List available OPTIMADE databases
fetch_optimade_providers(): Promise<Provider[]>

// Search structures across databases
search_optimade(query, provider): Promise<SearchResult>

// Fetch a specific structure by ID
fetch_optimade_structure(provider_id, structure_id): Promise<Structure>
```

### Supported Databases

OPTIMADE connects to many providers, including:
- Materials Project
- AFLOW
- OQMD
- NOMAD
- Materials Cloud
- COD (Crystallography Open Database)
- And many more

### Components

| Component | Description |
|-----------|-------------|
| `OptimadeSearchModal.svelte` | Search interface with provider selection, formula/element filters |
| `OptimadePreviewModal.svelte` | Preview structure before loading into viewer |

### Query Options

- **Chemical formula** — exact or partial formula match
- **Elements** — filter by contained elements
- **Space group** — filter by symmetry
- **Provider selection** — choose which databases to search

---

## Materials Project

Direct access to the [Materials Project](https://materialsproject.org/) database for crystal structures and computed properties.

### Key Functions

```typescript
// Fetch structure and properties by Materials Project ID
fetch_material_data(material_id: string): Promise<MaterialData>
```

### Server Route

```
GET /api/materials_project/structure/{material_id}
```

Returns:
- Crystal structure (pymatgen format)
- Summary properties (band gap, formation energy, etc.)
- Robocrystallographer description
- Similar structures

---

## PubChem

Search molecular structures from the [PubChem](https://pubchem.ncbi.nlm.nih.gov/) chemical database.

### Key Functions

```typescript
// Search compounds by name or formula
search_pubchem(query: string): Promise<SearchResult[]>

// Fetch 3D coordinates for a compound
fetch_pubchem_compound(cid: number): Promise<CompoundData>

// Convert PubChem data to structure format
extract_atoms_from_pubchem(compound_data): Structure
```

### Components

| Component | Description |
|-----------|-------------|
| `PubchemSearchModal.svelte` | Search by compound name, formula, or CID |

### Features

- Name-based search (e.g., "aspirin", "caffeine")
- Formula-based search (e.g., "C6H12O6")
- 3D conformer retrieval
- Automatic conversion to viewer format

---

## Architecture

Database queries can go through two paths:

1. **Direct client-side** — JavaScript fetches from public APIs directly (OPTIMADE, PubChem)
2. **Via Python server** — for APIs requiring server-side processing or API keys (Materials Project)

```
Browser                              External APIs
┌──────────────┐   direct fetch     ┌──────────────┐
│ API Client   │ ──────────────────→│ OPTIMADE     │
│ (TypeScript) │                    │ PubChem      │
└──────┬───────┘                    └──────────────┘
       │
       │ via server (API key)
       ▼
┌──────────────┐                    ┌──────────────┐
│ FastAPI      │ ──────────────────→│ Materials    │
│ Server       │                    │ Project      │
└──────────────┘                    └──────────────┘
```
