# MOF Frontend Integration + Sphere Clipping

## Summary

Two features in one spec:
1. **MOF Frontend Integration** — Call `detect_mof_sbus` WASM, use SBU data for auto-polyhedra coloring and Node Isolator
2. **Sphere Clipping** — Click atom + radius slider to show only nearby atoms/polyhedra

## Feature 1: MOF Frontend Integration

### Data Flow

```
Bond computation completes → bond_pairs available
    ↓
Call detect_mof_sbus(structure_json, bonds_json) via WASM
    ↓
Store MofClusters { sbus, attributions, is_mof } in state
    ↓
Use for:
  - Auto-color polyhedra by SBU type (inorganic=element color, organic=grey)
  - Only draw polyhedra on inorganic SBU atoms
  - Node Isolator (right-click → "Isolate Node")
```

### TypeScript WASM Wrapper

Add to `src/lib/structure/ferrox-wasm.ts`:
```typescript
export async function detect_mof_sbus(structure, bonds): Promise<MofClusters>
```

### Node Isolator

**Trigger:** Right-click atom → "Isolate Node" menu item

**Algorithm:**
1. Get clicked atom's SBU from `attributions[atom_idx]`
2. Find all atoms in that SBU
3. Find connected SBUs (SBUs that share bonds with this one)
4. Highlight: this SBU + connected SBUs fully visible, rest semi-transparent or hidden
5. User can toggle between hide/semi-transparent via setting

**Clear:** Right-click empty space or "Clear Isolation" button in settings

### Files

- Modify: `src/lib/structure/ferrox-wasm.ts` — add `detect_mof_sbus` wrapper
- Create: `src/lib/structure/mof-analysis.ts` — MofClusters types + Node Isolator logic
- Modify: `src/lib/structure/StructureScene.svelte` — MOF state + call WASM + use for polyhedra
- Modify: `src/lib/structure/Structure.svelte` — right-click "Isolate Node" menu item

## Feature 2: Sphere Clipping

### Interaction

**Trigger:** Right-click atom → "Clip Around This Atom"

**Controls (Settings panel → "Clipping" section):**
- Clipping active toggle
- Radius slider (2-20 Å, default 8 Å)
- Outside mode: "Hide" / "Semi-transparent" toggle
- Outside opacity slider (0.0-0.3, default 0.1, only shown in semi-transparent mode)
- "Clear Clipping" button

### Implementation

**State:** `clip_active`, `clip_center: Vec3 | null`, `clip_radius`, `clip_outside_mode`, `clip_outside_opacity`

**Filtering:** In `atom_data` or via `atom_opacity_overrides`:
- For each atom, compute distance to clip_center
- If distance > clip_radius: set opacity to 0 (hide) or clip_outside_opacity (semi-transparent)
- Polyhedra: only compute for atoms within clip radius
- Bonds: hide if both endpoints outside radius

### Files

- Modify: `src/lib/settings/types.ts` — add clipping settings
- Modify: `src/lib/settings/config.ts` — add clipping defaults
- Modify: `src/lib/structure/StructureScene.svelte` — clip state + opacity overrides
- Modify: `src/lib/structure/StructureControls.svelte` — Clipping settings section
- Modify: `src/lib/structure/Structure.svelte` — right-click menu items

## Shared: Right-Click Menu

Both features add items to the atom right-click context menu:
- "Clip Around This Atom" → sets clip_center + activates clipping
- "Isolate Node" → finds SBU + highlights (only shown when MOF detected)

## Out of Scope

- Full topology naming (RCSR database)
- Multiple clustering modes
- BFS-based Node Isolator (graph traversal) — use SBU attributions instead
