# Atom Manipulation Feature - Implementation Guide

This document explains the atom manipulation feature (add, delete, replace atoms) added to the 3D structure viewer with detailed line-by-line code breakdowns.

---

## Table of Contents

1. [Overview](#overview)
2. [What Was Added](#what-was-added)
3. [How It Works](#how-it-works)
4. [Code Changes Explained](#code-changes-explained)
5. [Testing the Feature](#testing-the-feature)

---

## Overview

### What This Feature Does

Allows users to interactively modify molecular structures by:

1. **Right-clicking on empty space** - Opens menu to add new atoms
2. **Right-clicking on an atom** - Opens menu to replace or delete that atom
3. **Selecting an element** - Choose from all 118 elements in a scrollable grid
4. **Real-time updates** - Structure updates immediately after each operation

This provides an intuitive interface for building and modifying molecular structures directly in the 3D viewer.

---

## What Was Added

### New User Interactions

1. **Context Menu** - Right-click menu with options for add/replace/delete
2. **Element Selector** - Grid showing all 118 elements from the periodic table
3. **Atom Operations** - Functions to add, delete, and replace atoms with proper coordinate handling

### Files Modified/Created

1. `src/lib/structure/atom-manipulation.ts` - Core atom manipulation functions (NEW)
2. `src/lib/structure/manipulation.ts` - Atom translation utilities (NEW)
3. `src/lib/structure/Structure.svelte` - Main viewer with context menu integration
4. `src/lib/structure/StructureScene.svelte` - 3D scene with right-click handlers
5. `src/lib/structure/index.ts` - Export new functions
6. `src/lib/ContextMenu.svelte` - Context menu component styling updates

---

## How It Works

### The Flow

```javascript
// State variables
let context_menu_visible = false
let context_menu_position = { x: 0, y: 0 }
let context_menu_3d_position = null // [x, y, z] coordinates for new atom
let context_menu_target_site = null // Index of atom to replace/delete
let selected_add_element = 'C' // Currently selected element

// When user right-clicks on empty space:
function onRightClick(event) {
  event.preventDefault()
  event.stopPropagation() // Critical: prevents menu from closing immediately

  // Calculate where to place new atom (center of mass + offset)
  const center = calculateCenterOfMass(structure)
  context_menu_3d_position = [center.x, center.y, center.z + 2]

  // Show menu at mouse position
  context_menu_position = { x: event.clientX, y: event.clientY }
  context_menu_visible = true
}

// When user right-clicks on an atom:
function onAtomRightClick(atom_index, atom_position, event) {
  event.preventDefault()
  event.stopPropagation() // Critical: prevents menu from closing immediately

  // Store which atom was clicked
  context_menu_target_site = atom_index
  context_menu_3d_position = atom_position

  // Show menu at mouse position
  context_menu_position = { x: event.clientX, y: event.clientY }
  context_menu_visible = true
}

// When user selects "Add atom":
function addAtom() {
  // Create new site with selected element
  const new_site = {
    species: [{ element: selected_add_element, occu: 1, oxidation_state: 0 }],
    xyz: context_menu_3d_position, // Cartesian coordinates
    abc: convertToFractional(context_menu_3d_position), // Fractional coordinates
    label: selected_add_element,
    properties: {},
  }

  structure.sites.push(new_site)
}

// When user selects "Delete atom":
function deleteAtom() {
  structure.sites = structure.sites.filter((site, idx) =>
    idx !== context_menu_target_site
  )
}

// When user selects "Replace atom":
function replaceAtom() {
  structure.sites[context_menu_target_site].species[0].element = selected_add_element
  structure.sites[context_menu_target_site].label = selected_add_element
}
```

---

## Code Changes Explained

This section breaks down each code change line-by-line across all modified files.

---

### 1. atom-manipulation.ts - Core Functions (NEW FILE)

This file contains the fundamental operations for adding, deleting, and replacing atoms.

#### Function: `add_atom` (Lines 13-51)

```typescript
export function add_atom(
  structure: AnyStructure,
  element: ElementSymbol,
  xyz_position: Vec3,
): AnyStructure {
```

- `export` - Makes this function available to other files
- `add_atom` - Function name describing what it does
- Three parameters:
  - `structure` - The existing structure to modify
  - `element` - Element symbol like 'C', 'O', 'Fe' (must be valid element)
  - `xyz_position` - 3D coordinates [x, y, z] in Angstroms (Cartesian coordinates)
- Returns a new structure with the atom added

```typescript
if (!structure?.sites) return structure
```

- Safety check: if structure doesn't exist or has no sites array, return unchanged
- `?.` is optional chaining - safely checks if property exists without crashing
- Prevents errors when structure is undefined or null

```typescript
let abc_position = xyz_position
```

- Initialize fractional coordinates to same as Cartesian
- For molecules (non-crystal structures), fractional = Cartesian
- Will be recalculated below for crystal structures

```typescript
if ('lattice' in structure && structure.lattice) {
```

- Check if this is a crystal structure (has a lattice)
- `'lattice' in structure` checks if the property exists
- `structure.lattice` ensures it's not null/undefined

```typescript
const lattice = structure.lattice as PymatgenStructure['lattice']
```

- TypeScript type assertion - tells compiler this is definitely a lattice
- Needed because TypeScript can't automatically narrow the type inside the if block

```typescript
const lattice_transposed = transpose_3x3_matrix(lattice.matrix)
const inv_matrix = matrix_inverse_3x3(lattice_transposed)
```

- **Crystal structures use lattice coordinates**
- Lattice matrix defines how to convert between fractional and Cartesian
- We need the inverse of the transposed matrix for the conversion
- Math: `fractional = inverse(transpose(lattice)) × cartesian`

```typescript
abc_position = mat3x3_vec3_multiply(inv_matrix, xyz_position)
```

- Multiply the inverse matrix by the Cartesian position
- Result: fractional coordinates (abc) in range 0-1
- Example: abc = [0.5, 0.5, 0.5] means center of unit cell

```typescript
const new_site: Site = {
  species: [
    {
      element,
      occu: 1,
      oxidation_state: 0,
    },
  ],
```

- Create the site object that represents the atom
- `species` - Array because sites can have multiple species (disorder)
- `element` - The element symbol passed to the function
- `occu: 1` - Occupancy of 100% (atom is fully present)
- `oxidation_state: 0` - Neutral charge (not ionized)

```typescript
  abc: abc_position,
  xyz: xyz_position,
  label: element,
  properties: {},
}
```

- `abc` - Fractional coordinates (for crystal structures)
- `xyz` - Cartesian coordinates in Angstroms
- `label` - Text label for the atom (same as element)
- `properties` - Empty object for additional metadata

```typescript
return {
  ...structure,
  sites: [...structure.sites, new_site],
}
```

- Create a NEW structure object (don't modify the original)
- `...structure` - Spread operator copies all properties from original
- `sites: [...]` - Override sites property with new array
- `...structure.sites` - Copy all existing sites
- `, new_site` - Add the new site at the end
- **Immutable update pattern** - creates new object instead of modifying

#### Function: `delete_atoms` (Lines 60-76)

```typescript
export function delete_atoms(
  structure: AnyStructure,
  site_indices: number[],
): AnyStructure {
```

- Function to remove one or more atoms from the structure
- `site_indices` - Array of indices to delete (e.g., [0, 3, 7])
- Returns new structure with specified atoms removed

```typescript
if (!structure?.sites || site_indices.length === 0) return structure
```

- Safety checks:
  - If no structure or sites, return unchanged
  - If no indices provided, return unchanged (nothing to delete)

```typescript
const indices_set = new Set(site_indices)
```

- Convert array to Set for O(1) lookup performance
- Set is like an array but much faster for checking if value exists
- Example: checking if 5 is in [1,3,5,7,9] is instant with Set, slow with array

```typescript
const new_sites = structure.sites.filter((_, idx) => !indices_set.has(idx))
```

- `filter()` - Creates new array with only items that pass the test
- `(_, idx)` - Arrow function taking site (unused, hence `_`) and index
- `!indices_set.has(idx)` - Keep site if its index is NOT in the set to delete
- Example: If deleting [1, 3], keeps indices [0, 2, 4, 5, ...]

```typescript
return {
  ...structure,
  sites: new_sites,
}
```

- Return new structure with filtered sites array
- Again using immutable update pattern

#### Function: `replace_atom` (Lines 86-115)

```typescript
export function replace_atom(
  structure: AnyStructure,
  site_index: number,
  new_element: ElementSymbol,
): AnyStructure {
```

- Function to change an atom's element (e.g., Carbon → Oxygen)
- `site_index` - Which atom to replace (0-based index)
- `new_element` - New element symbol to use
- Returns new structure with replaced atom

```typescript
if (!structure?.sites || site_index < 0 || site_index >= structure.sites.length) {
  return structure
}
```

- Validation checks:
  - Structure must exist and have sites
  - Index must be non-negative (0 or greater)
  - Index must be within array bounds (less than length)
- Example: If 10 sites, valid indices are 0-9

```typescript
const new_sites = structure.sites.map((site, idx) => {
```

- `map()` - Creates new array by transforming each element
- Takes function that receives each site and its index

```typescript
if (idx !== site_index) return site
```

- If this isn't the site we're replacing, return it unchanged
- Most sites pass through unmodified

```typescript
  return {
    ...site,
    species: [
      {
        element: new_element,
        occu: 1,
        oxidation_state: 0,
      },
    ],
    label: new_element,
  }
})
```

- For the target site, create a new site object
- `...site` - Copy all properties (keeps xyz, abc coordinates)
- Override `species` with new element
- Override `label` to match new element
- Keeps position, just changes the element type

---

### 2. manipulation.ts - Translation Functions (NEW FILE)

This file handles moving atoms in 3D space (not used in context menu, but part of atom manipulation).

#### Function: `translate_sites` (Lines 14-55)

```typescript
export function translate_sites(
  structure: AnyStructure,
  site_indices: number[],
  displacement: Vec3,
): AnyStructure {
```

- Function to move atoms by a specified distance
- `site_indices` - Which atoms to move
- `displacement` - [dx, dy, dz] movement in Angstroms
- Example: [1.0, 0.0, 0.0] moves atom 1 Angstrom in +X direction

```typescript
if (!structure?.sites || site_indices.length === 0) return structure
```

- Safety check: need structure and atoms to move

```typescript
const new_sites = structure.sites.map((site, idx) => {
  if (!site_indices.includes(idx)) return site
```

- Loop through all sites
- If this site isn't in the list to move, return unchanged

```typescript
const new_xyz: Vec3 = [
  site.xyz[0] + displacement[0],
  site.xyz[1] + displacement[1],
  site.xyz[2] + displacement[2],
]
```

- Calculate new Cartesian coordinates
- Add displacement to each component (x, y, z)
- Example: [1,2,3] + [0.5,0,0] = [1.5,2,3]

```typescript
let new_abc = site.abc
if ('lattice' in structure && structure.lattice) {
  const lattice = structure.lattice as PymatgenStructure['lattice']
  const lattice_transposed = transpose_3x3_matrix(lattice.matrix)
  const inv_matrix = matrix_inverse_3x3(lattice_transposed)
  new_abc = mat3x3_vec3_multiply(inv_matrix, new_xyz)
}
```

- For crystal structures, must update fractional coordinates too
- Same matrix math as in `add_atom`
- Convert new Cartesian position to fractional coordinates

```typescript
  return {
    ...site,
    xyz: new_xyz,
    abc: new_abc,
  }
})
```

- Create new site with updated coordinates
- Keep everything else (element, label, properties) the same

#### Function: `get_movement_step` (Lines 65-73)

```typescript
export function get_movement_step(
  shift: boolean,
  ctrl: boolean,
  base_step = 0.1,
): number {
```

- Helper function for keyboard-based atom movement
- `shift` - Is Shift key pressed?
- `ctrl` - Is Ctrl/Cmd key pressed?
- `base_step` - Default movement distance (0.1 Angstrom)
- Returns: adjusted step size based on modifier keys

```typescript
if (shift) return base_step * 10 // 1.0 Angstrom
if (ctrl) return base_step * 0.1 // 0.01 Angstrom
return base_step // 0.1 Angstrom
```

- Shift = 10x larger steps (coarse movement)
- Ctrl = 10x smaller steps (fine-tuning)
- No modifier = normal step size
- Allows users to control precision of movement

---

### 3. Structure.svelte - Context Menu Integration

This is where the context menu is integrated into the main structure viewer.

#### State Variables (Lines 54-59)

```typescript
let context_menu_visible = $state(false)
```

- Controls whether context menu is shown or hidden
- `$state()` makes it reactive - UI updates when value changes
- Starts hidden (`false`)

```typescript
let context_menu_position = $state({ x: 0, y: 0 })
```

- Stores pixel coordinates for where to show menu
- `{ x: 0, y: 0 }` - Top-left corner by default
- Updated to mouse position on right-click

```typescript
let context_menu_3d_position = $state<[number, number, number] | null>(null)
```

- Stores 3D coordinates for where to add new atom
- `[number, number, number]` - Array of three numbers [x, y, z]
- `| null` - Can also be null if no position set
- Used when user selects "Add atom"

```typescript
let selected_add_element = $state<ElementSymbol>(`C`)
```

- Which element is currently selected in the element picker
- Defaults to Carbon ('C')
- User can change by clicking different element in grid

```typescript
let context_menu_target_site = $state<number | null>(null)
```

- Index of atom that was right-clicked (for replace/delete)
- `null` if right-clicked on empty space
- `number` (0, 1, 2...) if right-clicked on specific atom

#### Context Menu Handler - Empty Space (Lines 716-744)

```typescript
function oncontextmenu(event: MouseEvent) {
```

- Triggered when user right-clicks on empty space in viewer
- `event: MouseEvent` - Contains mouse position and other info

```typescript
if (is_rotating || axis_lock_key) return
```

- Don't show menu if user is currently rotating structure
- Don't show menu if axis lock key is held down
- Prevents menu from interfering with rotation feature

```typescript
event.preventDefault()
event.stopPropagation()
```

- **CRITICAL LINES**
- `preventDefault()` - Stop browser's default right-click menu
- `stopPropagation()` - Stop event from bubbling to document
- Without `stopPropagation()`, menu closes immediately!
- The ContextMenu component listens for right-clicks on document to close
- Stopping propagation prevents that handler from seeing this event

```typescript
context_menu_position = { x: event.clientX, y: event.clientY }
```

- Save where user clicked
- `clientX` - Horizontal position in pixels from left edge of window
- `clientY` - Vertical position in pixels from top edge of window

```typescript
if (structure && structure.sites.length > 0) {
  const center = get_center_of_mass(structure)
  context_menu_3d_position = [center[0], center[1], center[2] + 2]
} else {
  context_menu_3d_position = [0, 0, 0]
}
```

- Calculate where to place new atom
- Find center of mass (weighted average of all atom positions)
- Add 2 Angstrom offset in Z direction so new atom doesn't overlap
- If no atoms yet, use origin [0, 0, 0]

```typescript
context_menu_target_site = null
```

- Clear any previously selected atom
- `null` indicates we're adding to empty space, not replacing

```typescript
console.log('Context menu opened at', context_menu_position, {
  '3d_position': context_menu_3d_position,
  'target_site': context_menu_target_site,
  'has_structure': !!structure,
  'site_count': structure?.sites.length,
})
```

- Debug logging to browser console (F12 to see)
- `!!structure` - Double NOT converts to boolean (true if exists)
- `?.` - Optional chaining, returns undefined if structure is null
- Helps diagnose issues during development

```typescript
context_menu_visible = true
```

- Show the menu!
- This triggers the UI to render the ContextMenu component

#### Context Menu Handler - Atom (Lines 747-764)

```typescript
function on_atom_context_menu(site_idx: number, position: [number, number, number], event: MouseEvent) {
```

- Called from StructureScene when user right-clicks on an atom
- `site_idx` - Which atom was clicked (0-based index)
- `position` - 3D coordinates of that atom
- `event` - Mouse event for position info

```typescript
event.preventDefault()
event.stopPropagation()
```

- Same critical lines as above
- Prevent default menu and stop event bubbling

```typescript
context_menu_position = { x: event.clientX, y: event.clientY }
context_menu_target_site = site_idx
context_menu_3d_position = position
```

- Save mouse position for menu placement
- **Key difference**: Set `context_menu_target_site` to the atom's index
- This tells the menu which atom to replace/delete
- Use atom's position for 3D coordinates

```typescript
console.log('Atom context menu opened', {
  'site_idx': site_idx,
  '3d_position': position,
  'target_site': context_menu_target_site,
})
context_menu_visible = true
```

- Debug logging
- Show the menu

#### Menu Selection Handler (Lines 765-800)

```typescript
function handle_context_menu_select(section_title: string, option: { value: string }) {
```

- Called when user clicks an option in the context menu
- `section_title` - Which section: "Add Atom" or "Edit Atoms"
- `option` - Which option: "add", "replace", or "delete"

```typescript
console.log('Context menu select:', section_title, option.value, {
  selected_add_element,
  context_menu_3d_position,
  context_menu_target_site,
})
```

- Debug log showing what was selected

```typescript
if (section_title === `Add Atom` && option.value === `add`) {
```

- Check if user selected "Add atom"

```typescript
if (structure && context_menu_3d_position) {
  console.log('Adding atom:', selected_add_element, 'at', context_menu_3d_position)
  structure = add_atom(structure, selected_add_element, context_menu_3d_position)
  console.log('Structure now has', structure.sites.length, 'atoms')
} else {
  console.warn('Cannot add atom: structure or position missing', {
    structure: !!structure,
    context_menu_3d_position,
  })
}
```

- Verify we have structure and position
- Call `add_atom` function we defined earlier
- Pass: structure, selected element, 3D position
- Update structure with returned value (new structure with added atom)
- Log success or warning

```typescript
} else if (section_title === `Edit Atoms`) {
```

- Handle options from "Edit Atoms" section

```typescript
if (option.value === `delete` && structure) {
  if (context_menu_target_site !== null) {
    console.log('Deleting atom at index', context_menu_target_site)
    structure = delete_atoms(structure, [context_menu_target_site])
    selected_sites = selected_sites.filter((idx) => idx !== context_menu_target_site)
```

- If deleting single atom (right-clicked on it):
- Call `delete_atoms` with array containing just that index
- Also remove from `selected_sites` if it was selected
- `filter` keeps all indices except the deleted one

```typescript
} else if (selected_sites.length > 0) {
  console.log('Deleting', selected_sites.length, 'selected atoms')
  structure = delete_atoms(structure, selected_sites)
  selected_sites = []
}
```

- If no target site but have selected sites:
- Delete all selected atoms
- Clear the selection array

```typescript
  } else if (option.value === `replace` && structure && context_menu_target_site !== null) {
    console.log('Replacing atom at index', context_menu_target_site, 'with', selected_add_element)
    structure = replace_atom(structure, context_menu_target_site, selected_add_element)
  }
}
```

- If user selected "Replace":
- Verify we have structure and a target atom
- Call `replace_atom` with index and new element
- Updates that atom's element to selected_add_element

```typescript
  context_menu_visible = false
}
```

- Hide menu after any selection
- Operation is complete

#### ContextMenu Component Rendering (Lines 1075-1115)

```svelte
<ContextMenu
  visible={context_menu_visible}
  position={context_menu_position}
  on_close={() => (context_menu_visible = false)}
  on_select={handle_context_menu_select}
```

- Render the ContextMenu component
- `visible` - Pass our state variable to control show/hide
- `position` - Pass mouse coordinates for placement
- `on_close` - Arrow function to hide menu when clicking outside
- `on_select` - Pass our handler for when option is clicked

```svelte
sections={}
```

- First section in menu: "ADD ATOM"
- One option: "Add C atom" (or whatever element is selected)
- `${selected_add_element}` - Template literal, inserts variable value
- `icon: 'Atom'` - Shows atom icon next to text
- `disabled: !context_menu_3d_position` - Grayed out if no valid position
- `!` converts to boolean and inverts (true → false, false → true)

```svelte
{}
```

- Second section: "EDIT ATOMS"
- First option: "Replace with C" (or selected element)
- Uses `Reset` icon (circular arrow)
- Disabled if no target atom (=== null means exactly equal to null)
- Only enabled when right-clicking on an atom

```svelte
{
  value: `delete`,
  label: context_menu_target_site !== null
    ? `Delete atom`
    : selected_sites.length > 0
      ? `Delete ${selected_sites.length} selected`
      : `Delete atom`,
  icon: `Close`,
  disabled: context_menu_target_site === null && selected_sites.length === 0,
},
```

- Delete option with dynamic label:
- If target atom: "Delete atom"
- Else if selected sites: "Delete 5 selected" (shows count)
- Else: "Delete atom" (default text)
- Uses ternary operator: `condition ? value_if_true : value_if_false`
- Nested ternary for three cases
- Disabled if neither target nor selections exist
- `&&` is logical AND - both must be true for disabled

#### Element Selector Rendering (Lines 1117-1136)

```svelte
{#if context_menu_visible}
```

- Only render element selector when menu is visible
- Svelte's `{#if}` block for conditional rendering

```svelte
<div class="element-selector" style="top: {context_menu_position.y}px; left: {context_menu_position.x + 180}px;">
```

- Create a div for the element grid
- Inline styles for absolute positioning
- `top: {context_menu_position.y}px` - Place at menu's Y position
- `left: {context_menu_position.x + 180}px` - Place 180 pixels right of menu
- `{}` in Svelte evaluates JavaScript expression
- Positions it next to the context menu

```svelte
<div class="element-selector-header">Select Element:</div>
<div class="element-grid">
```

- Header text: "Select Element:"
- Container div for the grid layout

```svelte
{#each elem_symbols as element}
```

- Loop through all element symbols (H, He, Li, Be, ...)
- `elem_symbols` is imported array of all 118 elements
- Creates one button for each element

```svelte
<button
  class="element-btn"
  class:selected={element === selected_add_element}
```

- Create button for this element
- `class:selected={}` - Svelte directive for conditional class
- Adds `selected` class if condition is true
- Highlights the currently selected element

```svelte
onclick={
  () => {
    selected_add_element = element
  }
}
```

- Arrow function for click handler
- Sets `selected_add_element` to clicked element
- Updates the state, causing UI to re-render

```svelte
title={element}
>
{element}
</button>
```

- `title` attribute - Shows tooltip on hover
- Button text is the element symbol
- Creates buttons like: H, He, Li, Be, B, C, N, O...

#### CSS Styling - Element Selector (Lines 1337-1384)

```css
.element-selector {
  position: absolute;
  background: var(--surface-bg, #1e1e1e);
```

- `position: absolute` - Positioned relative to nearest positioned ancestor
- Since it's outside `.structure` div, positioned relative to viewport
- `var(--surface-bg, #1e1e1e)` - CSS variable with fallback
- If `--surface-bg` not defined, use dark gray `#1e1e1e`

```css
border: 1px solid var(--border-color, #444);
border-radius: var(--border-radius, 4px);
box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.3), 0 4px 8px -2px rgba(0, 0, 0, 0.1);
```

- `border` - 1 pixel solid line, medium gray
- `border-radius` - Rounded corners (4px)
- `box-shadow` - Drop shadow effect
  - `0 8px 16px -4px` - First shadow (larger, softer)
  - `rgba(0, 0, 0, 0.3)` - Black with 30% opacity
  - Second shadow layered on top
  - Creates depth/elevation effect

```css
padding: 8px;
z-index: 100000002;
```

- `padding` - 8px space inside border
- `z-index` - VERY HIGH value (100 million+)
- Ensures it appears on top of everything
- Higher than ContextMenu (100000001) so it layers on top

```css
max-width: 300px;
max-height: 400px;
overflow-y: auto;
```

- `max-width` - Won't get wider than 300px
- `max-height` - Won't get taller than 400px
- `overflow-y: auto` - Vertical scrollbar if content exceeds 400px
- Makes element list scrollable

```css
.element-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
}
```

- `display: grid` - CSS Grid layout
- `repeat(6, 1fr)` - 6 columns, each taking equal fraction of space
- `1fr` = one fraction unit (equal width columns)
- `gap: 4px` - 4px space between grid items
- Creates 6-column grid: H He Li Be B C / N O F Ne Na Mg / ...

```css
.element-btn {
  padding: 6px 4px;
  background: var(--surface-bg-hover, #2a2a2a);
  border: 1px solid var(--border-color, #444);
  border-radius: 3px;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-color, #fff);
```

- Button styling for each element
- `padding: 6px 4px` - 6px top/bottom, 4px left/right
- Slightly lighter gray background
- Small rounded corners (3px)
- `0.7rem` - Smaller than normal text (70%)
- `font-weight: 600` - Semi-bold
- White text by default

```css
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: center;
}
```

- `cursor: pointer` - Shows hand cursor on hover
- `transition` - Smooth animation for all property changes
- `0.15s` - Animation takes 150 milliseconds
- `ease` - Ease-in-ease-out timing function
- `text-align: center` - Centers element symbol in button

```css
.element-btn:hover {
  background: var(--accent-color, #0066cc);
  color: var(--text-color, #fff);
  transform: scale(1.05);
}
```

- Hover state styling
- Background becomes blue
- `scale(1.05)` - Grows to 105% size
- Creates nice "pop" effect on hover

```css
.element-btn.selected {
  background: var(--accent-color, #0066cc);
  color: white;
  border-color: var(--accent-color, #0066cc);
}
```

- Style for currently selected element
- Blue background and border
- White text for contrast
- Same color as hover state

---

### 4. StructureScene.svelte - Atom Right-Click Handler

This file renders the 3D scene with atoms. We added right-click handling to atoms.

#### Prop Addition (Line ~158)

```typescript
on_atom_context_menu?: (site_idx: number, position: [number, number, number], event: MouseEvent) => void
```

- Optional prop (note the `?`)
- Function type with three parameters:
  - `site_idx` - Which atom was clicked
  - `position` - 3D coordinates of atom
  - `event` - Mouse event object
- `=> void` - Returns nothing
- Parent component (Structure.svelte) passes this function

#### Instanced Atoms Handler (Lines 581-584)

```typescript
oncontextmenu={(event: MouseEvent) => {
  const site_idx = atom.site_idx
  on_atom_context_menu?.(site_idx, atom.position, event)
}}
```

- Attached to each atom mesh in 3D scene
- Arrow function receives the right-click event
- Extract the site index from the atom object
- `?.()` - Optional call operator
- Only calls function if it exists (parent passed it)
- Prevents error if prop not provided
- Passes three arguments as defined above

#### Partial Occupancy Atoms Handler (Lines 610-613)

```typescript
oncontextmenu={(event: MouseEvent) => {
  const site_idx = atom.site_idx
  on_atom_context_menu?.(site_idx, atom.position, event)
}}
```

- Same handler for atoms with partial occupancy
- Some atoms can have multiple elements at same position
- These are rendered differently but need same right-click behavior

---

### 5. index.ts - Export New Functions (Line 13)

```typescript
export * from './atom-manipulation'
```

- `export *` - Export all functions from that file
- Makes `add_atom`, `delete_atoms`, `replace_atom` available
- Can now import from `$lib/structure` instead of `$lib/structure/atom-manipulation`
- Cleaner imports: `import { add_atom } from '$lib/structure'`

---

### 6. ContextMenu.svelte - Styling Updates

Added fallback colors so menu is visible even if CSS variables aren't defined.

#### Component Position (Lines 76-79)

```svelte
{#if visible}
  {@const { x, y } = get_smart_position()}
  {@const style = `position: absolute; left: ${x}px; top: ${y}px; ${rest.style ?? ``}`}
  <div {...rest} class="context-menu {rest.class ?? ``}" {style} bind:this={menu_element}>
```

- `{#if visible}` - Only render when visible
- `@const` - Svelte's way to declare constants in template
- `get_smart_position()` - Function that keeps menu in viewport
- If menu would go off screen, adjusts position
- `position: absolute` - Positioned at specific pixel coordinates
- `left` and `top` - Exact pixel position from edges
- `bind:this={menu_element}` - Binds DOM element to variable
- Used by `get_smart_position()` to check menu size

#### CSS Variables with Fallbacks (Lines 101-160)

```css
.context-menu {
  background: var(--surface-bg, #1e1e1e);
  border: 1px solid var(--border-color, #444);
```

- Pattern: `var(--variable-name, fallback-value)`
- If CSS variable exists, use it
- If not defined, use fallback
- `#1e1e1e` - Dark gray (almost black)
- `#444` - Medium gray

```css
  z-index: 100000001;
}
```

- Very high z-index ensures it appears on top
- Moved OUTSIDE `.structure` container so it's not clipped
- Can overlay entire page

```css
button {
  color: var(--text-color, #fff);
}
```

- Button text color
- `#fff` - White (fallback)
- Ensures text is visible on dark background

```css
button.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- Disabled state styling
- `opacity: 0.5` - 50% transparent (looks grayed out)
- `cursor: not-allowed` - Shows "no" symbol when hovering
- Indicates option isn't available

---

## Testing the Feature

### 1. Start the Development Server

```bash
npm run dev
```

### 2. Load a Structure

- Open the application in your browser
- Load any molecular or crystal structure
- Make sure you can see atoms in the 3D viewer

### 3. Test Adding Atoms

**Right-click on empty space:**

1. Right-click anywhere in the 3D viewer (not on an atom)
2. Context menu should appear with "Add C atom" option
3. Element selector grid should appear to the right
4. Click a different element (e.g., Oxygen 'O')
5. Notice menu updates to "Add O atom"
6. Click "Add O atom"
7. New atom should appear in the structure
8. Check browser console (F12) to see debug logs

**Console should show:**

```
Context menu opened at {x: 500, y: 300}
Adding atom: O at [1.5, 2.0, 3.2]
Structure now has 65 atoms
```

### 4. Test Replacing Atoms

**Right-click on an atom:**

1. Right-click directly on any atom in the structure
2. Context menu should appear
3. "Replace with C" option should be enabled (not grayed out)
4. "Delete atom" option should be enabled
5. Select a different element (e.g., Nitrogen 'N')
6. Click "Replace with N"
7. Atom should change to nitrogen
8. Color and label should update

**Console should show:**

```
Atom context menu opened {site_idx: 5, 3d_position: [1.2, 3.4, 2.1]}
Replacing atom at index 5 with N
```

### 5. Test Deleting Atoms

**Delete single atom:**

1. Right-click on an atom
2. Click "Delete atom"
3. Atom should disappear from structure
4. Structure count decreases by 1

**Delete multiple atoms:**

1. Click on several atoms to select them (Shift+click)
2. Right-click on empty space
3. Menu shows "Delete 3 selected" (or however many)
4. Click to delete
5. All selected atoms disappear

**Console should show:**

```
Deleting atom at index 5
Structure now has 64 atoms
```

or

```
Deleting 3 selected atoms
Structure now has 62 atoms
```

### 6. Test Element Selector

1. Right-click anywhere to open menu
2. Element selector should show all 118 elements
3. Scroll down to see elements past first rows
4. Click different elements:
   - H (Hydrogen) - top left
   - Au (Gold) - scroll down
   - U (Uranium) - near bottom
5. Menu text should update each time

### 7. Test Edge Cases

**Empty structure:**

- Try with no atoms loaded
- "Add atom" should work
- "Replace" and "Delete" should be grayed out

**Menu positioning:**

- Right-click near edge of screen
- Menu should adjust position to stay visible
- Should never go off-screen

**Clicking outside:**

- Open menu
- Left-click outside menu
- Menu should close
- Right-click outside menu
- Menu should close

### 8. Test Coordinates

**For crystal structures:**

1. Add atom at center
2. Check that both xyz and abc coordinates are set
3. abc should be fractional (0-1 range)
4. xyz should be Cartesian (Angstroms)

**For molecules:**

1. Add atom
2. Both coordinate systems should be set
3. For non-crystal, abc = xyz

---

## Debugging Tips

### 1. Console Logging

Open browser DevTools (F12 → Console tab) to see debug output:

```
Context menu opened at Object { x: 500, y: 300 }
ContextMenu visibility changed: true position: Object { x: 500, y: 300 } sections: 2
```

These logs help diagnose:

- Is context menu handler being called?
- Is ContextMenu component receiving props?
- What coordinates are being used?

### 2. Check Menu Visibility

If menu doesn't appear:

1. Open Elements tab in DevTools
2. Look for `<div class="context-menu">` in DOM
3. Check computed styles (right-click → Inspect)
4. Verify:
   - `display` is not `none`
   - `z-index` is very high (100000001)
   - `position` is `absolute`
   - `left` and `top` have pixel values

### 3. Event Propagation Issues

If menu opens then immediately closes:

- Check console for "visibility changed: false"
- This indicates `stopPropagation()` is missing
- Event is reaching document handler which closes menu

### 4. Verify Imports

If functions not found:

```typescript
// Structure.svelte should have:
import { add_atom, delete_atoms, replace_atom } from './atom-manipulation'
import { get_center_of_mass } from '$lib/structure'
```

### 5. Check Structure Updates

If atoms don't appear after adding:

- Verify `structure = add_atom(...)` assigns return value
- Check structure is reactive (`$state` or bindable)
- Look for structure in Scene component props

---

## Summary of Changes

| File                    | Purpose              | Key Changes                                                                      |
| ----------------------- | -------------------- | -------------------------------------------------------------------------------- |
| `atom-manipulation.ts`  | Core atom operations | `add_atom()`, `delete_atoms()`, `replace_atom()` with coordinate conversions     |
| `manipulation.ts`       | Atom movement        | `translate_sites()` for moving atoms, `get_movement_step()` for keyboard control |
| `Structure.svelte`      | Main integration     | Context menu state, handlers, element selector UI                                |
| `StructureScene.svelte` | 3D scene             | Added `oncontextmenu` handlers to atom meshes                                    |
| `index.ts`              | Exports              | Export atom manipulation functions                                               |
| `ContextMenu.svelte`    | Menu component       | Added z-index, fallback colors, positioning                                      |

---

## Key Concepts Explained

### Immutability

JavaScript pattern where we create new objects instead of modifying existing ones:

```javascript
// Bad (mutates original):
structure.sites.push(new_site)

// Good (creates new):
return { ...structure, sites: [...structure.sites, new_site] }
```

Benefits:

- Easier to track changes
- Prevents bugs from unexpected mutations
- Works better with React/Svelte's reactivity

### Coordinate Systems

Crystal structures use two coordinate systems:

**Cartesian (xyz):**

- Real-space coordinates in Angstroms
- Example: [1.5, 2.3, 0.8]
- Used for distances and geometry

**Fractional (abc):**

- Coordinates relative to unit cell
- Range: 0 to 1
- Example: [0.5, 0.5, 0.5] = center of cell
- Used for symmetry and periodicity

Conversion requires matrix math:

```
fractional = inverse(transpose(lattice)) × cartesian
```

### Event Bubbling

Events in JavaScript bubble up through DOM tree:

```
Atom → Canvas → Structure div → Body → Document
```

Why `stopPropagation()` matters:

1. User right-clicks atom
2. Event fires on atom
3. Our handler sets `context_menu_visible = true`
4. Without stopPropagation, event continues to document
5. Document handler sees right-click, closes menu
6. Result: menu flashes and disappears

With `stopPropagation()`:

- Event stops at our handler
- Document handler never sees it
- Menu stays open

### CSS Variables

CSS custom properties with fallbacks:

```css
color: var(--text-color, #fff);
```

- If `--text-color` defined, use it (theme color)
- If not defined, use `#fff` (white)
- Allows themes while ensuring visibility

### TypeScript Optional Types

```typescript
let value: string | null
```

- `|` means "or" (union type)
- Can be string OR null
- Compiler checks both cases

```typescript
function(callback?: () => void)
```

- `?` makes parameter optional
- Caller can omit it
- Must check if defined before calling

### Svelte Reactivity

```typescript
let count = $state(0)
count = count + 1 // UI updates automatically
```

- `$state()` creates reactive variable
- Any change triggers UI re-render
- No need to manually update DOM

---

## Common Errors and Fixes

### Error 1: "get_center_of_mass is not defined"

**Cause:** Missing import in Structure.svelte
**Fix:**

```typescript
import { get_center_of_mass, get_elem_amounts, get_pbc_image_sites } from '$lib/structure'
```

### Error 2: Menu closes immediately

**Cause:** Missing `event.stopPropagation()`
**Fix:** Add to both context menu handlers:

```typescript
function oncontextmenu(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation() // Critical line
  // ... rest of handler
}
```

### Error 3: Icons not found (plus, refresh, trash)

**Cause:** Icons don't exist in icon library
**Fix:** Use existing icons:

```typescript
icon: 'Atom' // instead of 'plus'
icon: 'Reset' // instead of 'refresh'
icon: 'Close' // instead of 'trash'
```

### Error 4: Menu not visible

**Cause:** Rendered inside container with overflow:hidden
**Fix:** Move ContextMenu and element-selector outside `.structure` div:

```svelte
</div> <!-- Close structure div -->

<!-- Now outside structure container -->
<ContextMenu ... />
{#if context_menu_visible}
  <div class="element-selector">...</div>
{/if}
```

### Error 5: Structure doesn't update after add/delete

**Cause:** Not assigning return value
**Fix:**

```typescript
// Wrong:
add_atom(structure, 'C', [0, 0, 0])

// Correct:
structure = add_atom(structure, 'C', [0, 0, 0])
```

---

## Questions?

If you're stuck, check:

1. Browser console (F12) for errors or logs
2. Elements tab to verify DOM structure
3. Network tab if components not loading
4. Console warnings about missing icons or functions

This feature demonstrates important concepts:

- Event handling and propagation
- State management with Svelte
- Coordinate system transformations
- Immutable data updates
- UI composition with components
- CSS positioning and z-index layering
